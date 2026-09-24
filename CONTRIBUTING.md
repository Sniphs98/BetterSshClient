# Contributing to BetterSshClient

Thank you for your interest in contributing!  This document describes the
development workflow, coding conventions, and review process.

---

## Table of contents

1. [Setting up the development environment](#1-setting-up-the-development-environment)
2. [Running the project](#2-running-the-project)
3. [Running tests](#3-running-tests)
4. [Code conventions](#4-code-conventions)
5. [Commit style](#5-commit-style)
6. [Opening a pull request](#6-opening-a-pull-request)
7. [Reporting bugs](#7-reporting-bugs)
8. [Releases](#8-releases)

---

## 1. Setting up the development environment

**Prerequisites:**

| Tool | Minimum version | Install |
|------|----------------|---------|
| Node.js | 22+ | [nodejs.org](https://nodejs.org) or `nvm` |
| Git  | any recent     | OS package manager |

**Clone and install:**

```bash
git clone https://github.com/Sniphs98/better-ssh-client.git
cd better-ssh-client
npm install
```

`npm install` pulls in `ssh2` and `electron`, both of which run a postinstall
step (native module rebuild / Electron binary download). If your npm config
blocks install scripts, approve them explicitly:

```bash
npm install-scripts approve electron esbuild ssh2 cpu-features
npm rebuild electron ssh2 cpu-features
```

**Repository layout:** an npm workspace with two packages:

| Package | Path | Contents |
|---------|------|----------|
| `better-ssh-client-electron` | `packages/electron` | Main process + preload + the ported SSH engine (connect/auth, PTY, SFTP, key setup, metrics, config) — no UI dependencies |
| `better-ssh-client-ui` | `packages/ui` | The SvelteKit renderer: dashboard, terminal, SFTP browser, snippets, settings |

---

## 2. Running the project

```bash
# Renderer only, in a browser (fast iteration on screens/stores; no IPC backend)
npm run dev

# Full Electron app (builds the main process, then launches it)
npm run dev:electron

# Production build (renderer + main process)
npm run build

# Package an installer for the current platform (.dmg / .AppImage+.deb+.rpm / .exe)
npm run package

# Package into an unpacked directory only, for a quick local smoke test
npm run package:dir
```

`npm run dev` alone only starts the SvelteKit dev server — screens that call
into the Electron bridge (`window.bsshClient`) will reject with "the Electron
bridge is unavailable" outside a real Electron window, which is expected;
use `npm run dev:electron` to exercise the whole app.

---

## 3. Running tests

```bash
# Everything (electron package, then ui package)
npm test

# One workspace only
npm run test --workspace packages/electron
npm run test --workspace packages/ui

# Type-check + svelte-check
npm run check
```

### End-to-end tests

```bash
npm run test:e2e --workspace packages/ui
```

`packages/ui/e2e/*.spec.ts` are Playwright specs that run against the built
static SPA (`vite preview`) with a `window.bsshClient` stub installed via
`page.addInitScript` — see `packages/ui/src/lib/electron.d.ts` for the
bridge shape a stub must match, and the module comment at the top of each
spec file for what it fakes.

### Integration tests (a real SSH server)

Everything above tests pure logic or a stubbed IPC boundary — nothing
actually speaks SSH. `packages/electron/src/**/*.integration.test.ts` does,
against a disposable local container:

```bash
docker compose up -d --build   # once, from the repo root
npm run test:integration
```

See [`docker/ssh-test-target/README.md`](docker/ssh-test-target/README.md)
for what the container is, its (intentionally public, test-only)
credentials, and how to point BetterSshClient itself at it to try a feature by
hand. These tests are opt-in and excluded from `npm test` — they need
Docker running, and touch a live TCP connection.

---

## 4. Code conventions

These conventions are enforced in code review and by CI.

### Architecture

- **The engine stays UI-free.** Code in `packages/electron/src/core` must
  not import from Svelte or `packages/ui`; it's plain TypeScript the main
  process runs.
- **Never block the main process with SSH operations.** All network I/O is
  `async`/`await`; nothing synchronous should touch the network or disk on
  a hot path.
- **IPC is the only bridge between renderer and main process.** The
  renderer never reaches `ssh2`, `node:fs`, or any other Node API directly
  — only through `ipcMain.handle` calls registered in `packages/electron/src/ipc/*`
  and exposed to the renderer via `packages/electron/src/preload.ts`'s
  `contextBridge`.
- **One session-id space for terminal and SFTP** (`state/sessionRegistry.ts`),
  so a terminal tab and an SFTP tab can never collide on the same id.
- **Ported logic keeps its original module boundaries.** When porting a
  piece of engine logic, mirror the shape of what it was ported from rather
  than inventing new structure, so the two stay easy to compare.

### Error handling

- Every SSH error (timeout, auth failure, host key mismatch) must be shown
  to the user via the status bar or a modal — never swallowed silently.
- Prefer throwing/rejecting over sentinel return values; `ipc/*` handlers
  convert a thrown `Error` into the `{ message }` shape the renderer expects.

### Frontend

- Components call `$lib/ipc/commands.ts` wrappers, never `window.bsshClient`
  directly.
- Store updates from backend events go through `$lib/ipc/router.ts`'s pure
  `applyXxx` functions, which stay framework- and transport-agnostic and
  unit-testable without a running Electron instance.
- Only semantic color tokens — no hardcoded hex/rgb/hsl in `.svelte` files
  (enforced by `theme/no-hardcoded-hex.test.ts`).

### Cross-platform

- Use `node:os`/`node:path` for all user-directory paths — never hardcode
  `~` or a platform-specific separator.
- Parse SSH command output with a normalize-newlines step to handle both
  `\n` and `\r\n`.

### Dependencies

Before adding a new package, check whether the feature can be implemented
in a small amount of plain TypeScript. Every new dependency increases
install time and the packaged app's size.

---

## 5. Commit style

BetterSshClient uses [Conventional Commits](https://www.conventionalcommits.org/).

```
<type>(<optional scope>): <short summary>

[optional body]

[optional footer]
```

**Types:**

| Type       | When to use |
|------------|-------------|
| `feat`     | New user-visible feature |
| `fix`      | Bug fix |
| `docs`     | Documentation only |
| `refactor` | Code change with no user-visible effect |
| `test`     | Adding or fixing tests |
| `chore`    | Build system, CI, dependency bumps |
| `perf`     | Performance improvement |
| `ci`       | CI/CD workflows |

The type is not just a label: it decides the next release (see [Releases](#8-releases)).
`feat` ships a minor release, `fix` and `perf` a patch release, and `feat!:` / `fix!:`
or a `BREAKING CHANGE:` footer a major one. `docs`, `refactor`, `test`, `chore` and `ci`
don't release anything on their own. Pick the type for what the *user* gets — a
refactor that happens to fix a bug is a `fix`.

**Examples:**

```
feat(sftp): add drag and drop file transfers

fix(ssh): respect connection timeout when host is unreachable

docs: update README with installation instructions

chore: bump ssh2 to 1.17
```

---

## 6. Opening a pull request

1. Fork the repository and create a branch:
   ```bash
   git checkout -b feat/my-feature
   ```
2. Make your changes following the conventions above.
3. Run the full test suite and checks:
   ```bash
   npm test && npm run check
   ```
4. Push and open a PR against the `main` branch.
5. Fill in the PR template (problem, solution, test plan).
6. A maintainer will review within a few days.

**PR checklist:**

- [ ] PR title is a Conventional Commit — with a squash merge it becomes the commit
      message, and with it the release note and the version bump
- [ ] All tests pass (`npm test`)
- [ ] `npm run check` passes (svelte-check + tsc, both packages)
- [ ] Relevant tests added (parsers, new features)
- [ ] README updated if the change is user-visible

CI runs everything on the PR — checks, unit, end-to-end and integration tests, and
packaging on all three platforms — so a green PR is a releasable one.

---

## 7. Reporting bugs

Please open a GitHub Issue with:

- BetterSshClient version (Settings screen, or the app's About info)
- OS
- Steps to reproduce
- Expected behaviour vs. actual behaviour
- Relevant log output

For security issues, please **do not** open a public issue — see
[SECURITY.md](SECURITY.md) for how to report one privately.

---

## 8. Releases

Releases are automatic: every merge to `main` runs the Release workflow
(`.github/workflows/release.yml`).

1. The whole CI workflow runs again on the merged code.
2. `scripts/next-version.mjs` reads the commits since the last `vX.Y.Z` tag and decides
   the version from their types (table in [Commit style](#5-commit-style)). No `feat`,
   `fix`, `perf` or breaking change since the last release → no release.
3. A draft GitHub Release is opened with notes grouped from those commits; each OS builds
   its installers under the new version and uploads them, plus the `latest*.yml` update
   manifests, into it.
4. Only when every platform succeeded is the draft published, which creates the tag.

A few consequences worth knowing:

- **You never edit the version by hand** for a normal release. The version in
  `packages/electron/package.json` is stamped by the workflow at build time and isn't
  committed back, so local builds keep reporting the last hand-set version.
- **To force a specific version** (say, a jump to `2.0.0`), set it in
  `packages/electron/package.json`. A version there that is ahead of the last release is
  used as-is on the next merge.
- **Release notes come from commit messages**, so write the summary for a user reading
  the release page. `CHANGELOG.md` holds the history up to 1.1.2.
- **Dry run:** *Actions → Release → Run workflow* runs the same checks and packaging,
  and attaches the installers to the run instead of publishing them.
- **Test the version logic** with `node --test "scripts/*.test.mjs"`, or see what the
  next release would be with `node scripts/next-version.mjs`.
