# Yerel geliştirme/test sunucusu

Bu makinedeki Nextcloud AIO master container'ı (`:8080`) hiç yapılandırılmamış: alan adı yok ve Nextcloud container'ı yok. AIO'nun genel DNS'li bir alan adı ve 443 portu gerektirmesi nedeniyle test sunucusu olarak Workhub reposunun kendi geliştirme compose'u kullanıldı. AIO'ya dokunulmadı.

| | |
|---|---|
| Kaynak | `kobeumut/nextcloud_workhub` `main` @ `a359a4c` (Workhub 0.5.0, bind-mount) — `docker-compose.yml` |
| Compose projesi | `workhub-dev` (nextcloud:35.0.2, mariadb:10.11, redis, cron, workhub_worker) |
| Adres | `http://192.168.0.64:18081` (trusted: `localhost`, `192.168.0.64`, `grisoft-server.local`, Android emulator `10.0.2.2`, hepsi `:18081`) |
| Uygulamalar | Talk (spreed) 25.0.6, Notifications 8.0.1, Deck 1.19.1, Tasks 0.18.1, Workhub 0.5.0 (backend `native`) |
| Test kullanıcıları | `admin`, `alice` + `bob` (grup `staff`), `carol` (kısıtlı: `module_projects_groups=["staff"]`) |
| Yönetici alanı (zaman incelemesi) | `alice`'in yöneticisi `bob`, `carol`'ın yöneticisi `alice` (`PUT /ocs/v2.php/cloud/users/<uid>` `key=manager`, admin ile). `smoke:time` ve masaüstü inceleme adımı buna dayanır |
| Web Push | `webpush_enabled=true` (onaylı). Yalnız dev: `allow_local_remote_servers=true` ve yerel relay'in self-signed sertifikası `occ security:certificates:import` ile güvenilir |
| Secret'lar | Repo dışında, yerel `0600` dosyada; issue/Git/log'a yazılmaz |

Sunucu HTTPS değil (yerel geliştirme). Uygulama `allowInsecureHttp` seçeneği yalnız geliştirme derlemesinde açılır; üretimde HTTPS zorunludur.

## Kurulum (yeniden üretmek için)

```bash
cd nextcloud_workhub            # güncel main
cp .env.example .env            # MYSQL_* için rastgele parola yazın
docker compose -p workhub-dev up -d
docker exec -u www-data workhub-dev-nextcloud-1 php occ maintenance:install \
  --database=mysql --database-host=nextcloud_db --database-name=nextcloud \
  --database-user=nextcloud --database-pass="$MYSQL_PASSWORD" --admin-user=admin --admin-pass="$ADMIN_PASS"
occ config:system:set trusted_domains 1 --value=192.168.0.64:18081
occ config:system:set overwrite.cli.url --value=http://192.168.0.64:18081
occ app:install spreed && occ app:install deck && occ app:install tasks && occ app:enable workhub
occ workhub:doctor
# kullanıcılar: occ user:add --password-from-env <uid>; occ group:add staff; occ group:adduser staff <uid>
# kısıtlı modül: occ config:app:set workhub module_projects_groups --value='["staff"]'
# smoke için app password: occ user:add-app-password --password-from-env <uid>
```

Workhub güncellemek: `git pull` (bind-mount olduğundan) → `occ upgrade` → `occ workhub:doctor`.
Kaldırmak: `docker compose -p workhub-dev down -v` (veriler silinir).

## Canlı smoke

```bash
# WH_SERVER, WH_ALLOW_HTTP=1, WH_{A,B,C}_{USER,PASS}, WH_A_REVOKE_PASS (tek kullanımlık app password)
npm run smoke:live -w @workhub-devices/core
```

`WH_A_REVOKE_PASS` test sırasında revoke edilir; her koşu için yenisi gerekir.

Talepler: `npm run smoke:requests -w @workhub-devices/core` (aynı `WH_*`; zincir `carol → alice → bob`).

Hedefler: `npm run smoke:goals -w @workhub-devices/core` (aynı `WH_*`; `bob` Hedefler modülüne erişebilmeli — devir hedefi).

Proje görünümleri (Gantt, etkinlik, iş yükü): `npm run smoke:views -w @workhub-devices/core` (aynı `WH_*`; `carol` Projeler modülüne erişemez → 403; olaylar saniyelere yayıldığı için koşu ~6 sn sürer).

