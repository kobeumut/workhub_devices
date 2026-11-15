# Phase 0 — version and combined push decision gate: status

Date: 2 November 2026 · Task: GENE-48 · Status: **Server + transport decision complete (ADR 0001); real FCM/APNs and device testing pending**

Phase 0 tests cannot be done without a real server and device. The following were **missing** in this run, so no Phase 0 item is counted as "passed":

| Required input | Status | Why it is needed |
|---|---|---|
| Test Nextcloud + versions | **resolved**: local Docker development server (`docs/dev-server.md`) | The matrix below |
| 2 normal + 1 restricted test users | **resolved**: `alice`, `bob`, `carol` (restricted) | Smoke tests |
| Brand bundle/app ID | **resolved**: `com.next.workhub` (`config/app-identity.json`) | APNs/FCM, NSE App Group |
| Relay hosting | **resolved**: Firebase Cloud Function (`services/push-relay`), no separate server | ADR 0001 |
| Firebase project + APNs `.p8` key | **to be added later** (README "Push notifications: Firebase setup") | Real delivery |
| Physical iOS and Android devices | not connected to this machine (`adb devices` is empty; no macOS/Xcode) | The Phase 0 exit criterion is accepted only with a physical device |
| Windows and macOS test machines | none (Linux host only) | Desktop notification/reply measurement, signed build |

## Server verification (2 November 2026, `npm run smoke:live`, 14/14 PASS)

| Component | Version | Note |
|---|---|---|
| Nextcloud | 35.0.2 | Within Workhub 0.5.0's range (34–35) |
| Talk (spreed) | 25.0.6 | Within the Workhub Talk adapter's `>=20,<26`; urgent messages enabled (`workhub:doctor`) |
| Notifications | 8.0.1 | push capability: `devices, object-data, delete`; Web Push API present, **off by default** |
| Workhub | 0.5.0 (`a359a4c`), API v1, backend `native` | Deck 1.19.1 is installed but task storage is native |

Smoke steps and results:

- Capabilities + compatibility check (`checkCompatibility` is empty).
- Login Flow v2: start, the login/poll URLs staying on the server, and an unapproved poll's 404→`expired`. The browser approval was not automated; for the smoke, app passwords were obtained with `occ user:add-app-password` (same token type).
- Workhub per-user gate: `alice` projects=true, `carol` projects=false.
- Talk: 1:1 room; send with `referenceId`; a single copy in the history on B's side; a passive fetch does not decrease the unread count; long-poll delivers the new message; the `spreed`/`chat` notification to B is routed to the correct room.
- Workhub write with **only an app password + `OCS-APIRequest`, without cookie/requesttoken**: create project (Idempotency-Key; repeating with the same body → same project; same key with a different body → `409 IDEMPOTENCY_KEY_REUSED`), add member, create a task assigned to B, PATCH, read back. No OCS auth/CSRF problem.
- A normal assignment produces a `workhub`/`card` notification for B (not a Talk message), link `/apps/workhub/projects/task/{id}` → task route; the task opens with the current ACL.
- `carol` cannot open the task (`PROJECTS_DISABLED` → feature_off). Unassign deletes B's notification. The deleted task is `gone` for B.
- Logout revokes the app password; the next request returns 401.

Finding: the task DTO `url` field has a different form from the notification link: `/apps/workhub/projects/{boardId}/board?card={cardId}`. The parser supports both (regression test added).

### Target server result for push

- On Notifications 8.0.1 the native push v2 routing is the same as in the reviewed snapshot: the Talk family goes only to Talk-type devices, the others (Workhub) only to other devices (`lib/Push.php:229-236`). A single native registration cannot safely cover both families.
- Web Push v2 is present in the same version and the `appTypes` filter supports `talk`/`all` (`Push.php:207-215`). However, the admin setting `webpush_enabled` is off by default: `occ config:app:set notifications webpush_enabled --value=true --type=boolean`. This setting had not been turned on yet at that point; turning it on is an infrastructure decision.
- Therefore path A (Web Push `appTypes=talk,workhub`) is **feasible** on this server. The remaining work is on the client side: the brand relay (Web Push endpoint → APNs/FCM) and RFC8291 decrypt in the iOS NSE and the Android worker.

## Web Push → relay end-to-end (2 November 2026)

`webpush_enabled` was turned on. Real Nextcloud 35.0.2 / Notifications 8.0.1 → local relay (`services/push-relay`, the same code will run on Firebase) → mock FCM → device-side RFC 8291 decrypt with `core`:

- `appTypes=talk,workhub` registration → the activation push was decrypted → activated.
- The Talk message **and** the normal Workhub assignment arrived on **the same subscription**; the route is correct (`room` / `task`).
- Unassign → a delete push with a `nid` topic arrived.
- The relay returned 201 for all 6 pushes. The encrypted Talk body is 3896 B in base64url; it fits the FCM/APNs 4 KB limit.

Finding: Nextcloud's web-push library produces the VAPID `aud` value without the port (`scheme://host`). The relay was fixed accordingly and a test was added; in production it makes no difference on port 443.

## Questions awaiting a decision (product owner) — answered as of 2 November 2026

1. Test server: URL and versions. Workhub 0.5.0 supports NC34–35; if the server is NC36, Workhub compatibility is a separate decision.
2. Push transport preference. According to the code review there are two candidates:
   - **A — Web Push `appTypes=talk,workhub`** (if the target Notifications version supports it). A single subscription covers both families, but it needs a brand-owned Web-Push→APNs/FCM relay and native RFC8291 decrypt (iOS NSE / Android worker).
   - **B — Native push v2 + brand proxy**. Because of the server's UA classification, a single registration does not guarantee Talk + Workhub together; a change/approval on the Talk/Notifications side may be needed.

   **Decision: A**, with a relay inside Firebase (ADR 0001).
3. Relay hosting: **Firebase Cloud Functions**; stateless, stores nothing.

## What was done in the meantime (does not replace push acceptance)

- `packages/core`: secure OCS client, Login Flow v2, account isolation, capability gate, Talk chat/room logic, notification dispatcher, deep link parser, Workhub task opening. 35 contract/regression tests with a mock `fetch`. These were **not verified** against a real server.
- Push payload interpretation (`interpretPush`) is for the JSON **after** native-v2/Web Push decrypt; the crypto and transport code will be written after the Phase 0 decision.

## To run when the Phase 0 smoke test arrives

1. `GET /ocs/v2.php/cloud/capabilities` (to be redacted and added to this file).
2. `GET /ocs/v2.php/apps/workhub/api/v1/capabilities`, the Talk `room` list, the Notifications list.
3. A reversible Workhub write: create a task in a test project (`Idempotency-Key`) → PATCH the title → read → delete; only app password + `OCS-APIRequest: true`, no cookie/requesttoken.
4. Whether the Notifications `push` capability and the Web Push endpoints (`/apps/notifications/api/v2/webpush`) exist.
