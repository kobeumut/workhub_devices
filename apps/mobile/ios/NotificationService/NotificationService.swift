// Notification Service Extension: decrypts the relayed Web Push payload natively (no JS), shows
// the real subject (lock screen hides previews by iOS setting "Show Previews: When Unlocked"),
// sets the category for quick reply, and activates new subscriptions.
import UserNotifications

final class NotificationService: UNNotificationServiceExtension {
  private var handler: ((UNNotificationContent) -> Void)?
  private var content: UNMutableNotificationContent?

  override func didReceive(_ request: UNNotificationRequest, withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
    handler = contentHandler
    let c = (request.content.mutableCopy() as? UNMutableNotificationContent) ?? UNMutableNotificationContent()
    content = c
    let info = request.content.userInfo
    guard let tag = info["acct"] as? String, let account = PushAccount.get(tag) else { return finish(generic: true) }

    if let ct = info["ct"] as? String, let body = Data(b64url: ct), let keys = WebPushCrypto.keys(tag: tag, create: false),
       let text = try? WebPushCrypto.decrypt(body, keys), let json = try? JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any] {
      if let activation = json["activationToken"] as? String {
        NextcloudHTTP.shared.call(account, "POST", "/ocs/v2.php/apps/notifications/api/v2/webpush/activate", json: ["activationToken": activation]) { _, _ in
          // Activation pushes must not bother the user; without the filtering entitlement iOS still shows it briefly.
          c.title = "Workhub"; c.body = "Bildirimler etkinleştirildi"
          self.finish(generic: false)
        }
        return
      }
      if json["delete"] as? Bool == true || json["delete-multiple"] as? Bool == true || json["delete-all"] as? Bool == true {
        let nids: [Int] = (json["nids"] as? [Int]) ?? ((json["nid"] as? Int).map { [$0] } ?? [])
        UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: nids.map { "\(tag):\($0)" })
        c.title = "Workhub"; c.body = "Bildirim güncellendi" // hidden only with com.apple.developer.usernotifications.filtering
        return finish(generic: false)
      }
      return present(tag: tag, nid: json["nid"] as? Int ?? 0, app: json["app"] as? String ?? "", type: json["type"] as? String ?? "", id: json["id"] as? String ?? "", subject: json["subject"] as? String ?? "")
    }
    // Payload too big for APNs: fetch with the account's own credentials.
    if let topic = info["topic"] as? String, topic.hasPrefix("nid"), let nid = Int(topic.dropFirst(3)) {
      NextcloudHTTP.shared.call(account, "GET", "/ocs/v2.php/apps/notifications/api/v2/notifications/\(nid)") { status, data in
        guard status == 200, let data, let o = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let n = (o["ocs"] as? [String: Any])?["data"] as? [String: Any] else { return self.finish(generic: true) }
        self.present(tag: tag, nid: nid, app: n["app"] as? String ?? "", type: n["object_type"] as? String ?? "", id: n["object_id"] as? String ?? "", subject: n["subject"] as? String ?? "")
      }
      return
    }
    finish(generic: true)
  }

  private func present(tag: String, nid: Int, app: String, type: String, id: String, subject: String) {
    guard let c = content else { return }
    let route = WorkhubRouting.route(app: app, type: type, id: id)
    c.title = subject.isEmpty ? (app == "workhub" ? "Workhub bildirimi" : "Yeni mesaj") : subject
    c.body = ""
    c.threadIdentifier = "\(tag):\(app)"
    c.userInfo = ["workhubRoute": ["tag": tag, "route": route]]
    if route["name"] as? String == "room" { c.categoryIdentifier = "WORKHUB_TALK_REPLY" }
    // identifier for later removal by delete pushes
    c.targetContentIdentifier = "\(tag):\(nid)"
    finish(generic: false)
  }

  private func finish(generic: Bool) {
    guard let c = content, let h = handler else { return }
    if generic { c.title = "Workhub"; c.body = "Yeni bildirim" }
    handler = nil
    h(c)
  }

  override func serviceExtensionTimeWillExpire() {
    finish(generic: true)
  }
}
