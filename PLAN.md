# Workhub Devices implementation plan — GENE-47

## GENE-89 — unread and presence (6 November 2026)

- [x] Account-scoped server unread reconciliation (5 s in the foreground), room + tab totals, refresh after a successful/visible read; no local increment on repeated events.
- [x] Desktop focus/visibility; mobile AppState + Android blur/focus drive the read/poll/foreground-route lifecycle. No mark-read without a FlatList visibility notification; account/room changes and cleanup isolate stale results.
- [x] Capability-gated user-status heartbeat (60 s); stops in the background without touching invisible/DND preferences, preserving the server's expiry behavior. Offline/away is never written.
- [x] Accessible server presence in the room/header/participants; unknown, background and failed refreshes are not shown as online.
- [x] GENE-90 combined scope: `PlatformServices.setBadgeCount` → Electron dock/tray, iOS native badge, Android silent count notification; cleared on zero/logout/account switch. Platform/permission limits are in `docs/test-evidence.md`.
- [x] `npm run check`: core 154 + relay 8 + desktop 3; mobile typecheck and Jest 5; desktop build passed. Regression tests for Backend/IPC, repeated events, multiple rooms, reconciliation, visible reads, rate limit and lifecycle.
- [ ] Live message with two users → badge → visible read → decrease, and presence on the other side: **unverified**. The dev server was not reachable from this working environment; no live user inputs.
- [ ] Real desktop/mobile smoke, native badge and push verification: **unverified**. The Electron smoke opened the login screen but login could not be completed; the Android offline build stopped because of a missing Kotlin cache; iOS Pods are missing. The detailed Gap/test matrix is in `docs/test-evidence.md`.

## Goal and current status

Talk chats will be the home screen; users will be able to reply from within a message notification, work with their Workhub tasks, and open tasks assigned to them from a notification. Targets: iOS, Android, Windows, macOS, Linux. The new code lives in `kobeumut/workhub_devices`; the Workhub server's existing API is preserved.

**This commit is not the implementation; it is the research/plan deliverable to be implemented.** The implementation owner is Opus2 - Full Stack Developer; the implementation sub-task is **GENE-48** (`01a19b2b-08c3-7f23-8e55-c92c866995a1`). Each phase must be delivered in small PRs with the acceptance criteria below and real test evidence. Until Phase 0 is resolved, do not claim that background push works on five platforms.

### Planning deliverable

- [x] Review the Spreed, Talk iOS, Talk Android, Workhub and Notifications sources.
- [x] Record the API/notification routing and version compatibility risks (`RESEARCH.md`).
- [x] Write the shared architecture, work order and measurable acceptance/test plan.
- [x] Push the documents to the Workhub Devices remote and verify the link/SHA (first plan commit `cd0566f`).
- [x] Check existing tasks and assign the implementation to Opus2 as a single new sub-task (GENE-48).

The implementation checkboxes are intentionally empty at the start; having written the plan does not mean the implementation/testing is complete.

## Implementation progress (GENE-48)

