# Kaynak ve uyumluluk analizi — GENE-47

İnceleme tarihi: 2026-11-02. Yerel checkout'lar ve resmî API belgeleri incelendi; çalışan bir Nextcloud sunucusuna bağlanılmadı. Aşağıdaki geliştirme dalı sürümleri hedef sunucuda kurulu sürümler değildir.

## 1. Kanıt anlık görüntüsü

| Depo | İncelenen commit | Bulgular |
|---|---|---|
| kobeumut/nextcloud_workhub | `a359a4c2754f6e983a64112165b7992fa3ecb080` | Workhub 0.5.0, PHP ≥8.2, Nextcloud 34–35; harici istemciye uygun OCS API mevcut. |
| nextcloud/spreed | `a371cacda3db001130f284c268512a546ea37856` | Talk 26.0.0-dev.16; Nextcloud 36 gerektiriyor; PHP sunucu + Vue/TypeScript web istemcisi, AGPL-3.0-or-later. |
| nextcloud/talk-ios | `49593aca63e03572eca79f695cd51df573aea20d` | Swift/Objective-C, UIKit, Realm, native bildirim uzantıları; RN SDK değil; GPL-3.0-or-later + App Store istisnası. |
| nextcloud/talk-android | `fd70cfa21e1b320d4eb5cb8b91d88a91fbe2a214` | Kotlin/Java, Views/Compose, Room, WorkManager, WebRTC, FCM/UnifiedPush; RN SDK değil; GPL-3.0-or-later. |
| nextcloud/notifications | `3f87e73a2d4c3c7631681342e9c425a5a61176dd` | 9.0.0-dev.1 / Nextcloud 36; bildirim yönlendirme sınırını netleştirmek için ek inceleme. |
| kobeumut/workhub_devices | inceleme başında boş | `gh repo view` isEmpty=true; remote ref yok. İlk içerik yalnızca bu araştırma/plan belgeleridir. |

**Uyumluluk sonucu:** Spreed main / Notifications master doğrudan kurulacak hedefler değildir. Workhub mevcut sürümü Nextcloud 36 ile uyumlu ilan edilmiyor; isteğe bağlı Workhub Talk köprüsü de Talk `>=20,<26` sınırında. Gerçek sunucunun kurulu sürüm/capabilities sonuçları alınarak uyumlu kararlı dal etiketleri seçilmeli. Workhub'ı sırf en yeni upstream main'i kullanmak için yükseltmek bu işin varsayılanı değildir.

## 2. Workhub mevcut sözleşmesi

Base: `{serverBase}/ocs/v2.php/apps/workhub/api/v1`. Nextcloud alt dizin kurulumunu koru.

- App password ile Basic auth, `OCS-APIRequest: true`, `Accept: application/json`; JSON yazma gövdesi. Sonuç `ocs.data` içindedir. Yalnızca HTTP 200'e bakma; OCS meta durumunu da denetle.
- Browser istemcisi Nextcloud axios/session + requesttoken kullanır. Harici token istemcisinin CSRF davranışı hedef sunucuda test edilmeli; controller'lar genel bir CSRF muafiyeti taşımıyor. Güvenliği kapatarak çözülmemeli.
- Actor sunucu oturumundan gelir; istemciden gönderilen kullanıcı kimliği yetki vermez.
- Native backend varsayılandır. Deck kurulu olması Workhub verisinin Deck'te olduğu anlamına gelmez. Workhub API'lerini kullan; doğrudan Deck API'sine yönelme.
- `/capabilities`: kullanıcıya özel modül gate'leri, backend, kimlik/zaman dilimi, time takım rapor yetkisi. Core capabilities'deki Workhub girdisi tek başına kullanıcı yetkisi değildir.
- Önbellek/nesne anahtarı: hesap + sunucu + backend + nesne kimliği. Bir instance içindeki grup sınırı güçlü tenant izolasyonu değildir.

### Özellik ve endpoint envanteri

Aşağıdaki yollar Workhub API base'ine göredir. Tam route listesi `appinfo/routes.php:24–161`; DTO örnekleri `src/services/projectApi.ts:50–179`. Yolun varlığı her kullanıcının yetkili olduğu anlamına gelmez.

