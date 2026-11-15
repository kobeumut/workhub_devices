# iOS setup (requires macOS + Xcode)

The code is ready but was **not built or verified** in this environment: iOS cannot be built on a Linux server. The steps below are done once on a Mac.

## 1. Dependencies

```bash
cd apps/mobile
npm ci
cd ios && bundle install && bundle exec pod install
open Workhub.xcworkspace
```

## 2. App target (Workhub)

1. **Signing & Capabilities:** select a Team, bundle ID `com.next.workhub`. Add:
   - **Push Notifications**
   - **App Groups** → `group.com.next.workhub`
   - **Keychain Sharing** → `com.next.workhub.shared`

   The `Workhub/Workhub.entitlements` file is ready with these values; point the *Code Signing Entitlements* setting to this file.
2. Add to the project (Add Files → Workhub target): `Workhub/Shared/WorkhubShared.swift`, `Workhub/WorkhubNative.swift`, `Workhub/WorkhubNative.m`. If Xcode asks about a bridging header, accept.

## 3. Notification Service Extension target

1. File → New → Target → **Notification Service Extension**, name: `NotificationService`. Bundle ID: `com.next.workhub.NotificationService`.
2. Delete the `NotificationService.swift` and `Info.plist` files that Xcode created. Add the repository's `NotificationService/NotificationService.swift` and `NotificationService/Info.plist` files to the target.
3. Add the `Workhub/Shared/WorkhubShared.swift` file to **this target too** (Target Membership: Workhub + NotificationService).
4. Capabilities: **App Groups** (`group.com.next.workhub`) and **Keychain Sharing** (`com.next.workhub.shared`). Entitlements file: `NotificationService/NotificationService.entitlements`.
5. The deployment target must be the same as the app's.

## 4. Firebase / APNs (added later)

- Add the `GoogleService-Info.plist` file under `Workhub/` and to the app target. Without the file the app runs, but push stays off.
- The APNs key is uploaded to Firebase ([README → Push notifications](../README.md#push-notifications-firebase-setup-apns--fcm-added-later)).
- The relay URL is written to `config/app-identity.json` → `push.relayBase`.
- Recommended: request the `com.apple.developer.usernotifications.filtering` entitlement from Apple. With this entitlement, delete/activation pushes are processed without becoming visible; without it, a short generic alert may appear.

## 5. Verification (physical iPhone)

1. Log in. "Web Push ready" should appear on the Account screen.
2. Close the app completely.
3. Send a Talk message from another user → a notification arrives; reply with "Reply" → the message appears on the other side **once**.
4. Make a normal Workhub assignment → a notification arrives and opens the correct task.
5. Remove the assignment → the notification disappears from the notification center.
