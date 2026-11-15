# Source and compatibility analysis — GENE-47

Review date: 2 November 2026. Local checkouts and the official API documentation were reviewed; no running Nextcloud server was connected to. The development branch versions below are not the versions installed on the target server.

## 1. Evidence snapshot

| Repository | Commit reviewed | Findings |
|---|---|---|
| kobeumut/nextcloud_workhub | `a359a4c2754f6e983a64112165b7992fa3ecb080` | Workhub 0.5.0, PHP ≥8.2, Nextcloud 34–35; an OCS API suitable for external clients is available. |
| nextcloud/spreed | `a371cacda3db001130f284c268512a546ea37856` | Talk 26.0.0-dev.16; requires Nextcloud 36; PHP server + Vue/TypeScript web client, AGPL-3.0-or-later. |
| nextcloud/talk-ios | `49593aca63e03572eca79f695cd51df573aea20d` | Swift/Objective-C, UIKit, Realm, native notification extensions; not an RN SDK; GPL-3.0-or-later + App Store exception. |
| nextcloud/talk-android | `fd70cfa21e1b320d4eb5cb8b91d88a91fbe2a214` | Kotlin/Java, Views/Compose, Room, WorkManager, WebRTC, FCM/UnifiedPush; not an RN SDK; GPL-3.0-or-later. |
| nextcloud/notifications | `3f87e73a2d4c3c7631681342e9c425a5a61176dd` | 9.0.0-dev.1 / Nextcloud 36; additional review to clarify the notification routing boundary. |
| kobeumut/workhub_devices | empty at the start of the review | `gh repo view` isEmpty=true; no remote ref. The first content is only these research/plan documents. |

**Compatibility result:** Spreed main / Notifications master are not direct installation targets. The current Workhub version is not declared compatible with Nextcloud 36; the optional Workhub Talk bridge is also limited to Talk `>=20,<26`. Compatible stable branch tags must be chosen from the installed version/capabilities results of the real server. Upgrading Workhub merely to use the newest upstream main is not the default for this work.

## 2. Workhub's current contract

Base: `{serverBase}/ocs/v2.php/apps/workhub/api/v1`. Preserve Nextcloud subdirectory installs.

- Basic auth with an app password, `OCS-APIRequest: true`, `Accept: application/json`; JSON write bodies. The result is in `ocs.data`. Do not look at HTTP 200 only; also check the OCS meta status.
- The browser client uses Nextcloud axios/session + requesttoken. The CSRF behavior of an external token client must be tested on the target server; the controllers do not carry a blanket CSRF exemption. Do not solve it by turning security off.
- The actor comes from the server session; a user ID sent by the client does not grant authority.
- The native backend is the default. Deck being installed does not mean Workhub data lives in Deck. Use the Workhub APIs; do not go to the Deck API directly.
- `/capabilities`: per-user module gates, backend, identity/time zone, time team-report permission. The Workhub entry in core capabilities is not a user permission on its own.
- Cache/object key: account + server + backend + object ID. A group boundary within one instance is not strong tenant isolation.

### Feature and endpoint inventory

The paths below are relative to the Workhub API base. Full route list: `appinfo/routes.php:24–161`; DTO examples: `src/services/projectApi.ts:50–179`. A path existing does not mean every user is authorized.

