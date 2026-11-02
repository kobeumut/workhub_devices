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
| Zaman: hafta | `time` | `GET /time/week` | İşler → Zaman | **Native** (görüntüleme) | Masaüstü smoke |
| Zaman: kayıt düzenleme, dönem gönderme, inceleme | `time`, reviewer | entries CRUD, periods, submissions | Diğer → web | Web fallback | — |
| Talepler: liste | `requests` | `GET /requests?scope=` | İşler → Talepler | **Native** | arayüz |
| Talepler: oluştur | `requests`, yöneticisi tanımlı | `POST /requests` | İşler → Talepler | **Native** | yönetici yoksa açıklama gösterilir |
| Talepler: yanıt / çöz / göreve dönüştür | yönetici | `respond/resolve/convert` | Diğer → web | Web fallback | — |
| Hedefler: liste ve ilerleme | `goals` | `GET /goals` | İşler → Hedefler | **Native** (görüntüleme) | arayüz |
| Hedefler: düzenleme, check-in, kart bağlama | `goals` | goals CRUD/targets/checkins | Diğer → web | Web fallback | — |
| Dashboard / widget / CSV | `dashboard` | `/dashboards…`, CSV | Diğer → web | Web fallback | — |
| İş akışları | `projects` | `/workflows…` | Diğer → web | Web fallback | — |
| AI | `ai` (varsayılan kapalı) | `/ai/…` | Diğer → web | Web fallback | — |
| Yönetim | admin | `/admin/…` (parola onayı) | Diğer → web (yalnız admin) | Web fallback (admin parolası uygulamada saklanmaz) | — |
| Proje/üye/sütun yönetimi | `manage` | `POST /projects`, `/members`, `/stacks` | — | Web fallback; üye silme API'si yok (**Gap**) | API smoke (oluşturma) |

**Sonuç:** Günlük iş akışı native: görev listeleme, oluşturma, açma, taşıma, tamamlama, alan düzenleme, kişi seçicili atama, alt işler, bağımlılıklar, yorum, atama bildirimleri, zamanlayıcı, talep oluşturma, hedef takibi. Yönetim ve analiz modülleri (dashboard, Gantt, iş yükü, iş akışları, AI, admin) ve düzenleme alt akışları şimdilik web fallback. Bunlar açık iş olarak duruyor ve "tam Workhub native" denmiyor.
