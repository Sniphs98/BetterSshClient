<div align="center">

# OmnySSH

### Every server you manage, in one window. Dashboard, terminal, SFTP, snippets.

<img src="assets/gui.webp" alt="OmnySSH GUI dashboard" width="900">

[![Downloads](https://img.shields.io/github/downloads/Sniphs98/omnyssh/total?label=total%20installs&color=2ea44f)](https://github.com/Sniphs98/omnyssh/releases)
[![Latest release](https://img.shields.io/github/v/release/Sniphs98/omnyssh?label=latest)](https://github.com/Sniphs98/omnyssh/releases/latest)
[![Stars](https://img.shields.io/github/stars/Sniphs98/omnyssh?style=flat)](https://github.com/Sniphs98/omnyssh/stargazers)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Build](https://img.shields.io/github/actions/workflow/status/Sniphs98/omnyssh/ci.yml?branch=main)](https://github.com/Sniphs98/omnyssh/actions)

**[Install](#install)** •
**[Features](#features)** •
**[SSH keys](#ssh-key-setup)** •
**[Contributing](#contributing)**

</div>

---

## Install

Grab the file for your platform from [**Releases**](https://github.com/Sniphs98/omnyssh/releases/latest):

| Platform | File |
|----------|------|
| macOS | `OmnySSH-*.dmg` |
| Linux x86_64 | `OmnySSH-*.AppImage` / `.deb` / `.rpm` |
| Windows x86_64 | `OmnySSH-*-setup.exe` |

No account, no login screen, no telemetry. The app opens with an empty dashboard and reads your existing `~/.ssh/config` if you have one — hosts behind a bastion (`ProxyJump`) included.

---

## What it does

You add a server once. After that it sits on the dashboard as a card with live CPU, RAM and disk, uptime, distro, the top processes eating your CPU, and a badge for what runs on it. One click on `sh` drops you into a real terminal. One click on `files` opens a two panel SFTP browser. Ten servers fit on one screen and refresh on their own.

### Live dashboard
Cards for every host with CPU, RAM and disk bars, uptime, OS version, top processes, and a Docker badge showing how many containers are up. Bars turn yellow, then red, so a sick server is obvious from across the room.

### Real terminals
Full PTY sessions in tabs, rendered with [xterm.js](https://xtermjs.org/). Open as many servers as you need, switch between them from the sidebar, and keep them running while you work in the dashboard.

### Two panel SFTP
Local on the left, remote on the right. Tick the files you want and move them across, watch the progress bar, select many at once. Nobody remembers `scp -r` syntax anyway.

### Snippets
Save the commands you paste every week. Pick a snippet, tick the hosts to send it to, and it runs on all of them at once. Snippets take parameters, so `sudo systemctl restart {{service}}` asks you for the name.

### Search everything
Hit ⌘K and start typing. Every host you have, plus every session already open. Enter drops you into a terminal on the host you picked, or back into the session you left.

### Streamer mode
Swaps every real IP on screen for a fake one. Record a demo or share your screen without leaking client infrastructure.

### Light and dark themes
Both ship in the app. Switch from the sidebar.

---

## SSH key setup

Password auth on a fresh VPS is the thing you always mean to fix and never do. OmnySSH does it in one click.

Pick a host you added yourself that has no key configured, hit **Set up SSH key**, and choose whether it should also turn password login off once the key is verified — on by default, but you can leave password auth as a fallback. Confirm, and the app generates an Ed25519 key, appends the public half to `authorized_keys`, and opens a fresh connection with the new key to prove it works. Only after that — and only if you asked for it — does it turn password login off. There is no further confirmation step in between: from there on it goes through with it.

Before touching `sshd_config` it saves a backup on the server. If any step fails, it restores the backup and leaves your access exactly as it was. Your private key never leaves your machine, and nothing gets sent anywhere except the server you chose.

The code lives in [`packages/electron/src/core/ssh/keySetup.ts`](packages/electron/src/core/ssh/keySetup.ts). Read it before you point this at production. That is the whole point of shipping it open source.

---

## Dev notes

I write about what I am building on Telegram. Release notes, work in progress screenshots, benchmarks, and the things that broke on the way there. Usually before they show up anywhere else.

### 👉 [**t.me/timhartmanndev**](https://t.me/timhartmanndev)

---

## Contributing

Pull requests welcome. [CONTRIBUTING.md](CONTRIBUTING.md) has the setup, the conventions and the checklist. Open an issue first if you plan something big, so we do not both build it.

Workspace layout:

```
packages/electron   Electron main process + preload + the ported SSH/config engine
packages/ui         SvelteKit renderer (dashboard, terminal, SFTP, snippets, settings)
```

## License

Apache 2.0. See [LICENSE](LICENSE).

<div align="center">

### ⭐ Star the repo if OmnySSH saved you a terminal tab

[Report a bug](https://github.com/Sniphs98/omnyssh/issues) •
[Request a feature](https://github.com/Sniphs98/omnyssh/issues) •
[Discussions](https://github.com/Sniphs98/omnyssh/discussions)

</div>
