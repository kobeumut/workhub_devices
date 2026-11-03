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
npm run check                # typecheck + birim testleri (core, relay, desktop paket kimliği)

# Masaüstü
npm run start -w @workhub-devices/desktop          # derle + çalıştır
npm run dist -w @workhub-devices/desktop           # electron-builder paketleri (imza: bkz. Dağıtım)
npm run dist:linux -w @workhub-devices/desktop     # Linux: release/workhub-<sürüm>-x86_64.AppImage + workhub-<sürüm>-amd64.deb

# Mobil (ayrı lockfile)
cd apps/mobile && npm ci
npx react-native start                             # Metro
JAVA_HOME=<jdk17> npx react-native run-android     # emülatör/cihaz
cd android && ./gradlew :app:testDebugUnitTest     # Kotlin Web Push testleri
# iOS: docs/ios-setup.md
```

Geliştirme derlemeleri (`__DEV__`, masaüstünde `WORKHUB_ALLOW_HTTP=1`) yerel test için `http://` sunuculara izin verir. Üretim derlemeleri yalnız HTTPS kabul eder.

**Sürüm ve kimlik tek kaynaktan:** `config/app-identity.json` (`version`, `displayName`, `android.applicationId`/`versionCode`, `desktop.appId`/`executableName`). Android Gradle (`applicationId`, `versionName`, `versionCode`, uygulama adı), electron-builder (`apps/desktop/electron-builder.config.cjs`), uygulama içi "Sürüm" ve user-agent buradan okur; sürüm yalnız orada artırılır (`apps/desktop/test/builder-config.test.mjs` kopya kalmadığını denetler).

**Linux paketleri:** AppImage (`chmod +x` → çalıştır; FUSE 2 gerekir, yoksa `--appimage-extract-and-run`) ve deb (`sudo apt install ./workhub-<sürüm>-amd64.deb` → `/opt/Workhub`, menüde "Workhub"). deb, kimlik deposu için `libsecret-1-0`'a bağlıdır ve `gnome-keyring | kwalletmanager` önerir; secret servisi yoksa giriş reddedilir. Paket yalnız esbuild/Vite çıktısını içerir (`node_modules` yok). Uygulama ikonu henüz yok (Electron varsayılanı) — sahibinden ikon bekleniyor.

**Android klavye (edge-to-edge):** Android 15/16'da `adjustResize` pencereyi küçültmez. Mobil kabuk tüm uygulamayı klavye yüksekliği kadar yukarı iter (`apps/mobile/src/keyboard.ts`); `KeyboardAvoidingView` yalnız iOS'ta kullanılır (`keyboardAvoidBehavior`). Yeni ekranlarda Android için ayrıca klavye kodu gerekmez.

**LogBox (yalnız debug):** uyarı balonları sekme çubuğunu/yazma alanını örttüğü için kapalıdır (`apps/mobile/src/devLogs.ts`). Uyarılar Metro terminalinde ve `adb logcat -s ReactNativeJS` içinde görünmeye devam eder; ölümcül JS hataları yine tam ekran açılır. Balonları görmek için `WORKHUB_LOGBOX_TOASTS = true`.

### Tasarım (web Workhub ile aynı görünüm)