| Alan | API yüzeyi |
|---|---|
| Proje ve kaynaklar | `GET/POST /projects`, `GET/PATCH /projects/{boardId}`, `POST /projects/{boardId}/members`, `POST /projects/{boardId}/stacks`, `PATCH /stacks/{stackId}`, `GET /sources/boards`, `/sources/boards/{boardId}`, `/sources/cards`, `/principals` |
| Görünümler | `GET /projects/{boardId}/views/kanban`, `/list`, `/gantt`, `/activity`; `GET /workload`, `/projects/{boardId}/automations` |
| Görev | `POST /projects/{boardId}/tasks`, `GET/PATCH/DELETE /tasks/{cardId}`, `POST /tasks/{cardId}/move`, `/tasks/batch` |
| Alt iş/bağımlılık/yorum | `GET/POST /tasks/{cardId}/subtasks`; `PUT/DELETE /tasks/{cardId}/subtasks/{index}`; `POST .../{index}/move`; `POST /tasks/{cardId}/dependencies`, `DELETE .../dependencies/{depId}`; `GET/POST .../comments` |
| Otomasyon/paylaşım | `GET/PUT /stacks/{stackId}/automations`, `GET/PUT /objects/{type}/{id}/shares` |
| Dashboard | `GET /widget-types`, `GET/POST /dashboards`, `GET/PATCH/DELETE /dashboards/{id}`, widget ekle/güncelle/sil, `POST .../{id}/query`, `GET .../widgets/{widgetId}/drilldown` |
| Hedefler | `/goals`, `/goals/{id}`, transfer, targets, checkins, cards bağlantıları ve `/cards/{cardId}/goals` |
| Talepler | `GET /requests/context`, `/requests/report`, `GET/POST /requests`, `GET /requests/{id}`, history; `POST .../{convert,resolve,respond}` |
| Zaman | `GET /time/timer`, `POST .../start`, `.../stop`; entries CRUD, week/team/reviews; period submit ve submission withdraw/approve/request-changes/reopen |
| İş akışı | `/workflows` CRUD, samples/handoffs/card handoffs, start/runs/cancel, step handoff/skip |
| AI | status, requests oluştur/listele/oku/iptal; proposals oku/accept/dismiss; capability varsayılan kapalı |
| Yönetim | `/admin/features`, `/admin/workload`, `/admin/time/policy`, `/admin/ai/provider` ve test/models/secret/usage, `/admin/deck-import`; admin/password-confirmation kurallarına tabi |
| CSV | OCS dışı `GET /apps/workhub/csv/dashboards/{id}/widgets/{widgetId}`, `/apps/workhub/csv/time`; indirme olarak ele al |

Task oluşturma: `stackId`, `title` zorunlu; açıklama/tarihler/assignees/priority/estimate/labels isteğe bağlı. PATCH assignees/labels tam küme değişimidir; alt iş `index` + `expectedText` ile korunur, kalıcı subtask UUID varsayma. Idempotency-Key yalnızca uygulayan endpoint'lerde vardır; bütün mutasyonlara kör retry yapılmaz.

Eksikler: Workhub realtime/delta aboneliği veya standart offline write replay sözleşmesi yok. Mevcut stack'i yeniden sıralama API'si yok: oluştururken `order` alınır, `PATCH /stacks/{stackId}` yalnız `title` değiştirir. Üye silme/değiştirme, yorum düzenleme/silme ve task attachment API'si bu route listesinde yok. Arayüzde sahte işlem sunma; mevcut web ekranı güvenli geçici fallback olabilir ama native tamamlanmış sayılmaz. Tüm Workhub modüllerinin taşınma durumu ayrı takip edilmeli.

## 3. Atama bildirimleri zaten üretiliyor

Native ve Deck gateway atamaları `TaskAssignedEvent` → `AssignmentNotificationService` üzerinden geçer. Self-assignment sessizdir; recipient Projects gate + task erişimine sahip olmalı.

```text
app=workhub
objectType=card
objectId=string(cardId)
subject=task-assigned
parameters={actor,title,board,boardId,priority}
link=rtrim(linkToRouteAbsolute('workhub.page.index'), '/') + '/projects/task/' + cardId
```

