<div align="center">

# BetterSshClient

### Every server you manage, in one window. Dashboard, terminal, SFTP, automations, RDP.

<img src="assets/gui.webp" alt="BetterSshClient GUI dashboard" width="900">

[![Downloads](https://img.shields.io/github/downloads/Sniphs98/better-ssh-client/total?label=total%20installs&color=2ea44f)](https://github.com/Sniphs98/better-ssh-client/releases)
[![Latest release](https://img.shields.io/github/v/release/Sniphs98/better-ssh-client?label=latest)](https://github.com/Sniphs98/better-ssh-client/releases/latest)
[![Stars](https://img.shields.io/github/stars/Sniphs98/better-ssh-client?style=flat)](https://github.com/Sniphs98/better-ssh-client/stargazers)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Build](https://img.shields.io/github/actions/workflow/status/Sniphs98/better-ssh-client/ci.yml?branch=main)](https://github.com/Sniphs98/better-ssh-client/actions)

**[Install](#install)** •
**[What it does](#what-it-does)** •
**[SSH keys](#ssh-key-setup)** •
**[Credits](#credits)** •
**[Contributing](#contributing)**

*A fork of [OmnySSH](https://github.com/timhartmann7/omnyssh) by Tim Hartmann, continued
under a new name — see [Credits](#credits).*

</div>

---

## Install

Grab the file for your platform from [**Releases**](https://github.com/Sniphs98/better-ssh-client/releases/latest):

| Platform | File |
|----------|------|
| macOS | `BetterSshClient-*.dmg` |
| Linux x86_64 | `BetterSshClient-*.AppImage` / `.deb` / `.rpm` |
| Windows x86_64 | `BetterSshClient-*-setup.exe` |

No account, no login screen, no telemetry. The app opens with an empty dashboard and reads your existing `~/.ssh/config` if you have one — hosts behind a bastion (`ProxyJump`) included.

---

## What it does

You add a server once. After that it sits on the dashboard as a card with live CPU, RAM and disk, uptime, distro, the top processes eating your CPU, and a badge for what runs on it. One click on `sh` drops you into a real terminal. One click on `files` opens a two panel SFTP browser. Ten servers fit on one screen and refresh on their own.

### Live dashboard
Cards for every host with CPU, RAM and disk bars, uptime, OS version, top processes, and a Docker badge showing how many containers are up. Bars turn yellow, then red, so a sick server is obvious from across the room.

### Real terminals
Full PTY sessions in tabs, rendered with [xterm.js](https://xtermjs.org/). Open as many
servers as you need, switch between them from the sidebar, and keep them running while
you work in the dashboard. Selecting copies, `Ctrl+Shift+V` pastes, and right-click is
yours to set — a Copy/Paste menu, or straight PuTTY-style paste.

### Two panel SFTP
Local on the left, remote on the right. Tick the files you want and move them across, watch the progress bar, select many at once. Nobody remembers `scp -r` syntax anyway.

### Snippets and automations
A snippet is one named shell command — the thing you paste every week. An automation
wires snippets together on a canvas: each node runs locally or on a host, edges say what
has to finish first, and a node can feed its output into the next one with
`{{nodes.<label>.output}}`. Parameters are asked for when you run it, so one automation
works against whichever host you point it at.

Snippets also run on their own: right-click a file in the SFTP browser and pick one, and
`{{file}}` in the command becomes that file's path.

### Remote desktop
RDP connection profiles live beside your SSH hosts, behind a switch at the top of the
sidebar. Connect hands the session to the OS's own client — `mstsc` on Windows,
`xfreerdp` elsewhere — so there's no half-finished protocol implementation in the way.
Passwords are stored with the same OS-level encryption as SSH passwords.

### Search everything
Hit ⌘K and start typing. Every host you have, plus every session already open. Enter drops you into a terminal on the host you picked, or back into the session you left.

### Streamer mode
Swaps every real IP on screen for a fake one. Record a demo or share your screen without leaking client infrastructure.

### Light and dark themes
Both ship in the app. Switch from the sidebar.

---

## SSH key setup

Password auth on a fresh VPS is the thing you always mean to fix and never do. BetterSshClient does it in one click.

Pick a host you added yourself that has no key configured, hit **Set up SSH key**, and choose whether it should also turn password login off once the key is verified — on by default, but you can leave password auth as a fallback. Confirm, and the app generates an Ed25519 key, appends the public half to `authorized_keys`, and opens a fresh connection with the new key to prove it works. Only after that — and only if you asked for it — does it turn password login off. There is no further confirmation step in between: from there on it goes through with it.

Before touching `sshd_config` it saves a backup on the server. If any step fails, it restores the backup and leaves your access exactly as it was. Your private key never leaves your machine, and nothing gets sent anywhere except the server you chose.

The code lives in [`packages/electron/src/core/ssh/keySetup.ts`](packages/electron/src/core/ssh/keySetup.ts). Read it before you point this at production. That is the whole point of shipping it open source.

---

## Credits

BetterSshClient is a fork of [**OmnySSH**](https://github.com/timhartmann7/omnyssh) by
[Tim Hartmann](https://github.com/timhartmann7). The dashboard, the SSH and SFTP engine,
the key setup, the terminal — that is his work, and it is still most of the code in this
repository. If this app is useful to you, his is the project that made it exist.

What this fork changed:

- **Renamed** from OmnySSH, with its own application id and config directory.
- **Remote desktop:** RDP connection profiles, launched through the OS's native client.
- **Snippets and automations reworked:** what used to be two features (flat snippets, and
  automations as a graph) became one model — snippets are plain commands, automations
  wire them together, and where a step runs is the automation's call rather than the
  snippet's.
- **Terminal clipboard:** copy on selection, `Ctrl+Shift+C`/`V`, and a configurable
  right-click. This also replaced Electron's default menu, which had been swallowing
  `Ctrl+C`, `Ctrl+Z` and `Ctrl+A` before the shell ever saw them.
- **Stored passwords encrypted** with the OS keystore (DPAPI / Keychain / libsecret)
  instead of plaintext in `hosts.toml`.

Both projects are licensed under Apache 2.0.

---

## Contributing

Pull requests welcome. [CONTRIBUTING.md](CONTRIBUTING.md) has the setup, the conventions and the checklist. Open an issue first if you plan something big, so we do not both build it.

Workspace layout:

```
packages/electron   Electron main process + preload + the ported SSH/config engine
packages/ui         SvelteKit renderer (dashboard, terminal, SFTP, automations, RDP, settings)
```

## License

Apache 2.0. See [LICENSE](LICENSE). Copyright for the original work remains with the
OmnySSH contributors; the modifications in this fork are released under the same terms.

<div align="center">

### ⭐ Star the repo if BetterSshClient saved you a terminal tab

[Report a bug](https://github.com/Sniphs98/better-ssh-client/issues) •
[Request a feature](https://github.com/Sniphs98/better-ssh-client/issues) •
[Discussions](https://github.com/Sniphs98/better-ssh-client/discussions)

</div>
