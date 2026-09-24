# SSH test target

A disposable Alpine container running `sshd`, for trying BetterSshClient out (host add, key
setup, terminal, SFTP, the file editor) against a real server without touching a real
machine. It's also what `npm run test:integration` connects to.

## Start it

From the repo root:

```bash
docker compose up -d --build
```

That builds the image the first time and starts the container, publishing it on
`localhost:2222`. `docker compose down` stops and removes it — nothing about it
persists, so a fresh `up` (without `--build`) gets you back to the seeded starting
state (an `better-ssh-client` user, password auth, a spread of sample files) every time. Add
`--build` again only if you changed the Dockerfile/sshd_config/service/testfiles.

## Sample files

`/home/better-ssh-client/testfiles/` (see `testfiles/readme.txt` in there, and the local
`testfiles/` folder next to this README for the source) has a broad spread of file
types for trying the SFTP browser's "Open" action and the Monaco editor it opens —
code/config files across ~15 languages, two files that should stay read-only (random
bytes with a `.png`/`.zip` extension), one over the editor's 2 MiB size cap (so you
see the read-only preview fallback), a nested folder, and two filenames chosen to
exercise path quoting (a space, and a single quote). `/home/better-ssh-client/config.yml` and
`/home/better-ssh-client/www/` stay where they were — `sftp.integration.test.ts` asserts they
exist.

## Add it in BetterSshClient

| Field | Value |
|---|---|
| Hostname | `127.0.0.1` |
| Port | `2222` |
| User | `better-ssh-client` |
| Password | `better-ssh-client` |

The user has passwordless `sudo`, so the auto SSH-key-setup flow's "disable password
auth" step works against it too — useful for trying that end to end, but remember the
container is disposable: `docker compose down` and a fresh `up` undoes it (no need to
manually re-enable password auth on a throwaway container).

## Safety notes

- **Never expose this port beyond your machine.** The credentials above are fixed and
  public (they're in this file). `docker-compose.yml` only publishes it on
  `127.0.0.1:2222`, not on all interfaces — don't change that for anything but a fully
  isolated network.
- It's genuinely disposable: nothing it holds is persisted in a volume. Delete it,
  rebuild it, run ten of them — none of it is real infrastructure.

## Integration tests

`npm run test:integration` (from the repo root, or `--workspace packages/electron`)
runs `packages/electron/src/**/*.integration.test.ts` against whatever
`BSSH_TEST_SSH_HOST`/`_PORT`/`_USER`/`_PASSWORD` point at — this container's
defaults (`127.0.0.1:2222`, `better-ssh-client`/`better-ssh-client`) if you don't set them. Start the
container first; these tests are the one place BetterSshClient's test suite actually opens a
real SSH connection instead of a unit-test fixture or the e2e UI stub, so they need it
running and will fail fast with a connection error if it isn't.
