# Workhub Devices

Talk merkezli mesajlaşma ve mevcut Nextcloud Workhub özellikleri için iOS, Android, Windows, macOS ve Linux istemcisi.

**Durum: uygulama başladı (GENE-48). Henüz kullanıcıya kurulabilir uygulama yok.** İlk dilim, platformdan bağımsız `packages/core` TypeScript katmanı ve `services/push-relay` (Web Push → Firebase relay) bileşenidir. Mobil (bare React Native) ve masaüstü (Electron + React Native Web) kabukları sonraki PR'larda gelecek. Push taşıması seçildi (Web Push → Firebase); gerçek APNs/FCM bilgileri ve cihaz testi bekleniyor: [docs/phase0-status.md](docs/phase0-status.md).

- [PLAN.md](PLAN.md): mimari, ayrıntılı işler, bağımlılıklar ve kabul/test ölçütleri (ilerleme bölümüyle).
- [RESEARCH.md](RESEARCH.md): incelenen kaynakların SHA'ları, API sözleşmeleri ve kritik bildirim bulguları.

## Geliştirme

Gereksinim: Node.js ≥ 22, npm (workspace + `package-lock.json`).

```bash
npm ci            # temiz kurulum
npm run typecheck # TypeScript strict
npm test          # node:test ile core sözleşme/regression testleri
npm run check     # ikisi birden (CI bunu çalıştırır)
```

## `packages/core` içeriği

| Modül | Sorumluluk |
|---|---|
| `serverUrl` | Sunucu adresi normalizasyonu: HTTPS zorunlu; userinfo/query/fragment reddedilir; alt dizin korunur; origin+path sınır kontrolü |
| `ocs` | OCS istemcisi: app password Basic auth (UTF-8), `OCS-APIRequest`, redirect takip edilmez (credential sızıntısı yok), 401/403/404/409/429/5xx/timeout normalizasyonu, Workhub hata kodları, güvenli path |
| `loginFlow` | Nextcloud Login Flow v2: login/poll URL'leri sunucu içinde olmalı, sınırlı ve iptal edilebilir polling, farklı origin sonucu reddedilir; logout'ta app password revoke |
| `accounts` | Hesap kimliği (`login|server`), hesap kapsamlı anahtarlar, `SecretStore` arayüzü (Keychain/Keystore/OS store; düz metin fallback yok), offline-güvenli logout |
| `capabilities` | Core/Talk/Notifications/Workhub capability ayrıştırma, uyumluluk kontrolü, Workhub kullanıcı modül gate'i (fail-closed) |
| `talk` | Oda listesi + delta, sohbet geçmişi/long-poll (`setReadMarker=0`), mesaj gönderimi (`referenceId`), optimistic timeline merge/duplicate önleme, HTML'siz rich-object render |
| `routing` | Notifications inbox normalizasyonu, `shouldNotify`, push payload yorumlama (delete kontrolleri), app/object dispatcher, pretty + `/index.php` + alt dizin deep link parser, kilit ekranı gizli önizleme |
| `webpush` | Web Push v2 aboneliği (anahtar üretimi, kayıt/aktivasyon/silme), RFC 8291 decrypt (native iOS/Android portları için referans), relay mesajı çözme |
| `workhub` | Workhub OCS API v1 istemcisi (proje/board/task/comment), bildirimden task açarken güncel ACL ile yeniden getirme |

`npm test` kaydedilmiş `fetch` yanıtlarıyla çalışır. Gerçek sunucuya karşı uçtan uca kontrol için `npm run smoke:live -w @workhub-devices/core` var; yerel test sunucusu ve ortam değişkenleri: [docs/dev-server.md](docs/dev-server.md). Bunlar cihaz/push doğrulaması değildir.

## Push bildirimleri: Firebase kurulumu (APNs + FCM sonradan eklenir)

Marka/uygulama kimliği: **`com.next.workhub`**. Tek kaynak `config/app-identity.json`. Mimari kararı: [docs/adr/0001-push-transport.md](docs/adr/0001-push-transport.md).

**Nasıl çalışır:** Nextcloud, Talk ve Workhub bildirimlerini tek bir Web Push aboneliğine (`appTypes=talk,workhub`) şifreli gönderir. Nextcloud yalnız Web Push protokolü konuşur; FCM ve APNs bunu native uygulamalar için kabul etmez. Bu yüzden Firebase içinde çok küçük bir Cloud Function (`services/push-relay`) çalışır. Bu fonksiyon:

- isteğin uygulamanın bağlı olduğu Nextcloud tarafından imzalandığını doğrular;
- şifreli içeriği açmadan FCM'e verir;
- hiçbir şey saklamaz.

FCM, Android'e doğrudan, iOS'a ise APNs üzerinden ulaştırır. Ayrı bir sunucu, veritabanı veya proxy işletmek gerekmez; her şey Firebase projesindedir.