- Genel Notifications OCS sonucunda alan adları `object_type`, `object_id`; şifreli push içinde `type`, `id`, `nid`. Bunları sınırda normalize et.
- Link'i sunucunun ürettiği biçimde kabul et: pretty URL `/apps/workhub/projects/task/{cardId}` veya alt dizin/`index.php` içeren eşdeğeri olabilir. Deep-link parser her iki biçimi aynı typed route'a doğrulayarak çevirmeli.
- Rich subject içindeki `deck-card`, native backend'de de kullanılır. Routing için bu tipe değil `app=workhub` + `card` kimliğine bak; görevi Workhub API'sinden getir.
- Unassign görevin ilgili alıcıdaki bekleyen bildirimini; delete tüm alıcılardakini temizler. Silme push kontrol mesajları OS bildirim merkezine de yansıtılmalı.
- `workhub/notify_assignment` ve `workhub/talk_urgent_message` instance ayarları varsayılan açık (`no` kapatır). Workhub'a ait per-user channel tercih API'si bulunmadı.
- Sadece **urgent** atama ayrıca Talk birebir mesajı yollar; urgent'e yükseltme mevcut assignee'lere Talk mesajı atabilir fakat yeni assignment bildirimi oluşturmaz. Normal atamalar Talk sohbetinde görünmek zorunda değildir.
- Deck UI içinden Workhub gateway dışı atamalar bu köprünün kapsamında değildir.
- Bildirimdeki yakalanmış başlıklar ACL değişince otomatik redakte edilmeyebilir; kilit ekranında varsayılan gizli içerik ve task açılırken güncel erişim kontrolü gerekir.

Kanıt: `lib/Notification/AssignmentNotificationService.php:72–218`, `lib/Notification/Notifier.php:53–103`, `lib/Integration/Talk/TalkAdapter.php:34–36,65–112`, `docs/notifications.md:16–20`.

## 4. Talk protokolü

| İş | Sözleşme |
|---|---|
| Discovery | `GET /ocs/v2.php/cloud/capabilities`; `spreed.features`, `spreed.config`. API sürümleri özelliğe göre değişir. |
| Oda listesi/detay | `GET /ocs/v2.php/apps/spreed/api/v4/room[/{token}]`; `conversation-v4` kontrolü. |
| Oda delta | `modifiedSince` = önceki `X-Nextcloud-Talk-Modified-Before`; istemci saati değil. `X-Nextcloud-Talk-Hash` değişince capability/signaling yenile. Silinen/çıkarılan odalar için full refresh gerekir; yalnız delta yeterli değil. |
| Mesaj geçmişi/canlı | `GET /ocs/v2.php/apps/spreed/api/v1/chat/{token}`; geçmiş `lookIntoFuture=0`, yeni mesaj long-poll `1`; `X-Chat-Last-Given` cursor. Default 100/max 200; timeout default 30/max 60 saniye; 304 normal boş sonuçtur. |
| Okunma yan etkisi | Pasif fetch'te `setReadMarker=0`; capability varsa `markNotificationsAsRead=0`; görünür ve odaklı sohbet için explicit okundu işlemi. |
| Gönder/yanıtla | Aynı chat path'e POST `message`, opsiyonel `replyTo`, capability varsa `referenceId`; 201 tam mesaj döner. |
| Tekilleştirme | `referenceId` optimistic/poll yarışını uzlaştırır. Server id ile gelenleri birleştir; aynı POST'u tekrar atmanın idempotent olduğuna dair sözleşme yok. Ağ sonucu belirsizken önce uzlaştır, sonra kullanıcı kontrollü retry. |
| Dosya | WebDAV yükle + Files Sharing shareType=10/shareWith=room token. Yeni attachment/folder akışı geliştirme snapshot'ında var; capability/sürüm doğrulamadan kullanma. |
| Arama | Core unified search `.../search/providers/talk-message/search`, `talk-message-current/search`; varsayımsal chat-search endpoint'i yazma. |
| Ses notu | Dosya paylaşımı metadata `messageType=voice-message`, `voice-message-sharing` capability. Canlı arama değildir. |
| Arama | `/api/v3/signaling/settings`, signaling/internal/external, ICE/STUN/TURN, WebRTC, call join/leave ve native ses/izin yaşam döngüsü ayrı iştir. REST sohbet tek başına audio/video arama sağlamaz. |

Kaynak: Spreed `docs/conversation.md:16–46`, `docs/chat.md:13–39,123–135,191–215`, `docs/capabilities.md:49,70–75`, `src/store/messagesStore.js:592–605`, `docs/internal-signaling.md:5–56`, `docs/call.md:8–11,38–62`.

