package com.next.workhub

import android.Manifest
import android.app.Notification
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.media.AudioAttributes
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.media.Ringtone
import android.media.RingtoneManager
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.Person
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import org.json.JSONObject

/**
 * Talk calls on Android.
 *
 * - [CallService]: foreground service (type phoneCall|microphone[|camera]) while a call runs, so
 *   the call keeps its microphone/camera and network when the app goes to the background.
 *   `phoneCall` is allowed because the app holds MANAGE_OWN_CALLS (self-managed calling app).
 * - [CallAudio]: communication audio mode + speaker/earpiece routing, ringtone for incoming calls.
 * - [IncomingCall]: the incoming-call notification (own channel, CallStyle, full-screen intent on
 *   the lock screen) built from a Talk `object_type=call` push.
 */
class CallService : Service() {
  companion object {
    const val NOTIF_ID = 0x7a1c
    const val EXTRA_TITLE = "title"
    const val EXTRA_VIDEO = "video"
    @Volatile var running = false

    fun start(ctx: Context, title: String, video: Boolean) {
      val i = Intent(ctx, CallService::class.java).putExtra(EXTRA_TITLE, title).putExtra(EXTRA_VIDEO, video)
      ContextCompat.startForegroundService(ctx, i)
    }

    fun stop(ctx: Context) {
      ctx.stopService(Intent(ctx, CallService::class.java))
    }
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    WorkhubNotifications.ensureChannels(this)
    val title = intent?.getStringExtra(EXTRA_TITLE)?.take(120) ?: "Talk"
    val video = intent?.getBooleanExtra(EXTRA_VIDEO, false) ?: false
    val open = PendingIntent.getActivity(
      this, NOTIF_ID,
      Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP),
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
    val n: Notification = NotificationCompat.Builder(this, WorkhubNotifications.CH_ONGOING_CALL)
      .setSmallIcon(R.mipmap.ic_launcher)
      .setContentTitle("Görüşme sürüyor")
      .setContentText(title)
      .setOngoing(true)
      .setCategory(NotificationCompat.CATEGORY_CALL)
      .setContentIntent(open)
      .setUsesChronometer(true)
      .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
      .build()
    var type = 0
    if (Build.VERSION.SDK_INT >= 29) {
      type = ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL
      if (Build.VERSION.SDK_INT >= 30 && granted(Manifest.permission.RECORD_AUDIO)) type = type or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
      if (Build.VERSION.SDK_INT >= 30 && video && granted(Manifest.permission.CAMERA)) type = type or ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA
    }
    try {
      ServiceCompat.startForeground(this, NOTIF_ID, n, type)
    } catch (e: Exception) {
      // Not allowed right now (e.g. started from the background on Android 14+): the call still
      // runs while the app is visible; the JS side keeps working.
      stopSelf()
    }
    running = true
    return START_NOT_STICKY
  }

  override fun onDestroy() {
    running = false
    CallAudio.release(this)
    super.onDestroy()
  }

  private fun granted(p: String) = ContextCompat.checkSelfPermission(this, p) == PackageManager.PERMISSION_GRANTED
}

object CallAudio {
  private var ringtone: Ringtone? = null

  fun communication(ctx: Context, on: Boolean) {
    val am = ctx.getSystemService(AudioManager::class.java) ?: return
    am.mode = if (on) AudioManager.MODE_IN_COMMUNICATION else AudioManager.MODE_NORMAL
  }

  /** Loudspeaker (video calls default) or earpiece; Android 12+ uses the communication-device API. */
  fun speaker(ctx: Context, on: Boolean) {
    val am = ctx.getSystemService(AudioManager::class.java) ?: return
    am.mode = AudioManager.MODE_IN_COMMUNICATION
    if (Build.VERSION.SDK_INT >= 31) {
      val want = if (on) AudioDeviceInfo.TYPE_BUILTIN_SPEAKER else AudioDeviceInfo.TYPE_BUILTIN_EARPIECE
      // A connected headset / Bluetooth device wins over the earpiece.
      val devices = am.availableCommunicationDevices
      val external = devices.firstOrNull { it.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO || it.type == AudioDeviceInfo.TYPE_WIRED_HEADSET || it.type == AudioDeviceInfo.TYPE_USB_HEADSET || it.type == AudioDeviceInfo.TYPE_BLE_HEADSET }
      val target = if (!on && external != null) external else devices.firstOrNull { it.type == want }
      if (target != null) am.setCommunicationDevice(target) else am.clearCommunicationDevice()
    } else {
      @Suppress("DEPRECATION")
      am.isSpeakerphoneOn = on
    }
  }