### 1. Firebase projesi

1. [Firebase Console](https://console.firebase.google.com) → yeni proje (ör. `workhub-push`). Cloud Functions için faturalandırmayı **Blaze** planına geçirin; kullandıkça ödenir ve bildirim hacminde maliyet düşüktür.
2. **Android uygulaması ekle** → paket adı `com.next.workhub` → `google-services.json` indirin.
3. **iOS uygulaması ekle** → bundle ID `com.next.workhub` → `GoogleService-Info.plist` indirin.
4. Bu iki dosya istemci yapılandırmasıdır; gizli anahtar değildir ama repoya koymayın. CI'da secret olarak saklanır ve build sırasında `apps/mobile/android/app/` ile `apps/mobile/ios/Workhub/` altına yazılır.

### 2. APNs (iOS)

1. Apple Developer → Certificates, IDs & Profiles → **Keys** → yeni anahtar, **Apple Push Notifications service (APNs)** işaretli → `.p8` dosyasını indirin. Key ID ve Team ID'yi not edin. `.p8` yalnız bir kez indirilebilir; parola kasasında saklayın.
2. Identifiers → `com.next.workhub` App ID'de **Push Notifications** ve **App Groups** (`group.com.next.workhub`) açık olsun. NSE için `com.next.workhub.NotificationService` App ID'si de aynı App Group'la oluşturulur.
3. Firebase Console → Proje ayarları → **Cloud Messaging** → Apple app configuration → **APNs Authentication Key**: `.p8`, Key ID, Team ID yükleyin. APNs sertifikası yerine anahtar kullanılır; süresi dolmaz ve hem sandbox hem production için geçerlidir.
4. Önerilen: Apple'dan `com.apple.developer.usernotifications.filtering` yetkisini isteyin. Bu yetki silme/kontrol push'larının görünmeden işlenmesini sağlar; yokken bilinen sınırlama ADR'de yazılı.

### 3. FCM (Android)

FCM, Firebase projesine Android uygulaması eklendiğinde hazırdır; ayrı bir anahtar gerekmez. Relay, Firebase'in kendi servis hesabıyla gönderir. Uygulama `com.next.workhub` paket adıyla ve `google-services.json` ile derlenmelidir.

### 4. Relay fonksiyonunu dağıtma

```bash
npm i -g firebase-tools && firebase login
cd services/push-relay
cp .firebaserc.example .firebaserc            # proje ID'sini yazın (git'e girmez)
echo "RELAY_ORIGIN=https://europe-west1-<proje-id>.cloudfunctions.net" > .env.<proje-id>
firebase deploy --only functions:workhub-push-relay
```

- Fonksiyon URL'si `https://europe-west1-<proje-id>.cloudfunctions.net/webpush`. Uygulamaların kaydettiği endpoint `…/webpush/wp/<FCM token>?k=<sunucu VAPID anahtarı>` olur.
- `RELAY_ORIGIN`, fonksiyon URL'sinin **origin** kısmıdır (path olmadan). Özel alan adı (Firebase Hosting rewrite) kullanılırsa o origin yazılır.
- Uygulamanın derleme ayarına relay tabanı girilir: `WORKHUB_PUSH_RELAY_BASE=https://europe-west1-<proje-id>.cloudfunctions.net/webpush`.

### 5. Nextcloud sunucusu

```bash
occ config:app:set notifications webpush_enabled --value=true --type=boolean
```

Yalnız bu ayar gerekir; Workhub, Talk ve Notifications kodunda değişiklik yok. Uygulama, girişten sonra `GET /ocs/v2.php/apps/notifications/api/v2/webpush/vapid` ile sunucu anahtarını alır, aboneliği `appTypes=talk,workhub` ile kaydeder ve aktivasyon push'unu onaylar. Logout'ta aboneliği siler.

### Doğrulama

- `npm test` relay ve RFC 8291 decrypt testlerini çalıştırır.
- `services/push-relay/test/e2e.live.ts` gerçek Nextcloud → relay → (taklit FCM) → cihaz tarafı decrypt zincirini test eder; çalıştırma adımları `docs/dev-server.md`'de.
- Firebase bilgileri eklendikten sonra gerçek FCM/APNs ile fiziksel iPhone ve Android cihazda kabul testi yapılır. O zamana kadar push "cihazda doğrulanmadı" sayılır.

## Sınırlar

Workhub deposunda değişiklik öngörülmez. Markalı uygulamanın arka plan bildirimleri için kendi APNs/FCM yetkileri, uygun push altyapısı ve Talk + Workhub birlikte teslimatının gerçek sunucuda doğrulanması gerekir. Mevcut Talk uygulamasını kopyalamak veya yalnızca push URL'sini değiştirmek yeterli değildir. Upstream Talk/Workhub kodu kopyalanmadı; yalnız belgelenmiş protokoller uygulanır.
