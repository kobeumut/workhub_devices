# Faz 0 — sürüm ve birleşik push karar kapısı: durum

Tarih: 2026-11-02 · Görev: GENE-48 · Durum: **BLOKE (dış girdi bekleniyor)**

Faz 0 testleri gerçek sunucu ve cihaz olmadan yapılamaz. Bu çalıştırmada aşağıdakiler **yoktu**, bu nedenle hiçbir Faz 0 maddesi "geçti" sayılmaz:

| Gerekli girdi | Durum | Neden gerekli |
|---|---|---|
| Test Nextcloud URL'si + kurulu Nextcloud/Talk/Notifications/Workhub sürümleri | verilmedi | Sürüm matrisi, `>=20,<26` Talk adapter kısıtı, Web Push `appTypes` desteği |
| 2 normal + 1 kısıtlı test kullanıcısı (app password Login Flow v2 ile alınacak) | verilmedi | GET + geri alınabilir Workhub POST/PATCH ile OCS auth/CSRF smoke, ACL/feature-off testleri |
| Marka bundle/app ID (iOS + Android) | verilmedi | APNs/FCM yetkisi, NSE App Group, deep-link şeması |
| Apple Developer/APNs anahtarı sahibi, Firebase/FCM projesi sahibi | verilmedi | Native push teslimatı; secret'lar repo/issue dışında, korumalı ortamda |
| Push proxy/relay barındırma kararı ve sahibi | verilmedi | Resmî Nextcloud proxy'si markalı uygulamaya teslim etmez |
| Fiziksel iOS ve Android cihaz | bu makinede bağlı değil (`adb devices` boş; macOS/Xcode yok) | Faz 0 çıkış ölçütü yalnız fiziksel cihazla kabul edilir |
| Windows ve macOS test makineleri | yok (yalnız Linux host) | Desktop bildirim/reply ölçümü, imzalı build |

## Kararı bekleyen sorular (ürün sahibi)

1. Test sunucusu: URL ve sürümler. Workhub 0.5.0 NC34–35 destekliyor; sunucu NC36 ise Workhub uyumu ayrı karar.
2. Push transport tercihi. Kod incelemesine göre iki aday var:
   - **A — Web Push `appTypes=talk,workhub`** (hedef Notifications sürümü destekliyorsa). Tek abonelik iki aileyi kapsar; ama markaya ait Web-Push→APNs/FCM relay ve native RFC8291 decrypt (iOS NSE / Android worker) gerekir.
   - **B — Native push v2 + marka proxy**. Sunucu UA sınıflandırması nedeniyle tek kayıt Talk + Workhub'ı birlikte garanti etmez; Talk/Notifications tarafında değişiklik/onay gerekebilir.
   Önerimiz önce hedef sunucuda A'yı doğrulamak. Bu yol için sunucu tarafında Workhub değişikliği gerekmez; relay barındırma onayı gerekir.
3. Relay'i kim barındıracak ve işletecek? Minimum retention, payload yalnız şifreli kalır.

## Bu arada yapılanlar (push kabulü yerine geçmez)

- `packages/core`: güvenli OCS istemcisi, Login Flow v2, hesap izolasyonu, capability gate, Talk sohbet/oda mantığı, bildirim dispatcher'ı, deep link parser, Workhub task açılışı. Mock `fetch` ile 35 sözleşme/regression testi. Bunlar gerçek sunucuya karşı **doğrulanmadı**.
- Push payload yorumlama (`interpretPush`) native-v2/Web Push decrypt **sonrası** JSON içindir; kripto ve taşıma kodu Faz 0 kararından sonra yazılacak.

## Faz 0 smoke testi geldiğinde çalıştırılacaklar

1. `GET /ocs/v2.php/cloud/capabilities` (redakte edilip bu dosyaya eklenecek).
2. `GET /ocs/v2.php/apps/workhub/api/v1/capabilities`, Talk `room` listesi, Notifications listesi.
3. Geri alınabilir Workhub yazma: test projesinde görev oluştur (`Idempotency-Key`) → PATCH başlık → oku → sil; yalnız app password + `OCS-APIRequest: true`, cookie/requesttoken yok.
4. Notifications `push` capability ve Web Push endpoint'leri (`/apps/notifications/api/v2/webpush`) var mı.