  fun release(ctx: Context) {
    val am = ctx.getSystemService(AudioManager::class.java) ?: return
    if (Build.VERSION.SDK_INT >= 31) am.clearCommunicationDevice() else @Suppress("DEPRECATION") run { am.isSpeakerphoneOn = false }
    am.mode = AudioManager.MODE_NORMAL
  }

  fun ringStart(ctx: Context) {
    if (ringtone?.isPlaying == true) return
    val uri = RingtoneManager.getActualDefaultRingtoneUri(ctx, RingtoneManager.TYPE_RINGTONE) ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE) ?: return
    ringtone = RingtoneManager.getRingtone(ctx, uri)?.apply {
      audioAttributes = AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build()
      if (Build.VERSION.SDK_INT >= 28) isLooping = true
      play()
    }
  }

  fun ringStop() {
    ringtone?.stop()
    ringtone = null
  }
}

object IncomingCall {
  private val ROOM = Regex("^[A-Za-z0-9]{1,64}$")
  const val ACTION_DECLINE = "com.next.workhub.CALL_DECLINE"

  private fun routeJson(tag: String, token: String, action: String?): String {
    val route = JSONObject().put("name", "call").put("token", token)
    if (action != null) route.put("action", action)
    return JSONObject().put("tag", tag).put("route", route).toString()
  }

  /** Talk call push → ringing notification. Content stays generic on the lock screen. */
  fun show(ctx: Context, tag: String, nid: Long, token: String, subject: String) {
    if (!ROOM.matches(token)) return
    WorkhubNotifications.ensureChannels(ctx)
    val notifId = WorkhubNotifications.notificationId(tag, nid)
    fun activity(req: Int, action: String?) = PendingIntent.getActivity(
      ctx, req,
      Intent(ctx, MainActivity::class.java).apply {
        flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
        putExtra(WorkhubNotifications.EXTRA_ROUTE, routeJson(tag, token, action))
      },
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
    val ring = activity(notifId, null)
    val answer = activity(notifId + 1, "accept")
    val decline = PendingIntent.getBroadcast(
      ctx, notifId + 2,
      Intent(ctx, CallActionReceiver::class.java).setAction(ACTION_DECLINE).putExtra("notifId", notifId),
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
    val caller = Person.Builder().setName(if (subject.isNotBlank()) subject else "Talk araması").setImportant(true).build()
    val publicVersion = NotificationCompat.Builder(ctx, WorkhubNotifications.CH_CALL)
      .setSmallIcon(R.mipmap.ic_launcher).setContentTitle("Gelen arama").build()
    val n = NotificationCompat.Builder(ctx, WorkhubNotifications.CH_CALL)
      .setSmallIcon(R.mipmap.ic_launcher)
      .setContentTitle("Gelen arama")
      .setContentText(subject)
      .setCategory(NotificationCompat.CATEGORY_CALL)
      .setPriority(NotificationCompat.PRIORITY_MAX)
      .setOngoing(true)
      .setAutoCancel(true)
      .setTimeoutAfter(60_000)
      .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
      .setPublicVersion(publicVersion)
      .setContentIntent(ring)
      .setFullScreenIntent(ring, true) // lock screen / screen off → ringing screen in the app
      .setStyle(NotificationCompat.CallStyle.forIncomingCall(caller, decline, answer))
      .setGroup("$tag:${WorkhubNotifications.CH_CALL}")
      .build()
    n.flags = n.flags or Notification.FLAG_INSISTENT // keep ringing until answered/declined/removed
    try {
      NotificationManagerCompat.from(ctx).notify(notifId, n)
    } catch (_: SecurityException) {
      // POST_NOTIFICATIONS denied: the inbox still shows the call.
    }
  }
}

/** "Reddet" on the incoming-call notification: stop ringing locally (Talk has no decline API). */
class CallActionReceiver : BroadcastReceiver() {
  override fun onReceive(ctx: Context, intent: Intent) {
    if (intent.action != IncomingCall.ACTION_DECLINE) return
    val id = intent.getIntExtra("notifId", 0)
    if (id != 0) NotificationManagerCompat.from(ctx).cancel(id)
    CallAudio.ringStop()
  }
}
