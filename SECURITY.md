# Security policy

## Reporting a vulnerability

Please report security issues **privately**; do not open a public issue or pull request for them.

Use GitHub's private vulnerability reporting: open the **Security** tab of this repository and choose **Report a vulnerability**. Include the affected component (mobile, desktop, shared packages or push relay) and version, the steps to reproduce and the impact you expect. We aim to acknowledge a report within a few working days and will keep you informed while it is fixed.

If private reporting is not available on the repository, open an issue that only asks for a private contact channel and contains no details of the problem.

## Supported versions

Security fixes are made on the `main` branch and shipped with the next release. Older releases are not patched.

## Design notes relevant to security

- Users sign in with Nextcloud Login Flow v2 in the system browser; the app stores an app password, never the account password. Credentials are kept in the platform secret store (Android Keystore, iOS Keychain, Electron `safeStorage` in the main process) and are never given to the desktop renderer, written to logs or put in web storage.
- Production builds accept HTTPS servers only. Redirects are not followed with credentials, and login and API URLs are validated against the server the user chose.
- The desktop app runs the renderer with context isolation and sandboxing, a strict Content-Security-Policy, a narrow validated IPC surface and no navigation or window opening outside the app.
- The push relay (`services/push-relay`) never decrypts notification content and stores nothing; it only verifies the Web Push signature and forwards the encrypted payload to FCM/APNs.
- No secrets belong in the repository. Firebase configuration (`google-services.json`, `GoogleService-Info.plist`), signing keys and certificates are ignored by Git and must be provided by your CI as secrets. The committed `debug.keystore` is the public React Native template keystore, used for debug builds only.
- Live smoke tests and the development server guide read all credentials from `WH_*` environment variables; nothing is hardcoded.

## If you find a leaked secret

Treat any credential, token or key found in the repository or its history as compromised: report it privately as described above so it can be rotated.