| Phase | Status | Evidence |
|---|---|---|
| 0 — version/push gate | Server verified (NC 35.0.2 / Talk 25.0.6 / Notifications 8.0.1 / Workhub 0.5.0). Transport: Web Push `talk,workhub` → Firebase relay (ADR 0001). Nextcloud → relay → decryption e2e passed. **Remaining (the owner will add):** Firebase project, APNs key, `relayBase`; physical-device acceptance | `docs/phase0-status.md`, `services/push-relay` |
| 1 — foundation/auth | `packages/core` + `Backend`; desktop (Electron+RNW) and mobile (RN 0.88) shells; Keystore/Keychain/safeStorage; multi-account; logout + revoke | `npm run check`, desktop smoke |
| 2 — Talk | Room list + search + delta, history, long-poll, mark as read, optimistic send/`referenceId` reconciliation, rich objects (no HTML). GENE-57: reply/quote, edit/delete (age + role rule), reactions (add/remove/list), mention suggestions + highlighting, message search (unified search), create/rename/describe room, add/remove participants, moderator, leave/delete — all gated by `talkFeatures` + a fresh room read; changes show up live on the other side through the system messages in the feed. GENE-58: file upload (WebDAV, chunked v2, quota pre-check, progress/cancel/retry) + room sharing (caption, reply), download/open (main process on desktop), voice note (WAV) recording/sharing/playback. Missing: jumping to an older message in search, iOS native file/audio module | desktop smoke, `smoke:talk`, `smoke:files` |
| 3 — notifications | Inbox + routing; Android FCM service, native decryption, RemoteInput reply, channels, hidden content on the lock screen; iOS NSE + reply (**not compiled**); desktop notification + tray, macOS inline reply, focused compose on the others | Kotlin RFC test, push e2e |
| 4 — Workhub | Project/board/task create-open-move-complete-comment, assignment notification → task (ACL-checked). GENE-49: task field editing, assignment with a person picker, subtasks, dependencies, refreshing project counters. GENE-61: project/column/member management, goal shares | desktop smoke, API smoke, `smoke:tasks`, `smoke:projects` |
| 5 — modules | Time native (GENE-50: timer, week, entry CRUD, submit/withdraw period, review, team report, CSV), Requests native (GENE-51: list, create, approve/reject, resolve without a task, convert to task, history, report), Goals native (GENE-52: create/edit/archive/delete, target value CRUD, check-in + history, task ↔ goal linking, ownership transfer), project views native (GENE-53: read-only accessible Gantt + dependencies, paginated activity feed, person × day workload matrix), Dashboard native (GENE-54: dashboard/widget CRUD, schema-driven settings + filters, result tables + bars, drilldown → task, CSV, sharing), Workflows native (GENE-55: template CRUD + step editor, activate, sharing, start/cancel, handoff/retry/skip, run history, handoffs on the task screen), AI native (GENE-56: gated by `modules.ai`; status/quota, summary/question/draft requests, plain-text result, cancel, history, draft preview + accept/reject) and linking a task to a time entry (GENE-56). The only flow that goes to the web: Workhub administration by Nextcloud admins (password confirmation; the app does not take the admin password — decision in `docs/workhub-modules.md`, awaiting user approval). A successful AI answer/draft acceptance was not verified live because the dev server has no network access to the provider | `docs/workhub-modules.md`, `smoke:time`, `smoke:requests`, `smoke:goals`, `smoke:views`, `smoke:dashboards`, `smoke:workflows`, `smoke:ai` |
| 6 — distribution | Version/identity single source `config/app-identity.json` (Gradle + electron-builder + in-app version). GENE-59: Linux AppImage + deb built, desktop UI smoke 33/33 on both in packaged form; Android 16 keyboard/edge-to-edge and debug LogBox issues fixed, emulator walkthrough. Missing: signing/store, Windows/macOS packages, app icon | README, `docs/test-evidence.md` |
| Design (GENE-62) | Web Workhub "Orbit" light theme, Lucide icon set (mobile SVG / desktop DOM SVG), on wide screens the web's left navigation + project workspace + task drawer, **Kanban** view (horizontal columns, web card, move via the card menu and by drag-and-drop on desktop, quick add in a column), search/filter bar, project Workload tab. The live desktop smoke could not be run because the dev server changed | `board.test.ts`, `npm run preview:shots`, Android APK + JS bundle |
| 7 — calls | **Scope approved (GENE-62 item 3)**; implementation in a separate sub-task | — |

The checkboxes below are ticked only when the item is completed in a real environment; mock tests of the core logic alone do not complete an item.

## 1. Decisions and scope boundary

| Topic | Decision / rationale |
|---|---|
| Mobile | Bare React Native + TypeScript. A Swift notification service extension and a Kotlin FCM/RemoteInput receiver/worker are required; a JS-only notification plan is not sufficient. |
| Desktop | React Native Web + Electron: a single desktop UI and main/preload pipeline for Windows/macOS/Linux. This path is recommended instead of three separate ports/bindings with RN Windows + RN macOS + community Linux. It is not a webview that wraps a remote Nextcloud page. |
| Native desktop expectation | Electron provides native windows/OS integration but does not guarantee native RN widgets. This distinction must be written into the acceptance record; only if native widgets are a hard requirement should Linux feasibility be decided separately. |
| Shared code | The same TypeScript domain, API contracts, capability policy, notification routing and RN/RNW feature components. Small adapters only at real platform boundaries; no generic plugin/event-bus/DI system. |
| Auth | Per-device app password via Nextcloud Login Flow v2. The main password is never taken or stored. Multi-server/account isolation from day one. |
| Talk | A new client using the official OCS API/capability protocol; do not import the iOS/Android apps assuming they are RN SDKs. |
| Workhub | Workhub OCS API v1; the native/Deck backend distinction is left to the server. Default: zero diff in the Workhub repo. |
| Push | **Open decision gate.** A native Talk-type push subscription does not receive Workhub generic push. A single generic subscription, on the other hand, can lose the Talk fallback once the official Talk registers on the account. A joint delivery path must be proven in Phase 0. |
| Live data | Talk uses the supported chat long-poll; Workhub uses focus/foreground refresh + push invalidation. No unproven WebSocket or background polling service. |
| Local data | Small account-scoped cache/drafts; SQLite only for message/draft storage that is truly needed. No generic offline mutation queue or sync engine. |
| Versions | Capability negotiation against the installed Nextcloud/Talk/Notifications versions. Choose RN/RNW/Electron/native dependency versions at the start of the implementation using official compatibility tables and the lockfile; do not mistake development mains for production. |
| License | Protocol implementation; if upstream code/assets are to be carried over, check license/notice/source and trademarks beforehand. Never silently copy GPL/AGPL code into proprietary code. |