## 5. Kritik sonuç: tek Talk native push kaydı iki uygulamayı kapsamaz

Notifications geliştirme snapshot'ında native v2 kayıt UA ile `talk`, `nextcloud` veya `unknown` olarak sınıflanır. Workhub için ayrı app allowlist yok; generic ile Talk ayrımı vardır.

| Sunucudaki kayıtlar | Talk ailesi (`spreed`, `talk`, `admin_notification_talk`) | `workhub` ve diğer uygulamalar |
|---|---|---|
| En az bir Talk türü kayıt var | Yalnız Talk kayıtları | Yalnız ordinary/unknown kayıtlar |
| Talk kaydı yok | Ordinary/unknown fallback | Ordinary/unknown kayıtlar |

Dolayısıyla generic kayıt ile iki bildirim tipini görmek, aynı hesaba resmî Talk kurulunca da çalışacağını kanıtlamaz. Stale Talk kaydı bile fallback'i kesebilir. Talk kimliğini taklit etmek çözüm değildir. `PushController.php:127–140`, `Push.php:229–253,264–306`.

Ayrıca v2 kayıt uid+auth token üzerinden güncellenir; aynı kullanıcının yeni auth token'ına aynı push-token hash'i kaydedilince eski hash kaydı silinir. **Aynı token'ı iki kez kaydedip biri Talk biri generic olsun** yaklaşımı geçerli bir varsayım değildir (`lib/Controller/PushController.php:184–204`).

### Taşıma seçenekleri — Faz 0 karar kapısı

1. **Destekleyen kurulumda Web Push:** bağımsız aktive subscription `appTypes=talk,workhub` veya `all` ile iki aileyi kapsar. Kod Talk alias'larını `talk`a normalize eder. Android Talk kendi kaydında yalnız `talk` istediğinden aynen kopyalanamaz. RN'nin browser Service Worker'ı yoktur; bu API kendi başına native APNs/FCM teslimatı sağlamaz. Android UnifiedPush veya markaya ait Web-Push→APNs/FCM endpoint/relay + native decryption/NSE uygulanabilirliği ve işletim maliyeti gerçek cihazda kanıtlanmalı. iOS teslimat/extension/crypto PoC olmadan destek iddia edilmez.
2. **Native v2 + marka proxy'si:** token/device-key ve account imzalı iki aşamalı kayıt sözleşmesi mevcut. Ancak yukarıdaki sunucu routing ayrımı çözülmeden birlikte teslimat garanti edilemez. Farklı kayıt kimlikleri veya altyapı düzenlemesi ancak sürüm/proxy testi ve açık onayla; otomatik çift kayıt veya UA spoof yok.
3. Hedef sürümde güvenli birleşik yol yoksa: Talk/Notifications tarafında küçük ve izole bir değişiklik ihtiyacını kanıtıyla onaya sun. **Workhub reposunu değiştirme.** Mobil background polling'i push diye pazarlama; ön plan inbox yalnız ara teslimattır.

Web Push kanıt: `lib/Push.php:207–222`, `lib/Controller/WebPushController.php:87–145,321–337`, `docs/webpush-v2.md:169–189`. `appTypes` string'i virgülle ayrılır; boşluk/case normalizasyonu yok. `webpush_enabled` ve browser session ise `webpush_browsers_enabled` şartları incelenmeli. Bu sürüm bulguları hedefte ayrıca doğrulanmalı.

### Native v2 kayıt ve güvenlik

- `POST /ocs/v2.php/apps/notifications/api/v2/push`: `pushTokenHash` (SHA-512), `devicePublicKey` (RSA-2048), `proxyServer` (HTTPS). Token auth gerekir. Sonuç `publicKey`, `deviceIdentifier`, `signature`.
- Proxy `POST /devices`: raw `pushToken`, `deviceIdentifier`, `deviceIdentifierSignature`, `userPublicKey`. Server tarafında 201 sonrası proxy kaydı; 200 mevcut kayıt durumudur, reconciliation/rotation dikkatle uygulanmalı.
- Logout server DELETE push → gerekiyorsa proxy DELETE `/devices`; sonra app password revoke/local wipe. Offline cleanup kullanıcı çıkışını engellememeli; kayıt temizliği retry/retention politikasıyla izlenmeli.
- Push encrypted `subject` + `signature`; önce hesap public key'iyle imzayı doğrula, sonra device private key ile çöz. Tam içerik için authenticated `GET notifications/{nid}`. Seçilen taşımanın gerçek crypto sözleşmesi kullanılır; native-v2 RSA ile Web Push RFC8291 karıştırılmaz.
- Silme kontrol olayları `delete`, `delete-multiple`, `delete-all` normal uyarı olarak gösterilmez.
- Kendi bundle/app kimlikleri kendi Apple/Google yetkili göndericisini gerektirir; Nextcloud'un resmî proxy'si keyfi marka için otomatik çalışmaz. Provider secret'ları uygulamaya veya Git'e konmaz. Proxy Nextcloud app password toplamaz, minimum şifreli payload taşır.
- Public HTTPS proxy URL'si kayıt API'sinde core host validator'a tabidir; bu checkout özel bir allowlist ayarını kanıtlamaz. Konfigürasyon ismi tahmin edilmemeli.