- **Tema:** web Workhub'ın "Obsidian Orbit" tasarım sisteminin açık varyantı (`packages/features/src/theme.ts`): slate metin, beyaz kartlar, Nextcloud mavisi vurgu, 6/10/14 px köşe yarıçapları. Metin renkleri ≥ 4.5:1 kontrast; renk tek başına anlam taşımaz (öncelik rozetinde ▲▲/▲/■/▼ + metin).
- **İkonlar:** [Lucide](https://lucide.dev) (ISC) — tek bir çizgi ikon ailesi, `packages/features/src/icons.tsx` (`<Icon name="kanban" />`). Mobil `lucide-react-native` + `react-native-svg`, masaüstü renderer `lucide-react` (Vite alias, DOM SVG). İkonlar dekoratiftir; erişilebilir ad her zaman kontrolün kendisindedir. iOS'ta yeni native modül için `pod install` yeniden çalıştırılmalı.
- **İşler (geniş ekran, ≥ 900 px):** web'deki gibi sol gezinme — modüller ikonlarıyla ve projeler renkli alt öğeler olarak (açık görev sayısıyla); sağda proje çalışma alanı, görev ayrıntısı sağ çekmece olarak açılır. Telefonda modüller ikonlu sekmeler.
- **Proje çalışma alanı:** renkli başlık + "Proje ayarları" + "Görev ekle"; görünümler **Kanban** (varsayılan), **Pano** (erişilebilir bölümlü liste), **Gantt**, **Etkinlik**, **İş yükü** (bu projeye filtreli). Kanban ve Pano için arama + filtreler (yalnız benim, öncelik, tamamlananlar).
- **Kanban:** yatay kaydırılan sütunlar (telefonda sütun ekranın ~%84'ü, sonraki sütun görünür ve kaydırma sütuna oturur), web kartı (#id, öncelik, başlık, etiketler, alt iş ilerlemesi, tamamlandı onay kutusu, bitiş rozeti — gecikmiş/bugün vurgulu, atanan avatarları). Sütun başında "+" ve altta "Görev ekle" ile hızlı ekleme. Kart taşıma: her platformda kart menüsü (sola/sağa, yukarı/aşağı, belirli listeye; uzun basma da açar) — dokunmatikte ve ekran okuyucuda tek yol budur; masaüstünde ayrıca fareyle sürükle-bırak. Sıra hesabı web ile aynı (`packages/core/src/board.ts`; filtreyle gizli kartlar hesaba katılır).
- **Çevrimdışı tasarım önizlemesi:** `npm run preview:shots -w @workhub-devices/desktop` gerçek arayüzü sahte (fixture) bir backend ile açar, Kanban akışını sürer (filtre, kart menüsüyle taşıma, hızlı ekleme, görev çekmecesi, Pano) ve masaüstü (1440×900) + telefon (412×900) ekran görüntülerini `apps/desktop/preview-out/` altına yazar. Uygulama paketine girmez.

### Canlı testler (gerçek Nextcloud'a karşı)

- `npm run smoke:live -w @workhub-devices/core`: API uçtan uca testi (14 adım).
- `npm run smoke:tasks -w @workhub-devices/core`: görev düzenleme / alt iş / bağımlılık canlı testi (aynı ortam değişkenleri; `WH_A_REVOKE_PASS` gerekmez).
- `npm run smoke:projects -w @workhub-devices/core`: proje oluşturma/yeniden adlandırma, sütun, üye ekleme, kişi/grup arama ve hedef paylaşımları canlı testi (aynı ortam değişkenleri; isteğe bağlı `WH_GROUP`, varsayılan `staff`).
- `npm run smoke:time -w @workhub-devices/core`: zaman kaydı CRUD, dönem gönder/geri çek, yönetici incelemesi (onay/değişiklik/yeniden açma), takım raporu ve CSV canlı testi. `WH_A_USER`'ın Nextcloud yöneticisi `WH_B_USER` olmalı; `WH_C_USER` kimsenin yöneticisi olmamalı.
- `services/push-relay/test/e2e.live.ts`: Nextcloud → relay → çözme zinciri.
- `npm run smoke:requests -w @workhub-devices/core`: talep onay/red, görevsiz çözme, göreve dönüştürme, geçmiş ve rapor canlı testi. `WH_C_USER`'ın yöneticisi `WH_A_USER`, `WH_A_USER`'ın yöneticisi `WH_B_USER` olmalı. Her koşu 3 talep + 1 proje oluşturur (silme API'si yok).
- `npm run smoke:goals -w @workhub-devices/core`: hedef oluşturma/düzenleme, hedef değer CRUD, check-in (idempotent) ve geçmiş, görev ↔ hedef bağlama, rol gate'leri, arşiv, sahiplik devri ve silme canlı testi (`WH_A_*` sahip, `WH_B_*` paylaşım + yeni sahip, `WH_C_*` dışarıdan). Her koşu 1 proje + 1 görev oluşturur (proje silme API'si yok); hedef silinir.
- `npm run smoke:views -w @workhub-devices/core`: Gantt yükü (tarih, bağımlılık türü/gecikme, tarih çakışması), etkinlik akışı (tür filtreleri, imleçle sayfalama, tekrar yok, geçersiz imleç) ve iş yükü matrisi (tahminin iş günlerine dağılımı, pano kısıtı, aralık sınırları) canlı testi; üye olmayan 404, modül kapalı 403 (`WH_A_*` sahip, `WH_B_*` üye değil, `WH_C_*` Projeler modülü kapalı). Her koşu 1 proje + 3 görev oluşturur.
- `npm run smoke:dashboards -w @workhub-devices/core`: dashboard/widget CRUD (sürüm kilidi, şablon, Idempotency-Key), şemaya göre ayar ve filtre hataları, KPI/dağılım sonuçları, drilldown (grup anahtarı, imleçle sayfalama), CSV, yenileme sınırı (429) ve erişim (yabancı 404, `view` paylaşımı salt okunur ve kendi erişimiyle kısıtlı) canlı testi (`WH_A_*` sahip, `WH_B_*` proje üyesi değil, `WH_C_*` Projeler modülü kapalı). Her koşu 1 proje + 55 kart oluşturur; dashboard'lar silinir.
- `npm run smoke:workflows -w @workhub-devices/core`: iş akışı şablon CRUD (sürüm kilidi, Idempotency-Key, grafik doğrulaması: döngü, seçilen adıma otomatik bağlantı, erişilemeyen liste, üye olmayan sorumlu), paylaşım (`view`/`edit`), çalıştırma başlatma (mevcut kartı bağlama, bağlı/tamamlanmış kart 409), kart tamamlanınca devir + otomatik dal, başarısız otomatik adımı yeniden deneme, atlama, iptal, geçmiş ve silme (çalışan çalıştırma iptal olur) canlı testi (`WH_A_*` sahip, `WH_B_*` ikinci kullanıcı, `WH_C_*` Projeler modülü kapalı). Her koşu 2 proje + birkaç kart oluşturur; şablon silinir.
- `npm run smoke:talk -w @workhub-devices/core`: Talk genişletmeleri canlı testi — grup/herkese açık sohbet oluşturma, yeniden adlandırma + açıklama, davet autocomplete, katılımcı ekle/çıkar, moderatör yap/al, yanıt (alıntı), mention önerisi, tepki ekle/kaldır/listele, düzenleme ve silme (B'nin feed'inde doğrulanır, yetkisiz 403), mesaj arama, ayrılma ve silme (`WH_A_*` sahip, `WH_B_*` karşı taraf, `WH_C_*` çıkarılan katılımcı). Oluşturulan sohbetler silinir.
- `npm run smoke:files -w @workhub-devices/core`: Talk dosyaları canlı testi (GENE-58) — tek PUT ve chunked v2 yükleme, odaya paylaşım + altyazı, ad çakışması, iptal, ses notu (WAV → `voice-message`), B'nin indirme/oynatması (baytlar birebir), salt okunur oda / katılımcı olmayan / güvensiz açma gate'leri ve kota (isteğe bağlı `WH_ADMIN_USER`/`WH_ADMIN_PASS`, yalnız dev: C'ye geçici 1 MB kota). Oda ve dosyalar silinir.
- `apps/desktop/scripts/smoke.mjs`: başsız masaüstü UI testi. Gerçek Login Flow v2 ile giriş, mesaj gönderme, proje panosu, görev oluşturma ve yorum, zamanlayıcı, proje yönetimi (oluştur, yeniden adlandır, sütun, üye), Talk (yeni sohbet, açıklama, katılımcı + moderatör, mention, yanıt, düzenleme, tepki, arama, silme; `WH_B_*` ile B'nin değişikliklerinin canlı yansıması), hedef paylaşımı, hedef değer + check-in + arşiv, görevi hedefe bağlama/kaldırma, sahiplik devri, talepler (alıcı onay/red; `WH_B_*` verilirse yönetici olarak göreve dönüştürme, çözme ve rapor), bildirimler ve hesap ekranlarını tıklayarak dolaşır ve ekran görüntüsü alır. Paylaşım adımı için geçici bir hedef oluşturur ve sonunda siler (`WH_SMOKE_MEMBER`, `WH_SMOKE_GROUP` isteğe bağlı). `WH_SMOKE_ROOM` (ör. `Bob`) açılacak sohbetin adıdır. `WH_SMOKE_BIN` verilirse aynı test paketlenmiş uygulamaya karşı koşar (ör. `release/workhub-0.1.0-x86_64.AppImage` veya deb içindeki `/opt/Workhub/workhub`).

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