### Release scope

1. **First usable slice:** login/account on five platforms, Talk room list/chat/messages, mobile background notification + quick reply, desktop OS notification/reply action, Workhub project/task/assignment inbox/deep link. This is not a claim that all of Workhub is complete.
2. **Full Workhub:** the capability-enabled operations in the module inventory below. Web functions that do not exist in the API are explicitly in the gap list; a safe web fallback does not make them count as natively complete.
3. **Talk extension:** reply/edit/delete/reaction/search/mention, files and voice notes, room/participant management. Support is always capability-checked.
4. **Audio/video calls:** the user specifically asks for messaging here; calling is a separate estimate/decision gate. It does not count as complete on its own; if accepted, Phase 7 is implemented. While calls are not available, call buttons are not shown and PushKit is not used for messages.

## 2. Initial file layout and trust boundary

Create a package only when real sharing emerges:

```text
apps/mobile/          RN iOS/Android + ios notification extension + android workers
apps/desktop/         Electron main, narrow preload, RNW renderer
packages/core/        account, OCS/Talk/Workhub client, DTOs and pure routing
packages/features/    chat, Workhub, inbox; shared RN components
```

No separate npm package per feature, no new backend and no new server table is needed. Use a single workspace tool/manager and commit the lockfile to the repo. The first PR contains only the two apps that come up and the core that is actually shared.

**Trust boundary:** mobile secrets live in Keychain/Keystore; desktop secrets in the OS credential store + main process. The Electron renderer only calls validated domain operations; there is no fetch proxy that attaches credentials to an arbitrary URL, no `shell`, no unrestricted IPC and no raw app password access. The native extension and the main process do the minimum notification/quick-reply work while the JS screen is closed.

**Core data keys:** `accountId`, normalized `serverBase` (subdirectory preserved), Talk `roomToken`, message server id, Workhub backend + `cardId`, Notification `notification_id`. The same card/room id must never merge across accounts. API responses and deep-link parameters are a trust boundary and are validated.

## 3. Phase 0 — version and combined push feasibility (first, blocking work)

Required external inputs: test server URL/installed versions, two normal users + one restricted user, Workhub/Talk/Notifications access; brand bundle/application ID; Apple Developer/APNs and Firebase/FCM entitlements; relay hosting/approval if needed; five OS test environments and distribution signing owners. Secrets are never written to an issue or Git. These have not been provided in this planning work yet.

- [x] Record the core and user Workhub capabilities output with redactions; build a version matrix for Nextcloud/Talk/Notifications/Workhub and native/Deck.
- [x] Compare Workhub's Nextcloud 34–35 and Talk adapter `>=20,<26` constraint against the real installation; the Talk 26/Notifications 9 development snapshot used in the review is for NC36. Select compatible stable versions.
- [x] Run a smoke test with Login Flow v2/app password: Talk room + Workhub project + Notifications GET. Also verify the OCS auth/CSRF behavior by making a reversible Workhub POST/PATCH with `OCS-APIRequest: true` without a browser cookie/requesttoken and reading back the persisted state; GET alone does not prove this.
- [ ] Build a minimal native push PoC on mobile; determine a delivery provider that fits the branding and secret ownership.
- [ ] Test both normal and urgent assignments and a Talk message **on the same account**, with and without another official Talk client and with a stale registration. Verify UA classification/native token hash uniqueness.
- [ ] Check the target server's Web Push API/activation/appTypes support; prove native iOS/Android delivery + crypto/NSE feasibility for a `talk,workhub` subscription. Do not mistake the existence of Web Push for proof of RN native delivery.
- [x] Write a single transport, or a justified limited combination of transports, for the target into an ADR: mobile provider, server registration, relay need, token identities, routing, crypto, rotation, cost and operating owner.
- [x] If it is proven that the two push types necessarily require an upstream Talk/Notifications setting/change, ask for explicit approval; do not touch the Workhub code. Do not add random proxy/UA workarounds from the internet.
- [x] Write the decision outcome and the credentials/infrastructure/OS environments that are still missing as blockers in the implementation issue.

**Exit criterion:** on at least one physical iOS and one physical Android device, with the JS process not running, a Talk message and a normal Workhub assignment are delivered separately and open on the correct account; no loss is seen while registered together with the official Talk. If this cannot be verified, Phase 0 has not passed; a foreground notification inbox cannot be presented in place of background push. If no physical device is connected, an existing simulator/emulator can be used for development but does not satisfy this acceptance; do not create a new simulator/emulator for testing.

Even if this gate is blocked, the auth/foreground UI and mock contract work below can continue; notifications are not declared complete/release-ready.

## 4. Phase 1 — base project, secure account and five target shells