| Area | API surface |
|---|---|
| Projects and sources | `GET/POST /projects`, `GET/PATCH /projects/{boardId}`, `POST /projects/{boardId}/members`, `POST /projects/{boardId}/stacks`, `PATCH /stacks/{stackId}`, `GET /sources/boards`, `/sources/boards/{boardId}`, `/sources/cards`, `/principals` |
| Views | `GET /projects/{boardId}/views/kanban`, `/list`, `/gantt`, `/activity`; `GET /workload`, `/projects/{boardId}/automations` |
| Task | `POST /projects/{boardId}/tasks`, `GET/PATCH/DELETE /tasks/{cardId}`, `POST /tasks/{cardId}/move`, `/tasks/batch` |
| Subtasks/dependencies/comments | `GET/POST /tasks/{cardId}/subtasks`; `PUT/DELETE /tasks/{cardId}/subtasks/{index}`; `POST .../{index}/move`; `POST /tasks/{cardId}/dependencies`, `DELETE .../dependencies/{depId}`; `GET/POST .../comments` |
| Automation/sharing | `GET/PUT /stacks/{stackId}/automations`, `GET/PUT /objects/{type}/{id}/shares` |
| Dashboard | `GET /widget-types`, `GET/POST /dashboards`, `GET/PATCH/DELETE /dashboards/{id}`, add/update/delete widget, `POST .../{id}/query`, `GET .../widgets/{widgetId}/drilldown` |
| Goals | `/goals`, `/goals/{id}`, transfer, targets, checkins, card links and `/cards/{cardId}/goals` |
| Requests | `GET /requests/context`, `/requests/report`, `GET/POST /requests`, `GET /requests/{id}`, history; `POST .../{convert,resolve,respond}` |
| Time | `GET /time/timer`, `POST .../start`, `.../stop`; entries CRUD, week/team/reviews; period submit and submission withdraw/approve/request-changes/reopen |
| Workflow | `/workflows` CRUD, samples/handoffs/card handoffs, start/runs/cancel, step handoff/skip |
| AI | status, requests create/list/read/cancel; proposals read/accept/dismiss; capability off by default |
| Administration | `/admin/features`, `/admin/workload`, `/admin/time/policy`, `/admin/ai/provider` and test/models/secret/usage, `/admin/deck-import`; subject to admin/password-confirmation rules |
| CSV | Non-OCS `GET /apps/workhub/csv/dashboards/{id}/widgets/{widgetId}`, `/apps/workhub/csv/time`; treat as downloads |

Task creation: `stackId` and `title` are required; description/dates/assignees/priority/estimate/labels are optional. PATCH of assignees/labels is a full-set replacement; a subtask is protected by `index` + `expectedText`, so do not assume a persistent subtask UUID. Idempotency-Key exists only on the endpoints that implement it; do not blindly retry every mutation.

Gaps: There is no Workhub realtime/delta subscription or standard offline write replay contract. There is no API to reorder an existing stack: `order` is accepted on creation, and `PATCH /stacks/{stackId}` changes only `title`. Member removal/change, comment edit/delete and a task attachment API are not in this route list. Do not offer fake operations in the UI; the existing web screen can be a safe temporary fallback, but the native feature is not counted as complete. The migration status of all Workhub modules must be tracked separately.

## 3. Assignment notifications are already produced

Native and Deck gateway assignments go through `TaskAssignedEvent` → `AssignmentNotificationService`. Self-assignment is silent; the recipient must have the Projects gate + task access.

```text
app=workhub
objectType=card
objectId=string(cardId)
subject=task-assigned
parameters={actor,title,board,boardId,priority}
link=rtrim(linkToRouteAbsolute('workhub.page.index'), '/') + '/projects/task/' + cardId
```

- In the generic Notifications OCS result the field names are `object_type`, `object_id`; inside the encrypted push they are `type`, `id`, `nid`. Normalize them at the boundary.
- Accept the link in the form the server produces it: the pretty URL `/apps/workhub/projects/task/{cardId}` or an equivalent containing a subdirectory/`index.php`. The deep-link parser must validate both forms and convert them to the same typed route.
- The `deck-card` in the rich subject is used with the native backend as well. For routing, look at `app=workhub` + the `card` identity, not at this type; fetch the task from the Workhub API.
- Unassign clears the task's pending notification for the affected recipient; delete clears it for all recipients. Delete push control messages must also be reflected in the OS notification center.
- The instance settings `workhub/notify_assignment` and `workhub/talk_urgent_message` are on by default (`no` turns them off). No per-user channel preference API belonging to Workhub was found.
- Only an **urgent** assignment also sends a one-to-one Talk message; raising a task to urgent may send a Talk message to existing assignees but does not create a new assignment notification. Normal assignments do not have to appear in a Talk chat.
- Assignments made from the Deck UI outside the Workhub gateway are outside this bridge's scope.
- Titles captured in a notification may not be redacted automatically when the ACL changes; hide content on the lock screen by default and check current access when opening the task.

Evidence: `lib/Notification/AssignmentNotificationService.php:72–218`, `lib/Notification/Notifier.php:53–103`, `lib/Integration/Talk/TalkAdapter.php:34–36,65–112`, `docs/notifications.md:16–20`.

## 4. Talk protocol

