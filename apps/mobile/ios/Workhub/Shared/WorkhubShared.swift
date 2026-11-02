// Shared by the app target AND the NotificationService extension (add to both targets).
// Swift port of packages/core (webpush decrypt, routing) + Keychain storage in the shared
// access group so the extension can decrypt and reply while JS is not running.
import CryptoKit
import Foundation
import Security

enum WorkhubShared {
  static let appGroup = "group.com.next.workhub"
  static let keychainGroup: String = {
    // "$(AppIdentifierPrefix)com.next.workhub.shared" — prefix read from Info.plist key AppIdentifierPrefix
    let prefix = Bundle.main.object(forInfoDictionaryKey: "AppIdentifierPrefix") as? String ?? ""
    return prefix + "com.next.workhub.shared"
  }()
  static var defaults: UserDefaults { UserDefaults(suiteName: appGroup) ?? .standard }
}

enum Keychain {
  private static func base(_ key: String) -> [String: Any] {
    [kSecClass as String: kSecClassGenericPassword,
     kSecAttrService as String: "com.next.workhub",
     kSecAttrAccount as String: key,
     kSecAttrAccessGroup as String: WorkhubShared.keychainGroup]
  }
  static func get(_ key: String) -> String? {
    var q = base(key)
    q[kSecReturnData as String] = true
    q[kSecMatchLimit as String] = kSecMatchLimitOne
    var out: AnyObject?
    guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let d = out as? Data else { return nil }
    return String(data: d, encoding: .utf8)
  }
  @discardableResult static func set(_ key: String, _ value: String) -> Bool {
    delete(key)
    var q = base(key)
    q[kSecValueData as String] = Data(value.utf8)
    // Available after first unlock so the extension can read it while the phone is locked.
    q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    return SecItemAdd(q as CFDictionary, nil) == errSecSuccess
  }
  static func delete(_ key: String) { SecItemDelete(base(key) as CFDictionary) }
}

struct PushAccount {
  let tag: String, serverBase: String, loginName: String, secretKey: String
  var appPassword: String? { Keychain.get(secretKey) }

  static func get(_ tag: String) -> PushAccount? {
    guard tag.range(of: "^[A-Za-z0-9_-]{1,64}$", options: .regularExpression) != nil,
          let d = WorkhubShared.defaults.dictionary(forKey: "acct.\(tag)") as? [String: String],
          let s = d["serverBase"], let l = d["loginName"], let k = d["secretKey"] else { return nil }
    return PushAccount(tag: tag, serverBase: s, loginName: l, secretKey: k)
  }
  static func put(tag: String, serverBase: String, loginName: String, secretKey: String) {
    WorkhubShared.defaults.set(["serverBase": serverBase, "loginName": loginName, "secretKey": secretKey], forKey: "acct.\(tag)")
  }
  static func forget(_ tag: String) {
    WorkhubShared.defaults.removeObject(forKey: "acct.\(tag)")
    WorkhubShared.defaults.removeObject(forKey: "keys.\(tag)")
    Keychain.delete("push-key::\(tag)")
  }
}

enum WebPushCrypto {
  struct Keys { let privateKey: P256.KeyAgreement.PrivateKey; let auth: Data; var publicRaw: Data { privateKey.publicKey.x963Representation } }
  enum Failure: Error { case format, auth, padding }

