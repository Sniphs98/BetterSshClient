# Security policy

BetterSshClient holds the keys to other people's servers — SSH credentials, host lists,
a one-click setup that edits `sshd_config`. Security reports are taken seriously and
handled before anything else.

## Reporting a vulnerability

**Please don't open a public issue.** Report it privately instead:
[**Security → Report a vulnerability**](https://github.com/Sniphs98/better-ssh-client/security/advisories/new).

Helpful to include:

- the BetterSshClient version and OS,
- what an attacker could do, and what they need for it (a malicious server? local access?),
- steps or a proof of concept to reproduce it.

You'll get an answer within a week. Once a fix is released, the advisory is published
with credit to you, unless you'd rather stay anonymous.

## Supported versions

Only the latest release gets security fixes. Releases ship automatically from `main`,
so a fix reaches users as soon as it is merged.

## Scope

In scope: the desktop app and everything it does with credentials, host keys and remote
servers — including the SSH key setup, stored passwords, `known_hosts` handling and the
auto-update path.

Out of scope: the disposable test container in `docker/ssh-test-target`, whose
credentials are intentionally public and which must never be exposed beyond your own
machine.
