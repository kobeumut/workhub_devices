# Workhub Devices

Workhub Devices is a client for iOS, Android, Windows, macOS and Linux that combines Talk-centric messaging with the existing Nextcloud Workhub features. Users enter their own Nextcloud server address and sign in with Nextcloud Login Flow v2, as in the Talk apps. The server side is the separate repository [`kobeumut/nextcloud_workhub`](https://github.com/kobeumut/nextcloud_workhub).

The mobile app is bare React Native (iOS + Android); the desktop app is Electron + React Native Web (Windows, macOS, Linux). Both share the same TypeScript core and the same React Native UI.

- [PLAN.md](PLAN.md): architecture, work items and acceptance criteria; the progress table is at the top.
- [docs/workhub-modules.md](docs/workhub-modules.md): Workhub module/endpoint/screen matrix and open gaps.
- [docs/adr/0001-push-transport.md](docs/adr/0001-push-transport.md): push decision. [docs/phase0-status.md](docs/phase0-status.md): server verification.
- [docs/dev-server.md](docs/dev-server.md): local test server and live tests. [docs/ios-setup.md](docs/ios-setup.md): Xcode steps.

## Features

- **Talk messaging:** chats, replies, reactions, edit/delete, message search, group and public chats, participants and moderators, file sharing and voice notes; reply directly from a notification.
- **Workhub:** projects with Kanban, Board, Gantt, Activity and Workload views; tasks with comments, subtasks and dependencies; time tracking, requests, goals, dashboards, workflows and AI requests (when enabled on the server).
- **Notifications:** Talk and Workhub notifications through one Web Push subscription, relayed to FCM/APNs (see [Push notifications](#push-notifications-firebase-setup-apns--fcm-added-later)); inbox, badge counts and deep links to the right chat or task.
- **Multiple accounts**, with credentials kept in the platform secret store (Android Keystore, iOS Keychain, the Electron main process).
- **Localization:** English and Turkish (see [Localization](#localization)).

## Repository layout

| Directory | Contents |
|---|---|
| `packages/core` | Platform-independent TypeScript: secure OCS client, Login Flow v2, accounts, Talk, notification routing, Web Push, Workhub API, a single `Backend` interface and desktop IPC validation |
| `packages/features` | Shared React Native UI: login, chats, chat, Workhub (projects/board/task/time/requests/goals), notifications, account. Runs natively on mobile and through React Native Web on desktop |
| `apps/mobile` | iOS + Android (bare React Native 0.88). Native: Keystore/Keychain, FCM service, RFC 8291 decryption, reply from a notification (Android `RemoteInput`, iOS `UNTextInputNotificationAction` + Notification Service Extension) |
| `apps/desktop` | Windows/macOS/Linux: Electron + React Native Web. Credentials live only in the main process; the renderer uses a narrow, validated IPC |
| `services/push-relay` | Web Push → Firebase (FCM/APNs) relay; a Firebase Cloud Function |
| `config/app-identity.json` | App identity (`com.next.workhub`) and push relay address — single source of truth |
| `docs/` | Documentation: architecture decision records (`docs/adr/`), Workhub module matrix, dev server and iOS setup guides, Phase 0 status, test evidence |

## Prerequisites

- Node.js ≥ 22 and npm.
- Mobile: Android SDK + JDK 17 for Android; macOS + Xcode (and Ruby with Bundler for CocoaPods) for iOS.
- Optional: Docker for the local Nextcloud test server ([docs/dev-server.md](docs/dev-server.md)); the Firebase CLI to deploy the push relay.

## Getting started

```bash
npm ci                       # core, features, relay, desktop (workspace)
npm run check                # typecheck + unit tests (core, features i18n parity, relay, desktop package identity)

# Desktop
npm run start -w @workhub-devices/desktop          # build + run
npm run dist -w @workhub-devices/desktop           # electron-builder packages (signing: see Distribution)
npm run dist:linux -w @workhub-devices/desktop     # Linux: release/workhub-<version>-x86_64.AppImage + workhub-<version>-amd64.deb

# Mobile (separate lockfile)
cd apps/mobile && npm ci
npx react-native start                             # Metro
JAVA_HOME=<jdk17> npx react-native run-android     # emulator/device
cd android && ./gradlew :app:testDebugUnitTest     # Kotlin Web Push tests
cd .. && npm run typecheck && npm test             # mobile TypeScript check + Jest
# iOS: docs/ios-setup.md
```

Development builds (`__DEV__`; `WORKHUB_ALLOW_HTTP=1` on desktop) allow `http://` servers for local testing. Production builds accept HTTPS only.

**Version and identity from a single source:** `config/app-identity.json` (`version`, `displayName`, `android.applicationId`/`versionCode`, `desktop.appId`/`executableName`). Android Gradle (`applicationId`, `versionName`, `versionCode`, app name), electron-builder (`apps/desktop/electron-builder.config.cjs`), the in-app "Version" entry and the user agent all read it; bump the version only there (`apps/desktop/test/builder-config.test.mjs` checks that no copies remain).

**Linux packages:** AppImage (`chmod +x` → run; needs FUSE 2, otherwise use `--appimage-extract-and-run`) and deb (`sudo apt install ./workhub-<version>-amd64.deb` → `/opt/Workhub`, "Workhub" in the menu). The deb depends on `libsecret-1-0` for the credential store and recommends `gnome-keyring | kwalletmanager`; without a secret service, login is refused. The package contains only the esbuild/Vite output (no `node_modules`). There is no app icon yet (Electron default) — an icon from the owner is pending.

**Android keyboard (edge-to-edge):** On Android 15/16, `adjustResize` does not shrink the window. The mobile shell pushes the whole app up by the keyboard height (`apps/mobile/src/keyboard.ts`); `KeyboardAvoidingView` is used on iOS only (`keyboardAvoidBehavior`). New screens need no extra keyboard code for Android.

**LogBox (debug only):** warning toasts are disabled because they cover the tab bar and the composer (`apps/mobile/src/devLogs.ts`). Warnings still appear in the Metro terminal and in `adb logcat -s ReactNativeJS`; fatal JS errors still open full screen. Set `WORKHUB_LOGBOX_TOASTS = true` to see the toasts.

### Design (same look as the web Workhub)

- **Theme:** the light variant of the web Workhub's "Obsidian Orbit" design system (`packages/features/src/theme.ts`): slate text, white cards, Nextcloud-blue accent, 6/10/14 px corner radii. Text colors have a contrast ratio ≥ 4.5:1; color never carries meaning on its own (the priority badge adds ▲▲/▲/■/▼ + text).
- **Icons:** [Lucide](https://lucide.dev) (ISC) — a single line-icon family, `packages/features/src/icons.tsx` (`<Icon name="kanban" />`). Mobile uses `lucide-react-native` + `react-native-svg`; the desktop renderer uses `lucide-react` (Vite alias, DOM SVG). Icons are decorative; the accessible name always lives on the control itself. On iOS, run `pod install` again after adding a new native module.
- **Tasks (wide screen, ≥ 900 px):** left navigation as on the web — modules with their icons and projects as colored sub-items (with the open task count); the project workspace is on the right, and the task detail opens as a right drawer. On phones, modules are tabs with icons.
- **Project workspace:** colored header + "Project settings" + "Add task"; views **Kanban** (default), **Board** (accessible sectioned list), **Gantt**, **Activity**, **Workload** (filtered to this project). Kanban and Board have search + filters (only mine, priority, completed).
- **Kanban:** horizontally scrolling columns (on phones a column is ~84% of the screen width, the next column stays visible and scrolling snaps to columns), the web card (#id, priority, title, labels, subtask progress, done checkbox, due badge — overdue/today highlighted, assignee avatars). Quick add with "+" in the column header and "Add task" at the bottom. Moving cards: on every platform through the card menu (left/right, up/down, to a specific list; long press also opens it) — this is the only way on touch and with screen readers; on desktop, mouse drag and drop is available as well. The ordering calculation is the same as on the web (`packages/core/src/board.ts`; cards hidden by a filter are taken into account).
- **Offline design preview:** `npm run preview:shots -w @workhub-devices/desktop` opens the real UI with a fake (fixture) backend, drives the Kanban flow (filter, moving through the card menu, quick add, task drawer, Board) and writes desktop (1440×900) and phone (412×900) screenshots to `apps/desktop/preview-out/`. It is not part of the app package.

### Live tests (against a real Nextcloud)

- `npm run smoke:live -w @workhub-devices/core`: end-to-end API test (14 steps).
- `npm run smoke:tasks -w @workhub-devices/core`: live test for task editing / subtasks / dependencies (same environment variables; `WH_A_REVOKE_PASS` is not needed).
- `npm run smoke:projects -w @workhub-devices/core`: live test for project creation/renaming, columns, adding members, person/group search and goal shares (same environment variables; optional `WH_GROUP`, default `staff`).
- `npm run smoke:time -w @workhub-devices/core`: live test for time entry CRUD, submitting/withdrawing a period, manager review (approve/request changes/reopen), team report and CSV. The Nextcloud manager of `WH_A_USER` must be `WH_B_USER`; `WH_C_USER` must not be anyone's manager.
- `services/push-relay/test/e2e.live.ts`: Nextcloud → relay → decrypt chain.
- `npm run smoke:requests -w @workhub-devices/core`: live test for request approve/reject, resolving without a task, converting to a task, history and report. The manager of `WH_C_USER` must be `WH_A_USER`, and the manager of `WH_A_USER` must be `WH_B_USER`. Each run creates 3 requests + 1 project (there is no delete API).
- `npm run smoke:goals -w @workhub-devices/core`: live test for goal creation/editing, goal target value CRUD, check-in (idempotent) and history, task ↔ goal linking, role gates, archive, ownership transfer and deletion (`WH_A_*` owner, `WH_B_*` share + new owner, `WH_C_*` outsider). Each run creates 1 project + 1 task (there is no project delete API); the goal is deleted.
- `npm run smoke:views -w @workhub-devices/core`: live test for the Gantt payload (dates, dependency type/lag, date conflict), the activity feed (type filters, cursor pagination, no duplicates, invalid cursor) and the workload matrix (distribution of the estimate across working days, board constraint, range limits); non-member 404, module off 403 (`WH_A_*` owner, `WH_B_*` not a member, `WH_C_*` Projects module off). Each run creates 1 project + 3 tasks.
- `npm run smoke:dashboards -w @workhub-devices/core`: live test for dashboard/widget CRUD (version lock, template, Idempotency-Key), settings and filter errors by schema, KPI/distribution results, drilldown (group key, cursor pagination), CSV, the refresh limit (429) and access (foreign 404; a `view` share is read-only and limited to the viewer's own access) (`WH_A_*` owner, `WH_B_*` not a project member, `WH_C_*` Projects module off). Each run creates 1 project + 55 cards; the dashboards are deleted.
- `npm run smoke:workflows -w @workhub-devices/core`: live test for workflow template CRUD (version lock, Idempotency-Key, graph validation: cycle, automatic link to the selected step, unreachable list, assignee who is not a member), sharing (`view`/`edit`), starting a run (linking an existing card, linked/completed card 409), handoff + automatic branch when a card is completed, retrying a failed automatic step, skip, cancel, history and deletion (a running run is cancelled) (`WH_A_*` owner, `WH_B_*` second user, `WH_C_*` Projects module off). Each run creates 2 projects + a few cards; the template is deleted.
- `npm run smoke:talk -w @workhub-devices/core`: live test for the Talk extensions — group/public chat creation, rename + description, invite autocomplete, add/remove participants, promote/demote moderator, reply (quote), mention suggestions, add/remove/list reactions, edit and delete (verified in B's feed, unauthorized 403), message search, leaving and deleting (`WH_A_*` owner, `WH_B_*` counterpart, `WH_C_*` removed participant). The created chats are deleted.
- `npm run smoke:files -w @workhub-devices/core`: live test for Talk files (GENE-58) — single PUT and chunked v2 upload, sharing to the room + caption, name conflict, cancel, voice note (WAV → `voice-message`), B's download/playback (bytes identical), read-only room / non-participant / unsafe-open gates and quota (optional `WH_ADMIN_USER`/`WH_ADMIN_PASS`, dev only: temporary 1 MB quota for C). The room and files are deleted.
- `apps/desktop/scripts/smoke.mjs`: headless desktop UI test. It signs in with a real Login Flow v2, then clicks through and takes screenshots of: sending a message, the project board, task creation and comments, the timer, project management (create, rename, column, member), Talk (new chat, description, participant + moderator, mention, reply, edit, reaction, search, delete; live reflection of B's changes with `WH_B_*`), goal sharing, goal target value + check-in + archive, linking/unlinking a task to a goal, ownership transfer, requests (recipient approve/reject; when `WH_B_*` is given, convert to a task, resolve and report as a manager), notifications and account screens. It creates a temporary goal for the sharing step and deletes it at the end (`WH_SMOKE_MEMBER`, `WH_SMOKE_GROUP` optional). `WH_SMOKE_ROOM` (e.g. `Bob`) is the name of the chat to open. If `WH_SMOKE_BIN` is given, the same test runs against a packaged app (e.g. `release/workhub-0.1.0-x86_64.AppImage` or `/opt/Workhub/workhub` from the deb).

Details are in `docs/dev-server.md`.

## Localization

The UI is available in English (default and fallback) and Turkish. The language follows the device language; users can override it in **Account → Language** (English / Türkçe / Device language).

Texts live in typed catalogs under `packages/features/src/i18n/catalogs/` — one file per screen group, each declared with `defineCatalog(en, tr)`. The compiler enforces that every English key has a Turkish counterpart with the same signature. Shared helpers: `t.<key>` for shared text and `messages.<screen>.<key>` for per-screen text; parameterised and plural texts are functions.

To add a language:

1. In `packages/features/src/i18n/core.ts`, add its tag to `SUPPORTED_LOCALES`, `LOCALE_NAMES` and the `INTL_TAGS` map.
2. Extend `CatalogPair` and every `defineCatalog` call with the new language (the compiler lists the gaps).
3. Add native strings: Android `res/values-<lang>/strings.xml`, the iOS `L10n` helper and the desktop notifier table.
4. Run `npm test -w @workhub-devices/features` (parity tests).

Android and iOS native notification texts follow the OS language; the desktop main process uses `app.getLocale()`.

## Desktop notification behavior

- When the window is closed, the app **keeps running in the tray** and notifications keep arriving (checked every 60 s). Use "Quit" in the tray menu to close it completely; while it is closed, notifications **do not arrive**.
- macOS: inline reply from the notification is supported.
- Windows/Linux: Electron has no in-notification text field. "Reply"/clicking opens the app in the relevant chat (focused composer).
- Lock screen/preview content is hidden by default. No alert is shown when the server has decided that another client will show it (`shouldNotify=false`), or for the chat that is currently open.
- On Linux, credentials are stored with libsecret/KWallet. If neither is available, the app does not fall back to plain text; login is refused.

## Push notifications: Firebase setup (APNs + FCM added later)

App identity: **`com.next.workhub`**. Single source: `config/app-identity.json`. Architecture decision: [docs/adr/0001-push-transport.md](docs/adr/0001-push-transport.md).

**How it works:** Nextcloud sends Talk and Workhub notifications, encrypted, to a single Web Push subscription (`appTypes=talk,workhub`). Nextcloud speaks only the Web Push protocol; FCM and APNs do not accept it for native apps. For this reason a very small Cloud Function (`services/push-relay`) runs inside Firebase. This function:

- verifies that the request was signed by the Nextcloud the app is connected to;
- hands the encrypted content to FCM without decrypting it;
- stores nothing.

FCM delivers to Android directly and to iOS through APNs. There is no separate server, database or proxy to operate; everything lives in the Firebase project.

### 1. Firebase project

1. [Firebase Console](https://console.firebase.google.com) → new project (e.g. `workhub-push`). Switch billing to the **Blaze** plan for Cloud Functions; it is pay-as-you-go and the cost is low at notification volumes.
2. **Add Android app** → package name `com.next.workhub` → download `google-services.json`.
3. **Add iOS app** → bundle ID `com.next.workhub` → download `GoogleService-Info.plist`.
4. Place the files: `google-services.json` → `apps/mobile/android/app/`, `GoogleService-Info.plist` → `apps/mobile/ios/Workhub/` (add it to the target in Xcode). Both are in `.gitignore`; store them as secrets in CI. When the file is present, the Android build applies the Google Services plugin automatically; without it, the build is made with push disabled.

### 2. APNs (iOS)

1. Apple Developer → Certificates, IDs & Profiles → **Keys** → new key with **Apple Push Notifications service (APNs)** checked → download the `.p8` file. Note the Key ID and Team ID. The `.p8` can be downloaded only once; keep it in a password vault.
2. Identifiers → in the `com.next.workhub` App ID, enable **Push Notifications** and **App Groups** (`group.com.next.workhub`). For the NSE, also create the `com.next.workhub.NotificationService` App ID with the same App Group.
3. Firebase Console → Project settings → **Cloud Messaging** → Apple app configuration → **APNs Authentication Key**: upload the `.p8`, Key ID and Team ID. Use the key instead of an APNs certificate; it does not expire and is valid for both sandbox and production.
4. Recommended: request the `com.apple.developer.usernotifications.filtering` entitlement from Apple. It allows delete/control pushes to be processed without becoming visible; without it, the known limitation is documented in the ADR.

### 3. FCM (Android)

FCM is ready once the Android app is added to the Firebase project; no separate key is needed. The relay sends with Firebase's own service account. The app must be built with the package name `com.next.workhub` and with `google-services.json`.

### 4. Deploying the relay function

```bash
npm i -g firebase-tools && firebase login
cd services/push-relay
cp .firebaserc.example .firebaserc            # enter the project ID (not committed to git)
echo "RELAY_ORIGIN=https://europe-west1-<project-id>.cloudfunctions.net" > .env.<project-id>
firebase deploy --only functions:workhub-push-relay
```

- The function URL is `https://europe-west1-<project-id>.cloudfunctions.net/webpush`. The endpoint that apps register becomes `…/webpush/wp/<FCM token>?k=<server VAPID key>`.
- `RELAY_ORIGIN` is the **origin** part of the function URL (without a path). If a custom domain (Firebase Hosting rewrite) is used, enter that origin.
- Enter the relay address in `config/app-identity.json` → `push.relayBase`: `https://europe-west1-<project-id>.cloudfunctions.net/webpush`. While the field is empty, the apps work but do not register for push.

### 5. Nextcloud server

```bash
occ config:app:set notifications webpush_enabled --value=true --type=boolean
```

This is the only setting required; there is no change in the Workhub, Talk or Notifications code. After login, the app fetches the server key with `GET /ocs/v2.php/apps/notifications/api/v2/webpush/vapid`, registers the subscription with `appTypes=talk,workhub` and confirms the activation push. On logout, it deletes the subscription.

### Verification

- `npm test` runs the relay and RFC 8291 decrypt tests.
- `services/push-relay/test/e2e.live.ts` tests the real Nextcloud → relay → (mock FCM) → device-side decrypt chain; the steps to run it are in `docs/dev-server.md`.
- After the Firebase credentials are added, acceptance testing with real FCM/APNs is done on a physical iPhone and Android device. Until then, push counts as "not verified on a device".

## Limits

The Workhub repository was not modified (zero diff). Background notifications for the branded app require its own APNs/FCM credentials, a suitable push infrastructure, and verification of combined Talk + Workhub delivery on a real server. Copying the existing Talk app or merely changing its push URL is not enough. Upstream Talk/Workhub code was not copied; only documented protocols are implemented.

### Known security limit (mobile)

React Native's `fetch` cannot disable redirects. The client rejects a response that redirects away from the server. Android (OkHttp) already drops the `Authorization` header on a redirect to a different host; on iOS this behavior must be verified on a device. Native paths (push, quick reply) do not follow redirects. On desktop, redirects are never followed.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for how to contribute.

## Security

To report a vulnerability, see [SECURITY.md](SECURITY.md). Do not post secrets, tokens or message bodies in issues, commits or logs.

## License

License: not yet specified — see the maintainer.
