package com.next.workhub

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.RemoteInput
import org.json.JSONObject

/** Builds/cancels OS notifications. Lock screen shows a generic public version (content hidden). */
object WorkhubNotifications {
  const val CH_CHAT = "chat"
  const val CH_WORKHUB = "workhub"
  const val CH_OTHER = "other"
  const val EXTRA_ROUTE = "workhub.route"
  const val KEY_REPLY = "workhub.reply"
  private val ROOM = Regex("^[A-Za-z0-9]{1,64}$")
  private val INT = Regex("^[1-9][0-9]{0,15}$")

  fun ensureChannels(ctx: Context) {
    if (Build.VERSION.SDK_INT < 26) return
    val nm = ctx.getSystemService(NotificationManager::class.java)
    nm.createNotificationChannel(NotificationChannel(CH_CHAT, "Sohbet mesajları", NotificationManager.IMPORTANCE_HIGH))
    nm.createNotificationChannel(NotificationChannel(CH_WORKHUB, "Workhub görevleri", NotificationManager.IMPORTANCE_DEFAULT))
    nm.createNotificationChannel(NotificationChannel(CH_OTHER, "Diğer bildirimler", NotificationManager.IMPORTANCE_LOW))
  }

  /** Android badges require an active notification and a supporting launcher. No OEM broadcasts. */
  fun setBadgeCount(ctx: Context, count: Int) {
    val nm = NotificationManagerCompat.from(ctx)
    if (count == 0) { nm.cancel("talk-unread", 0); return }
    if (Build.VERSION.SDK_INT >= 26) {
      ctx.getSystemService(NotificationManager::class.java).createNotificationChannel(
        NotificationChannel("talk-unread", "Okunmamış mesaj sayısı", NotificationManager.IMPORTANCE_LOW).apply { setShowBadge(true) }
      )
    }
    val open = Intent(ctx, MainActivity::class.java).apply {
      action = "com.next.workhub.OPEN_UNREAD"
      flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
    }
    val n = NotificationCompat.Builder(ctx, "talk-unread")
      .setSmallIcon(R.mipmap.ic_launcher).setContentTitle("Workhub")
      .setContentText("$count okunmamış mesaj").setNumber(count)
      .setSilent(true).setOnlyAlertOnce(true).setVisibility(NotificationCompat.VISIBILITY_SECRET)
      .setContentIntent(PendingIntent.getActivity(ctx, 0, open, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE))
      .build()
    try { nm.notify("talk-unread", 0, n) } catch (_: SecurityException) { /* notification permission denied */ }
  }

  fun notificationId(tag: String, nid: Long): Int = "$tag:$nid".hashCode()

  /** Same dispatch rules as packages/core routing.routeForObject. */
  fun route(app: String, type: String, id: String): JSONObject {
    if (app == "spreed" || app == "talk") {
      val token = id.substringBefore('/')
      if (ROOM.matches(token) && type in setOf("chat", "room", "call", "reminder", "remote_talk_share")) {
        return JSONObject().put("name", "room").put("token", token)
      }
    }
    if (app == "workhub" && type == "card" && INT.matches(id)) return JSONObject().put("name", "task").put("cardId", id.toLong())
    return JSONObject().put("name", "inbox")
  }

  fun show(ctx: Context, tag: String, nid: Long, app: String, type: String, id: String, subject: String) {
    ensureChannels(ctx)
    val route = route(app, type, id)
    val roomToken = if (route.getString("name") == "room") route.getString("token") else null
    if (roomToken != null && WorkhubNativeModule.isForeground(tag, roomToken)) return

    val channel = when (app) {
      "spreed", "talk" -> CH_CHAT
      "workhub" -> CH_WORKHUB
      else -> CH_OTHER
    }
    val genericTitle = when (channel) {
      CH_CHAT -> "Yeni mesaj"
      CH_WORKHUB -> "Workhub bildirimi"
      else -> "Yeni bildirim"
    }
    val notifId = notificationId(tag, nid)
    val open = Intent(ctx, MainActivity::class.java).apply {
      flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
      putExtra(EXTRA_ROUTE, JSONObject().put("tag", tag).put("route", route).toString())
    }
    val contentIntent = PendingIntent.getActivity(ctx, notifId, open, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    val publicVersion = NotificationCompat.Builder(ctx, channel)
      .setSmallIcon(R.mipmap.ic_launcher)
      .setContentTitle(genericTitle)
      .build()
    val b = NotificationCompat.Builder(ctx, channel)
      .setSmallIcon(R.mipmap.ic_launcher)
      .setContentTitle(if (subject.isNotBlank()) subject else genericTitle)
      .setAutoCancel(true)
      .setContentIntent(contentIntent)
      .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
      .setPublicVersion(publicVersion)
      .setCategory(if (channel == CH_CHAT) NotificationCompat.CATEGORY_MESSAGE else NotificationCompat.CATEGORY_EVENT)
      .setGroup("$tag:$channel")

    if (roomToken != null) {
      val replyIntent = Intent(ctx, ReplyReceiver::class.java).apply {
        component = ComponentName(ctx, ReplyReceiver::class.java)
        putExtra("tag", tag)
        putExtra("token", roomToken)
        putExtra("notifId", notifId)
        putExtra("channel", channel)
      }
      // RemoteInput requires a MUTABLE PendingIntent; it is explicit (component set) so it cannot be redirected.
      val replyPi = PendingIntent.getBroadcast(ctx, notifId, replyIntent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE)
      val input = RemoteInput.Builder(KEY_REPLY).setLabel("Yanıt yazın").build()
      b.addAction(NotificationCompat.Action.Builder(R.mipmap.ic_launcher, "Yanıtla", replyPi).addRemoteInput(input).setAllowGeneratedReplies(false).build())
    }
    try {
      NotificationManagerCompat.from(ctx).notify(notifId, b.build())
    } catch (_: SecurityException) {
      // POST_NOTIFICATIONS not granted: inbox still has it.
    }
  }

  fun status(ctx: Context, notifId: Int, channel: String, text: String) {
    ensureChannels(ctx)
    val n = NotificationCompat.Builder(ctx, channel).setSmallIcon(R.mipmap.ic_launcher).setContentTitle(text).setAutoCancel(true).setTimeoutAfter(8_000).build()
    try {
      NotificationManagerCompat.from(ctx).notify(notifId, n)
    } catch (_: SecurityException) {}
  }

  fun cancel(ctx: Context, tag: String, nid: Long) = NotificationManagerCompat.from(ctx).cancel(notificationId(tag, nid))

  /** `delete-all` for one account: only that account's notifications (grouped by tag). */
  fun cancelForTag(ctx: Context, tag: String) {
    val nm = ctx.getSystemService(NotificationManager::class.java)
    for (sbn in nm.activeNotifications) if (sbn.notification.group?.startsWith("$tag:") == true) nm.cancel(sbn.id)
  }
}
