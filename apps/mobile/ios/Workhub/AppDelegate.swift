import FirebaseCore
import FirebaseMessaging
import UIKit
import UserNotifications

@main
class AppDelegate: UIResponder, UIApplicationDelegate, UNUserNotificationCenterDelegate {
  func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    // Firebase is configured only once GoogleService-Info.plist is added (README: Push bildirimleri).
    if Bundle.main.path(forResource: "GoogleService-Info", ofType: "plist") != nil { FirebaseApp.configure() }
    let center = UNUserNotificationCenter.current()
    center.delegate = self
    let reply = UNTextInputNotificationAction(identifier: "WORKHUB_REPLY", title: "Yanıtla", options: [.authenticationRequired], textInputButtonTitle: "Gönder", textInputPlaceholder: "Yanıt yazın")
    center.setNotificationCategories([UNNotificationCategory(identifier: "WORKHUB_TALK_REPLY", actions: [reply], intentIdentifiers: [], options: [])])
    return true
  }

  func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
    if FirebaseApp.app() != nil { Messaging.messaging().apnsToken = deviceToken }
  }

  // Foreground: don't banner the chat that is open.
  func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent n: UNNotification, withCompletionHandler done: @escaping (UNNotificationPresentationOptions) -> Void) {
    let r = (n.request.content.userInfo["workhubRoute"] as? [String: Any])
    let route = r?["route"] as? [String: Any]
    if let tag = r?["tag"] as? String, route?["name"] as? String == "room", tag == WorkhubNative.fgTag, route?["token"] as? String == WorkhubNative.fgRoom { return done([]) }
    done([.banner, .list, .sound])
  }

  func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler done: @escaping () -> Void) {
    guard let r = response.notification.request.content.userInfo["workhubRoute"] as? [String: Any], let tag = r["tag"] as? String, let route = r["route"] as? [String: Any] else { return done() }
    if response.actionIdentifier == "WORKHUB_REPLY", let text = (response as? UNTextInputNotificationResponse)?.userText.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty,
       let token = route["token"] as? String, let account = PushAccount.get(tag) {
      // Exactly-once: one POST with a fresh referenceId; failure is shown, never silently retried.
      var bytes = [UInt8](repeating: 0, count: 32)
      _ = SecRandomCopyBytes(kSecRandomDefault, 32, &bytes)
      let ref = bytes.map { String(format: "%02x", $0) }.joined()
      let task = UIApplication.shared.beginBackgroundTask(withName: "workhub-reply")
      NextcloudHTTP.shared.call(account, "POST", "/ocs/v2.php/apps/spreed/api/v1/chat/\(token)", json: ["message": text, "referenceId": ref]) { status, _ in
        if status != 201 && status != 200 {
          let c = UNMutableNotificationContent()
          c.title = "Yanıt gönderilemedi"
          c.body = status == 401 ? "Tekrar giriş gerekli" : status == 0 ? "Bağlantı yok — sohbeti açıp kontrol edin" : "Sohbete erişim yok (\(status))"
          UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: UUID().uuidString, content: c, trigger: nil))
        }
        UIApplication.shared.endBackgroundTask(task)
        done()
      }
      return
    }
    if let data = try? JSONSerialization.data(withJSONObject: ["tag": tag, "route": route]), let json = String(data: data, encoding: .utf8) { WorkhubNative.deliver(route: json) }
    done()
  }
}
