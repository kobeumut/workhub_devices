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

## GENE-49 — görev düzenleme dilimi (2026-11-02)

| Alan | Komut / yöntem | Sonuç |
|---|---|---|
| Birim/sözleşme | `npm run check`; `apps/mobile`: `npx tsc --noEmit` | core 46/46, relay 8/8; typecheck temiz (mobil dahil) |
| Canlı API | `npm run smoke:tasks -w @workhub-devices/core` | 9/9 (etiket adımı açıkça atlandı: native backend'de düz etiket yok, oluşturma API'si yok). Alan PATCH'i, tam küme atama, `INVALID_DATE_RANGE`/`INVALID_ASSIGNEE`, alt iş ekle/işaretle/yeniden adlandır/sil, eski `expectedText` → 409 `SUBTASK_CHANGED`, bağımlılık ekle/kaldır + döngü 409, üye B düzenler, kısıtlı C 403, sayaçlar |
| **Linux masaüstü** | `apps/desktop/scripts/smoke.mjs` | 10/10: yeni adım "Düzenle → başlık/bitiş/tahmini süre/öncelik kaydet → alt iş ekle + işaretle"; sol paneldeki proje sayacı yenilemeden 4 → 5 |
| Android | — | Bu dilimde çalıştırılmadı (ortak RN bileşenleri; mobil typecheck temiz) |

## Doğrulanmayanlar (açıkça)

- **iOS:** kod yazıldı, derlenmedi (macOS/Xcode yok). Kurulum: `docs/ios-setup.md`.
- **Windows ve macOS masaüstü:** aynı Electron kodu, bu makinede çalıştırılmadı/paketlenmedi. macOS inline reply ve Windows bildirim eylemleri ölçülmedi.
- **Gerçek FCM/APNs teslimatı ve bildirimden hızlı yanıt:** Firebase/APNs bilgileri sahibi tarafından eklenecek. Android native alıcı ve yanıt kodu derlendi ama gerçek push ile cihazda çalıştırılmadı. Emülatör/mock push kabul yerine geçmez.
- Fiziksel cihaz testi yapılmadı (bağlı cihaz yok).

## Bilinen sorunlar

- Android 16 emülatöründe klavye açıkken yazma alanının alt kısmı klavyeye hafifçe biniyor (edge-to-edge zorunluluğu). Gönder düğmesi çalışıyor; düzeltme açık iş.
- Debug derlemede React Native LogBox uyarı balonu alt sekme çubuğunu kapatabiliyor (yalnız geliştirme modunda).
- ~~Proje listesindeki açık/tamamlandı sayaçları görev oluşturduktan sonra eski kalıyor.~~ GENE-49'da düzeltildi (görev değişiminde liste yenilenir; masaüstü smoke ile doğrulandı).
