package com.next.workhub

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.core.PermissionAwareActivity
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging

/** JS ↔ native bridge: secure/plain storage, push key preparation, routes from notifications. */
class WorkhubNativeModule(private val ctx: ReactApplicationContext) : ReactContextBaseJavaModule(ctx) {
  companion object {
    @Volatile private var fgTag: String? = null
    @Volatile private var fgRoom: String? = null
    @Volatile var pendingRoute: String? = null
    @Volatile var instance: WorkhubNativeModule? = null

    fun isForeground(tag: String, room: String) = fgTag == tag && fgRoom == room

    fun deliverRoute(json: String) {
      val m = instance
      if (m != null && m.ctx.hasActiveReactInstance()) m.ctx.emitDeviceEvent("WorkhubRoute", json) else pendingRoute = json
    }
  }

  init {
    instance = this
  }

  override fun getName() = "WorkhubNative"

  private val plain get() = ctx.getSharedPreferences("workhub_plain", Context.MODE_PRIVATE)

  private inline fun run(p: Promise, block: () -> Any?) {
    try {
      p.resolve(block())
    } catch (e: Exception) {
      p.reject("E_WORKHUB", e.javaClass.simpleName) // never forward secret-bearing messages
    }
  }

  @ReactMethod fun secretGet(k: String, p: Promise) = run(p) { SecureStore.get(ctx, k) }
  @ReactMethod fun secretSet(k: String, v: String, p: Promise) = run(p) { SecureStore.set(ctx, k, v); null }
  @ReactMethod fun secretDelete(k: String, p: Promise) = run(p) { SecureStore.delete(ctx, k); null }

  @ReactMethod fun plainGet(k: String, p: Promise) = run(p) { plain.getString(k, null) }
  @ReactMethod fun plainSet(k: String, v: String, p: Promise) = run(p) { plain.edit().putString(k, v).apply(); null }
  @ReactMethod fun plainDelete(k: String, p: Promise) = run(p) { plain.edit().remove(k).apply(); null }
  @ReactMethod fun plainDeletePrefix(prefix: String, p: Promise) = run(p) {
    val e = plain.edit()
    plain.all.keys.filter { it.startsWith(prefix) }.forEach { e.remove(it) }
    e.apply()
    null
  }

  @ReactMethod
  fun pushPrepare(tag: String, serverBase: String, loginName: String, secretKey: String, p: Promise) {
    try {
      PushAccounts.put(ctx, tag, serverBase, loginName, secretKey)
      val keys = PushAccounts.keys(ctx, tag, true)!!
      val out = Arguments.createMap().apply {
        putString("publicKey", WebPushCrypto.b64url(keys.publicRaw))
        putString("auth", WebPushCrypto.b64url(keys.auth))
      }
      // Without google-services.json Firebase is not initialised: push stays off, app still works.
      if (FirebaseApp.getApps(ctx).isEmpty()) {
        out.putNull("fcmToken")
        return p.resolve(out)
      }
      FirebaseMessaging.getInstance().token.addOnCompleteListener { t ->
        if (t.isSuccessful) out.putString("fcmToken", t.result) else out.putNull("fcmToken")
        p.resolve(out)
      }
    } catch (e: Exception) {
      p.reject("E_WORKHUB", e.javaClass.simpleName)
    }
  }

  @ReactMethod fun pushForget(tag: String, p: Promise) = run(p) {
    WorkhubNotifications.cancelForTag(ctx, tag)
    PushAccounts.forget(ctx, tag)
    null
  }

  @ReactMethod fun consumeInitialRoute(p: Promise) = run(p) {
    val r = pendingRoute
    pendingRoute = null
    r
  }

  @ReactMethod fun setForeground(tag: String?, room: String?) {
    fgTag = tag
    fgRoom = room
  }

  @ReactMethod
  fun requestNotificationPermission(p: Promise) {
    if (Build.VERSION.SDK_INT < 33 || ContextCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) {
      return p.resolve(true)
    }
    val activity = ctx.currentActivity as? PermissionAwareActivity ?: return p.resolve(false)
    activity.requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 4711) { code, _, results ->
      if (code == 4711) {
        p.resolve(results.isNotEmpty() && results[0] == PackageManager.PERMISSION_GRANTED)
        true
      } else {
        false
      }
    }
  }

  // Required by NativeEventEmitter
  @ReactMethod fun addListener(eventName: String) {}
  @ReactMethod fun removeListeners(count: Double) {}
}
