# Local development/test server

The Nextcloud AIO master container on this machine (`:8080`) was never configured: there is no domain name and no Nextcloud container. Because AIO requires a domain name with public DNS and port 443, the Workhub repository's own development compose was used as the test server. AIO was not touched.

| | |
|---|---|
| Source | `kobeumut/nextcloud_workhub` `main` @ `a359a4c` (Workhub 0.5.0, bind-mount) — `docker-compose.yml` |
| Compose project | `workhub-dev` (nextcloud:35.0.2, mariadb:10.11, redis, cron, workhub_worker) |
| Address | `http://<server-ip>:18081` (trusted: `localhost`, `<server-ip>`, `dev-server.example`, Android emulator `10.0.2.2`, all on `:18081`) |
| Apps | Talk (spreed) 25.0.6, Notifications 8.0.1, Deck 1.19.1, Tasks 0.18.1, Workhub 0.5.0 (backend `native`) |
| Test users | `admin`, `alice` + `bob` (group `staff`), `carol` (restricted: `module_projects_groups=["staff"]`) |
| Manager field (time review) | `alice`'s manager is `bob`, `carol`'s manager is `alice` (`PUT /ocs/v2.php/cloud/users/<uid>` `key=manager`, as admin). `smoke:time` and the desktop review step depend on this |
| Web Push | `webpush_enabled=true` (approved). Dev only: `allow_local_remote_servers=true` and the local relay's self-signed certificate is trusted via `occ security:certificates:import` |
| Secrets | Outside the repo, in a local `0600` file; never written to issues/Git/logs |

The server is not HTTPS (local development). The app's `allowInsecureHttp` option is enabled only in development builds; HTTPS is mandatory in production.

## Setup (to reproduce)

```bash
cd nextcloud_workhub            # current main
cp .env.example .env            # set strong passwords for MYSQL_* (use your secret store/env)
docker compose -p workhub-dev up -d
docker exec -u www-data workhub-dev-nextcloud-1 php occ maintenance:install \
  --database=mysql --database-host=nextcloud_db --database-name=nextcloud \
  --database-user=nextcloud --database-pass="$MYSQL_PASSWORD" --admin-user=admin --admin-pass="$ADMIN_PASS"
occ config:system:set trusted_domains 1 --value=<server-ip>:18081
occ config:system:set overwrite.cli.url --value=http://<server-ip>:18081
occ app:install spreed && occ app:install deck && occ app:install tasks && occ app:enable workhub
occ workhub:doctor
# users: occ user:add --password-from-env <uid>; occ group:add staff; occ group:adduser staff <uid>
# restricted module: occ config:app:set workhub module_projects_groups --value='["staff"]'
# app password for the smoke tests: occ user:add-app-password --password-from-env <uid>
```

Updating Workhub: `git pull` (because it is a bind-mount) → `occ upgrade` → `occ workhub:doctor`.
Removing: `docker compose -p workhub-dev down -v` (data is deleted).

## Live smoke

```bash
# WH_SERVER, WH_ALLOW_HTTP=1, WH_{A,B,C}_{USER,PASS}, WH_A_REVOKE_PASS (single-use app password)
npm run smoke:live -w @workhub-devices/core
```

`WH_A_REVOKE_PASS` is revoked during the test; a new one is needed for every run.

Requests: `npm run smoke:requests -w @workhub-devices/core` (same `WH_*`; chain `carol → alice → bob`).

Goals: `npm run smoke:goals -w @workhub-devices/core` (same `WH_*`; `bob` must be able to access the Goals module — he is the transfer target).

Project views (Gantt, activity, workload): `npm run smoke:views -w @workhub-devices/core` (same `WH_*`; `carol` cannot access the Projects module → 403; because events are spread over seconds, a run takes ~6 s).

Dashboards: `npm run smoke:dashboards -w @workhub-devices/core` (same `WH_*`; `bob` reads the shared dashboard but cannot access the source project → results are `restricted`; because of the mandatory refresh limit, a run takes ~15 s).

Workflows: `npm run smoke:workflows -w @workhub-devices/core` (same `WH_*`; `alice` is added as a read-only member to `bob`'s project → the automatic step becomes `failed`, and `bob`, who has an `edit` share, retries it).

AI: `npm run smoke:ai -w @workhub-devices/core` (same `WH_*`; the `ai` module is open to the `staff` group → `carol` gets 403; the admin must have enabled AI and defined a provider). On the dev server the provider is defined as "Dev mock" (`http://<docker-host-ip>.sslip.io:11435/v1`, `authMode=none`, `allowHttpPrivate`, `host:port` on the allowlist), but because the containers cannot reach the host, requests end with `failed` `PROVIDER_TIMEOUT` (~6 s). Note: the AI worker (`occ workhub:worker --wait=30`) reads its settings at process start; the first request right after an admin change may be cancelled with `AI_DISABLED` under the old settings — the next request works correctly.

Administration (admin) write endpoints require password confirmation: with the admin's **app password** they return 403; in the dev setup they were called with the admin's login password (from a secret file outside the repo).

Talk (GENE-57): `npm run smoke:talk -w @workhub-devices/core` (same `WH_*`; A creates a group chat, B and C are added/removed, edit/delete/reaction are verified in B's feed; the created chats are deleted at the end, message bodies are not printed). When `WH_B_*` is given, the desktop smoke plays B through REST in the Talk steps.

Time module: `npm run smoke:time -w @workhub-devices/core` (same `WH_*` variables; each run uses a different future-dated week and deletes its entries).

Talk files (GENE-58): `npm run smoke:files -w @workhub-devices/core` (same `WH_*`; for the quota step, optional `WH_ADMIN_USER`/`WH_ADMIN_PASS` — the admin's **login password**, from a secret file outside the repo; the step temporarily sets C's quota to 1 MB and restores the old value). On the dev server `spreed.config.attachments` = `allowed: true`, `folder: /Talk`, `conversation-subfolders: true`. With `WH_B_*`, the desktop smoke also runs the file/voice-note steps (Electron fake microphone).

## Push relay end-to-end test (dev)

Because the host firewall drops connections from the Docker network to the host, the relay is run in a temporary `node:22-alpine` container (`relay-e2e`) on the same Docker network as Nextcloud:

```bash
# once: certificate for relay-e2e (SAN DNS:relay-e2e), import it into Nextcloud, trusted_domains += nextcloud
npx tsc -p services/push-relay/tsconfig.e2e.json && echo '{"type":"commonjs"}' > services/push-relay/.e2e-dist/package.json
docker run --rm --name relay-e2e --network workhub-dev_default --network-alias relay-e2e \
  --env-file <secrets>/e2e.env -e RELAY_BIND=relay-e2e:8789 \
  -e RELAY_CERT=/secrets/relay/cert.pem -e RELAY_KEY=/secrets/relay/key.pem \
  -v $PWD:/repo:ro -v <secrets>:/secrets:ro -w /repo/services/push-relay \
  node:22-alpine node .e2e-dist/services/push-relay/test/e2e.live.js
```

`e2e.env` is the same as `smoke.env`, except `WH_SERVER=http://nextcloud`.
