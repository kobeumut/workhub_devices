# Workhub modül matrisi (Devices istemcisi)

Kaynak: Workhub 0.5.0 (`a359a4c`), API v1. Test: Nextcloud 35.0.2 dev sunucusu, kullanıcılar `alice`/`bob` (staff), `carol` (kısıtlı). Durum değerleri:

- **Native**: uygulama içinde ekran var ve canlı sunucuda doğrulandı.
- **Native (kısmi)**: temel akış var; listelenen işlemler web'de.
- **Web fallback**: kullanıcının kendi sunucusundaki web arayüzü açılır. Bu, native tamamlandı sayılmaz.
- **Gap**: sunucuda API yok.

Gate sütunu `GET /capabilities` → `modules.*` (kullanıcı bazlı, fail-closed) ve yönetici bilgisidir.

| Modül | Gate / rol | Endpoint'ler | Ekran | Durum | Doğrulama |
|---|---|---|---|---|---|
| Projeler listesi | `projects` | `GET /projects` | İşler → Projeler | **Native** | Masaüstü smoke; API smoke |
| Proje oluştur | `projects` (her modül kullanıcısı; oluşturan `manage`+`share` alır) | `POST /projects` (+Idempotency-Key) | İşler → Projeler → "Yeni proje" | **Native** | `smoke:projects`; masaüstü smoke |
| Proje yeniden adlandır | board `manage` | `PATCH /projects/{id}` (en çok 100 karakter) | Pano → Yönet → Proje adı | **Native** | `smoke:projects` (B 403); masaüstü smoke |
| Sütun oluştur / yeniden adlandır | board `manage` | `POST /projects/{id}/stacks` (sona eklenir), `PATCH /stacks/{id}` | Pano → Yönet → Sütunlar | **Native** | `smoke:projects`; masaüstü smoke |
| Üye ekle (kişi/grup) | board `share`; verilen yetki kendi yetkinizle sınırlı (sunucu kırpar) | `POST /projects/{id}/members`, `GET /principals?q=`; tekrar 409 `PROJECT_MEMBER_EXISTS` | Pano → Yönet → Üye ekle (kişi/grup arama) | **Native** | `smoke:projects`; masaüstü smoke |
| Üye çıkarma / yetki değiştirme | — | yok | Panelde açıklama | **Gap** (Workhub API'sinde yok) | — |
| Sütun silme / sıralama, proje arşivleme/silme | — | yok | — | **Gap** (Workhub API'sinde yok) | — |
| Paylaşımlar (hedef) | nesnede `manage` rolü (sahip veya manage paylaşımı) | `GET/PUT /objects/goal/{id}/shares` (tam liste değişimi) | İşler → Hedefler → Paylaş | **Native** | `smoke:projects` (B 403, geçersiz kullanıcı 422); masaüstü smoke |
| Paylaşımlar (dashboard, iş akışı) | nesnede `manage` | `GET/PUT /objects/{dashboard,workflow}/{id}/shares` | Ortak `SharesEditor` hazır; ekran o modüllerin native dilimiyle bağlanır | Web fallback (modül ekranı henüz yok) | birim (IPC tip listesi) |
| Pano (kanban/liste) | `projects`, board `edit` | `GET /projects/{id}/views/kanban` | Pano (sütun bölümleri) | **Native** | Masaüstü smoke |
| Görev oluştur | `projects`, `edit` | `POST /projects/{id}/tasks` (+Idempotency-Key) | Pano → "Yeni görev" | **Native** | Masaüstü smoke |
| Görev taşı | `edit` | `POST /tasks/{id}/move` | Pano → "Taşı" (erişilebilir, sürüklemesiz) | **Native** | birim/arayüz |
| Görev detayı | ACL | `GET /tasks/{id}` (her açılışta taze) | Görev | **Native** | API smoke (403/404/feature off) |
| Tamamla / yeniden aç | `edit` | `PATCH /tasks/{id}` `done` | Görev | **Native** | arayüz |
| Atama değiştirme | `edit` | `PATCH assignees` (kullanıcıların tam kümesi; grup atamalarına dokunulmaz) | Görev → Düzenle → Atananlar (proje üyeleri) | **Native** | `smoke:tasks`; API smoke (unassign) |
| Başlık/açıklama/öncelik/tarih/tahmini süre/etiket düzenleme | `edit` | `PATCH /tasks/{id}` (yalnız değişen alanlar; etiket tam küme + mevcut öncelik etiketi) | Görev → Düzenle | **Native** | `smoke:tasks`; masaüstü smoke |
| Etiket oluşturma/yönetimi | — | yok (yalnız öncelik etiketi sunucuda otomatik) | — | **Gap** (Workhub API'sinde yok; mevcut etiketler seçilebilir) | `smoke:tasks` (native backend'de düz etiket yok) |
| Yorumlar | ACL | `GET/POST /tasks/{id}/comments` | Görev → Yorumlar | **Native** | Masaüstü smoke |
| Yorum düzenle/sil | — | yok | — | **Gap** (Workhub API'sinde yok) | — |
| Alt işler | `edit` | `/tasks/{id}/subtasks` (`index`+`expectedText`; eski metinle yazma 409 `SUBTASK_CHANGED`) | Görev → Alt işler (ekle, işaretle, sil) | **Native** | `smoke:tasks`; masaüstü smoke |
| Bağımlılıklar | `edit`, `features.dependencies` | `POST/DELETE /tasks/{id}/dependencies` (aynı proje; döngü 409) | Görev → Bağımlılıklar (bekliyor/engelliyor) | **Native** | `smoke:tasks` |
| Görev ekleri | — | yok | — | **Gap** | — |
| Atama bildirimi → görev | `projects` | Notifications + `GET /tasks/{id}` | Bildirimler / push | **Native** | API smoke, push e2e |
| Gantt / etkinlik | `projects` | `views/gantt`, `views/activity` | Diğer → web | Web fallback | — |
| İş yükü | `projects` | `GET /workload` | Diğer → web | Web fallback | — |
| Zaman: zamanlayıcı | `time` | `GET /time/timer`, `POST start/stop` | İşler → Zaman; Görev → "Zamanlayıcı başlat" | **Native** | Masaüstü smoke |
| Zaman: hafta | `time` | `GET /time/week?date=` (dönem, günler, kayıtlar, gönderimler, politika, gezinme) | İşler → Zaman → Haftam (önceki/sonraki/bugün) | **Native** | Masaüstü smoke |
| Zaman: kayıt oluştur / düzenle / sil | `time`; yalnız açık dönem (`draft`, `changes_requested`, `reopened`) | `POST /time/entries` (+Idempotency-Key; `range` veya `duration`), `PATCH /time/entries/{id}` (yalnız değişen alanlar + `version`), `DELETE /time/entries/{id}` (`version`) | Haftam → Kayıt ekle / Düzenle / Sil | **Native** — kilitli dönemde kayıt 🔒 ve salt okunur; sunucu 409 `PERIOD_LOCKED`; çakışma politikası `warn` uyarısı gösterilir; eski sürüm 409 `VERSION_CONFLICT`; tür değişimi 422 `KIND_IMMUTABLE` | `smoke:time`; masaüstü smoke; birim (form→gövde, saat dilimi) |
| Zaman: dönemi gönder / geri çek | `time`, sahibi | `POST /time/periods/{id}/submit`, `POST /time/submissions/{id}/withdraw` (dönem `version`) | Haftam → Dönem onayı | **Native** — yöneticisi yoksa uyarı; çalışan zamanlayıcı 409 `TIMER_RUNNING` | `smoke:time`; masaüstü smoke |
| Zaman: inceleme (onay, değişiklik isteme, yeniden açma) | `time` + `permissions.canViewTeamReport` (Nextcloud doğrudan yönetici); kendi çizelgesi 403 `SELF_APPROVAL` | `GET /time/reviews?status=pending|approved`, `POST /time/submissions/{id}/approve|request-changes|reopen` (gerekçe: değişiklik/yeniden açmada zorunlu) | Zaman → İnceleme (yalnız yöneticilerde görünür) | **Native** — istemci ve Backend gate'i fail-closed, sunucu yeniden denetler | `smoke:time` (B onaylar, C/A 403/404); masaüstü smoke (onay → gerekçesiz yeniden açma reddi → yeniden açma) |
| Zaman: takım raporu | aynı yönetici gate'i | `GET /time/team?from&to` (en çok 93 gün) | Zaman → Takım raporu (erişilebilir tablo: `role=table/row/columnheader/rowheader/cell`, hücrelerde ekran okuyucu için tam süre) | **Native** | `smoke:time`; masaüstü smoke (tablo semantiği denetlenir) |
| Zaman: CSV indirme | `own`: `time`; `team`: yönetici gate'i | `GET /index.php/apps/workhub/csv/time?scope&from&to` (OCS dışı, en çok 366 gün; BOM'lu UTF-8) | Haftam → CSV indir; Takım raporu → Takım CSV indir. Masaüstü: main süreç kaydetme penceresi; mobil: sistem paylaşım sayfası (Android FileProvider, iOS UIActivityViewController) | **Native** — CSV yalnız sunucu gövdesidir; credential yalnız `Authorization` başlığında; dosya adı istemcide doğrulanmış parçalardan üretilir | birim (yönlendirme reddi, JSON hata), `smoke:time` ve masaüstü smoke (BOM, başlık, 0 credential) |
| Zaman: kayda görev bağlama, zaman widget'ları | `time` (+ kart erişimi) | `cardId` destekleniyor ama kart seçici yok | — | **Açık iş (istemci)** — API var, kart seçici sonraki dilim; görevden zamanlayıcı başlatma native | — |
| Zaman: politika yönetimi | admin | `/admin/time/policy` | Diğer → Yönetim (web) | Web fallback (admin) | — |
| Talepler: liste | `requests` | `GET /requests?scope=` | İşler → Talepler | **Native** | arayüz |
| Talepler: oluştur | `requests`, yöneticisi tanımlı | `POST /requests` | İşler → Talepler | **Native** | yönetici yoksa açıklama gösterilir |
| Talepler: yanıt / çöz / göreve dönüştür | yönetici | `respond/resolve/convert` | Diğer → web | Web fallback | — |
| Hedefler: liste ve ilerleme | `goals` | `GET /goals` | İşler → Hedefler | **Native** (görüntüleme) | arayüz |
| Hedefler: düzenleme, check-in, kart bağlama | `goals` | goals CRUD/targets/checkins | Diğer → web | Web fallback | — |
| Dashboard / widget / CSV | `dashboard` | `/dashboards…`, CSV | Diğer → web | Web fallback | — |
| İş akışları | `projects` | `/workflows…` | Diğer → web | Web fallback | — |
| AI | `ai` (varsayılan kapalı) | `/ai/…` | Diğer → web | Web fallback | — |
| Yönetim | admin | `/admin/…` (parola onayı) | Diğer → web (yalnız admin) | Web fallback (admin parolası uygulamada saklanmaz) | — |

Proje paylaşımı Workhub'da ayrı bir "share" nesnesi değildir: sunucu `objects/{type}` için yalnız `dashboard`, `goal`, `workflow` kabul eder (`ShareController::TYPES`). Projeye erişim üye ekleme ile verilir.

**Sonuç:** Günlük iş akışı native: proje oluşturma/yeniden adlandırma, sütun ve üye yönetimi, hedef paylaşımı, görev listeleme, oluşturma, açma, taşıma, tamamlama, alan düzenleme, kişi seçicili atama, alt işler, bağımlılıklar, yorum, atama bildirimleri, zamanlayıcı, zaman kaydı CRUD, dönem gönderme/geri çekme, yönetici incelemesi, takım raporu ve CSV, talep oluşturma, hedef takibi. Yönetim ve analiz modülleri (dashboard, Gantt, iş yükü, iş akışları, AI, admin) ve düzenleme alt akışları şimdilik web fallback. Bunlar açık iş olarak duruyor ve "tam Workhub native" denmiyor.
