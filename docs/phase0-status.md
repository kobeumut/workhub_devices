# Faz 0 — sürüm ve birleşik push karar kapısı: durum

Tarih: 2026-11-02 · Görev: GENE-48 · Durum: **Sunucu + taşıma kararı tamam (ADR 0001); gerçek FCM/APNs ve cihaz testi bekleniyor**

Faz 0 testleri gerçek sunucu ve cihaz olmadan yapılamaz. Bu çalıştırmada aşağıdakiler **yoktu**, bu nedenle hiçbir Faz 0 maddesi "geçti" sayılmaz:

| Gerekli girdi | Durum | Neden gerekli |
|---|---|---|
| Test Nextcloud + sürümler | **çözüldü**: yerel Docker geliştirme sunucusu (`docs/dev-server.md`) | Aşağıdaki matris |
| 2 normal + 1 kısıtlı test kullanıcısı | **çözüldü**: `alice`, `bob`, `carol` (kısıtlı) | Smoke testleri |
| Marka bundle/app ID | **çözüldü**: `com.next.workhub` (`config/app-identity.json`) | APNs/FCM, NSE App Group |
| Relay barındırma | **çözüldü**: Firebase Cloud Function (`services/push-relay`), ayrı sunucu yok | ADR 0001 |
| Firebase projesi + APNs `.p8` anahtarı | **sonra eklenecek** (README "Push bildirimleri: Firebase kurulumu") | Gerçek teslimat |
| Fiziksel iOS ve Android cihaz | bu makinede bağlı değil (`adb devices` boş; macOS/Xcode yok) | Faz 0 çıkış ölçütü yalnız fiziksel cihazla kabul edilir |
| Windows ve macOS test makineleri | yok (yalnız Linux host) | Desktop bildirim/reply ölçümü, imzalı build |

## Sunucu doğrulaması (2026-11-02, `npm run smoke:live`, 14/14 PASS)

| Bileşen | Sürüm | Not |
|---|---|---|
| Nextcloud | 35.0.2 | Workhub 0.5.0 aralığında (34–35) |
| Talk (spreed) | 25.0.6 | Workhub Talk adapter `>=20,<26` içinde; urgent mesajları açık (`workhub:doctor`) |
| Notifications | 8.0.1 | push capability: `devices, object-data, delete`; Web Push API var, **varsayılan kapalı** |
| Workhub | 0.5.0 (`a359a4c`), API v1, backend `native` | Deck 1.19.1 kurulu ama görev kaydı native |

Smoke adımları ve sonuçları:

- Capabilities + uyumluluk kontrolü (`checkCompatibility` boş).
- Login Flow v2: başlatma, login/poll URL'lerinin sunucu içinde olması, onaysız poll'un 404→`expired`. Tarayıcı onayı otomatik yapılmadı; smoke için app password'lar `occ user:add-app-password` ile alındı (aynı token türü).
- Workhub per-user gate: `alice` projects=true, `carol` projects=false.
- Talk: 1:1 oda; `referenceId` ile gönderim; B tarafında geçmişte tek kopya; pasif fetch okunmamış sayısını düşürmüyor; long-poll yeni mesajı teslim ediyor; B'ye `spreed`/`chat` bildirimi doğru odaya yönleniyor.
- **Cookie/requesttoken olmadan, yalnız app password + `OCS-APIRequest`** ile Workhub yazma: proje oluştur (Idempotency-Key; aynı gövdeyle tekrar → aynı proje; farklı gövdeyle aynı anahtar → `409 IDEMPOTENCY_KEY_REUSED`), üye ekle, B'ye atanmış görev oluştur, PATCH, geri oku. OCS auth/CSRF sorunu yok.
- Normal atama B'de `workhub`/`card` bildirimi üretiyor (Talk mesajı değil), link `/apps/workhub/projects/task/{id}` → task route; görev güncel ACL ile açılıyor.
- `carol` görevi açamıyor (`PROJECTS_DISABLED` → feature_off). Unassign B'nin bildirimini siliyor. Silinen görev B için `gone`.
- Logout app password'u revoke ediyor; sonraki istek 401.

Bulgu: task DTO `url` alanı bildirim linkinden farklı biçimde: `/apps/workhub/projects/{boardId}/board?card={cardId}`. Parser her ikisini destekliyor (regression testi eklendi).

### Push için hedef sunucu sonucu