  static func keys(tag: String, create: Bool) -> Keys? {
    if let raw = Keychain.get("push-key::\(tag)"), let d = Data(b64url: raw),
       let authS = WorkhubShared.defaults.string(forKey: "keys.\(tag)"), let auth = Data(b64url: authS),
       let k = try? P256.KeyAgreement.PrivateKey(rawRepresentation: d) { return Keys(privateKey: k, auth: auth) }
    guard create else { return nil }
    let k = P256.KeyAgreement.PrivateKey()
    var auth = Data(count: 16)
    _ = auth.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, 16, $0.baseAddress!) }
    Keychain.set("push-key::\(tag)", k.rawRepresentation.b64url)
    WorkhubShared.defaults.set(auth.b64url, forKey: "keys.\(tag)")
    return Keys(privateKey: k, auth: auth)
  }

  private static func hkdf(salt: Data, ikm: Data, info: Data, length: Int) -> Data {
    let prk = Data(HMAC<SHA256>.authenticationCode(for: ikm, using: SymmetricKey(data: salt)))
    return Data(Data(HMAC<SHA256>.authenticationCode(for: info + Data([1]), using: SymmetricKey(data: prk))).prefix(length))
  }

  /// RFC 8291 aes128gcm, single record.
  static func decrypt(_ body: Data, _ keys: Keys) throws -> String {
    let b = [UInt8](body)
    guard b.count >= 16 + 4 + 1 + 65 + 17, b[20] == 65 else { throw Failure.format }
    let salt = Data(b[0..<16])
    let asPublic = Data(b[21..<86])
    let ct = Data(b[86...])
    let peer = try P256.KeyAgreement.PublicKey(x963Representation: asPublic)
    let shared = try keys.privateKey.sharedSecretFromKeyAgreement(with: peer)
    let ecdh = shared.withUnsafeBytes { Data($0) }
    let ikm = hkdf(salt: keys.auth, ikm: ecdh, info: Data("WebPush: info".utf8) + Data([0]) + keys.publicRaw + asPublic, length: 32)
    let cek = hkdf(salt: salt, ikm: ikm, info: Data("Content-Encoding: aes128gcm".utf8) + Data([0]), length: 16)
    let nonce = hkdf(salt: salt, ikm: ikm, info: Data("Content-Encoding: nonce".utf8) + Data([0]), length: 12)
    guard ct.count > 16 else { throw Failure.format }
    let box = try AES.GCM.SealedBox(nonce: AES.GCM.Nonce(data: nonce), ciphertext: ct.dropLast(16), tag: ct.suffix(16))
    guard let plain = try? AES.GCM.open(box, using: SymmetricKey(data: cek)) else { throw Failure.auth }
    var p = [UInt8](plain)
    while let last = p.last, last == 0 { p.removeLast() }
    guard p.last == 2 else { throw Failure.padding }
    p.removeLast()
    return String(decoding: p, as: UTF8.self)
  }
}

enum WorkhubRouting {
  /// Same rules as packages/core routing.routeForObject.
  static func route(app: String, type: String, id: String) -> [String: Any] {
    if app == "spreed" || app == "talk" {
      let token = String(id.split(separator: "/").first ?? "")
      if token.range(of: "^[A-Za-z0-9]{1,64}$", options: .regularExpression) != nil,
         ["chat", "room", "call", "reminder", "remote_talk_share"].contains(type) { return ["name": "room", "token": token] }
    }
    if app == "workhub", type == "card", let n = Int(id), n > 0 { return ["name": "task", "cardId": n] }
    return ["name": "inbox"]
  }
}

/// Authenticated OCS call that never follows redirects.
final class NextcloudHTTP: NSObject, URLSessionTaskDelegate {
  static let shared = NextcloudHTTP()
  private lazy var session = URLSession(configuration: .ephemeral, delegate: self, delegateQueue: nil)

  func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
    completionHandler(nil)
  }

  func call(_ a: PushAccount, _ method: String, _ path: String, json: [String: Any]? = nil, completion: @escaping (Int, Data?) -> Void) {
    guard path.hasPrefix("/"), !path.contains(".."), let pw = a.appPassword,
          let url = URL(string: a.serverBase + path + (path.contains("?") ? "&" : "?") + "format=json") else { return completion(0, nil) }
    var r = URLRequest(url: url, timeoutInterval: 15)
    r.httpMethod = method
    r.setValue("Basic " + Data("\(a.loginName):\(pw)".utf8).base64EncodedString(), forHTTPHeaderField: "Authorization")
    r.setValue("true", forHTTPHeaderField: "OCS-APIRequest")
    r.setValue("application/json", forHTTPHeaderField: "Accept")
    if let json { r.httpBody = try? JSONSerialization.data(withJSONObject: json); r.setValue("application/json", forHTTPHeaderField: "Content-Type") }
    session.dataTask(with: r) { data, resp, _ in completion((resp as? HTTPURLResponse)?.statusCode ?? 0, data) }.resume()
  }
}

extension Data {
  init?(b64url: String) {
    var s = b64url.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    while s.count % 4 != 0 { s += "=" }
    self.init(base64Encoded: s)
  }
  var b64url: String { base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "") }
}
