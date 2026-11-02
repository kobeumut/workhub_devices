package com.next.workhub

import android.content.Context
import org.json.JSONObject

/**
 * Native view of the logged-in accounts, keyed by the opaque tag that the relay forwards in
 * every push. Holds only what native code needs: server, login, the SecureStore name of the app
 * password, and the Web Push keys (private key in SecureStore).
 */
object PushAccounts {
  private const val PREFS = "workhub_push_accounts"

  class Account(val tag: String, val serverBase: String, val loginName: String, val secretKey: String) {
    fun appPassword(ctx: Context): String? = SecureStore.get(ctx, secretKey)
  }

  private val TAG_RE = Regex("^[A-Za-z0-9_-]{1,64}$")

  fun put(ctx: Context, tag: String, serverBase: String, loginName: String, secretKey: String) {
    require(TAG_RE.matches(tag)) { "invalid tag" }
    require(serverBase.startsWith("https://") || (BuildConfig.DEBUG && serverBase.startsWith("http://"))) { "insecure server" }
    val json = JSONObject().put("serverBase", serverBase).put("loginName", loginName).put("secretKey", secretKey)
    ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(tag, json.toString()).apply()
  }

  fun get(ctx: Context, tag: String): Account? {
    if (!TAG_RE.matches(tag)) return null
    val raw = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(tag, null) ?: return null
    val j = JSONObject(raw)
    return Account(tag, j.getString("serverBase"), j.getString("loginName"), j.getString("secretKey"))
  }

  fun keys(ctx: Context, tag: String, createIfMissing: Boolean): WebPushCrypto.Keys? {
    val prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    val pub = prefs.getString("$tag.pub", null)
    val auth = prefs.getString("$tag.auth", null)
    val priv = SecureStore.get(ctx, "push-key::$tag")
    if (pub != null && auth != null && priv != null) {
      return WebPushCrypto.Keys(WebPushCrypto.b64urlDecode(pub), WebPushCrypto.b64urlDecode(priv), WebPushCrypto.b64urlDecode(auth))
    }
    if (!createIfMissing) return null
    val k = WebPushCrypto.generate()
    SecureStore.set(ctx, "push-key::$tag", WebPushCrypto.b64url(k.privatePkcs8))
    prefs.edit().putString("$tag.pub", WebPushCrypto.b64url(k.publicRaw)).putString("$tag.auth", WebPushCrypto.b64url(k.auth)).apply()
    return k
  }

  fun forget(ctx: Context, tag: String) {
    ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().remove(tag).remove("$tag.pub").remove("$tag.auth").apply()
    SecureStore.delete(ctx, "push-key::$tag")
  }
}