### Genel bildirim inbox'ı

Base `/ocs/v2.php/apps/notifications/api/v2/notifications`:

- GET liste, GET `/{id}` tek öğe, DELETE `/{id}` dismiss. DELETE tümünü yalnız ilgili capability ile ve açık kullanıcı eylemiyle.
- `notification_id`, `app`, `object_type`, `object_id`, `link`, subject/message ve Rich Object String parametreleri bulunur.
- Polling sonucundaki `shouldNotify=false` ise öğeyi inbox'ta tut ama OS alert üretme. Sunucu aktif resmî Talk Desktop oturumunu ve UA'yı hesaba katar; yerel dedup tek başına çoklu istemciyi çözmez (`lib/Controller/EndpointController.php:105–111,315–328`).
- Belgelenmemiş pagination/cursor icat etme. ETag varsa sakla; 304 ve boş gövdeyi, yeni sürümlerde aynı içerikli 200'ü işle. 204 polling'i saatte bire düşürme sinyalidir. DND'yi dikkate al.
- OS badge/chat unread/task inbox aynı kavram değildir; okundu/dismiss semantiklerini birbirine karıştırma.

## 6. Native örneklerden alınacak desenler

| Platform | Kanıt | Alınacak desen / değişmesi gereken |
|---|---|---|
| iOS | `NotificationServiceExtension/NotificationService.swift:60–176` | RN başlatmadan hesap bul, verify/decrypt, güvenli zenginleştirme; süre/memory sınırında genel fallback. |
| iOS | `NextcloudTalk/Notifications/NCPushNotification.swift:82–100` | Mevcut parser non-spreed'i reddeder; Workhub dispatch ayrıca yazılmalı. |
| iOS | `NextcloudTalk/AppDelegate.swift:235–245`, `Notifications/NCNotificationController.swift:372–468` | Authentication-required text input quick reply; doğru hesapla kısa native background send + görünür hata. |
| Android | `app/src/gplay/.../services/firebase/NCFirebaseMessagingService.kt:41–76` | Native FCM reception, token rotation, WorkManager işi; JS runtime'a bağımlı değil. |
| Android | `app/src/main/.../jobs/NotificationWorker.kt:183–209,433–486` | Verify/decrypt, hesap ayrımı; Talk-only filtresini kopyalama. |
| Android | `app/src/main/.../receivers/DirectReplyReceiver.kt:65–124` | RemoteInput ile hesabı/room'u belirli native reply; başarı/hata bildirimi. |
| Android | `app/src/main/.../jobs/PushRegistrationWorker.kt:349–356` | Web Push `appTypes=talk`; birleşik istemci için uygun değil. |

Yukarıdaki `...` gösterimi Android kaynak kökü `java/com/nextcloud/talk` içindir. iOS NSE için App Group ve Keychain paylaşım entitlement'ları markaya ait olmalı. PushKit/VoIP gerçek arama olmadan mesaj/atama için kullanılmamalı. Android Workhub normal/alert priority, Talk chat high/alert, call high/voip sınıflanır; Workhub'ı hileyle VoIP/high yapma (`notifications/lib/Push.php:984–997`).

## 7. Beş platform kararı ve lisans

React Native core iOS/Android odaklıdır. Windows/macOS partner out-of-tree; Linux community seçeneği native modül ve sürüm paritesini garanti etmez. Önerilen tek masaüstü hattı Electron + React Native Web'dir: native pencere/tray/OS notification + web-rendered UI, üç ayrı native desktop port değil. Mobil tüm ekranı uzak webview ile açmak yerine native RN çalışır.