| Area | Contract |
|---|---|
| Discovery | `GET /ocs/v2.php/cloud/capabilities`; `spreed.features`, `spreed.config`. API versions vary by feature. |
| Room list/detail | `GET /ocs/v2.php/apps/spreed/api/v4/room[/{token}]`; check `conversation-v4`. |
| Room delta | `modifiedSince` = the previous `X-Nextcloud-Talk-Modified-Before`; not the client clock. When `X-Nextcloud-Talk-Hash` changes, refresh capabilities/signaling. A full refresh is needed for deleted/removed rooms; delta alone is not enough. |
| Message history/live | `GET /ocs/v2.php/apps/spreed/api/v1/chat/{token}`; history `lookIntoFuture=0`, new-message long poll `1`; `X-Chat-Last-Given` cursor. Default 100/max 200; timeout default 30/max 60 seconds; 304 is a normal empty result. |
| Read side effect | For a passive fetch use `setReadMarker=0`; if the capability exists, `markNotificationsAsRead=0`; for a visible and focused chat, perform an explicit mark-as-read. |
| Send/reply | POST `message` to the same chat path, optional `replyTo`, `referenceId` if the capability exists; 201 returns the full message. |
| Deduplication | `referenceId` reconciles the optimistic/poll race. Merge the messages that arrive with a server ID; there is no contract that repeating the same POST is idempotent. When the network result is uncertain, reconcile first, then offer a user-controlled retry. |
| File | WebDAV upload + Files Sharing shareType=10/shareWith=room token. The new attachment/folder flow exists in the development snapshot; do not use it without verifying the capability/version. |
| Search | Core unified search `.../search/providers/talk-message/search`, `talk-message-current/search`; do not write a hypothetical chat-search endpoint. |
| Voice note | File share metadata `messageType=voice-message`, `voice-message-sharing` capability. This is not a live call. |
| Calls | `/api/v3/signaling/settings`, signaling/internal/external, ICE/STUN/TURN, WebRTC, call join/leave and the native audio/permission lifecycle are separate work. REST chat alone does not provide audio/video calls. |

Source: Spreed `docs/conversation.md:16–46`, `docs/chat.md:13–39,123–135,191–215`, `docs/capabilities.md:49,70–75`, `src/store/messagesStore.js:592–605`, `docs/internal-signaling.md:5–56`, `docs/call.md:8–11,38–62`.

## 5. Critical conclusion: a single native Talk push registration does not cover two apps

In the Notifications development snapshot, a native v2 registration is classified by UA as `talk`, `nextcloud` or `unknown`. There is no separate app allowlist for Workhub; there is a distinction between generic and Talk.

| Registrations on the server | Talk family (`spreed`, `talk`, `admin_notification_talk`) | `workhub` and other apps |
|---|---|---|
| At least one Talk-type registration exists | Talk registrations only | Ordinary/unknown registrations only |
| No Talk registration | Ordinary/unknown fallback | Ordinary/unknown registrations |

Therefore, seeing both notification types with a generic registration does not prove that it will keep working once the official Talk app is installed on the same account. Even a stale Talk registration can cut off the fallback. Impersonating Talk's identity is not a solution. `PushController.php:127–140`, `Push.php:229–253,264–306`.

Also, a v2 registration is updated by uid + auth token; when the same push-token hash is registered for the same user's new auth token, the old hash registration is deleted. The approach of **registering the same token twice, once as Talk and once as generic**, is not a valid assumption (`lib/Controller/PushController.php:184–204`).

### Transport options — Phase 0 decision gate

1. **Web Push on a supporting installation:** an independently activated subscription with `appTypes=talk,workhub` or `all` covers both families. The code normalizes Talk aliases to `talk`. Android Talk requests only `talk` in its own registration, so it cannot be copied as-is. RN has no browser Service Worker; this API does not by itself provide native APNs/FCM delivery. The feasibility and operating cost of Android UnifiedPush, or of a brand-owned Web-Push→APNs/FCM endpoint/relay + native decryption/NSE, must be proven on a real device. No support is claimed for iOS without a delivery/extension/crypto PoC.
2. **Native v2 + brand proxy:** a two-step registration contract signed with the token/device key and the account exists. However, combined delivery cannot be guaranteed until the server routing split above is resolved. Different registration identities or an infrastructure change only with version/proxy testing and explicit approval; no automatic double registration or UA spoofing.
3. If there is no safe combined path in the target version: submit the need for a small, isolated change on the Talk/Notifications side for approval, with evidence. **Do not modify the Workhub repository.** Do not market mobile background polling as push; a foreground inbox is only an interim delivery.

