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
  @objc func setBadgeCount(_ count: NSNumber) {
    let value = count.doubleValue
    guard value.isFinite, value >= 0, value <= Double(Int32.max), value.rounded(.down) == value else { return }
    // Main-queue FIFO keeps rapid account-switch/reset updates ordered (including iOS <16).
    DispatchQueue.main.async { UIApplication.shared.applicationIconBadgeNumber = Int(value) }
  }
  @objc func requestNotificationPermission(_ r: @escaping RCTPromiseResolveBlock, rejecter _: RCTPromiseRejectBlock) {
    UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { ok, _ in
      if ok { DispatchQueue.main.async { UIApplication.shared.registerForRemoteNotifications() } }
      r(ok)
    }
  }

  /// Share a generated export (CSV) via the system share sheet; file lives in a private temp dir.
  @objc func shareFile(_ filename: String, content: String, mime: String, resolver r: @escaping RCTPromiseResolveBlock, rejecter j: @escaping RCTPromiseRejectBlock) {
    guard mime == "text/csv", filename.range(of: "^[A-Za-z0-9_.-]{1,120}\\.csv$", options: .regularExpression) != nil, content.utf8.count <= 50 * 1024 * 1024 else {
      j("E_WORKHUB", "invalid", nil)
      return
    }
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent("exports", isDirectory: true)
    try? FileManager.default.removeItem(at: dir)
    do {
      try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
      let url = dir.appendingPathComponent(filename)
      try content.write(to: url, atomically: true, encoding: .utf8)
      DispatchQueue.main.async {
        guard let root = RCTPresentedViewController() else { j("E_WORKHUB", "no_view", nil); return }
        let vc = UIActivityViewController(activityItems: [url], applicationActivities: nil)
        vc.popoverPresentationController?.sourceView = root.view
        vc.completionWithItemsHandler = { _, completed, _, _ in r(completed ? "saved" : "cancelled") }
        root.present(vc, animated: true)
      }
    } catch {
      j("E_WORKHUB", "write_failed", nil)
    }
  }
}
