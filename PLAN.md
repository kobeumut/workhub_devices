# Workhub Devices uygulama planı — GENE-47

## Hedef ve mevcut durum

Talk sohbetleri ana ekran olacak; kullanıcı mesaj bildiriminin içinden cevaplayabilecek, Workhub'daki işleriyle çalışabilecek ve kendisine atanan görevleri bildirimden açabilecek. Hedefler: iOS, Android, Windows, macOS, Linux. Yeni kodun deposu `kobeumut/workhub_devices`; Workhub sunucusunun mevcut API'si korunacak.

**Bu commit uygulama değil, uygulanacak araştırma/plan teslimidir.** Uygulama sahibi Opus2 - Full Stack Developer; uygulama alt görevi **GENE-48** (`01a19b2b-08c3-7f23-8e55-c92c866995a1`). Her faz küçük PR'larla, aşağıdaki kabul ölçütleri ve gerçek test kanıtlarıyla teslim edilmeli. Faz 0 çözülmeden beş platformda arka plan push çalışıyor denmez.

### Planlama teslimi

- [x] Spreed, Talk iOS, Talk Android, Workhub ve Notifications kaynaklarını incele.
- [x] API/notification routing ve sürüm uyumluluk risklerini kaydet (`RESEARCH.md`).
- [x] Ortak mimari, iş sırası ve ölçülebilir kabul/test planını yaz.
- [x] Belgeleri Workhub Devices remote'una gönder ve link/SHA doğrula (ilk plan commit'i `cd0566f`).
- [x] Mevcut görevleri kontrol ederek uygulamayı tek yeni alt görevle Opus2'ye ata (GENE-48).

Uygulama checkbox'ları başlangıçta kasıtlı olarak boş; plan yazılmış olması uygulamanın/testin tamamlandığı anlamına gelmez.

## Uygulama ilerlemesi (GENE-48)

