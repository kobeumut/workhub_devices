# Workhub Devices

Talk merkezli mesajlaşma ve mevcut Nextcloud Workhub özellikleri için iOS, Android, Windows, macOS ve Linux istemcisi.

**Durum: uygulama başladı (GENE-48). Henüz kullanıcıya kurulabilir uygulama yok.** İlk dilim, platformdan bağımsız `packages/core` TypeScript katmanıdır. Mobil (bare React Native) ve masaüstü (Electron + React Native Web) kabukları sonraki PR'larda gelecek. Arka plan push kararı **Faz 0** dış girdilerini bekliyor: [docs/phase0-status.md](docs/phase0-status.md).

- [PLAN.md](PLAN.md): mimari, ayrıntılı işler, bağımlılıklar ve kabul/test ölçütleri (ilerleme bölümüyle).
- [RESEARCH.md](RESEARCH.md): incelenen kaynakların SHA'ları, API sözleşmeleri ve kritik bildirim bulguları.

## Geliştirme

Gereksinim: Node.js ≥ 22, npm (workspace + `package-lock.json`).

```bash
npm ci            # temiz kurulum
npm run typecheck # TypeScript strict
npm test          # node:test ile core sözleşme/regression testleri
npm run check     # ikisi birden (CI bunu çalıştırır)
```

## `packages/core` içeriği

| Modül | Sorumluluk |
|---|---|
| `serverUrl` | Sunucu adresi normalizasyonu: HTTPS zorunlu; userinfo/query/fragment reddedilir; alt dizin korunur; origin+path sınır kontrolü |
| `ocs` | OCS istemcisi: app password Basic auth (UTF-8), `OCS-APIRequest`, redirect takip edilmez (credential sızıntısı yok), 401/403/404/409/429/5xx/timeout normalizasyonu, Workhub hata kodları, güvenli path |
| `loginFlow` | Nextcloud Login Flow v2: login/poll URL'leri sunucu içinde olmalı, sınırlı ve iptal edilebilir polling, farklı origin sonucu reddedilir; logout'ta app password revoke |
| `accounts` | Hesap kimliği (`login|server`), hesap kapsamlı anahtarlar, `SecretStore` arayüzü (Keychain/Keystore/OS store; düz metin fallback yok), offline-güvenli logout |
| `capabilities` | Core/Talk/Notifications/Workhub capability ayrıştırma, uyumluluk kontrolü, Workhub kullanıcı modül gate'i (fail-closed) |
| `talk` | Oda listesi + delta, sohbet geçmişi/long-poll (`setReadMarker=0`), mesaj gönderimi (`referenceId`), optimistic timeline merge/duplicate önleme, HTML'siz rich-object render |
| `routing` | Notifications inbox normalizasyonu, `shouldNotify`, push payload yorumlama (delete kontrolleri), app/object dispatcher, pretty + `/index.php` + alt dizin deep link parser, kilit ekranı gizli önizleme |
| `workhub` | Workhub OCS API v1 istemcisi (proje/board/task/comment), bildirimden task açarken güncel ACL ile yeniden getirme |

`npm test` kaydedilmiş `fetch` yanıtlarıyla çalışır. Gerçek sunucuya karşı uçtan uca kontrol için `npm run smoke:live -w @workhub-devices/core` var; yerel test sunucusu ve ortam değişkenleri: [docs/dev-server.md](docs/dev-server.md). Bunlar cihaz/push doğrulaması değildir.

## Sınırlar

Workhub deposunda değişiklik öngörülmez. Markalı uygulamanın arka plan bildirimleri için kendi APNs/FCM yetkileri, uygun push altyapısı ve Talk + Workhub birlikte teslimatının gerçek sunucuda doğrulanması gerekir. Mevcut Talk uygulamasını kopyalamak veya yalnızca push URL'sini değiştirmek yeterli değildir. Upstream Talk/Workhub kodu kopyalanmadı; yalnız belgelenmiş protokoller uygulanır.
