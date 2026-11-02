# Test kanıtları — 2026-11-02 (GENE-48)

Sunucu: yerel Docker dev (Nextcloud 35.0.2, Talk 25.0.6, Notifications 8.0.1, Workhub 0.5.0), `docs/dev-server.md`.

| Alan | Komut / yöntem | Sonuç |
|---|---|---|
| Birim/sözleşme | `npm run check` | core 43/43, relay 8/8; features, desktop ve mobil typecheck temiz |
| Kotlin Web Push çözme | `./gradlew :app:testDebugUnitTest` | 3/3 (RFC 8291 test vektörü dahil) |
| Canlı API | `npm run smoke:live -w @workhub-devices/core` | 14/14 |
| Push zinciri | `services/push-relay/test/e2e.live.ts` | Talk + normal atama + unassign delete tek abonelikte geldi ve çözüldü |
| **Linux masaüstü** (Electron, başsız) | `apps/desktop/scripts/smoke.mjs` | 9/9 adım: gerçek Login Flow v2 ile giriş, sohbet listesi, mesaj gönderme, pano, görev oluşturma + yorum, zamanlayıcı başlat/durdur, bildirimler, hesap |
| **Android** (mevcut emülatör, Android 16, debug APK + Metro) | Elle/adb ile sürülen arayüz | Login Flow v2 (Chrome, app password onayı) → `bob` girişi. Sohbet listesinde masaüstünden gönderilen mesaj göründü. Telefondan gönderilen mesaj sunucuda **tek kopya** doğrulandı. Proje panosu, görev detayı (masaüstü yorumu görünür). Alice'in normal atama bildirimi inbox'ta → doğru görev açıldı. Android geri tuşu uygulama içinde geri gidiyor |

## Doğrulanmayanlar (açıkça)

- **iOS:** kod yazıldı, derlenmedi (macOS/Xcode yok). Kurulum: `docs/ios-setup.md`.
- **Windows ve macOS masaüstü:** aynı Electron kodu, bu makinede çalıştırılmadı/paketlenmedi. macOS inline reply ve Windows bildirim eylemleri ölçülmedi.
- **Gerçek FCM/APNs teslimatı ve bildirimden hızlı yanıt:** Firebase/APNs bilgileri sahibi tarafından eklenecek. Android native alıcı ve yanıt kodu derlendi ama gerçek push ile cihazda çalıştırılmadı. Emülatör/mock push kabul yerine geçmez.
- Fiziksel cihaz testi yapılmadı (bağlı cihaz yok).

## Bilinen sorunlar

- Android 16 emülatöründe klavye açıkken yazma alanının alt kısmı klavyeye hafifçe biniyor (edge-to-edge zorunluluğu). Gönder düğmesi çalışıyor; düzeltme açık iş.
- Debug derlemede React Native LogBox uyarı balonu alt sekme çubuğunu kapatabiliyor (yalnız geliştirme modunda).
- Proje listesindeki açık/tamamlandı sayaçları görev oluşturduktan sonra listeyi yenileyene kadar eski kalıyor.
