<div align="center">

# BetterSshClient

### Every server you manage, in one window.
Live dashboard · real terminals · two-panel SFTP · automations · remote desktop

<img src="assets/gui.webp" alt="The BetterSshClient dashboard: a card per server with live CPU, RAM and disk" width="900">

[![Latest release](https://img.shields.io/github/v/release/Sniphs98/better-ssh-client?label=latest)](https://github.com/Sniphs98/better-ssh-client/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/Sniphs98/better-ssh-client/total?label=downloads&color=2ea44f)](https://github.com/Sniphs98/better-ssh-client/releases)
[![Release](https://img.shields.io/github/actions/workflow/status/Sniphs98/better-ssh-client/release.yml?branch=main&label=release)](https://github.com/Sniphs98/better-ssh-client/actions/workflows/release.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

**[Install](#install)** •
**[Features](#features)** •
**[Your data](#where-your-data-lives)** •
**[Development](#development)** •
**[Releases](#how-releases-work)** •
**[Credits](#credits)**

*A fork of [OmnySSH](https://github.com/timhartmann7/omnyssh) by Tim Hartmann — see [Credits](#credits).*

</div>

---

## Install

Download the file for your platform from the [**latest release**](https://github.com/Sniphs98/better-ssh-client/releases/latest):

| Platform | File | Notes |
|---|---|---|
| **Windows** x64 | `BetterSshClient-<version>-setup.exe` | Installer. Also available: `-portable.exe` (no install) and a `.zip`. |
| **macOS** | `BetterSshClient-<version>-mac-<arch>.dmg` | Drag to *Applications*. |
| **Linux** x64 | `.AppImage`, `.deb` or `.rpm` | The AppImage runs anywhere; the packages integrate with `apt`/`dnf`. |

**First launch.** The builds aren't code-signed yet, so your OS asks once:

- **Windows** — SmartScreen says "Windows protected your PC": *More info → Run anyway*.
- **macOS** — right-click the app → *Open* → *Open*. (Or: `xattr -dr com.apple.quarantine /Applications/BetterSshClient.app`.)
- **Linux AppImage** — `chmod +x BetterSshClient-*.AppImage`, then run it.

No account, no login screen, no telemetry. The app opens with an empty dashboard and picks
up the hosts in your `~/.ssh/config` — including ones behind a bastion (`ProxyJump`).

**Updates.** On start, the app checks this repository for a newer release and shows a
banner with a link to it. New releases ship automatically whenever a change lands on
`main` ([how](#how-releases-work)).

---

## Features

### Live dashboard
A card per server with CPU, RAM and disk bars, uptime, OS, load, and the processes eating
your CPU. Bars turn yellow, then red, so a sick server is obvious from across the room.
Running services are detected and badged (Docker with its container count, nginx,
Node.js, PostgreSQL, Redis). Refreshes on its own, every 10 s to 5 min — your choice.

Firewalls, switches and other appliances that speak SSH but have no shell can be watched
with a plain **TCP port check** instead: reachable or not, no login.

### Real terminals
Full PTY sessions in tabs, rendered by [xterm.js](https://xtermjs.org/) on the GPU (WebGL),
so even a build log scrolling past stays smooth. Keep as many open as you like; they stay
alive while you switch to the dashboard. Selecting copies, `Ctrl+Shift+C`/`V` copy and
paste, and right-click is yours to choose: a Copy/Paste menu, or PuTTY-style instant paste.
A host's default directory is where its terminal opens.

### Two-panel SFTP
Local on the left, remote on the right. Mark files and send them across — several at a
time, side by side — or drag and drop, including straight from your file manager.
Directories with thousands of entries scroll without a hitch. Double-click a text file to
edit it in place (Monaco, the editor from VS Code), or open a terminal drawer right below
the panes, already in the folder you're looking at.

### Snippets and automations
A **snippet** is one named shell command — the thing you paste every week. An
**automation** wires snippets together on a canvas: each step runs locally or on a host,
arrows say what has to finish first, and a step can use an earlier one's output via
`{{nodes.<label>.output}}`. Parameters are asked for at run time, so one automation works
against whichever host you point it at. Right-click a file in the SFTP browser to run a
snippet on it — `{{file}}` becomes its path.

### Remote desktop
RDP profiles live next to your SSH hosts. Connecting hands the session to your OS's own
client — `mstsc` on Windows, `xfreerdp` elsewhere.

### One-click SSH key setup
Password login on a fresh VPS is the thing you always mean to fix and never do. Pick a
host, hit **Set up SSH key**, and the app generates an Ed25519 key, installs it, and proves
it works over a fresh connection. Only then — and only if you ask — does it turn password
login off. It backs up `sshd_config` first and rolls back if any step fails, so your access
is never left half-changed. Your private key never leaves your machine.
The code is in [`keySetup.ts`](packages/electron/src/core/ssh/keySetup.ts) — read it
before you point this at production; that's why it's open source.

### And also
- **Search everything** — `Ctrl+K` / `⌘K` finds any host or open session.
- **ProxyJump** — multi-hop bastions work everywhere: dashboard, terminal, SFTP, automations.
- **One connection per host** — the dashboard, terminals and SFTP share it, so a new tab
  opens instantly instead of logging in again.
- **Streamer mode** — swaps every real address on screen for a convincing fake, for demos and screen sharing.
- **Light and dark themes.**

---

## Where your data lives

Everything stays on your machine, in plain TOML you can read and back up:

| OS | Folder |
|---|---|
| Windows | `%APPDATA%\better-ssh-client\` |
| macOS | `~/Library/Application Support/better-ssh-client/` |
| Linux | `~/.config/better-ssh-client/` (or `$XDG_CONFIG_HOME`) |

`hosts.toml` (your hosts), `snippets.toml`, `automations.toml`, `remote-desktop.toml` and
`config.toml` (settings). Stored passwords are encrypted with your OS keystore — DPAPI on
Windows, Keychain on macOS, libsecret on Linux. (On a Linux desktop with no keyring
running, there is nothing to encrypt with, so a password is saved as plain text; prefer
key authentication there — the one-click key setup does it for you.)

Your `~/.ssh/config` is only ever **read**. Editing an imported host saves your own copy
in `hosts.toml`. New host keys are learned into `~/.ssh/known_hosts` on first connect, and
a changed key is refused.

---

## Development

You need **Node.js 22+** and npm. Docker is optional, for the integration tests.

```bash
git clone https://github.com/Sniphs98/better-ssh-client.git
cd better-ssh-client
npm ci

npm run dev:electron     # build and launch the full app
npm run dev              # just the UI in a browser, for fast iteration on screens
npm run package:dir      # an unpacked app for your platform, in release/
```

### Project layout

```
packages/electron   Electron main process: SSH/SFTP engine, config, IPC, preload
packages/ui         SvelteKit renderer: dashboard, terminal, SFTP, automations, settings
docker/             a disposable SSH server for integration tests and manual testing
scripts/            release versioning and the repo hygiene guard
```

The renderer talks to the main process only through the preload bridge
([`bindings.ts`](packages/ui/src/lib/bindings.ts) is the single entry point).

### Tests

| Command | What it covers |
|---|---|
| `npm run check` | TypeScript + svelte-check, both packages |
| `npm test` | Unit tests (Vitest), both packages |
| `npm run test:e2e` | The UI end to end in Chromium (Playwright), against a stubbed backend |
| `npm run test:integration` | Real SSH/SFTP against the test container — start it first with `docker compose up -d --build` |

All four run on every pull request. [CONTRIBUTING.md](CONTRIBUTING.md) has the details,
the code conventions, and the PR checklist.

---

## How releases work

There is no release checklist: **every merge to `main` is a release candidate.**

1. The full test suite — checks, unit, end-to-end and integration tests, plus packaging on
   Windows, macOS and Linux — runs on the merged code.
2. The next version is worked out from the [Conventional Commits](https://www.conventionalcommits.org/)
   since the last release ([`scripts/next-version.mjs`](scripts/next-version.mjs)):

   | Commits contain | Release |
   |---|---|
   | `feat: …` | minor — `1.2.0` → `1.3.0` |
   | `fix: …`, `perf: …` | patch — `1.2.0` → `1.2.1` |
   | `feat!: …` or a `BREAKING CHANGE:` footer | major — `1.2.0` → `2.0.0` |
   | only `docs`, `test`, `chore`, `refactor`, `ci` | no release, just the tests |

3. Installers for every platform are built and uploaded to a draft GitHub Release, with
   notes grouped from the commit messages. Only when **all** platforms succeeded is it
   published — a failure anywhere leaves no half-finished release behind.

Each release also carries electron-builder's update manifests (`latest.yml`,
`latest-mac.yml`, `latest-linux.yml`), so in-app auto-update can be switched on later
without changing the release process. To try the whole pipeline without publishing
anything, run the **Release** workflow by hand from the Actions tab: the installers are
attached to that run instead.

---

## Credits

BetterSshClient is a fork of [**OmnySSH**](https://github.com/timhartmann7/omnyssh) by
[Tim Hartmann](https://github.com/timhartmann7). The dashboard, the SSH and SFTP engine,
the key setup, the terminal — that is his work, and it is still the heart of this
repository. If this app is useful to you, his is the project that made it exist.

What this fork changed:

- **Rebuilt on Electron + SvelteKit** (from Tauri + Rust), with its own name, app id and config folder.
- **Remote desktop** profiles, launched through the OS's native RDP client.
- **Snippets and automations** reworked into one model: plain commands, wired together on a canvas.
- **Terminal clipboard** — copy on select, `Ctrl+Shift+C`/`V`, a configurable right-click.
- **Stored passwords encrypted** with the OS keystore instead of plain text.
- **Speed** — shared connections, GPU terminal rendering, parallel SFTP transfers.
- **Automatic releases** on every merge to `main`.

The SFTP file-type icons are from [vscode-icons](https://github.com/vscode-icons/vscode-icons)
(MIT, © Roberto Huertas); the licence ships with them in `packages/ui/static/file-icons/`.

## License

Apache 2.0 — see [LICENSE](LICENSE). Copyright in the original work remains with the
OmnySSH contributors; this fork's changes are released under the same terms.

<div align="center">

[Report a bug](https://github.com/Sniphs98/better-ssh-client/issues/new/choose) •
[Request a feature](https://github.com/Sniphs98/better-ssh-client/issues/new/choose) •
[Security](SECURITY.md) •
[Contributing](CONTRIBUTING.md)

</div>
