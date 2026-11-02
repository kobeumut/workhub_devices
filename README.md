# Workhub Devices

Talk merkezli mesajlaşma ve mevcut Nextcloud Workhub özellikleri için iOS, Android, Windows, macOS ve Linux istemcisi. Kullanıcı kendi Nextcloud sunucu adresini girer; giriş, Talk uygulamalarındaki gibi Nextcloud Login Flow v2 ile yapılır.

- [PLAN.md](PLAN.md): mimari, işler ve kabul ölçütleri; ilerleme tablosu en üstte.
- [docs/workhub-modules.md](docs/workhub-modules.md): Workhub modül/endpoint/ekran matrisi ve açık boşluklar.
- [docs/adr/0001-push-transport.md](docs/adr/0001-push-transport.md): push kararı. [docs/phase0-status.md](docs/phase0-status.md): sunucu doğrulaması.
- [docs/dev-server.md](docs/dev-server.md): yerel test sunucusu ve canlı testler. [docs/ios-setup.md](docs/ios-setup.md): Xcode adımları.

## Yapı

| Dizin | İçerik |
|---|---|
| `packages/core` | Platformdan bağımsız TypeScript: güvenli OCS istemcisi, Login Flow v2, hesaplar, Talk, bildirim yönlendirme, Web Push, Workhub API, tek `Backend` arayüzü ve masaüstü IPC doğrulaması |
| `packages/features` | Ortak React Native arayüzü: giriş, sohbetler, sohbet, Workhub (projeler/pano/görev/zaman/talepler/hedefler), bildirimler, hesap. Mobilde native, masaüstünde React Native Web ile çalışır |
| `apps/mobile` | iOS + Android (bare React Native 0.88). Native: Keystore/Keychain, FCM servisi, RFC 8291 çözme, bildirimden yanıt (Android `RemoteInput`, iOS `UNTextInputNotificationAction` + Notification Service Extension) |
| `apps/desktop` | Windows/macOS/Linux: Electron + React Native Web. Kimlik bilgisi yalnız main process'te; renderer dar, doğrulanan IPC kullanır |
| `services/push-relay` | Web Push → Firebase (FCM/APNs) relay'i; Firebase Cloud Function |
| `config/app-identity.json` | Uygulama kimliği (`com.next.workhub`) ve push relay adresi — tek kaynak |

## Geliştirme

Gereksinim: Node.js ≥ 22. Mobil için ayrıca: Android SDK + JDK 17; iOS için macOS + Xcode.

```bash
npm ci                       # core, features, relay, desktop (workspace)
npm run check                # typecheck + birim testleri (core 43, relay 8)

# Masaüstü
npm run start -w @workhub-devices/desktop          # derle + çalıştır
npm run dist -w @workhub-devices/desktop           # electron-builder paketleri (imza: bkz. Dağıtım)

# Mobil (ayrı lockfile)
cd apps/mobile && npm ci
npx react-native start                             # Metro
JAVA_HOME=<jdk17> npx react-native run-android     # emülatör/cihaz
cd android && ./gradlew :app:testDebugUnitTest     # Kotlin Web Push testleri
# iOS: docs/ios-setup.md
```

Geliştirme derlemeleri (`__DEV__`, masaüstünde `WORKHUB_ALLOW_HTTP=1`) yerel test için `http://` sunuculara izin verir. Üretim derlemeleri yalnız HTTPS kabul eder.

### Canlı testler (gerçek Nextcloud'a karşı)

