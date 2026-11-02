package com.next.workhub

import android.Manifest
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaPlayer
import android.media.MediaRecorder
import android.net.Uri
import android.provider.OpenableColumns
import android.util.Base64
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.BaseActivityEventListener
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.facebook.react.modules.core.PermissionAwareActivity
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.UUID

/**
 * Talk attachments on Android (GENE-58). JS only ever gets opaque ids for files it may read:
 * documents the user picked (SAF, read permission for this process) and voice notes recorded
 * here. Downloads are written to a private cache file, then either saved where the user chooses
 * (ACTION_CREATE_DOCUMENT) or opened with a viewer via FileProvider (safe types are decided in JS
 * core; nothing is ever executed). Voice notes: 16 kHz mono PCM16 WAV (Talk keeps `voice-message`
 * only for WAV/MP3).
 */
class TalkFiles(private val ctx: ReactApplicationContext) {
  private val picked = HashMap<String, Uri>()
  private val sinks = HashMap<String, File>()
  private var pickPromise: Promise? = null
  private var savePromise: Promise? = null
  private var saveSource: File? = null
  private var recorder: Recording? = null
  private var player: MediaPlayer? = null

  private companion object {
    const val PICK = 4720
    const val SAVE = 4721
    const val MIC = 4722
    const val RATE = 16000
    const val MAX_VOICE_MS = 10 * 60_000L
    const val MAX_SINK = 50L * 1024 * 1024
    val NAME = Regex("^[^/\\\\\\u0000-\\u001f]{1,200}$")
  }

  init {
    ctx.addActivityEventListener(object : BaseActivityEventListener() {
      override fun onActivityResult(activity: Activity, requestCode: Int, resultCode: Int, data: Intent?) {
        if (requestCode == PICK) onPicked(resultCode, data)
        if (requestCode == SAVE) onSaveTarget(resultCode, data)
      }
    })
  }

  private fun dir(name: String) = File(ctx.cacheDir, name).apply { mkdirs() }

  private fun describe(id: String, uri: Uri): WritableMap? {
    var name = uri.lastPathSegment ?: "file"
    var size = -1L
    if (uri.scheme == "file") {
      val f = File(uri.path ?: return null)
      if (!f.isFile) return null
      name = f.name
      size = f.length()
    } else {
      ctx.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { c ->
        if (c.moveToFirst()) {
          c.getString(0)?.let { name = it }
          if (!c.isNull(1)) size = c.getLong(1)
        }
      }
      if (size < 0) ctx.contentResolver.openAssetFileDescriptor(uri, "r")?.use { size = it.length }
    }
    if (size < 0) return null
    val mime = if (uri.scheme == "file") "audio/wav" else ctx.contentResolver.getType(uri) ?: "application/octet-stream"
    return Arguments.createMap().apply {
      putString("id", id)
      putString("name", name)
      putDouble("size", size.toDouble())
      putString("mime", mime)
    }
  }

  // ---- pick + read ----------------------------------------------------------------