Dashboard'lar: `npm run smoke:dashboards -w @workhub-devices/core` (aynı `WH_*`; `bob` paylaşılan dashboard'u okur, kaynak projeye erişemez → sonuçlar `restricted`; zorunlu yenileme sınırı nedeniyle koşu ~15 sn sürer).

İş akışları: `npm run smoke:workflows -w @workhub-devices/core` (aynı `WH_*`; `alice` `bob`'un projesine salt okunur üye eklenir → otomatik adım `failed` olur, `edit` paylaşımlı `bob` yeniden dener).

AI: `npm run smoke:ai -w @workhub-devices/core` (aynı `WH_*`; `ai` modülü `staff` grubuna açık → `carol` 403; yönetici AI'yı etkinleştirmiş ve bir sağlayıcı tanımlamış olmalı). Dev sunucuda sağlayıcı "Dev mock" (`http://172.17.0.1.sslip.io:11435/v1`, `authMode=none`, `allowHttpPrivate`, izin listesinde `host:port`) tanımlı ama container'lar host'a ulaşamadığı için istekler `failed` `PROVIDER_TIMEOUT` ile biter (~6 sn). Not: AI worker (`occ workhub:worker --wait=30`) ayarları süreç başında okur; yönetim değişikliğinden hemen sonraki ilk istek eski ayarla `AI_DISABLED` ile iptal olabilir — bir sonraki istek doğru çalışır.

Yönetim (admin) yazma uçları parola onayı ister: yönetici **uygulama parolasıyla** 403 döner; dev hazırlığında yönetici asıl parolasıyla (repo dışı secret dosyası) çağrıldı.

Talk (GENE-57): `npm run smoke:talk -w @workhub-devices/core` (aynı `WH_*`; A grup sohbeti oluşturur, B ve C eklenir/çıkarılır, düzenleme/silme/tepki B'nin feed'inde doğrulanır; oluşturulan sohbetler sonunda silinir, mesaj gövdeleri yazdırılmaz). Masaüstü smoke `WH_B_*` verilirse Talk adımlarında B'yi REST ile oynatır.

Zaman modülü: `npm run smoke:time -w @workhub-devices/core` (aynı `WH_*` değişkenleri; her koşu ileri tarihli farklı bir haftayı kullanır ve kayıtlarını siler).

Talk dosyaları (GENE-58): `npm run smoke:files -w @workhub-devices/core` (aynı `WH_*`; kota adımı için isteğe bağlı `WH_ADMIN_USER`/`WH_ADMIN_PASS` — yönetici **giriş parolası**, repo dışı secret dosyasından; adım C'nin kotasını geçici 1 MB yapıp eski değere döndürür). Dev sunucuda `spreed.config.attachments` = `allowed: true`, `folder: /Talk`, `conversation-subfolders: true`. Masaüstü smoke `WH_B_*` ile dosya/ses notu adımlarını da çalıştırır (Electron sahte mikrofonu).

## Push relay uçtan uca testi (dev)

Host güvenlik duvarı Docker ağından host'a gelen bağlantıları düşürdüğü için relay, Nextcloud ile aynı Docker ağında geçici bir `node:22-alpine` container'ında (`relay-e2e`) çalıştırılır:

```bash
# bir kez: relay-e2e için sertifika (SAN DNS:relay-e2e), Nextcloud'a import, trusted_domains += nextcloud
npx tsc -p services/push-relay/tsconfig.e2e.json && echo '{"type":"commonjs"}' > services/push-relay/.e2e-dist/package.json
docker run --rm --name relay-e2e --network workhub-dev_default --network-alias relay-e2e \
  --env-file <secrets>/e2e.env -e RELAY_BIND=relay-e2e:8789 \
  -e RELAY_CERT=/secrets/relay/cert.pem -e RELAY_KEY=/secrets/relay/key.pem \
  -v $PWD:/repo:ro -v <secrets>:/secrets:ro -w /repo/services/push-relay \
  node:22-alpine node .e2e-dist/services/push-relay/test/e2e.live.js
```

`e2e.env`, `smoke.env` ile aynıdır, yalnız `WH_SERVER=http://nextcloud`.