- [ ] Create the mobile RN and desktop Electron/RNW workspace; TypeScript strict, lint/test with the existing standards, minimal CI, a lockfile and clean-install steps.
- [ ] Build smoke of a Hello/account screen on five targets; if an OS/toolchain is missing, list which build was not actually produced.
- [ ] Validate server URL input: HTTPS by default, reject query/fragment/userinfo, preserve the subdirectory, no auth header leak on cross-origin redirects; do not trust self-signed certificates by default.
- [ ] Start Login Flow v2 → system browser → bounded polling/cancel → store the app password. Validate the server origin of the login flow endpoints; never log secrets.
- [ ] Keychain/Keystore + desktop credential store integration; if none is available, no silent fallback to plain text. Multi-account add/select/remove and per-account client/capability/cache.
- [ ] OCS envelope + HTTP error normalization; auth revoke/401 re-login; 403 permission message; 404 stale object; 429 Retry-After and backoff; network timeout/abort. Do not automatically replay non-idempotent mutations.
- [ ] Core/spreed/Workhub capabilities, feature off/read-only, role gates and an incompatible-version screen. Do not show server admin endpoints to normal users.
- [ ] On logout, deregister the subscription/revoke the appropriate token, clean up cache/drafts/notifications; other accounts are unaffected. Offline logout works safely and a failed server cleanup is explained.

**Acceptance:** the same username/room/card id works on two different servers without collisions; a revoked token prompts for re-login; no raw password/token appears in the renderer/localStorage/AsyncStorage/Git/logs.

## 5. Phase 2 — Talk home screen and everyday messaging

### Home screen / UX

- [ ] The default landing screen is **Chats**. Last message, unread, search, pin/favorite (if the capability exists); offline/loading/empty/error states. Mobile bottom navigation: Chats, Tasks, Notifications; Settings/account separate. On desktop, room list + chat in two columns.
- [ ] `room/v4` initial list + supported delta; server timestamp header; full reconcile on deletion/removal. The previous poll is cancelled when the account changes.
- [ ] Room detail/history; `X-Chat-Last-Given` cursor, 304 empty result, date separators, sender/avatar, pending/sent/failed; virtualized list. Names/texts are escaped, rich objects are rendered through a whitelist; HTML is never executed.
- [ ] Bounded long-poll/reconnect/backoff for the active chat. No endless JS polling while the app is in the background. Catch up with the cursor on resume.
- [ ] Passive preview uses `setReadMarker=0`; explicit read for a focused/visible chat. If the capability exists, `markNotificationsAsRead=0`; do not accidentally trigger notification dismissal across the whole account.
- [ ] Message composer, keyboard/IME, multiline/send, platform shortcuts, UTF-8/Turkish/emoji. Capability-dependent `referenceId`, optimistic server-id reconciliation, and duplicate prevention when the network outcome stays uncertain.
- [x] Reply/quote, rich mentions, supported edit/delete/reaction, conversation create/manage/participants/leave and search; if a feature is not supported, the button is hidden and the reason is explained. (GENE-57; `smoke:talk` + desktop smoke, two users. Jumping from search to a message older than the loaded window is an open item)
- [ ] Drafts are per account + room; they do not leave the device until the user sends. The message body is never logged.

### Files and voice notes

- [x] File selection → controlled WebDAV upload → Files Sharing shareType 10/room token share; permission, size and file type errors. The new attachment flow is used only if the target capability is proven. (GENE-58: `attachments.allowed` gate, quota pre-check + 507, chunked v2, progress/cancel; `smoke:files` + desktop smoke)
- [x] Sandbox/safe file name and user confirmation on download; Nextcloud credentials are never attached to an arbitrary URL. (GENE-58: own WebDAV path from a fresh message, save dialog, "Open" only for safe types; `hide-download` is enforced but cannot be set on a Talk 25 room share — Gap)
- [x] Voice note record/permission/cancel/playback and the `voice-message-sharing` support check; tested separately from live calls. (GENE-58: WAV; desktop smoke with a fake microphone; no iOS native module, button hidden. GENE-59: on the Android emulator, recording → `voice-message` → playback, attaching/saving via SAF and opening via FileProvider were verified)

**Acceptance:** two users exchange messages; no gaps/duplicates in history; an offline send shows a visible failure + controlled retry; content cannot be opened once room access is removed; notifications/rooms of two accounts do not mix. Files and extended operations are verified against the target capability.

## 6. Phase 3 — notification inbox, native quick reply, assignment deep link

The Phase 0 transport decision is a prerequisite for this. The shared inbox covers most of the work; registration and provider crypto stay at the real native boundary.

### Shared routing

