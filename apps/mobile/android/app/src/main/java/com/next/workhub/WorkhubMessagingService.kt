package com.next.workhub

import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import org.json.JSONObject

/**
 * Receives relayed Web Push messages via FCM — runs natively, JS/React does not need to be alive.
 * data: { acct: account tag, ct?: base64url aes128gcm body, topic?: "nid<id>", urgency }
 */
class WorkhubMessagingService : FirebaseMessagingService() {
  override fun onMessageReceived(message: RemoteMessage) {
    val data = message.data
    val tag = data["acct"] ?: return
    val account = PushAccounts.get(this, tag) ?: return
    try {
      val ct = data["ct"]
      if (ct != null) {
        val keys = PushAccounts.keys(this, tag, false) ?: return
        handlePayload(account, JSONObject(WebPushCrypto.decrypt(WebPushCrypto.b64urlDecode(ct), keys)))
      } else {
        val nid = Regex("^nid([1-9][0-9]{0,15})$").find(data["topic"] ?: "")?.groupValues?.get(1)?.toLong() ?: return
        fetchAndShow(account, nid)
      }
    } catch (_: Exception) {
      // Undecryptable/forged payloads are dropped silently (never shown).
    }
  }

  private fun handlePayload(account: PushAccounts.Account, p: JSONObject) {
    val activation = p.optString("activationToken", "")
    if (activation.isNotEmpty()) {
      val pw = account.appPassword(this) ?: return
      NextcloudHttp.call(account, pw, "POST", "/ocs/v2.php/apps/notifications/api/v2/webpush/activate", JSONObject().put("activationToken", activation))
      return
    }
    when {
      p.optBoolean("delete-all") -> WorkhubNotifications.cancelForTag(this, account.tag)
      p.optBoolean("delete-multiple") -> p.optJSONArray("nids")?.let { a -> for (i in 0 until a.length()) WorkhubNotifications.cancel(this, account.tag, a.getLong(i)) }
      p.optBoolean("delete") -> WorkhubNotifications.cancel(this, account.tag, p.getLong("nid"))
      else -> {
        val nid = p.optLong("nid", 0)
        if (nid <= 0) return
        WorkhubNotifications.show(this, account.tag, nid, p.optString("app"), p.optString("type"), p.optString("id"), p.optString("subject"))
      }
    }
  }

  /** Payload too large for FCM: fetch the notification with the account's own credentials. */
  private fun fetchAndShow(account: PushAccounts.Account, nid: Long) {
    val pw = account.appPassword(this) ?: return
    val r = NextcloudHttp.call(account, pw, "GET", "/ocs/v2.php/apps/notifications/api/v2/notifications/$nid")
    if (r.status == 404) return WorkhubNotifications.cancel(this, account.tag, nid)
    if (r.status != 200) return
    val n = JSONObject(r.body).getJSONObject("ocs").getJSONObject("data")
    WorkhubNotifications.show(this, account.tag, nid, n.optString("app"), n.optString("object_type"), n.optString("object_id"), n.optString("subject"))
  }

  override fun onNewToken(token: String) {
    // The JS layer re-registers every account's subscription with the new token on next start
    // (ensurePush). Flag it so the app can do it promptly.
    getSharedPreferences("workhub_plain", MODE_PRIVATE).edit().putBoolean("push.tokenRotated", true).apply()
  }
}
