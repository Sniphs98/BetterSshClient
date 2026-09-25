# Windows RDP test target

A real Windows 11, for trying BetterSshClient's Remote Desktop feature against a real
RDP server. It is [dockurr/windows](https://github.com/dockur/windows): Windows runs as a
QEMU/KVM virtual machine *inside* the container, installed unattended on first start.

It is heavy and optional — the SSH test target next door (`docker/ssh-test-target`) is
what the automated tests use.

## Requirements

- KVM available to Docker. Docker Desktop on Windows with the WSL 2 backend has it; check
  with `docker run --rm --device /dev/kvm alpine ls -l /dev/kvm`.
- About 4 GB of RAM for the VM and up to 64 GB of disk (a Docker volume).
- Windows runs unactivated (watermark, some personalisation locked) — fine for testing.

## Start it

From the repo root:

```bash
docker compose -f docker/windows-rdp-target/compose.yml up -d
```

The **first** start downloads Windows from Microsoft and installs it: 15–30 minutes. Watch
it at <http://127.0.0.1:8006>. Later starts boot in about a minute; the installed system
lives in the `better-ssh-client-rdp_windows-storage` volume.

Stop it with `docker compose -f docker/windows-rdp-target/compose.yml stop`. `down -v`
also deletes the volume, i.e. the installation.

## Add it in BetterSshClient

Remote Desktop → New connection:

| Field | Value |
|---|---|
| Hostname / IP | `127.0.0.1` |
| Port | `13389` |
| Username | `tester` |
| Password | `tester` |

Not `localhost` or port 3389: those would be this machine's own Remote Desktop. The
certificate is self-signed, so mstsc asks once whether to trust it.

### Through an SSH tunnel

To try "Connect: Through SSH host", start the SSH test target too (`docker compose up -d`
at the repo root) and add it as an SSH host (see `docker/ssh-test-target/README.md`).
Then create an RDP profile with

| Field | Value |
|---|---|
| Connect | Through SSH host *(the test target)* |
| Hostname / IP | `host.docker.internal` |
| Port | `13389` |

— the hostname as the SSH container sees it: Docker's name for this machine, where
the Windows container's port is published.

## Never expose it

The ports are bound to `127.0.0.1` only, and the credentials are fixed and public. Keep
it that way.
