# iOS kurulumu (macOS + Xcode gerekir)

Kod hazır ama bu ortamda **derlenmedi ve doğrulanmadı**: Linux sunucuda iOS derlenemiyor. Aşağıdaki adımlar bir Mac'te bir kez yapılır.

## 1. Bağımlılıklar

```bash
cd apps/mobile
npm ci
cd ios && bundle install && bundle exec pod install
open Workhub.xcworkspace
```

## 2. Uygulama hedefi (Workhub)

1. **Signing & Capabilities:** Team seçin, bundle ID `com.next.workhub`. Şunları ekleyin:
   - **Push Notifications**
   - **App Groups** → `group.com.next.workhub`
   - **Keychain Sharing** → `com.next.workhub.shared`

   `Workhub/Workhub.entitlements` dosyası bu değerlerle hazır; *Code Signing Entitlements* ayarına bu dosyayı gösterin.
2. Projeye ekleyin (Add Files → Workhub target): `Workhub/Shared/WorkhubShared.swift`, `Workhub/WorkhubNative.swift`, `Workhub/WorkhubNative.m`. Xcode bridging header sorarsa kabul edin.

## 3. Notification Service Extension hedefi

1. File → New → Target → **Notification Service Extension**, ad: `NotificationService`. Bundle ID: `com.next.workhub.NotificationService`.
2. Xcode'un oluşturduğu `NotificationService.swift` ve `Info.plist` dosyalarını silin. Repodaki `NotificationService/NotificationService.swift` ve `NotificationService/Info.plist` dosyalarını hedefe ekleyin.
3. `Workhub/Shared/WorkhubShared.swift` dosyasını **bu hedefe de** ekleyin (Target Membership: Workhub + NotificationService).
4. Capabilities: **App Groups** (`group.com.next.workhub`) ve **Keychain Sharing** (`com.next.workhub.shared`). Entitlements dosyası: `NotificationService/NotificationService.entitlements`.
5. Deployment target uygulamayla aynı olmalı.

## 4. Firebase / APNs (sonra eklenecek)

- `GoogleService-Info.plist` dosyasını `Workhub/` altına ve uygulama hedefine ekleyin. Dosya yoksa uygulama çalışır ama push kapalı kalır.
- APNs anahtarı Firebase'e yüklenir (README → "Push bildirimleri").
- `config/app-identity.json` → `push.relayBase` alanına relay URL'si yazılır.
- Önerilen: `com.apple.developer.usernotifications.filtering` yetkisini Apple'dan isteyin. Bu yetkiyle silme/aktivasyon push'ları görünmeden işlenir; yetki yokken kısa bir genel uyarı görünebilir.

## 5. Doğrulama (fiziksel iPhone)

1. Giriş yapın. Hesap ekranında "Web Push hazır" görünmeli.
2. Uygulamayı tamamen kapatın.
3. Başka bir kullanıcıdan Talk mesajı gönderin → bildirim gelir; "Yanıtla" ile cevap verin → mesaj karşı tarafta **bir kez** görünür.
4. Normal Workhub ataması yapın → bildirim gelir ve doğru görevi açar.
5. Atamayı kaldırın → bildirim merkezden kalkar.
