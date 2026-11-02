package com.next.workhub

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.app.RemoteInput
import org.json.JSONObject
import java.security.SecureRandom
import kotlin.concurrent.thread

/**
 * Notification quick reply (RemoteInput) → Talk message, natively, with the right account.
 * Exactly-once: one POST with a fresh referenceId, no automatic retry; failure is shown.
 */
class ReplyReceiver : BroadcastReceiver() {
  override fun onReceive(ctx: Context, intent: Intent) {
    val text = RemoteInput.getResultsFromIntent(intent)?.getCharSequence(WorkhubNotifications.KEY_REPLY)?.toString()?.trim()
    val tag = intent.getStringExtra("tag") ?: return
    val token = intent.getStringExtra("token") ?: return
    val notifId = intent.getIntExtra("notifId", 0)
    val channel = intent.getStringExtra("channel") ?: WorkhubNotifications.CH_CHAT
    if (text.isNullOrEmpty() || !Regex("^[A-Za-z0-9]{1,64}$").matches(token)) return
    val pending = goAsync()
    thread {
      try {
        val account = PushAccounts.get(ctx, tag)
        val pw = account?.appPassword(ctx)
        if (account == null || pw == null) {
          WorkhubNotifications.status(ctx, notifId, channel, "Yanıt gönderilemedi: oturum yok")
          return@thread
        }
        val ref = ByteArray(32).also { SecureRandom().nextBytes(it) }.joinToString("") { "%02x".format(it) }
        val r = try {
          NextcloudHttp.call(account, pw, "POST", "/ocs/v2.php/apps/spreed/api/v1/chat/$token", JSONObject().put("message", text).put("referenceId", ref))
        } catch (_: Exception) {
          null
        }
        when (r?.status) {
          201, 200 -> WorkhubNotifications.status(ctx, notifId, channel, "Yanıt gönderildi")
          401 -> WorkhubNotifications.status(ctx, notifId, channel, "Yanıt gönderilemedi: tekrar giriş gerekli")
          403, 404 -> WorkhubNotifications.status(ctx, notifId, channel, "Yanıt gönderilemedi: sohbete erişim yok")
          null -> WorkhubNotifications.status(ctx, notifId, channel, "Yanıt gönderilemedi: bağlantı yok — sohbeti açıp kontrol edin")
          else -> WorkhubNotifications.status(ctx, notifId, channel, "Yanıt gönderilemedi (${r.status})")
        }
      } finally {
        pending.finish()
      }
    }
  }
}
