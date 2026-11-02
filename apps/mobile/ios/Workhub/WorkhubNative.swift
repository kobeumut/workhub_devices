import FirebaseCore
import FirebaseMessaging
import Foundation
import React
import UserNotifications

/// Same JS contract as android/WorkhubNativeModule.kt (see src/native.ts).
@objc(WorkhubNative)
final class WorkhubNative: RCTEventEmitter {
  static var pendingRoute: String?
  static weak var instance: WorkhubNative?
  static var fgTag: String?
  static var fgRoom: String?
  private var hasListeners = false

  override init() { super.init(); WorkhubNative.instance = self }
  override static func requiresMainQueueSetup() -> Bool { false }
  override func supportedEvents() -> [String]! { ["WorkhubRoute"] }
  override func startObserving() { hasListeners = true }
  override func stopObserving() { hasListeners = false }

  static func deliver(route json: String) {
    if let i = instance, i.hasListeners { i.sendEvent(withName: "WorkhubRoute", body: json) } else { pendingRoute = json }
  }

  @objc func secretGet(_ k: String, resolver r: RCTPromiseResolveBlock, rejecter _: RCTPromiseRejectBlock) { r(Keychain.get(k)) }
  @objc func secretSet(_ k: String, value v: String, resolver r: RCTPromiseResolveBlock, rejecter j: RCTPromiseRejectBlock) {
    Keychain.set(k, v) ? r(nil) : j("E_WORKHUB", "keychain", nil)
  }
  @objc func secretDelete(_ k: String, resolver r: RCTPromiseResolveBlock, rejecter _: RCTPromiseRejectBlock) { Keychain.delete(k); r(nil) }

  @objc func plainGet(_ k: String, resolver r: RCTPromiseResolveBlock, rejecter _: RCTPromiseRejectBlock) { r(WorkhubShared.defaults.string(forKey: "plain.\(k)")) }
  @objc func plainSet(_ k: String, value v: String, resolver r: RCTPromiseResolveBlock, rejecter _: RCTPromiseRejectBlock) { WorkhubShared.defaults.set(v, forKey: "plain.\(k)"); r(nil) }
  @objc func plainDelete(_ k: String, resolver r: RCTPromiseResolveBlock, rejecter _: RCTPromiseRejectBlock) { WorkhubShared.defaults.removeObject(forKey: "plain.\(k)"); r(nil) }
  @objc func plainDeletePrefix(_ p: String, resolver r: RCTPromiseResolveBlock, rejecter _: RCTPromiseRejectBlock) {
    for key in WorkhubShared.defaults.dictionaryRepresentation().keys where key.hasPrefix("plain.\(p)") { WorkhubShared.defaults.removeObject(forKey: key) }
    r(nil)
  }

  @objc func pushPrepare(_ tag: String, serverBase: String, loginName: String, secretKey: String, resolver r: @escaping RCTPromiseResolveBlock, rejecter j: RCTPromiseRejectBlock) {
    PushAccount.put(tag: tag, serverBase: serverBase, loginName: loginName, secretKey: secretKey)
    guard let keys = WebPushCrypto.keys(tag: tag, create: true) else { return j("E_WORKHUB", "keys", nil) }
    var out: [String: Any] = ["publicKey": keys.publicRaw.b64url, "auth": keys.auth.b64url, "fcmToken": NSNull()]
    guard FirebaseApp.app() != nil else { return r(out) } // GoogleService-Info.plist not added yet
    Messaging.messaging().token { token, _ in
      if let token { out["fcmToken"] = token }
      r(out)
    }
  }

  @objc func pushForget(_ tag: String, resolver r: RCTPromiseResolveBlock, rejecter _: RCTPromiseRejectBlock) { PushAccount.forget(tag); r(nil) }
  @objc func consumeInitialRoute(_ r: RCTPromiseResolveBlock, rejecter _: RCTPromiseRejectBlock) { r(WorkhubNative.pendingRoute); WorkhubNative.pendingRoute = nil }
  @objc func setForeground(_ tag: String?, room: String?) { WorkhubNative.fgTag = tag; WorkhubNative.fgRoom = room }
  @objc func requestNotificationPermission(_ r: @escaping RCTPromiseResolveBlock, rejecter _: RCTPromiseRejectBlock) {
    UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { ok, _ in
      if ok { DispatchQueue.main.async { UIApplication.shared.registerForRemoteNotifications() } }
      r(ok)
    }
  }
}
