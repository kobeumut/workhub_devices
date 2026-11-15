# Contributing

Thank you for helping with Workhub Devices. This guide explains how to set up the project, what a good change looks like and how it gets merged.

## Before you start

- Read the [README](README.md) for the repository layout, prerequisites and build commands, and [PLAN.md](PLAN.md) for the scope, phases and acceptance criteria. [AGENTS.md](AGENTS.md) lists the working rules (it is written for coding agents but applies to everyone).
- For anything larger than a small fix, open an issue first and describe the problem and your proposed approach.
- Report security problems privately, as described in [SECURITY.md](SECURITY.md). Do not open a public issue for them.
- The server side lives in the separate `nextcloud_workhub` repository. Do not change it from here; if a server change is needed, open an issue with evidence.

## Workflow

1. Fork the repository and create a feature branch from `main`.
2. Make a focused change. One pull request should do one thing; do not mix refactoring with behavior changes. Build the smallest working slice and avoid new dependencies or abstractions you do not need.
3. Every non-trivial change leaves a regression check behind (a unit test, or a live smoke step documented in `docs/dev-server.md`).
4. Run the checks below.
5. Open a pull request against `main`. State which tests and builds you ran, which platforms you did **not** verify and which blockers remain. A simulator or mock result is not evidence for a real device or for all five operating systems; real push delivery is a device test.

## Language and localization

- **Code, identifiers, comments, documentation and commit messages are English.**
- Every user-facing text lives in the typed catalogs under `packages/features/src/i18n/catalogs/`. Add the English source text and its Turkish translation together with `defineCatalog(en, tr)`; the compiler and the parity test (`npm test -w @workhub-devices/features`) reject a missing translation. Use `t.<key>` for shared texts and `messages.<screen>.<key>` for screen texts; write whole sentences (functions for parameters and plurals), never concatenate translated fragments.
- Text that is read when a module is imported would freeze the language: read catalog values at render time.
- Native notification texts follow the OS language: Android `res/values*/strings.xml`, the iOS `L10n` helper, the desktop `src/main/i18n.ts` table.
- To add a language, follow the steps in the Localization section of the [README](README.md).

## Security rules for changes

- Never write secrets, tokens, server addresses of private environments, personal data or message bodies to Git, issues, logs or test fixtures. Live tests read credentials from the `WH_*` environment variables only.
- The desktop renderer must never receive raw credentials; credentials live in the platform secret store (Android Keystore, iOS Keychain, Electron `safeStorage` in the main process).
- Production builds accept HTTPS servers only; `http://` is for development builds.

## Checks

```bash
npm ci
npm run check            # typecheck + unit tests: core, features (i18n parity), push relay, desktop

# Mobile has its own lockfile
(cd apps/mobile && npm ci && npm run typecheck && npm test)
```

Native code (Kotlin, Swift) and the live smoke tests need Android/iOS tooling or a Nextcloud test server; see [docs/dev-server.md](docs/dev-server.md) and [docs/ios-setup.md](docs/ios-setup.md).

## Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/) with an English description, for example `feat(talk): …`, `fix(desktop): …`, `docs: …`, `test: …`.

## License

This repository does not declare a license yet; contributions will be accepted under the license the maintainer chooses. Please wait for the maintainer to confirm it before sending substantial work.