  fun pick(p: Promise) {
    val activity = ctx.currentActivity ?: return p.reject("E_WORKHUB", "no_activity")
    if (pickPromise != null) return p.reject("E_WORKHUB", "busy")
    pickPromise = p
    val i = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
      addCategory(Intent.CATEGORY_OPENABLE)
      type = "*/*"
      putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
    }
    try {
      activity.startActivityForResult(i, PICK)
    } catch (e: ActivityNotFoundException) {
      pickPromise = null
      p.reject("E_WORKHUB", "no_picker")
    }
  }

  private fun onPicked(resultCode: Int, data: Intent?) {
    val p = pickPromise ?: return
    pickPromise = null
    val out = Arguments.createArray()
    if (resultCode == Activity.RESULT_OK && data != null) {
      val uris = ArrayList<Uri>()
      data.clipData?.let { cd -> for (k in 0 until minOf(cd.itemCount, 10)) uris.add(cd.getItemAt(k).uri) } ?: data.data?.let { uris.add(it) }
      for (u in uris) {
        val id = "fh-" + UUID.randomUUID().toString()
        try {
          describe(id, u)?.let {
            picked[id] = u
            out.pushMap(it)
          }
        } catch (_: Exception) { /* unreadable document: skipped */ }
      }
    }
    p.resolve(out)
  }

  fun stat(id: String, p: Promise) {
    val u = picked[id] ?: return p.resolve(null)
    try { p.resolve(describe(id, u)) } catch (e: Exception) { p.resolve(null) }
  }

  fun read(id: String, offset: Double, length: Double, p: Promise) {
    val u = picked[id] ?: return p.reject("E_WORKHUB", "gone")
    val len = length.toInt()
    if (offset < 0 || len < 0 || len > 16 * 1024 * 1024) return p.reject("E_WORKHUB", "range")
    try {
      val buf = ByteArray(len)
      var n = 0
      val input = if (u.scheme == "file") FileInputStream(File(u.path!!)) else ctx.contentResolver.openAssetFileDescriptor(u, "r")!!.createInputStream()
      input.use { s ->
        s.channel.position(offset.toLong())
        while (n < len) {
          val r = s.read(buf, n, len - n)
          if (r < 0) break
          n += r
        }
      }
      p.resolve(Base64.encodeToString(buf, 0, n, Base64.NO_WRAP))
    } catch (e: Exception) {
      p.reject("E_WORKHUB", "read")
    }
  }

  fun release(id: String) {
    val u = picked.remove(id) ?: return
    // Recorded notes are ours: delete them once sent/discarded.
    if (u.scheme == "file") u.path?.let { File(it).delete() }
  }

  // ---- download sinks ------------------------------------------------------------------

  fun sinkOpen(name: String, p: Promise) {
    if (!NAME.matches(name)) return p.reject("E_WORKHUB", "name")
    val id = "sk-" + UUID.randomUUID().toString()
    val d = File(dir("downloads"), id).apply { mkdirs() }
    sinks[id] = File(d, name)
    p.resolve(id)
  }

  fun sinkWrite(id: String, b64: String, p: Promise) {
    val f = sinks[id] ?: return p.reject("E_WORKHUB", "gone")
    try {
      val bytes = Base64.decode(b64, Base64.NO_WRAP)
      if (f.length() + bytes.size > MAX_SINK) return p.reject("E_WORKHUB", "too_large")
      FileOutputStream(f, true).use { it.write(bytes) }
      p.resolve(null)
    } catch (e: Exception) {
      p.reject("E_WORKHUB", "write")
    }
  }

  fun sinkAbort(id: String) {
    sinks.remove(id)?.parentFile?.deleteRecursively()
  }

  /** `save` → system "create document" (user picks the place); `open` → a viewer app via FileProvider. */
  fun sinkFinish(id: String, mime: String, mode: String, p: Promise) {
    val f = sinks.remove(id) ?: return p.reject("E_WORKHUB", "gone")
    if (!f.exists()) f.createNewFile()
    val activity = ctx.currentActivity ?: return p.reject("E_WORKHUB", "no_activity")
    val type = if (Regex("^[\\w.+-]+/[\\w.+-]+$").matches(mime)) mime else "application/octet-stream"
    if (mode == "open") {
      val uri = FileProvider.getUriForFile(ctx, "${ctx.packageName}.exports", f)
      val view = Intent(Intent.ACTION_VIEW).apply {
        setDataAndType(uri, type)
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
      }
      try {
        activity.startActivity(view)
        p.resolve("opened")
      } catch (e: ActivityNotFoundException) {
        p.reject("E_WORKHUB", "no_app")
      }
      return
    }
    if (savePromise != null) return p.reject("E_WORKHUB", "busy")
    savePromise = p
    saveSource = f
    val create = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
      addCategory(Intent.CATEGORY_OPENABLE)
      setType(type)
      putExtra(Intent.EXTRA_TITLE, f.name)
    }
    try {
      activity.startActivityForResult(create, SAVE)
    } catch (e: ActivityNotFoundException) {
      savePromise = null
      p.reject("E_WORKHUB", "no_picker")
    }
  }

  private fun onSaveTarget(resultCode: Int, data: Intent?) {
    val p = savePromise ?: return
    val src = saveSource
    savePromise = null
    saveSource = null
    val target = data?.data
    if (resultCode != Activity.RESULT_OK || target == null || src == null) {
      src?.parentFile?.deleteRecursively()
      return p.resolve("cancelled")
    }
    try {
      ctx.contentResolver.openOutputStream(target, "w")!!.use { out -> FileInputStream(src).use { it.copyTo(out) } }
      p.resolve("saved")
    } catch (e: Exception) {
      p.reject("E_WORKHUB", "write")
    } finally {
      src.parentFile?.deleteRecursively()
    }
  }

  // ---- voice notes -----------------------------------------------------------------------

  private class Recording(val pcm: File, val record: AudioRecord, val thread: Thread, val started: Long) {
    @Volatile var running = true
  }

  fun voiceStart(p: Promise) {
    if (recorder != null) return p.resolve(null)
    if (ContextCompat.checkSelfPermission(ctx, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) return startRecording(p)
    val activity = ctx.currentActivity as? PermissionAwareActivity ?: return p.reject("E_WORKHUB", "mic_denied")
    activity.requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), MIC) { code, _, results ->
      if (code != MIC) return@requestPermissions false
      if (results.isNotEmpty() && results[0] == PackageManager.PERMISSION_GRANTED) startRecording(p) else p.reject("E_WORKHUB", "mic_denied")
      true
    }
  }

  @Suppress("MissingPermission")
  private fun startRecording(p: Promise) {
    try {
      val min = AudioRecord.getMinBufferSize(RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
      val rec = AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION, RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, maxOf(min, RATE))
      if (rec.state != AudioRecord.STATE_INITIALIZED) {
        rec.release()
        return p.reject("E_WORKHUB", "mic_denied")
      }
      val pcm = File(dir("voice"), "rec-${System.currentTimeMillis()}.pcm")
      lateinit var r: Recording
      val t = Thread {
        val buf = ByteArray(4096)
        FileOutputStream(pcm).use { out ->
          while (r.running && System.currentTimeMillis() - r.started < MAX_VOICE_MS) {
            val n = rec.read(buf, 0, buf.size)
            if (n > 0) out.write(buf, 0, n)
          }
        }
      }
      r = Recording(pcm, rec, t, System.currentTimeMillis())
      rec.startRecording()
      t.start()
      recorder = r
      p.resolve(null)
    } catch (e: Exception) {
      p.reject("E_WORKHUB", "mic_denied")
    }
  }

  private fun finishRecording(): Recording? {
    val r = recorder ?: return null
    recorder = null
    r.running = false
    try { r.record.stop() } catch (_: Exception) {}
    r.thread.join(2000)
    r.record.release()
    return r
  }

  fun voiceStop(name: String, p: Promise) {
    val r = finishRecording() ?: return p.resolve(null)
    try {
      val data = r.pcm.length()
      if (data < RATE / 2 || !NAME.matches(name)) {
        r.pcm.delete()
        return p.resolve(null)
      }
      val wav = File(dir("voice"), name)
      FileOutputStream(wav).use { out ->
        out.write(wavHeader(data))
        FileInputStream(r.pcm).use { it.copyTo(out) }
      }
      r.pcm.delete()
      val id = "fh-" + UUID.randomUUID().toString()
      val uri = Uri.fromFile(wav)
      picked[id] = uri
      p.resolve(describe(id, uri))
    } catch (e: Exception) {
      p.reject("E_WORKHUB", "record")
    }
  }

  fun voiceCancel() {
    finishRecording()?.pcm?.delete()
  }

  private fun wavHeader(data: Long): ByteArray = ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN).apply {
    put("RIFF".toByteArray()); putInt((36 + data).toInt()); put("WAVE".toByteArray())
    put("fmt ".toByteArray()); putInt(16); putShort(1); putShort(1); putInt(RATE); putInt(RATE * 2); putShort(2); putShort(16)
    put("data".toByteArray()); putInt(data.toInt())
  }.array()

  // ---- playback -----------------------------------------------------------------------------

  fun audioPlay(b64: String, p: Promise) {
    audioStop()
    try {
      val f = File(dir("play"), "clip-${System.currentTimeMillis()}")
      f.writeBytes(Base64.decode(b64, Base64.NO_WRAP))
      val mp = MediaPlayer()
      mp.setDataSource(f.path)
      mp.setOnCompletionListener {
        f.delete()
        emitEnded()
        audioStop()
      }
      mp.setOnErrorListener { _, _, _ -> f.delete(); emitEnded(); true }
      mp.prepare()
      mp.start()
      player = mp
      p.resolve(null)
    } catch (e: Exception) {
      p.reject("E_WORKHUB", "play")
    }
  }

  fun audioStop() {
    player?.let { try { it.stop() } catch (_: Exception) {}; it.release() }
    player = null
  }

  private fun emitEnded() {
    ctx.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java).emit("WorkhubAudioEnded", null)
  }
}