- [ ] Notifications API list/detail/dismiss, ETag/204/304 and DND behavior; keep an item with `shouldNotify=false` in the inbox but do not raise an OS alert. Do not override the server's UA/active official Talk Desktop decision with local dedup. Instead of assuming a fully trustworthy message from the push, fetch the `nid` detail when needed.
- [ ] A pure, testable dispatcher: account → app → object type/id. `spreed` → room/message; `workhub` + card → Workhub task fetch. An unknown payload safely falls into the inbox or is suppressed; no arbitrary URL execution.
- [ ] Deep links are parsed against an allowlisted server origin/path; pretty `/apps/...` and `/index.php/apps/...` as well as subdirectory installations are supported, and they are converted into an in-app typed route. If the user is logged out, a safe deferred route runs after auth; multi-account selects the correct account.
- [ ] Check the current ACL before entering the Workhub detail; 403/404 shows an access-removed/task-deleted screen and does not show old notification data. The server may not automatically redact assignment content after revoke.
- [ ] Keep the received/stored payload minimal; the lock screen is hidden by default, with an opt-in rich preview by the user. Unassign/delete control messages remove the notification from the OS notification center.
- [ ] In the foreground, prevent duplicate banners for the user's own open chat; inbox unread, OS badge and Talk read marker are managed separately.

### iOS

- [ ] Brand APNs entitlement, push permission flow, token rotation, App Group/Keychain sharing and the Notification Service Extension target.
- [ ] NSE: short native verify/decrypt/account lookup, authenticated enrichment where needed; a generic safe fallback when the OS time limit hits. Do not rely on starting a JS runtime.
- [ ] `UNTextInputNotificationAction` quick reply, unlock/authentication when required, a short native HTTP POST to the correct account/room; background completion and failed sends are visible. Test with JS killed.
- [ ] Alert push for ordinary messages/tasks; PushKit/CallKit only if the calls phase is actually accepted.

### Android

- [ ] Brand Firebase configuration or the chosen supported provider; Android notification runtime permission, separate chat/workhub channels and user control.
- [ ] Native receiver/service + WorkManager for verify/decrypt/detail/route; native token rotation/re-registration. Works while the app's JS is not running.
- [ ] RemoteInput receiver/background native reply; current account auth/room permission, short timeout, visible failure. The notification PendingIntent identity is separated per account/room and uses the appropriate immutable/mutable policy.
- [ ] If the user force-stops the app, document the OS delivery limitation explicitly and catch up on relaunch; do not confuse this with a normal process kill.

### Windows / macOS / Linux

- [ ] Per-account notification receive/foreground polling, tray, focus routing and debounce in the Electron main process; credential access does not leak once the renderer closes.
- [ ] Do not assume the Phase 0 native mobile token path carries over to desktop automatically; browser web push or API polling while the app is open is verified at runtime. A notification to a fully quit desktop app is possible only with a chosen real background agent/autostart solution; the first release explains the tray lifecycle explicitly.
- [ ] Test the macOS reply feature, Windows action activation and Linux freedesktop notification capabilities at runtime. Notification reply/action where supported; otherwise fall back to **Reply → focused compose**. Do not promise inline reply on every OS; make platform support visible to the user.
- [ ] Click/reply never uses another server's credentials; main IPC payloads are validated. Notification data never enters a shell command.

**Acceptance:** a normal Workhub assignment, an urgent assignment, a Talk message and deletion events go to the correct account/object; on two native platforms, a background quick reply message appears exactly once on the other side or gives an explicit error. A normal assignment having no Talk message is not a bug. Two channels may occur for urgent; app-level routing separates them semantically. The desktop behavior on the three OSes and the fully-quit/tray difference are written explicitly in the test report.

## 7. Phase 4 — first Workhub vertical slice

- [ ] Gate Projects via Workhub `/capabilities`; explain when the feature is off. The same API client for the native and Deck backends; no direct connection to a different data source.
- [ ] Project list/detail, kanban + list; show stacks in server order, apply task move/ordering and server permissions. There is no existing stack reorder API; creation-time order and rename are separate operations. Drag is not required on mobile; an accessible task Move action is sufficient.
- [ ] Task detail/create/update/delete/move; title, description, assignees, priority, date, estimate, labels. The assignee/label PATCH full-set contract is preserved.
- [ ] Principal search/assignee selection; server role rules, visible validation errors. The client does not impersonate authority by sending an actorId.
- [ ] Subtasks (`index` + `expectedText`), dependencies, add/list comments; race/409 handling and refresh.
- [ ] Notification assignment card → task detail → project context; 403/404 handled safely; unassign/delete notification cleanup is verified.
- [ ] Invalidate the relevant caches after a mutation; measured refresh on background/focus and on the active screen; no offline write queue, show the user a retry.

**Acceptance:** user A assigns a normal task to user B; B receives a push in the background and opens the correct Workhub task; when B is unassigned, the old notification is removed. Operations stop once the active gate is turned off. The native backend is required; if the existing installation uses Deck, the same scenario also works on Deck.

## 8. Phase 5 — completing the existing Workhub features