- Notifications 8.0.1'de native push v2 yönlendirmesi incelenen snapshot ile aynı: Talk ailesi yalnız Talk türü cihazlara, diğerleri (Workhub) yalnız diğer cihazlara gider (`lib/Push.php:229-236`). Tek native kayıt iki aileyi güvenle kapsamaz.
- Web Push v2 aynı sürümde mevcut ve `appTypes` filtresi `talk`/`all` destekliyor (`Push.php:207-215`). Ancak admin ayarı `webpush_enabled` varsayılan kapalı: `occ config:app:set notifications webpush_enabled --value=true --type=boolean`. Bu ayarı henüz açmadım; açılması altyapı kararıdır.
- Dolayısıyla A yolu (Web Push `appTypes=talk,workhub`) bu sunucuda **uygulanabilir**. Kalan iş istemci tarafında: marka relay'i (Web Push endpoint → APNs/FCM), iOS NSE ve Android worker'da RFC8291 decrypt.

## Web Push → relay uçtan uca (2026-11-02)

`webpush_enabled` açıldı. Gerçek Nextcloud 35.0.2 / Notifications 8.0.1 → yerel relay (`services/push-relay`, aynı kod Firebase'de çalışacak) → taklit FCM → `core` ile cihaz tarafı RFC 8291 decrypt:

- `appTypes=talk,workhub` kaydı → aktivasyon push'u çözüldü → aktive edildi.
- Talk mesajı **ve** normal Workhub ataması **aynı aboneliğe** geldi; route doğru (`room` / `task`).
- Unassign → `nid` topic'li delete push'u geldi.
- 6 push'un hepsine relay 201 döndü. Talk şifreli gövdesi base64url 3896 B; FCM/APNs 4 KB sınırına sığıyor.

Bulgu: Nextcloud'un web-push kütüphanesi VAPID `aud` değerini port olmadan üretiyor (`scheme://host`). Relay buna göre düzeltildi ve test eklendi; production'da 443 portunda fark etmez.

## Kararı bekleyen sorular (ürün sahibi) — 2026-11-02 itibarıyla yanıtlandı

1. Test sunucusu: URL ve sürümler. Workhub 0.5.0 NC34–35 destekliyor; sunucu NC36 ise Workhub uyumu ayrı karar.
2. Push transport tercihi. Kod incelemesine göre iki aday var:
   - **A — Web Push `appTypes=talk,workhub`** (hedef Notifications sürümü destekliyorsa). Tek abonelik iki aileyi kapsar; ama markaya ait Web-Push→APNs/FCM relay ve native RFC8291 decrypt (iOS NSE / Android worker) gerekir.
   - **B — Native push v2 + marka proxy**. Sunucu UA sınıflandırması nedeniyle tek kayıt Talk + Workhub'ı birlikte garanti etmez; Talk/Notifications tarafında değişiklik/onay gerekebilir.
   **Karar: A**, Firebase içinde relay ile (ADR 0001).
3. Relay barındırma: **Firebase Cloud Functions**; durumsuz, hiçbir şey saklamaz.

## Bu arada yapılanlar (push kabulü yerine geçmez)

- `packages/core`: güvenli OCS istemcisi, Login Flow v2, hesap izolasyonu, capability gate, Talk sohbet/oda mantığı, bildirim dispatcher'ı, deep link parser, Workhub task açılışı. Mock `fetch` ile 35 sözleşme/regression testi. Bunlar gerçek sunucuya karşı **doğrulanmadı**.
- Push payload yorumlama (`interpretPush`) native-v2/Web Push decrypt **sonrası** JSON içindir; kripto ve taşıma kodu Faz 0 kararından sonra yazılacak.

## Faz 0 smoke testi geldiğinde çalıştırılacaklar

1. `GET /ocs/v2.php/cloud/capabilities` (redakte edilip bu dosyaya eklenecek).
2. `GET /ocs/v2.php/apps/workhub/api/v1/capabilities`, Talk `room` listesi, Notifications listesi.
3. Geri alınabilir Workhub yazma: test projesinde görev oluştur (`Idempotency-Key`) → PATCH başlık → oku → sil; yalnız app password + `OCS-APIRequest: true`, cookie/requesttoken yok.
4. Notifications `push` capability ve Web Push endpoint'leri (`/apps/notifications/api/v2/webpush`) var mı.