Electron lokal paketli kod, sandbox/contextIsolation açık, nodeIntegration kapalı, dar ve doğrulanan preload IPC, credential saklayan main process kullanmalı. Renderer'a raw shell/IPC/arbitrary authenticated fetch verilmemeli; uzak linkten executable code yüklenmemeli.

Upstream uygulama kodunu/markasını kopyalamak yerine belgelenmiş protokolleri uygula. Kod taşımak gerekirse AGPL/GPL, App Store istisnası, transitif bağımlılık ve varlık lisansları incelenerek source/notice yükümlülükleri belirlenmeli; istisna GPL yükümlülüklerini silmez. Yeni deponun lisansı insan kararı olmadan rastgele seçilmedi.

## 8. Kaynak bağlantıları

Pinned kaynaklar; tablo içindeki yollar bu commit'lere göredir:

- [Workhub routes](https://github.com/kobeumut/nextcloud_workhub/blob/a359a4c2754f6e983a64112165b7992fa3ecb080/appinfo/routes.php#L24-L161)
- [Workhub assignment üretimi](https://github.com/kobeumut/nextcloud_workhub/blob/a359a4c2754f6e983a64112165b7992fa3ecb080/lib/Notification/AssignmentNotificationService.php#L72-L218)
- [Workhub notifier](https://github.com/kobeumut/nextcloud_workhub/blob/a359a4c2754f6e983a64112165b7992fa3ecb080/lib/Notification/Notifier.php#L53-L103)
- [Workhub Talk sürüm sınırı](https://github.com/kobeumut/nextcloud_workhub/blob/a359a4c2754f6e983a64112165b7992fa3ecb080/lib/Integration/Talk/TalkAdapter.php#L34-L36)
- [Spreed conversation sözleşmesi](https://github.com/nextcloud/spreed/blob/a371cacda3db001130f284c268512a546ea37856/docs/conversation.md)
- [Spreed chat sözleşmesi](https://github.com/nextcloud/spreed/blob/a371cacda3db001130f284c268512a546ea37856/docs/chat.md)
- [Talk iOS push parser](https://github.com/nextcloud/talk-ios/blob/49593aca63e03572eca79f695cd51df573aea20d/NextcloudTalk/Notifications/NCPushNotification.swift#L82-L100)
- [Talk Android web push kaydı](https://github.com/nextcloud/talk-android/blob/fd70cfa21e1b320d4eb5cb8b91d88a91fbe2a214/app/src/main/java/com/nextcloud/talk/jobs/PushRegistrationWorker.kt#L349-L356)
- [Notifications native routing](https://github.com/nextcloud/notifications/blob/3f87e73a2d4c3c7631681342e9c425a5a61176dd/lib/Push.php#L229-L253)
- [Notifications native kayıt tekilliği](https://github.com/nextcloud/notifications/blob/3f87e73a2d4c3c7631681342e9c425a5a61176dd/lib/Controller/PushController.php#L184-L204)
- [Notifications Web Push filtresi](https://github.com/nextcloud/notifications/blob/3f87e73a2d4c3c7631681342e9c425a5a61176dd/lib/Push.php#L207-L222)
- [Notifications Web Push API](https://github.com/nextcloud/notifications/blob/3f87e73a2d4c3c7631681342e9c425a5a61176dd/docs/webpush-v2.md)
- [Notifications OCS API](https://github.com/nextcloud/notifications/blob/3f87e73a2d4c3c7631681342e9c425a5a61176dd/docs/ocs-endpoint-v2.md)
- [Native push v2 protokolü](https://github.com/nextcloud/notifications/blob/3f87e73a2d4c3c7631681342e9c425a5a61176dd/docs/push-v2.md)
- [Login Flow v2 resmî belge](https://docs.nextcloud.com/server/latest/developer_manual/client_apis/LoginFlow/index.html#login-flow-v2)
- [React Native out-of-tree platformlar](https://reactnative.dev/docs/out-of-tree-platforms)
- [Electron güvenlik kılavuzu](https://www.electronjs.org/docs/latest/tutorial/security)

Çalışan sunucu/hesap/APNs/FCM bilgileri verilmediğinden authenticated API, cihaz push, build ve mağaza dağıtımı doğrulanmadı. Bu rapor bu testlerin geçtiği iddiasını taşımaz.
