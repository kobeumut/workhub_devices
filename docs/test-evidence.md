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

## GENE-61 — proje, üye, sütun yönetimi ve paylaşımlar (2026-11-02)

| Alan | Komut / yöntem | Sonuç |
|---|---|---|
| Birim/sözleşme | `npm run check`; `apps/mobile`: `npx tsc --noEmit` | core 49/49 (yeni: istek gövdeleri, Idempotency-Key, istemci tarafı sınırlar, paylaşım tip listesi; IPC'de bilinmeyen alan/rol/tip reddi), relay 8/8; typecheck temiz (mobil dahil) |
| Canlı API | `npm run smoke:projects -w @workhub-devices/core` | 9/9: aynı anahtarla iki kez oluşturma → tek proje + varsayılan 3 sütun; yeniden adlandırma; sütun ekle (sona) + yeniden adlandır; kişi/grup arama; üye ekle (kişi + grup), tekrar 409 `PROJECT_MEMBER_EXISTS`, olmayan kullanıcı 422; yalnız `edit` yetkili B için yeniden adlandırma/sütun/üye 403; Projeler kapalı C için `PROJECTS_DISABLED`; hedef paylaşımı GET/PUT, B görür ama yönetemez (403), geçersiz kullanıcı 422 `INVALID_SHARE`, sahip listede yok sayılır |
| **Linux masaüstü** | `apps/desktop/scripts/smoke.mjs` | 12/12. Yeni adımlar: "Yeni proje → Yönet → yeniden adlandır → sütun ekle + yeniden adlandır → Bob'u üye ekle" ve "Hedefler → Paylaş → `staff` grubu → Kaydet". Sunucu kontrolü: `group:staff=view` |
| Android | — | Bu dilimde çalıştırılmadı (AVD var ama kapalı; ortak RN bileşenleri, mobil typecheck temiz) |

## GENE-50 — Zaman modülü: kayıt CRUD, dönem, inceleme, takım raporu, CSV (2026-11-02)

Sözleşme `nextcloud_workhub@a359a4c` `TimeController`/`SubmissionController`/`TimeCsvController` ve servislerinden okundu; yanıt şekilleri canlı sunucuda doğrulandı. Workhub reposu değişmedi. Test verisi: Nextcloud yönetici alanı `alice → bob` ve `carol → alice` (provisioning API, yalnız dev sunucusu; bkz. `docs/dev-server.md`).

| Alan | Komut / yöntem | Sonuç |
|---|---|---|
| Birim/sözleşme | `npm run check`; `apps/mobile`: `npx tsc --noEmit` | core 57/57 (yeni 8: saat dilimi/DST dönüşümü, form → oluşturma gövdesi ve minimal PATCH, kilit/eylem türetimi, yol/gövde/Idempotency-Key, CSV indirme — yönlendirme reddi + JSON hata + BOM korunur, Backend gate'i — modül kapalıyken istek yok, yönetici olmayan için 403, IPC — bilinmeyen alan/tür karışımı/gerekçesiz karar/aralık sınırı reddi), relay 8/8; typecheck temiz (mobil dahil) |
| Canlı API | `npm run smoke:time -w @workhub-devices/core` | 11/11: aralık + süre kaydı; çakışmada `TIME_OVERLAP` uyarısı (politika `warn`); minimal PATCH, eski sürüm 409 `VERSION_CONFLICT`, tür değişimi 422 `KIND_IMMUTABLE`; başka kullanıcı 404; gönder → kayıtlar `locked` + güncelle/sil 409 `PERIOD_LOCKED` → geri çek; sahibin kararı 403 `SELF_APPROVAL`, yönetici olmayan 404/403; yönetici kuyruğu → gerekçesiz değişiklik isteği 422 → gerekçeli → sahibi düzeltip yeniden gönderir → onay → onaylananlar listesi → gerekçeli yeniden açma; takım raporu toplamları; CSV own/team (BOM, başlık, app password yok), yönetici olmayan team CSV 403 |
| **Linux masaüstü** | `apps/desktop/scripts/smoke.mjs` | 15/15. Yeni adımlar: "Kayıt ekle → düzenle → dönemi gönder (kilit, Sil düğmesi yok) → geri çek → sil", "CSV indir", "İnceleme → Onayla → Onaylananlar → gerekçesiz Yeniden aç reddedilir → gerekçeyle yeniden aç → Takım raporu tablosu (5 sütun başlığı, satırlar `role` semantiğiyle) → Takım CSV". Kaydedilen CSV'ler: BOM ✓, başlık ✓, credential sızıntısı 0 |
| Android | `./gradlew :app:assembleDebug` | Derlendi (FileProvider + `shareFile`). Emülatörde paylaşım sayfası bu dilimde çalıştırılmadı |
| iOS | — | `shareFile` (UIActivityViewController) yazıldı, derlenmedi (macOS yok) |

## GENE-51 — Talepler: yanıt, çözme, göreve dönüştürme, geçmiş, rapor (2026-11-02)

Sözleşme `nextcloud_workhub@a359a4c` `RequestController`, `RequestService`, `RequestRepository`, `RequestReportService` kodundan okundu; yanıt şekilleri canlı sunucuda doğrulandı. Workhub reposu değişmedi. Test verisi: yönetici zinciri `carol → alice → bob` (bkz. `docs/dev-server.md`).

| Alan | Komut / yöntem | Sonuç |
|---|---|---|
| Birim/sözleşme | `npm run check`; `apps/mobile`: `npx tsc --noEmit` | core 62/62 (yeni 5: eylem türetimi yalnız sunucu bayrakları + durumdan; yol/gövde/Idempotency-Key/imleç/rapor sorgusu; 409 → `conflict`; Backend gate'i — modül kapalıyken istek yok, yönetici olmayanın çözme/dönüştürme isteği hiç gönderilmez, boş red/çözüm gerekçesi reddi; IPC — bilinmeyen alan/kapsam/durum, 366 gün, negatif sürüm, geçersiz kimlik reddi), relay 8/8; typecheck temiz (mobil dahil) |
| Canlı API | `npm run smoke:requests -w @workhub-devices/core` | 9/9: C → A üç talep (`pending`); yalnız alıcı yanıtlayabilir, bekleyen talebi B göremez (404); talep eden yanıtı 404, gerekçesiz red 422 `FIELD_REQUIRED`, eski sürüm 409 `VERSION_CONFLICT`; gerekçeli red → talep eden gerekçeyi görür; aynı Idempotency-Key ile iki onay tek geçiş; B ekip görünümünde çöz/dönüştür bayrakları, A'da yok; çözmede talep eden/alıcı 404, eski sürüm 409; dönüştürmede alıcı 404, başka projenin sütunu 422 `INVALID_STACK`, eski sürüm 409, görev panoda, talep edene `cardRestricted`; geçmiş olayları (`created → approved → resolved/converted`, red gerekçesi); rapor: B ekip satırları + `byState`, C'de ekip satırı yok, 366 gün aşımı 422 `RANGE_TOO_LARGE` |
| **Linux masaüstü** | `apps/desktop/scripts/smoke.mjs` | 17/17. Yeni adımlar: "Talepler → Bana gelenler → Onayla; gerekçesiz Reddet reddedilir → gerekçeyle Reddet; alıcıda Çöz/Göreve dönüştür yok" ve "Ekibim → proje ara + seç → ilk sütun önseçili → Görev oluştur → bağlı görev + geçmiş; gerekçesiz Çöz reddedilir → gerekçeyle çöz → Rapor → Ekip (5 sütunlu tablo)". Sunucu kontrolü: `reject=rejected convert=converted resolve=resolved` (onaylanan talep `open`, yöneticisine geçti) |
| Erişilebilirlik düzeltmesi | masaüstü smoke | Ortak `Chip` seçimi RN Web'de `accessibilityState` ile DOM'a yansımıyordu (ekran okuyucu seçili durumu duymuyordu); `aria-checked`/`aria-disabled` eklendi ve smoke `aria-checked` ile doğruluyor |
| Android | — | Bu dilimde çalıştırılmadı (yalnız ortak RN/TS değişikliği, native kod yok; mobil typecheck temiz) |

## GENE-52 — Hedefler: oluştur/düzenle, hedef değerler, check-in, kart bağlama, sahiplik devri (2026-11-02)

Sözleşme `nextcloud_workhub@a359a4c` `GoalController`, `GoalService`, `GoalProgress`, `GoalCalculator` kodundan okundu; yanıt şekilleri (ayrıntı, target, check-in, `cards/{id}/goals`, hata gövdeleri) canlı sunucuda doğrulandı. Workhub reposu değişmedi.

| Alan | Komut / yöntem | Sonuç |
|---|---|---|
| Birim/sözleşme | `npm run check`; `apps/mobile`: `npx tsc --noEmit` | core 69/69 (yeni 7: ondalık normalizasyonu sunucu biçimi + `scale`; eylemler yalnız rol bayrakları + yaşam döngüsünden; 14 uç için yol/gövde/Idempotency-Key; modül kapalıyken tek çağrı yapılmaz; rol gate'i taze ayrıntıyla — `manage`/`edit`/arşiv reddinde yazma isteği hiç gönderilmez; kart kaldırma güncel target sürümü + yalnız o kart; IPC — tür başına kesin alan kümesi, para birimi yalnız `currency`, ondalık yalnız dize, tekrarlı kart kimliği, sahip değişikliği yalnız devirle), relay 8/8; typecheck temiz (mobil dahil) |
| Canlı API | `npm run smoke:goals -w @workhub-devices/core` | 9/9: oluştur + başlık/tarih düzenle (eski sürüm 409, geçersiz tarih 422); sayı/para/evet-hayır hedef değer CRUD (boş aralık 422, yanlış türde alan 422); check-in: aynı Idempotency-Key iki kez → tek kayıt, eski sürüm 409, mutlak + evet/hayır, geçmiş, fazla ondalık 422; görevden bağlama → `task` hedef değeri oluşur, kart hedefi listeler, yabancı kullanıcı 404, `task`'a check-in 422; roller: `view` paylaşımı yazamaz (403), `edit` paylaşımı check-in yapar ama devir/silme 403, sahibin projesindeki kartı göremeyen kullanıcı kümeden düşüremez (422 `CARDS_NOT_READABLE`); bağlantı kaldırma (eski sürüm 409); arşivde yazma 409 `GOAL_ARCHIVED` → yeniden etkinleştir; devir (olmayan/kendisi 422, eski sürüm 409) → önceki sahip `manage` korur; silme (eski sürüm 409) → iki kullanıcıda 404 |
| **Linux masaüstü** | `apps/desktop/scripts/smoke.mjs` | 20/20. Yeni adımlar: "Hedef → Para hedef değeri ekle (1000,50 TRY) → 1,234 check-in istemcide reddedilir → +250,25 artış (not ile) → Geçmiş → Arşivle (check-in gizli) → Yeniden etkinleştir", "Proje → yeni görev → Hedefler → Hedefe bağla → listede ilerlemeyle → Bağlantıyı kaldır", "Sahipliği devret → kişi ara (Bob) → Devret → Sahip: Bob · Rolünüz: yönetir". Sunucu kontrolü: `owner=bob callerRole=manage targets=currency+task current=250.25` |
| Android | — | Bu dilimde çalıştırılmadı: bağlı cihaz/çalışan emülatör yok (yeni emülatör oluşturulmaz). Değişiklik yalnız ortak RN/TS; native kod yok; mobil typecheck temiz |

## Doğrulanmayanlar (açıkça)

- **iOS:** kod yazıldı, derlenmedi (macOS/Xcode yok). Kurulum: `docs/ios-setup.md`.
- **Windows ve macOS masaüstü:** aynı Electron kodu, bu makinede çalıştırılmadı/paketlenmedi. macOS inline reply ve Windows bildirim eylemleri ölçülmedi.
- **Gerçek FCM/APNs teslimatı ve bildirimden hızlı yanıt:** Firebase/APNs bilgileri sahibi tarafından eklenecek. Android native alıcı ve yanıt kodu derlendi ama gerçek push ile cihazda çalıştırılmadı. Emülatör/mock push kabul yerine geçmez.
- Fiziksel cihaz testi yapılmadı (bağlı cihaz yok).

## Bilinen sorunlar

- Android 16 emülatöründe klavye açıkken yazma alanının alt kısmı klavyeye hafifçe biniyor (edge-to-edge zorunluluğu). Gönder düğmesi çalışıyor; düzeltme açık iş.
- Debug derlemede React Native LogBox uyarı balonu alt sekme çubuğunu kapatabiliyor (yalnız geliştirme modunda).
- ~~Proje listesindeki açık/tamamlandı sayaçları görev oluşturduktan sonra eski kalıyor.~~ GENE-49'da düzeltildi (görev değişiminde liste yenilenir; masaüstü smoke ile doğrulandı).