Each row can be a separate small PR/vertical slice. Do not present a single Tasks screen as all of Workhub. If the backend does not support something, prove it as disabled because of the capability/contract; a user's lack of access permission is not confused with a missing feature.

| Item | User flow / specific acceptance |
|---|---|
| [x] Project management | Project/member/stack create-update, source selection and principals, share access in the existing API. A member remove that does not exist in the API is not invented. **GENE-61:** create/rename project, create/rename column, add member with a person/group picker, goal shares native (`smoke:projects` 9/9, desktop smoke 12/12). Member removal, column deletion and project deletion do not exist in the API (Gap). Dashboard/workflow sharing will be wired through the shared editor in those modules' slices; source selection (`/sources/*`) in the Goals/Dashboard slices. |
| [x] Gantt / activity / workload | API view, dates and workload filters; large dataset/loading/empty/timezone. An accessible first view without adding a complex chart dependency. **GENE-53:** Board → Gantt: no chart library, a list sorted by date + a visual (hidden from screen readers) proportional bar; each row states the date/milestone, delay, assignees, "Waits for / Blocks" dependencies (type, lag days) and date conflicts in text; undated tasks are separate. Board → Activity: type filter, search, "Older" pagination with a cursor (deduplication). Tasks → Workload: person × day table (`role=table`, a full screen-reader label per cell, load also as text), 1/2-week navigation, cell → that day's tasks → task. The Backend gate is fail-closed (`PROJECTS_DISABLED`); strict filter/cursor/range in IPC (≤120 days, days that do not exist in the calendar are rejected). The Gantt and workload web links under "More" were removed. `smoke:views` 6/6, desktop smoke 22/22. Open item (client): drag-to-schedule/zoom/critical path in the Gantt, choosing the dependency type/lag, a person/date filter UI in the activity feed, a project/person picker in the workload (these exist in the APIs). Capacity settings are in the admin web. |
| [x] Dashboard | Dashboard/widget CRUD, query/drilldown, save and CSV; authorized filters/roles; file export content type/download. **GENE-54:** Tasks → Dashboard: list (paginated), create (blank / project summary template, source projects; Idempotency-Key), edit (title, description, time zone, auto-refresh, sources, global filter; `version`), delete, share (`SharesEditor`). Add/edit/remove widgets: types exposed to the user, settings fields from the `/widget-types` schema (int/enum/bool/idList), filter fields supported by the type, size. Results: KPI count (count/%/hours), distribution and trend as an accessible table + a decorative bar with no extra dependency, goal progress, card list, AI text as plain text; partial/restricted/ignored filters stated in text; Refresh (429 explained). Drilldown: KPI/distribution group/list → card table (cursor-paginated) → task. CSV: save/share. The Backend gate is fail-closed (`DASHBOARD_DISABLED`) + role from a fresh detail (`DASHBOARD_EDIT_REQUIRED`/`DASHBOARD_MANAGE_REQUIRED`); in IPC the FilterSpec/ConfigSchema shape, limits, grid, cursor. `smoke:dashboards` 12/12, desktop smoke 23/23. Open item (client): column/label/assignee filter picker, viewer filter UI, drag-to-arrange layout, goal picker. |
| [x] Goals | Goal/target/check-in, ownership transfer, card link/unlink; edit permissions and time ranges. **GENE-52:** create/edit goal (title, description, end date), archive/reactivate, delete; number/currency/yes-no/task target values (add, edit, remove; server decimal format); check-in (absolute/delta/yes-no, note, Idempotency-Key) and history; linked goals on the task screen, link/unlink; ownership transfer (person picker). Actions are visible only through server role flags + lifecycle; the Backend gate is fail-closed (`GOALS_DISABLED`, with a fresh detail `GOAL_EDIT_REQUIRED` / `GOAL_MANAGE_REQUIRED` / `GOAL_ARCHIVED`); refresh on a `version` 409. `smoke:goals` 9/9, desktop smoke 20/20. Gap: target weight and type change do not exist in the API; check-in history is at most 100 records (no pagination). The goal dashboard widget comes with the Dashboard slice. |
| [x] Requests | Context/report/list/detail/history, create/respond/resolve/convert; valid actions in every state. **GENE-51:** recipient approve/reject (rejection reason required), manager resolve without a task and convert to a task with a project/column picker, detail + linked task + history, filtered report table. Actions are visible only through server flags (`canRespond`, `canManage` + `open`); the Backend gate is fail-closed (`REQUESTS_DISABLED`, `REQUEST_MANAGER_REQUIRED`); refresh on a `version` 409. `smoke:requests` 9/9, desktop smoke 17/17. Open item: choosing a recipient other than the manager (API exists). |
| [x] Time | Timer start/stop, entry CRUD, week/team/report, period submission/withdraw, review approve/change/reopen; a single active timer/server state and DST/timezone. **GENE-50:** create/edit/delete entry (range + duration, wall clock in the period's time zone → UTC, DST-tested; read-only in a locked period), submit/withdraw period, manager review (approve, request changes with a reason/reopen; the `canViewTeamReport` gate is fail-closed), accessible team report table, CSV (own/team; desktop save dialog, mobile share sheet). `smoke:time` 11/11, desktop smoke 15/15. Open item: card-linking picker on an entry; policy management is in the admin web. |
| [x] Workflows | Workflow CRUD/sample/handoff/runs, start/cancel/step handoff/skip; read-only states and audit trail. **GENE-55:** Tasks → Workflows: Waiting for you (hand off / retry / skip; a form filled from the server preview, only changed fields, Idempotency-Key) and Templates (create from a blank canvas or from a sample; edit title/description/category, activate/deactivate, share, delete). Step editor: start mode + triggering list, first step, add/remove steps, project → list picker, fixed/selected assignee + allowlist, due day, title/description template + placeholders, ⚡/✋ links; the server's graph rules are mirrored live on the client (cycle, auto-link to a selected step, step without a list/inaccessible step, unknown placeholder). Run: start (title, link an existing card, assignee on the selected first step, description, due date), history (last 50, progress, steps, card → task), confirmed cancel. Task screen: handoffs originating from that card. The Backend gate is fail-closed (`PROJECTS_DISABLED`) + role and step checks from a fresh detail/run (`WORKFLOW_EDIT_REQUIRED`/`WORKFLOW_MANAGE_REQUIRED`, `WORKFLOW_DISABLED`, `WORKFLOW_NO_ENTRY`, `WORKFLOW_STEP_HANDLED`, `ACTION_FORBIDDEN`, `WORKFLOW_RUN_FINISHED`); a client-side version guard for delete since the server has no CAS; graph shape and limits in IPC. `smoke:workflows` 17/17, desktop smoke 24/24. Gap: no handoff notification (server). Remaining on the web: drag-to-position on the canvas. |
| [ ] Automations | Stack rules (subtask/assignment automation when a card is moved to a column); read-only states and audit trail. |
| [ ] AI | Status/request/proposal/accept/dismiss/cancel; gate off by default, a "provider not ready" message; a suggestion is not an automatic mutation. |
| [ ] Administration | Feature/workload/time policy/AI provider/deck import UI for admins only. If API password verification or a secure credential step cannot be provided on desktop/native, an explicit web administration link + a gap record; the admin password is never stored. |
| [ ] Existing web gap analysis | Web screen ↔ endpoint ↔ mobile/desktop screen list; APIs that do not exist on the server, such as task attachments and comment edit/delete, are an additional owner decision. |

**Acceptance:** for every module, the test account/role/capability/screen/endpoint and the list of verified operations are in the repo; 403 on an unauthorized request. Which modules carry a temporary web fallback or an upstream API gap is marked explicitly; the "full Workhub complete" label is given only together with the agreed gaps.

## 9. Phase 6 — security, testing and five-platform distribution

- [ ] Threat review of local credentials/cache/push keys; TLS origin boundaries, no secret/body logs, deep-link injection and rich-content sanitization; relay minimum retention and a user-data/privacy text.
- [ ] Electron `contextIsolation`, sandbox, `nodeIntegration=false`, CSP, navigation/new-window allowlist, permission handler and narrow validated IPC; local renderer code. No unsigned updates or remote JS execution.
- [ ] iOS/Android accessibility, keyboard/screen-reader/focus/contrast, large text, Turkish text/dates; desktop keyboard navigation and resize.
- [ ] Use the existing test tooling; do not add a new generic framework or a fake large fixture system. Contract fixtures must be redacted and small.
- [ ] Typecheck/lint + pure normalization/routing/merge/OCS error tests in CI; every changed non-trivial piece of logic gets at least one runnable regression check.
- [ ] PR CI without secrets; signed distribution in a separate protected pipeline. iOS archive/TestFlight, Android signed APK/AAB, Windows signed installer, macOS signing/notarization, Linux package choice and notification/tray dependencies. (GENE-59: Linux package choice AppImage + deb; deb dependencies `libnotify4`, `libsecret-1-0`, recommends `gnome-keyring | kwalletmanager`.)
- [ ] The CI build matrix fits the host OSes; an iOS build is not shown as passed on Linux. Account/APNs/FCM/signer secrets via the environment/secure store.
- [ ] README setup/dev/test/build/distribution, push server/proxy ops runbook, token rotate/logout/revoke, known gaps and minimum supported Nextcloud/Talk/capabilities.
- [ ] Release smoke and upgrade/migration/rollback evidence; an auto-updater is not added without a separate justification. The version/bundle id is a single human-approved source. (GENE-59: version/bundle id single source `config/app-identity.json` ✓ — Gradle, electron-builder and the in-app version read it; Linux AppImage/deb release smoke ✓. Upgrade/rollback evidence is open.)

### Mandatory test matrix

| Area | Scenario / pass criterion |
|---|---|
| Five OSes | Real launch, login, list rooms, send/receive messages, open a Workhub task on iOS/Android/Windows/macOS/Linux; a target that was not run is explicitly marked unsupported/unverified. |
| Auth | Login cancel/timeout, subdirectory server, HTTPS/certificate failure, revoked password, two servers/two accounts, logout/offline logout; no credential leak. |
| Talk sync | Initial load/history/cursor/304/reconnect; no duplicate if a send times out and later shows up in the poll; deleted room and capability/hash change. |
| Chat notifications | Foreground, background, normal process kill, lock screen, permission denied, DND, token rotation, a second official Talk client; in every supported case delivery/route/reply, or an explicit OS limitation. |
| Workhub notifications | Normal/urgent/self assignment, escalation to urgent, unassign/delete, ACL revoke, gate off; duplicate channel semantics, correct task/account and hidden lock screen preview. |
| Quick reply | iOS/Android with no JS running; server offline/revoked account/403/room missing/unlock; sent exactly once or a visible retry/error, no silent loss. |
| Desktop lifecycle | Renderer closed/main tray open, app fully quit, OS action/reply support, Linux GNOME/KDE differences; while the official Talk Desktop is active, `shouldNotify=false` raises no OS alert; what is not guaranteed is documented. |
| Security | No credential leak on cross-origin redirects; a malformed/unsigned push is not processed; untrusted URI and shell/HTML injection do not work; the renderer cannot obtain credentials. |
| Workhub modules | Native backend; Deck if used on the target; member/admin/restricted, feature off, PATCH full-set, subtask race, timer/DST, request/workflow state transitions. |
| License/release | Licenses of carried-over source/assets, notice/source access; signed installation, upgrade and uninstall. |

Device priority: a connected physical device → an existing sim/emulator if there is one. Do not create a new sim/emulator for testing. Push/APNs/FCM/OS lifecycle acceptance is not marked complete based only on unit test/simulator results.

## 10. Phase 7 — live audio/video calls, only if the scope is approved

- [ ] Choose the supported Talk signaling settings/internal/external HPB, ICE/STUN/TURN and SDP flow through a separate ADR/PoC.
- [ ] RN native WebRTC + desktop WebRTC, microphone/camera/Bluetooth/permission lifecycle; group call/reconnect/network switch and TURN-required network tests.
- [ ] iOS CallKit/appropriate PushKit, Android Telecom/foreground service and call notification; separate channels from ordinary messages/assignments.
- [ ] Cross-OS calls across the five OSes, headset/interrupt/audio route, background call and safe hang-up.

This phase is not a hidden prerequisite of the first messaging slice; if calls are not supported, this is stated explicitly. Messaging/assignment and Workhub are completed first.

## 11. Ordering, risks and the Opus2 handoff contract

**Dependencies:** Phase 0 transport/version decision → Phase 3 real push. Phase 1 → Phase 2 and Phase 4. The shared dispatcher joins Phase 3 and Phase 4. Phase 4 → Phase 5. Phase 6 checks are applied from the start and collected again at the release gate. Phase 7 is a separate scope decision.

Recommended first PRs: (1) version/transport PoC and decision record, (2) workspace + auth/capabilities + five shells, (3) Talk vertical slice, (4) native inbox/quick reply + Workhub assignment task, (5+) Workhub module slices, (last) release evidence. Security and testing are part of every PR; they are not deferred to the end.

Main risks: combined push routing/provider ownership; incompatibility between the installed NC/Talk versions; Electron's difference from the native widget expectation; native background crypto/reply; web functions that have no API; license/store obligations; unreachable Windows/Linux test machines. The priority is to resolve the first two risks without growing the code. If credentials or runtime access are missing, leave a blocker record instead of a fabricated success.

Opus2's implementation task must take these documents as its source and keep the per-stage evidence with PR/commit links. Minimum delivery: Talk verified on five targets + the first Workhub slice and real combined notifications; closing the whole work requires the Phase 5 inventory and Phase 6 acceptance. The scope is not narrowed unless the web fallback/desktop reply limitations are explicitly recorded with user acceptance. If a change on the Workhub server appears mandatory, evidence/approval comes first; default zero Workhub diff.

## GENE-92: Story points

- [x] Story points in the task edit form (Fibonacci chips + an integer field, 0–1000), a "Points" row in the task detail, open points / count of unpointed tasks per person in the Workload matrix; PATCH `storyPoints` is in the allowlist. The server contract is Workhub 0.5.1 (ADR-0006); the field does not exist on an older server and is treated as empty.
- [x] `npm run check` passed (typecheck + 154 core tests). No live server/device verification was done: **unverified**.
