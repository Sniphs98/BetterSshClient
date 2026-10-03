# Test automations

Automations and snippets for trying the automation features by hand. Import them in
Remoty: **Automations → Import…**, then pick a file.

- `all-test-automations.remoty-library.json`: every automation below and its snippets, in one file.
- One `*.remoty-automation.json` per automation, if you want just one. The two that call
  each other ("ship" and "release") only come in the library file, since one needs the other.

Their snippets are all named `Test: …`, so they're easy to find and remove afterwards.

## What they need

- **Local steps** run in `cmd.exe` (written on Windows).
- **WSL steps** need WSL with a distribution (they were tested with Ubuntu).
- **Steps on a host** go to the host you pick when the automation runs. The SSH test container
  works for all of them: `docker compose up -d --build` at the repo root, then add it as a host
  (`127.0.0.1`, port `2222`, user and password `remoty`). See `docker/ssh-test-target/README.md`.

## The automations

| Automation | Needs | What it shows |
|---|---|---|
| Test: success, failure, skip | — | A failing step skips what depends on it; one set to *continue on error* doesn't. |
| Test: long run to cancel | WSL | Counts to 60, one line a second: press **Stop** during it. The step fails as *canceled*, the next is skipped. |
| Test: upload 1 GB from WSL | WSL, a host | Makes a 1 GB file in WSL, uploads it with the progress bar (then *Finishing on the host…*), checks it on the host and removes it on both sides. |
| Test: if | — | Asks for an environment: `prod` runs *deploy*, anything else runs *skip*. |
| Test: ship (runs release) | a host | Runs *Test: release (called by ship)* on the host it was given, then uses its output. Double-click the *release* node to open the one it runs. |
| Test: fixed variable | — | A variable set in the automation, never asked for. |
| Test: many steps (scrolling) | — | 25 steps: the run panel follows them to the bottom. |
| Test: parallel branches | WSL | Two branches of 5 s each. They run one after the other today (~10 s in all). |

## Changing them

They're made by `generate.cjs` in this folder, which checks each one against the app's own
validation before writing it. Change it, then from the repo root:

```bash
npm run build
node examples/test-automations/generate.cjs
```