| Faz | Durum | Kanıt |
|---|---|---|
| 0 — sürüm/push kapısı | **Bloke**: test sunucusu, hesaplar, bundle ID, APNs/FCM, relay sahibi ve fiziksel cihaz verilmedi | `docs/phase0-status.md` |
| 1 — temel/auth | Kısmi: `packages/core` (URL doğrulama, OCS istemcisi/hata normalizasyonu, Login Flow v2, hesap izolasyonu, logout, capability gate) + CI. RN/Electron kabukları, OS secret store, beş OS build'i yok | `npm run check` (35 test) |
| 2 — Talk | Kısmi: core oda/sohbet/gönderim/merge/rich-render mantığı; UI ve gerçek sunucu testi yok | `packages/core/src/talk.ts` |
| 3 — bildirim | Kısmi: saf dispatcher, push payload yorumlama, deep link, gizli önizleme; native push/quick reply yok (Faz 0'a bağlı) | `packages/core/src/routing.ts` |
| 4 — Workhub | Kısmi: API v1 istemcisinin task/proje/yorum alt kümesi, bildirimden ACL'li açılış; UI yok | `packages/core/src/workhub.ts` |
| 5–7 | Başlamadı | — |

Aşağıdaki checkbox'lar yalnız madde gerçek ortamda tamamlanınca işaretlenir; core mantığının mock testleri bir maddeyi tek başına tamamlamaz.

## 1. Kararlar ve kapsam sınırı

| Konu | Karar / gerekçe |
|---|---|
| Mobil | Bare React Native + TypeScript. Swift notification service extension, Kotlin FCM/RemoteInput receiver/worker gerekir; JS-only bildirim planı yeterli değil. |
| Masaüstü | React Native Web + Electron: Windows/macOS/Linux için tek desktop UI ve main/preload hattı. RN Windows + RN macOS + community Linux'ta üç ayrı port/binding yerine bu yol önerilir. Uzak Nextcloud sayfasını paketleyen webview değildir. |
| Native desktop beklentisi | Electron native pencere/OS entegrasyonu verir, native RN widget garantisi vermez. Bu ayrım kabul kaydına yazılmalı; yalnız native widget şartı varsa Linux fizibilitesi ayrıca karara bağlanmalı. |
| Ortaklık | Aynı TypeScript domain, API sözleşmeleri, capability politikası, notification routing ve RN/RNW özellik bileşenleri. Sadece gerçek platform sınırında küçük adapter; genel plugin/event-bus/DI sistemi yok. |
| Auth | Nextcloud Login Flow v2 ile per-device app password. Ana şifre alma/saklama yok. Çoklu sunucu/hesap izolasyonu ilk günden. |
| Talk | Resmî OCS API/capability protokolüyle yeni istemci; iOS/Android uygulamasını RN SDK sanıp import etme. |
| Workhub | Workhub OCS API v1; native/Deck backend ayrımı sunucuya bırakılır. Varsayılanı Workhub reposunda sıfır diff. |
| Push | **Açık karar kapısı.** Native Talk türü push aboneliği Workhub generic push almaz. Tek generic abonelik ise hesaba resmî Talk kaydolunca Talk fallback'ini kaybedebilir. Faz 0'da birlikte teslimat yolu kanıtlanmalı. |
| Canlı veri | Talk desteklenen chat long-poll; Workhub focus/foreground refresh + push invalidation. Kanıtlanmamış WebSocket veya background polling servisi yok. |
| Yerel veri | Küçük hesap-scope'lu cache/draft; SQLite yalnız gerçekten gerekli mesaj/draft saklama için. Genel offline mutation queue veya sync engine yok. |
| Sürümler | Kurulu Nextcloud/Talk/Notifications sürümlerine göre capability negotiation. RN/RNW/Electron/native dependency sürümlerini uygulama başında resmî uyumluluk ve lockfile ile seç; geliştirme main'lerini prod sanma. |
| Lisans | Protokol implementasyonu; upstream kod/asset taşınacaksa lisans/notice/source ve marka kontrolü önceden yapılır. GPL/AGPL kodunu proprietary koda sessizce kopyalama. |

### Release kapsamı

1. **İlk kullanılabilir dilim:** beş platformda giriş/hesap, Talk oda listesi/sohbet/mesaj, mobil background bildirim + quick reply, desktop OS notification/reply action, Workhub proje/görev/assignment inbox/deep link. Bu, bütün Workhub'ın tamamlandığı iddiası değildir.
2. **Tam Workhub:** aşağıdaki modül envanterindeki capability-enabled operasyonlar. API'de olmayan web işlevleri açıkça gap listesinde; güvenli web fallback bunları native tamamlanmış yapmaz.
3. **Talk genişletme:** reply/edit/delete/reaction/search/mention, dosya ve ses notu, oda/katılımcı yönetimi. Destek her zaman capability kontrollü.
4. **Audio/video çağrıları:** kullanıcı burada özellikle mesajlaşma istiyor; arama ayrı tahmin/karar kapısıdır. Kendiliğinden tamamlandı sayılmaz; kabul edilirse Faz 7 uygulanır. Çağrı yokken call butonları gösterilmez, PushKit mesajlar için kullanılmaz.

## 2. Başlangıç dosya yerleşimi ve güven sınırı

Yalnız gerçek ortaklık oluştukça paket aç:

```text
apps/mobile/          RN iOS/Android + ios notification extension + android workers
apps/desktop/         Electron main, dar preload, RNW renderer
packages/core/        account, OCS/Talk/Workhub istemcisi, DTO ve saf routing
packages/features/    sohbet, Workhub, inbox; ortak RN bileşenleri
```

Bütün özellik için ayrı npm paketi, yeni backend veya yeni sunucu tablosu gerekmez. Workspace aracı/manager tek olsun, lockfile repo'ya girsin. İlk PR'da yalnız ayağa kalkan iki app ve gerçekten paylaşılan core olsun.

**Güven sınırı:** mobil secret'lar Keychain/Keystore; desktop secret'lar OS credential store + main process. Electron renderer sadece doğrulanan domain işlemlerini çağırır; arbitrary URL'ye credential ekleyen fetch proxy, `shell`, sınırsız IPC veya raw app password erişimi yok. Native extension ve main process, JS ekranı kapalıyken minimum bildirim/quick-reply işini yapar.

**Temel veri anahtarları:** `accountId`, normalize edilmiş `serverBase` (alt dizin korunur), Talk `roomToken`, mesaj server id, Workhub backend + `cardId`, Notification `notification_id`. Aynı card/room id başka hesapla birleşmemeli. API response'u ve deep-link parametresi trust boundary'dir; validate edilir.

## 3. Faz 0 — sürüm ve birleşik push fizibilitesi (ilk, bloke edici iş)

Gereken dış girdiler: test sunucusu URL'si/kurulu sürümleri, iki normal kullanıcı + bir sınırlı kullanıcı, Workhub/Talk/Notifications erişimi; marka bundle/application ID; Apple Developer/APNs, Firebase/FCM yetkileri; gerekirse relay hosting/onay; beş OS test ortamı ve dağıtım imzalama sahipleri. Secret'lar issue/Git'e yazılmaz. Bunlar henüz bu planlama işinde verilmedi.

- [ ] Core ve kullanıcı Workhub capabilities çıktısını redakte ederek kaydet; Nextcloud/Talk/Notifications/Workhub ve native/Deck sürüm matrisi oluştur.
- [ ] Workhub Nextcloud 34–35 ve Talk adapter `>=20,<26` kısıtını gerçek kurulumla karşılaştır; incelemede kullanılan Talk 26/Notifications 9 geliştirme snapshot'ı NC36 içindir. Uyumlu kararlı sürümleri seç.
- [ ] Login Flow v2/app password ile Talk room + Workhub project + Notifications GET smoke testi yap. Ayrıca browser cookie/requesttoken olmadan `OCS-APIRequest: true` ile geri alınabilir Workhub POST/PATCH yapıp kalıcı state'i okuyarak OCS auth/CSRF davranışını doğrula; yalnız GET bunu kanıtlamaz.
- [ ] Mobil minimal native push PoC kur; branding'e uygun delivery provider ve secret ownership belirle.
- [ ] Hem normal hem urgent atama ve Talk mesajını **aynı hesapta**, başka resmî Talk client'ı yokken/varken ve stale kayıt varken test et. UA sınıflandırma/native token hash tekilliğini doğrula.
- [ ] Hedefin Web Push API/activation/appTypes desteğini kontrol et; `talk,workhub` aboneliğinin native iOS/Android teslimat + crypto/NSE fizibilitesini kanıtla. Web Push varlığını RN native delivery kanıtı sanma.
- [ ] Hedef için tek transport veya gerekçeli sınırlı transport kombinasyonunu ADR'ye yaz: mobile provider, server registration, relay ihtiyacı, token identities, routing, crypto, rotation, maliyet ve işletim sahibi.
- [ ] İki push türünün zorunlu olarak upstream Talk/Notifications ayarı/değişikliği gerektirdiği kanıtlanırsa açık onay iste; Workhub koduna dokunma. İnternetten rastgele proxy/UA workaround ekleme.
- [ ] Karar sonucunu ve hâlâ eksik credential/altyapı/OS ortamlarını uygulama issue'sunda blocker olarak yaz.

**Çıkış ölçütü:** en az bir fiziksel iOS ve Android'de JS süreci çalışmıyorken Talk mesajı ve normal Workhub ataması ayrı ayrı teslim edilir, doğru hesaba açılır; resmî Talk ile birlikte kayıtlıyken kayıp görülmez. Doğrulanamıyorsa Faz 0 geçmedi; foreground bildirim inbox'ı arka plan push yerine gösterilemez. Fiziksel cihaz bağlı değilse mevcut sim/emulator geliştirme için kullanılabilir ama bu kabulü karşılamaz; test için yeni simulator/emulator yaratma.

Bu kapı bloke olsa bile aşağıdaki auth/foreground UI ve mock sözleşme işleri sürdürülebilir; bildirim tamamlanmış/release-ready denmez.

## 4. Faz 1 — temel proje, güvenli hesap ve beş hedef shell

- [ ] Mobile RN ve desktop Electron/RNW workspace'i oluştur; TypeScript strict, mevcut standartlarla lint/test, minimum CI, lockfile ve temiz kurulum adımları.
- [ ] Beş hedefte Hello/hesap ekranı build smoke; eksik OS/toolchain varsa hangi build'in gerçekten alınmadığını listele.
- [ ] Server URL girişini validate et: HTTPS varsayılan, query/fragment/userinfo reddi, alt dizin korunması, cross-origin yönlendirmede auth header sızmaması; self-signed sertifikayı varsayılan güvenilir sayma.
- [ ] Login Flow v2 başlat → sistem tarayıcısı → sınırlı polling/iptal → app password saklama. Login flow endpoint'lerinin server origin doğrulamasını yap; secret loglama yok.
- [ ] Keychain/Keystore + desktop credential store entegrasyonu; hiçbiri yoksa düz metne sessiz fallback yok. Çoklu hesap ekle/seç/sil ve per-account client/capability/cache.
- [ ] OCS envelope + HTTP error normalizasyonu; auth revoke/401 tekrar giriş; 403 yetki mesajı; 404 stale nesne; 429 Retry-After ve backoff; network timeout/abort. Non-idempotent mutasyonları otomatik replay etme.
- [ ] Core/spreed/Workhub capabilities, feature off/read-only, rol kapıları ve uyumsuz sürüm ekranı. Server admin endpoint'lerini normal kullanıcıya gösterme.
- [ ] Logout sırasında abonelik deregister/uygun token revoke, cache/draft/notification temizliği; diğer hesap etkilenmez. Offline çıkış güvenli çalışır ve başarısız server cleanup açıklanır.

**Kabul:** iki farklı sunucuda aynı username/room/card id çakışmadan çalışır; revoked token tekrar giriş ister; renderer/localStorage/AsyncStorage/Git/log içinde raw şifre/token bulunmaz.

## 5. Faz 2 — Talk ana ekranı ve günlük mesajlaşma

### Ana ekran / UX

- [ ] Varsayılan açılış **Sohbetler**. Son mesaj, okunmamış, arama, pin/favori (capability varsa); offline/loading/empty/error durumları. Mobil alt gezinme: Sohbetler, İşler, Bildirimler; Ayarlar/hesap ayrı. Desktop'ta oda listesi + sohbet iki sütun.
- [ ] `room/v4` ilk liste + desteklenen delta; sunucu timestamp header'ı; silme/çıkarılmada full reconcile. Hesap değişince önceki poll iptal edilir.
- [ ] Oda detay/geçmiş; `X-Chat-Last-Given` cursor, 304 boş sonuç, tarih separator, sender/avatar, pending/sent/failed; virtualized liste. İsim/metinler escaped, rich objects whitelist ile render; HTML çalıştırılmaz.
- [ ] Aktif sohbet için bounded long-poll/reconnect/backoff. Uygulama arka plandayken sonsuz JS poll yok. Resume'da cursor ile catch-up.
- [ ] Pasif preview `setReadMarker=0`; odaklı/görünür sohbet için explicit read. Capability varsa `markNotificationsAsRead=0`; notification dismiss'ini tüm hesapta yanlışlıkla tetikleme.
- [ ] Mesaj composer, klavye/IME, multiline/send, platform shortcut, UTF-8/Türkçe/emoji. Capability'ye bağlı `referenceId`, optimistic server-id uzlaştırma ve ağ sonucu belirsiz kaldığında duplicate önleme.
- [ ] Reply/quote, rich mentions, desteklenen edit/delete/reaction, conversation create/manage/participants/leave ve search; supported feature yoksa buton gizli ve neden açıklı.
- [ ] Draft hesap+oda bazında; kullanıcı gönderene kadar dışarı çıkmaz. Mesaj gövdesi loglanmaz.

### Dosya ve ses notu

- [ ] Dosya seçimi → kontrollü WebDAV upload → Files Sharing shareType 10/room token paylaşımı; yetki, boyut ve dosya türü hataları. Yeni attachment akışı yalnız hedef capability kanıtlıysa.
- [ ] İndirmede sandbox/güvenli dosya adı, kullanıcı onayı; rastgele URL'ye Nextcloud credential eklenmez.
- [ ] Ses notu record/izin/iptal/playback ve `voice-message-sharing` destek kontrolü; canlı aramadan ayrı test.

**Kabul:** iki kullanıcı karşılıklı mesajlaşır; geçmişte gap/duplicate yok; offline send görünür başarısızlık + kontrollü retry; oda erişimi kaldırılınca içerik açılamaz; iki hesap bildirim/oda karışmaz. Dosya ve genişletilmiş işlemler hedef capability ile doğrulanır.

## 6. Faz 3 — bildirim inbox'ı, native quick reply, assignment deep link

Faz 0 taşıma kararı bunun ön koşuludur. Ortak inbox çoğu işi paylaşır; registration ve provider crypto gerçek native sınırında kalır.

### Ortak routing

- [ ] Notifications API list/detail/dismiss, ETag/204/304 ve DND davranışı; `shouldNotify=false` öğesini inbox'ta tut fakat OS alert üretme. Sunucunun UA/aktif resmî Talk Desktop kararını yerel dedup ile ezme. Push'tan tam güvenilir mesaj varsaymak yerine gerektiğinde `nid` detayını getir.
- [ ] Saf ve test edilebilir dispatcher: account → app → object type/id. `spreed` → room/mesaj; `workhub` + card → Workhub task fetch. Unknown payload güvenli inbox'a düşer veya bastırılır; arbitrary URL execution yok.
- [ ] Deep link allowlist'li server origin/path ile parse edilir; pretty `/apps/...` ile `/index.php/apps/...` ve alt dizin kurulumları desteklenir, uygulama içi typed route'a çevrilir. Kullanıcı logout ise auth sonrası güvenli deferred route; multi-account doğru hesabı seçer.
- [ ] Workhub detayına girmeden güncel ACL kontrolü; 403/404 erişim kaldırıldı/görev silindi ekranı, eski bildirim verisini göstermeme. Sunucu atama içeriğini revoke sonrası otomatik redakte etmeyebilir.
- [ ] Gelen/tutulan payload minimum; kilit ekranı varsayılan gizli, kullanıcı opt-in rich preview. Unassign/delete kontrol mesajlarını OS merkezinden kaldır.
- [ ] Foreground'da kendi açık sohbeti için duplicate banner önleme; inbox unread, OS badge ve Talk read marker ayrı yönetilir.

### iOS

- [ ] Marka APNs entitlement, push permission akışı, token rotate, App Group/Keychain paylaşımı ve Notification Service Extension hedefi.
- [ ] NSE: kısa native verify/decrypt/account lookup, gerekli authenticated zenginleştirme; OS süre sınırında genel güvenli fallback. JS runtime başlatmaya bel bağlama.
- [ ] `UNTextInputNotificationAction` quick reply, gerektiğinde unlock/authentication, doğru hesap/room'a native kısa HTTP POST; background completion ve başarısız gönderim görünür. Killed JS'te test et.
- [ ] Ordinary mesaj/görev için alert push; PushKit/CallKit yalnız gerçekten çağrı fazı kabul edilirse.

### Android

- [ ] Marka Firebase yapılandırması veya seçilen desteklenen provider; Android notification runtime izni, chat/workhub ayrı channel ve kullanıcı kontrolü.
- [ ] Native receiver/service + WorkManager ile verify/decrypt/detay/route; native token rotation/re-registration. App JS'i kapalıyken çalışır.
- [ ] RemoteInput receiver/background native reply; güncel hesap auth/room permission, kısa timeout, görünür failure. Notification PendingIntent kimliği hesap/oda ayrımlı ve uygun immutable/mutable politikası.
- [ ] App kullanıcı tarafından force-stop edilirse OS delivery sınırlamasını açıkça belgeleyip relaunch catch-up yap; bunu normal process kill ile karıştırma.

### Windows / macOS / Linux

- [ ] Electron main'de hesap başına notification receive/foreground polling, tray, focus routing ve debounce; renderer kapanınca credential'a erişim sızmaz.
- [ ] Faz 0'da native mobile token yolunu otomatik desktop'a taşımış sayma; browser web push veya açıkken API polling runtime'da doğrulanır. Tamamen quit edilmiş desktop app'e bildirim ancak seçilmiş gerçek background agent/autostart çözümüyle; ilk sürümde tray yaşam döngüsü açıkça anlatılır.
- [ ] macOS reply özelliği, Windows action activation ve Linux freedesktop notification yeteneklerini runtime'da test et. Desteklenen ortamda notification reply/action; destek yoksa **Yanıtla → odaklı compose** fallback. Her OS'te inline reply garantisi verme; kullanıcıya platform desteği görünür olsun.
- [ ] Click/reply başka server credential'ı kullanmaz; main IPC payload'ları validate edilir. Bildirim verisi shell komutuna girmez.

**Kabul:** normal Workhub ataması, urgent atama, Talk mesajı ve silme olayları doğru hesap/nesneye gider; iki native platformda background quick reply mesajı karşı tarafta tam bir kez görünür veya açık hata verir. Normal assignment'ın Talk mesajı olmaması hata sayılmaz. Urgent için iki kanal oluşabilir; app-level routing bunları semantik olarak ayırır. Desktop üç OS davranışı ve fully-quit/tray farkı test raporunda açıkça yazılır.

## 7. Faz 4 — Workhub ilk dikey dilim

- [ ] Workhub `/capabilities` ile Projects gate; feature kapalıysa açıklama. Native ve Deck backend için aynı API client, farklı veri kaynağına doğrudan bağlanma yok.
- [ ] Proje listesi/detay, kanban + list; stack'leri sunucu sırasında göster, task taşıma/sıralama ve server permission'larını uygula. Mevcut stack yeniden sıralama API'si yok; creation-time order ve rename ayrı işlemdir. Mobilde drag zorunlu değil, erişilebilir task Move aksiyonu yeterli.
- [ ] Görev detayı/oluştur/güncelle/sil/taşı; title, açıklama, assignees, priority, tarih, estimate, labels. Assignee/label PATCH tam küme sözleşmesi korunur.
- [ ] Principal araması/assignee seçimi; sunucu rol kuralları, görünür validation errors. İstemci actorId göndererek yetki taklit etmez.
- [ ] Alt işler (`index` + `expectedText`), bağımlılıklar, yorum ekle/listele; yarış/409 kontrolü ve refresh.
- [ ] Notification assignment kartı → task detay → proje bağlamı; 403/404 güvenli; unassign/delete bildirim temizliği doğrulanır.
- [ ] Mutation sonrası ilgili cache invalidation; background/focus ve aktif ekranda ölçülü refresh; offline write queue yok, kullanıcıya retry göster.

**Kabul:** A kullanıcısı B'ye normal görev atar; B arka planda push alır, doğru Workhub task'ı açar; B'yi unassign edince eski bildirim kaldırılır. Aktif gate kapatılınca işlemler devam etmez. Native backend zorunlu, mevcut kurulum Deck kullanıyorsa aynı senaryo Deck üzerinde de çalışır.

## 8. Faz 5 — mevcut Workhub özelliklerinin tamamlanması

Her satır ayrı küçük PR/dikey dilim olabilir. Tek bir Tasks ekranını tüm Workhub yerine sunma. Backend desteklemiyorsa capability/contract nedeniyle disabled olarak kanıtla; kullanıcı erişim yetkisi yokluğu özellik eksikliğiyle karıştırılmaz.

| İş | Kullanıcı akışı / özel kabul |
|---|---|
| [ ] Proje yönetimi | Proje/member/stack oluştur-güncelle, kaynak seçimi ve principals, mevcut API'deki share erişimleri. API'de olmayan member remove uydurulmaz. |
| [ ] Gantt / activity / workload | API görünümü, tarihler ve workload filtreleri; büyük dataset/loading/empty/timezone. Karmaşık chart dependency eklemeden erişilebilir ilk görünüm. |
| [ ] Dashboard | Dashboard/widget CRUD, query/drilldown, kaydetme ve CSV; yetkili filtre/rol; dosya export içerik tipi/indirimi. |
| [ ] Goals | Goal/target/check-in, ownership transfer, card link/unlink; edit izinleri ve zaman aralıkları. |
| [ ] Requests | Context/rapor/list/detail/history, oluştur/yanıtla/resolve/convert; her state'te geçerli action. |
| [ ] Time | Timer start/stop, entry CRUD, week/team/report, period submission/withdraw, review approve/change/reopen; tek aktif timer/sunucu state ve DST/timezone. |
| [ ] Automations / workflows | Stack kuralları, workflow CRUD/sample/handoff/runs, start/cancel/step handoff/skip; read-only durumlar ve denetim izi. |
| [ ] AI | Status/request/proposal/accept/dismiss/cancel; gate kapalı varsayılan, provider hazır değil mesajı; öneri otomatik mutasyon değildir. |
| [ ] Yönetim | Feature/workload/time policy/AI provider/deck import UI yalnız admin. API parola doğrulaması veya güvenli credential adımı desktop/native'de sağlanamıyorsa açık web yönetim bağlantısı + gap kaydı; admin parolası saklanmaz. |
| [ ] Mevcut web gap analizi | Web ekranı ↔ endpoint ↔ mobile/desktop ekranı listesi; task attachment, yorum edit/delete vb. sunucuda olmayan API'ler ayrıca owner kararı. |

**Kabul:** her modül için test hesabı/rol/capability/ekran/endpoint ve doğrulanmış işlemler listesi depoda; yetkisiz istekte 403. Hangi modül geçici web fallback veya upstream API eksikliği taşıyor açıkça işaretlenir; full Workhub tamamlandı etiketi ancak anlaşılmış gap'lerle verilir.

## 9. Faz 6 — güvenlik, test ve beş platform dağıtımı

- [ ] Local credential/cache/push key threat review; TLS origin sınırları, no secret/body logs, deep-link injection ve zengin içerik sanitization; relay minimum retention ve kullanıcı verisi/privacy metni.
- [ ] Electron `contextIsolation`, sandbox, `nodeIntegration=false`, CSP, navigation/new-window allowlist, permission handler ve dar validate edilmiş IPC; local renderer kodu. Unsigned update veya uzak JS yürütme yok.
- [ ] iOS/Android accessibility, keyboard/screen-reader/focus/contrast, büyük yazı, Türkçe metin/tarih; desktop keyboard navigasyonu ve resize.
- [ ] Mevcut test aracını kullan; yeni genel framework veya sahte büyük fixture sistemi ekleme. Sözleşme fixture'ları redakte ve küçük olsun.
- [ ] Typecheck/lint + saf normalization/routing/merge/OCS error testleri CI'da; değişen non-trivial logic'in en az bir runnable regression check'i olsun.
- [ ] Secrets olmadan PR CI; imzalı distribution ayrı protected pipeline. iOS archive/TestFlight, Android signed APK/AAB, Windows signed installer, macOS signing/notarization, Linux paket seçimi ve bildirim/tray bağımlılıkları.
- [ ] CI build matrix host OS'lere uygun; Linux'ta iOS build geçmiş gibi gösterilmez. Hesap/APNs/FCM/signer secret'ları environment/secure store ile.
- [ ] README kurulum/dev/test/build/distribution, push server/proxy ops runbook, token rotate/logout/revoke, known gaps ve minimum desteklenen Nextcloud/Talk/capabilities.
- [ ] Release smoke ve upgrade/migration/rollback kanıtı; otomatik güncelleyici ayrı gerekçe yoksa eklenmez. Sürüm/bundle id insan onaylı tek kaynak.

### Zorunlu test matrisi

| Alan | Senaryo / geçme ölçütü |
|---|---|
| Beş OS | iOS/Android/Windows/macOS/Linux gerçek açılış, giriş, oda listele, mesaj gönder/al, Workhub görev aç; çalıştırılmayan hedef açıkça unsupported/unverified. |
| Auth | Login cancel/timeout, alt dizin server, HTTPS/certificate failure, revoked password, iki sunucu/iki hesap, logout/offline logout; credential leak yok. |
| Talk sync | İlk load/history/cursor/304/reconnect; send timeout sonradan poll'a gelirse duplicate yok; silinen room ve capability/hash değişimi. |
| Chat bildirim | Foreground, background, normal process kill, lock screen, permission denied, DND, token rotate, ikinci resmî Talk client; her destekli durumda teslim/route/reply veya açık OS sınırlaması. |
| Workhub bildirim | Normal/urgent/self assignment, urgent'e yükseltme, unassign/delete, ACL revoke, gate off; duplicate kanal semantiği, doğru task/account ve gizli lockscreen preview. |
| Quick reply | iOS/Android JS yokken; server offline/revoked account/403/room missing/unlock; tam bir kez gönderim veya görünür retry/hata, sessiz kayıp yok. |
| Desktop lifecycle | Renderer kapalı/main tray açık, uygulama fully quit, OS action/reply desteği, Linux GNOME/KDE farkı; resmî Talk Desktop aktifken `shouldNotify=false` OS alert üretmez; neyin garanti edilmediği belgeli. |
| Güvenlik | Cross-origin redirect credential sızıntısı yok; bozuk/imzasız push işlenmez; untrusted URI ve shell/HTML injection çalışmaz; renderer credential alamaz. |
| Workhub modülleri | Native backend; hedefte kullanılıyorsa Deck; member/admin/restricted, feature off, PATCH full-set, subtask race, timer/DST, request/workflow state transition. |
| Lisans/release | Taşınan source/asset lisansları, notice/source erişimi; imzalı kurulum, upgrade ve uninstall. |

Cihaz önceliği: bağlı fiziksel cihaz → varsa mevcut sim/emulator. Test için yeni sim/emulator oluşturma. Push/APNs/FCM/OS lifecycle kabulü yalnız unit test/simulator sonucuyla tamamlanmış işaretlenmez.

## 10. Faz 7 — yalnız kapsam onaylanırsa canlı audio/video çağrıları

- [ ] Desteklenen Talk signaling settings/internal/external HPB, ICE/STUN/TURN ve SDP akışını ayrı ADR/PoC ile seç.
- [ ] RN native WebRTC + desktop WebRTC, mikrofon/kamera/Bluetooth/izin lifecycle; grup çağrısı/reconnect/network switch ve TURN-required ağ testleri.
- [ ] iOS CallKit/uygun PushKit, Android Telecom/foreground service ve arama bildirimi; sıradan mesaj/atamayla ayrı kanallar.
- [ ] Beş OS çapraz çağrı, headset/interrupt/audio route, arka plan çağrı ve güvenli hang-up.

Bu faz ilk mesajlaşma diliminin gizli ön şartı değildir; çağrı desteklenmiyorsa açıkça belirtilir. Önce mesajlaşma/atama ve Workhub tamamlanır.

## 11. Sıralama, riskler ve Opus2 devir sözleşmesi

**Bağımlılıklar:** Faz 0 transport/sürüm kararı → Faz 3 gerçek push. Faz 1 → Faz 2 ve Faz 4. Ortak dispatcher Faz 3 ve Faz 4'ü birleştirir. Faz 4 → Faz 5. Faz 6 kontrolleri baştan uygulanır ve release kapısında yeniden toplanır. Faz 7 ayrı kapsam kararıdır.

Önerilen ilk PR'lar: (1) sürüm/transport PoC ve karar kaydı, (2) workspace + auth/capabilities + beş shell, (3) Talk dikey dilim, (4) native inbox/quick reply + Workhub assignment task, (5+) Workhub modül dilimleri, (son) release evidence. Güvenlik ve test her PR'ın parçasıdır; en sona ertelenmez.

Başlıca riskler: birleşik push yönlendirmesi/provider ownership; kurulu NC/Talk sürüm uyumsuzluğu; Electron'un native widget beklentisinden farkı; native background crypto/reply; API'si olmayan web işlevleri; lisans/mağaza yükümlülükleri; erişilemeyen Windows/Linux test makineleri. Öncelik ilk iki riski kodu büyütmeden çözmektir. Credential veya runtime erişimi yoksa uydurma başarı yerine blocker kaydı bırakılır.

Opus2'nin uygulama görevi şu belgeleri kaynak almalı ve PR/commit linkleriyle aşama kanıtlarını tutmalı. Asgari teslim: beş hedefte doğrulanmış Talk + ilk Workhub dilimi ve gerçek birleşik bildirim; tam iş kapanışı için Faz 5 envanteri ve Faz 6 kabulü gerekir. Web fallback/desktop reply kısıtları kullanıcı kabulüyle açıkça kaydedilmeden kapsam daraltılmaz. Workhub sunucusunda değişiklik zorunlu görünürse önce kanıt/onay; varsayılan sıfır Workhub diff.