Web Push evidence: `lib/Push.php:207–222`, `lib/Controller/WebPushController.php:87–145,321–337`, `docs/webpush-v2.md:169–189`. The `appTypes` string is comma-separated; there is no whitespace/case normalization. The `webpush_enabled` condition, and for a browser session the `webpush_browsers_enabled` condition, must be examined. These version findings must be verified separately on the target.

### Native v2 registration and security

- `POST /ocs/v2.php/apps/notifications/api/v2/push`: `pushTokenHash` (SHA-512), `devicePublicKey` (RSA-2048), `proxyServer` (HTTPS). Token auth is required. The result contains `publicKey`, `deviceIdentifier`, `signature`.
- Proxy `POST /devices`: raw `pushToken`, `deviceIdentifier`, `deviceIdentifierSignature`, `userPublicKey`. On the server side, the proxy registration follows a 201; 200 means the registration already exists; implement reconciliation/rotation carefully.
- Logout: server DELETE push → if needed, proxy DELETE `/devices`; then app password revoke/local wipe. Offline cleanup must not block the user from logging out; track registration cleanup with a retry/retention policy.
- A push carries an encrypted `subject` + `signature`; first verify the signature with the account public key, then decrypt with the device private key. For the full content, use the authenticated `GET notifications/{nid}`. Use the actual crypto contract of the chosen transport; do not mix native-v2 RSA with Web Push RFC8291.
- The delete control events `delete`, `delete-multiple`, `delete-all` are not shown as normal alerts.
- Own bundle/app identities require their own Apple/Google authorized sender; Nextcloud's official proxy does not work automatically for an arbitrary brand. Provider secrets are not put in the app or in Git. The proxy does not collect Nextcloud app passwords and carries a minimal encrypted payload.
- A public HTTPS proxy URL is subject to the core host validator in the registration API; this checkout does not prove a special allowlist setting. Do not guess the configuration name.

### General notification inbox

Base `/ocs/v2.php/apps/notifications/api/v2/notifications`:

- GET list, GET `/{id}` single item, DELETE `/{id}` dismiss. DELETE all only with the relevant capability and an explicit user action.
- `notification_id`, `app`, `object_type`, `object_id`, `link`, subject/message and Rich Object String parameters are present.
- If `shouldNotify=false` in the polling result, keep the item in the inbox but do not raise an OS alert. The server accounts for an active official Talk Desktop session and the UA; local dedup alone does not solve multiple clients (`lib/Controller/EndpointController.php:105–111,315–328`).
- Do not invent undocumented pagination/cursors. Store the ETag if present; handle 304 and an empty body, and, in newer versions, a 200 with identical content. 204 is the signal to reduce polling to once per hour. Respect DND.
- OS badge, chat unread and task inbox are not the same concept; do not mix up read/dismiss semantics.

## 6. Patterns to take from the native examples

| Platform | Evidence | Pattern to adopt / what must change |
|---|---|---|
| iOS | `NotificationServiceExtension/NotificationService.swift:60–176` | Find the account without starting RN, verify/decrypt, safe enrichment; generic fallback at the time/memory limit. |
| iOS | `NextcloudTalk/Notifications/NCPushNotification.swift:82–100` | The current parser rejects non-spreed; Workhub dispatch must be written separately. |
| iOS | `NextcloudTalk/AppDelegate.swift:235–245`, `Notifications/NCNotificationController.swift:372–468` | Authentication-required text-input quick reply; short native background send with the right account + visible error. |
| Android | `app/src/gplay/.../services/firebase/NCFirebaseMessagingService.kt:41–76` | Native FCM reception, token rotation, WorkManager job; not dependent on the JS runtime. |
| Android | `app/src/main/.../jobs/NotificationWorker.kt:183–209,433–486` | Verify/decrypt, account separation; do not copy the Talk-only filter. |
| Android | `app/src/main/.../receivers/DirectReplyReceiver.kt:65–124` | Native reply bound to a specific account/room via RemoteInput; success/error notification. |
| Android | `app/src/main/.../jobs/PushRegistrationWorker.kt:349–356` | Web Push `appTypes=talk`; not suitable for a unified client. |

The `...` notation above stands for the Android source root `java/com/nextcloud/talk`. For the iOS NSE, the App Group and Keychain sharing entitlements must belong to the brand. PushKit/VoIP must not be used for messages/assignments without a real call. On Android, Workhub is classified as normal/alert priority, Talk chat as high/alert, and calls as high/voip; do not make Workhub VoIP/high by trickery (`notifications/lib/Push.php:984–997`).