- `npm run smoke:live -w @workhub-devices/core`: API uçtan uca testi (14 adım).
- `npm run smoke:tasks -w @workhub-devices/core`: görev düzenleme / alt iş / bağımlılık canlı testi (aynı ortam değişkenleri; `WH_A_REVOKE_PASS` gerekmez).
- `npm run smoke:projects -w @workhub-devices/core`: proje oluşturma/yeniden adlandırma, sütun, üye ekleme, kişi/grup arama ve hedef paylaşımları canlı testi (aynı ortam değişkenleri; isteğe bağlı `WH_GROUP`, varsayılan `staff`).
- `npm run smoke:time -w @workhub-devices/core`: zaman kaydı CRUD, dönem gönder/geri çek, yönetici incelemesi (onay/değişiklik/yeniden açma), takım raporu ve CSV canlı testi. `WH_A_USER`'ın Nextcloud yöneticisi `WH_B_USER` olmalı; `WH_C_USER` kimsenin yöneticisi olmamalı.
- `services/push-relay/test/e2e.live.ts`: Nextcloud → relay → çözme zinciri.
- `npm run smoke:requests -w @workhub-devices/core`: talep onay/red, görevsiz çözme, göreve dönüştürme, geçmiş ve rapor canlı testi. `WH_C_USER`'ın yöneticisi `WH_A_USER`, `WH_A_USER`'ın yöneticisi `WH_B_USER` olmalı. Her koşu 3 talep + 1 proje oluşturur (silme API'si yok).
- `apps/desktop/scripts/smoke.mjs`: başsız masaüstü UI testi. Gerçek Login Flow v2 ile giriş, mesaj gönderme, proje panosu, görev oluşturma ve yorum, zamanlayıcı, proje yönetimi (oluştur, yeniden adlandır, sütun, üye), hedef paylaşımı, talepler (alıcı onay/red; `WH_B_*` verilirse yönetici olarak göreve dönüştürme, çözme ve rapor), bildirimler ve hesap ekranlarını tıklayarak dolaşır ve ekran görüntüsü alır. Paylaşım adımı için geçici bir hedef oluşturur ve sonunda siler (`WH_SMOKE_MEMBER`, `WH_SMOKE_GROUP` isteğe bağlı).

Ayrıntılar `docs/dev-server.md`'de.

## Masaüstü bildirim davranışı

- Pencere kapatılınca uygulama **tepside çalışmaya devam eder** ve bildirimler gelir (60 sn'de bir kontrol). Tepsi menüsündeki "Çıkış" ile tamamen kapanır; kapalıyken bildirim **gelmez**.
- macOS: bildirimden doğrudan yanıt (inline reply) desteklenir.
- Windows/Linux: Electron'da bildirim içi yazma alanı yok. "Yanıtla"/tıklama uygulamayı ilgili sohbette açar (odaklı yazma alanı).
- Kilit ekranı/önizleme varsayılan olarak gizlidir. Sunucu başka bir istemcinin göstereceğine karar verdiyse (`shouldNotify=false`) ve açık olan sohbet için uyarı gösterilmez.
- Linux'ta kimlik bilgileri libsecret/KWallet ile saklanır. İkisi de yoksa uygulama düz metne düşmez, giriş reddedilir.

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
4. Dosyaları koyun: `google-services.json` → `apps/mobile/android/app/`, `GoogleService-Info.plist` → `apps/mobile/ios/Workhub/` (Xcode'da hedefe ekleyin). İkisi de `.gitignore`'da; CI'da secret olarak saklanır. Dosya varken Android derlemesi Google Services eklentisini otomatik uygular; yokken push kapalı derlenir.

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
- Relay adresini `config/app-identity.json` → `push.relayBase` alanına yazın: `https://europe-west1-<proje-id>.cloudfunctions.net/webpush`. Alan boşken uygulamalar çalışır ama push kaydı yapılmaz.

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

Workhub deposunda değişiklik yapılmadı (sıfır diff). Markalı uygulamanın arka plan bildirimleri için kendi APNs/FCM yetkileri, uygun push altyapısı ve Talk + Workhub birlikte teslimatının gerçek sunucuda doğrulanması gerekir. Mevcut Talk uygulamasını kopyalamak veya yalnızca push URL'sini değiştirmek yeterli değildir. Upstream Talk/Workhub kodu kopyalanmadı; yalnız belgelenmiş protokoller uygulanır.

### Bilinen güvenlik sınırı (mobil)

React Native'in `fetch`'i yönlendirmeleri kapatamaz. İstemci, sunucu dışına yönlenen yanıtı reddeder. Android (OkHttp) farklı host'a yönlendirmede `Authorization` başlığını zaten düşürür; iOS'ta bu davranış cihazda doğrulanmalıdır. Native yollar (push, hızlı yanıt) yönlendirme izlemez. Masaüstünde yönlendirmeler hiç izlenmez.
