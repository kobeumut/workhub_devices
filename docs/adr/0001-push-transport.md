# ADR 0001 — Push transport: Nextcloud Web Push → Firebase (FCM) relay

Status: **Accepted** (2 November 2026, product owner approval: Web Push may be enabled, brand `com.next.workhub`, Firebase instead of a standalone relay where possible)

## Context

- A Talk message and a normal Workhub assignment must arrive in the background on **the same account and the same device**; nothing may be lost when the official Talk app is also installed.
- Notifications 8.0.1 native push v2 sends the Talk family only to Talk-type registrations and other apps (Workhub) only to other registrations. A single native registration cannot safely cover both. In addition, Nextcloud's official push proxy does not deliver to a branded app.
- Notifications 8.0.1 includes Web Push v2: one subscription with `appTypes=talk,workhub` receives both families and is independent of the registrations of other clients.
- Nextcloud sends only with the Web Push protocol (RFC 8030, VAPID-signed, RFC 8291-encrypted). FCM and APNs do **not accept** this protocol for native apps. A very small endpoint that translates the protocol in between is therefore mandatory. "Direct Firebase" is not possible; the closest option is to run this endpoint **inside Firebase** (Cloud Functions).

## Decision

```
Nextcloud (Web Push, VAPID + aes128gcm)
   │  POST https://<relay>/wp/<FCM token>?k=<server VAPID key>
   ▼
Firebase Cloud Function `webpush`  (services/push-relay, stateless)
   │  verifies the VAPID signature with the key pinned in the URL, forwards the encrypted body without opening it
   ▼
FCM ──► Android: FirebaseMessagingService (native decrypt, notification, RemoteInput reply)
   └──► APNs (with the APNs key uploaded to Firebase) ──► iOS Notification Service Extension (native decrypt)
```

- The relay **stores nothing**: no database, no keys, no content. It does not see Nextcloud credentials and cannot decrypt.
- Security: the server's VAPID public key is pinned in the endpoint URL. Only requests signed by that Nextcloud reach the device; even if the URL leaks, nobody else can push.
- Size: Nextcloud pads the content to 2820 bytes and encrypts it (~2.9 KB). Its base64url form is ~3.9 KB, which fits the FCM/APNs 4 KB limit, so the encrypted content is forwarded directly. For larger bodies only `topic=nid<id>` is sent; the app fetches the content with its own identity via `GET notifications/{id}` (404 = deleted).
- Delete events (`delete`, `delete-multiple`, `delete-all`) arrive over the same channel and remove the OS notification.
- Priority: Talk `high`. Workhub and deletes `normal`; because both produce a user-visible notification, they are sent with Android `high` and APNs `10`. `low`/`very-low` are sent with low priority.
- FCM error mapping: unregistered/invalid token → 410 (Nextcloud deletes the subscription). Quota → 429 + Retry-After. Other errors → 503; the subscription is not deleted.

## Consequences

- **No** change is required in the Workhub, Talk or Notifications code. Only an admin setting: `occ config:app:set notifications webpush_enabled --value=true --type=boolean`.
- The Firebase project requires the **Blaze** (pay-as-you-go) plan; Cloud Functions do not run on the free plan. The cost is low at notification volumes; the free quotas are generous.
- iOS: the NSE can modify every alert before it is shown but **cannot hide** it. To process delete/control pushes without making them visible, the `com.apple.developer.usernotifications.filtering` entitlement must be requested from Apple. Until the entitlement arrives, a delete push may appear as a short generic alert; this is a known limitation.
- On iOS, an alert push arrives even if the user force-quits the app. On Android, FCM does not deliver after "Force stop" (an OS rule); the inbox is synced when the app is opened.
- Evidence: `services/push-relay/test/e2e.live.ts`. Real Nextcloud → relay → (mock FCM) → device-side decrypt; Talk + normal assignment + unassign delete passed on a single subscription. Testing with real FCM/APNs and a physical device will be done once the Firebase credentials are added.

## Rejected options

- **Native push v2 + our own proxy:** a single registration is not enough because of the Talk/other split; two registrations are deduplicated by the same token hash; UA spoofing is unacceptable.
- **UnifiedPush:** requires an additional distributor app on Android; no solution for iOS.
- **Periodic background polling:** not real time, and subject to battery and OS limits; it cannot be offered in place of push.
