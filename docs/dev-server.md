# Yerel geliştirme/test sunucusu

Bu makinedeki Nextcloud AIO master container'ı (`:8080`) hiç yapılandırılmamış: alan adı yok ve Nextcloud container'ı yok. AIO'nun genel DNS'li bir alan adı ve 443 portu gerektirmesi nedeniyle test sunucusu olarak Workhub reposunun kendi geliştirme compose'u kullanıldı. AIO'ya dokunulmadı.

| | |
|---|---|
| Kaynak | `kobeumut/nextcloud_workhub` `main` @ `a359a4c` (Workhub 0.5.0, bind-mount) — `docker-compose.yml` |
| Compose projesi | `workhub-dev` (nextcloud:35.0.2, mariadb:10.11, redis, cron, workhub_worker) |
| Adres | `http://192.168.0.64:18081` (trusted: `localhost`, `192.168.0.64`, `grisoft-server.local`, Android emulator `10.0.2.2`, hepsi `:18081`) |
| Uygulamalar | Talk (spreed) 25.0.6, Notifications 8.0.1, Deck 1.19.1, Tasks 0.18.1, Workhub 0.5.0 (backend `native`) |
| Test kullanıcıları | `admin`, `alice` + `bob` (grup `staff`), `carol` (kısıtlı: `module_projects_groups=["staff"]`) |
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
