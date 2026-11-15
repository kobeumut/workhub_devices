# Workhub Devices

## Read first

- `PLAN.md`: scope, phases and acceptance criteria; update it before starting work and tick the checkboxes as items are completed.
- `RESEARCH.md`: pinned sources and critical version/push routing limits. The development snapshot is not the version of the target server.

## Limits

- This repository started as a plan only; build/test commands now live in the README. When you add new commands, create and run them first, then document them in the README.
- Talk is the main screen; the five targets are iOS, Android, Windows, macOS and Linux. The desktop proposal is RN Web + Electron; native widgets are not guaranteed.
- Do not modify the Workhub repository by default. If it becomes necessary, provide evidence and get approval beforehand.
- A native Talk push subscription does not cover Workhub push. Do not count notification acceptance as complete until combined push feasibility has been proven with a real server/device.
- Do not write secrets, tokens or message bodies to Git, issues or logs. The desktop renderer must not receive raw credentials.
- Build the smallest working vertical slice; do not add a new backend, a generic sync engine, or unnecessary dependencies/abstractions. Every non-trivial change must leave a runnable regression check.
- For testing, prefer a connected physical device; otherwise use an existing simulator/emulator. Do not create a new simulator/emulator for testing. Real native push acceptance is a device test.
- In the PR, state clearly which tests/builds were run, which platforms were not verified and which blockers remain. Do not present a mock/simulator result as production push or as evidence for all five OSes.
- Language: documentation and commit messages are written in English. User-facing UI strings use English source text plus a Turkish translation in the typed catalogs under `packages/features/src/i18n/catalogs/`.