## 7. Five-platform decision and license

The React Native core focuses on iOS/Android. Windows/macOS are partner out-of-tree ports; the Linux community option does not guarantee native modules and version parity. The recommended single desktop line is Electron + React Native Web: native window/tray/OS notification + web-rendered UI, not three separate native desktop ports. On mobile, native RN runs instead of opening the whole screen in a remote webview.

Electron should use locally packaged code, with sandbox/contextIsolation on and nodeIntegration off, a narrow and validated preload IPC, and a main process that stores the credentials. The renderer must not be given a raw shell/IPC/arbitrary authenticated fetch; no executable code should be loaded from a remote link.

Instead of copying upstream application code/branding, implement the documented protocols. If code has to be ported, the source/notice obligations must be determined by reviewing AGPL/GPL, the App Store exception, transitive dependencies and asset licenses; an exception does not remove GPL obligations. The license of the new repository was not chosen arbitrarily without a human decision.

## 8. Source links

Pinned sources; the paths in the tables are relative to these commits:

- [Workhub routes](https://github.com/kobeumut/nextcloud_workhub/blob/a359a4c2754f6e983a64112165b7992fa3ecb080/appinfo/routes.php#L24-L161)
- [Workhub assignment generation](https://github.com/kobeumut/nextcloud_workhub/blob/a359a4c2754f6e983a64112165b7992fa3ecb080/lib/Notification/AssignmentNotificationService.php#L72-L218)
- [Workhub notifier](https://github.com/kobeumut/nextcloud_workhub/blob/a359a4c2754f6e983a64112165b7992fa3ecb080/lib/Notification/Notifier.php#L53-L103)
- [Workhub Talk version limit](https://github.com/kobeumut/nextcloud_workhub/blob/a359a4c2754f6e983a64112165b7992fa3ecb080/lib/Integration/Talk/TalkAdapter.php#L34-L36)
- [Spreed conversation contract](https://github.com/nextcloud/spreed/blob/a371cacda3db001130f284c268512a546ea37856/docs/conversation.md)
- [Spreed chat contract](https://github.com/nextcloud/spreed/blob/a371cacda3db001130f284c268512a546ea37856/docs/chat.md)
- [Talk iOS push parser](https://github.com/nextcloud/talk-ios/blob/49593aca63e03572eca79f695cd51df573aea20d/NextcloudTalk/Notifications/NCPushNotification.swift#L82-L100)
- [Talk Android Web Push registration](https://github.com/nextcloud/talk-android/blob/fd70cfa21e1b320d4eb5cb8b91d88a91fbe2a214/app/src/main/java/com/nextcloud/talk/jobs/PushRegistrationWorker.kt#L349-L356)
- [Notifications native routing](https://github.com/nextcloud/notifications/blob/3f87e73a2d4c3c7631681342e9c425a5a61176dd/lib/Push.php#L229-L253)
- [Notifications native registration uniqueness](https://github.com/nextcloud/notifications/blob/3f87e73a2d4c3c7631681342e9c425a5a61176dd/lib/Controller/PushController.php#L184-L204)
- [Notifications Web Push filter](https://github.com/nextcloud/notifications/blob/3f87e73a2d4c3c7631681342e9c425a5a61176dd/lib/Push.php#L207-L222)
- [Notifications Web Push API](https://github.com/nextcloud/notifications/blob/3f87e73a2d4c3c7631681342e9c425a5a61176dd/docs/webpush-v2.md)
- [Notifications OCS API](https://github.com/nextcloud/notifications/blob/3f87e73a2d4c3c7631681342e9c425a5a61176dd/docs/ocs-endpoint-v2.md)
- [Native push v2 protocol](https://github.com/nextcloud/notifications/blob/3f87e73a2d4c3c7631681342e9c425a5a61176dd/docs/push-v2.md)
- [Login Flow v2 official documentation](https://docs.nextcloud.com/server/latest/developer_manual/client_apis/LoginFlow/index.html#login-flow-v2)
- [React Native out-of-tree platforms](https://reactnative.dev/docs/out-of-tree-platforms)
- [Electron security guide](https://www.electronjs.org/docs/latest/tutorial/security)

Because no running server/account/APNs/FCM credentials were provided, authenticated API calls, device push, builds and store distribution were not verified. This report does not claim that these tests passed.
