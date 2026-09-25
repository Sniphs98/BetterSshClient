# Example plugins

Plugins are **experimental**. They run sandboxed (no Node.js, no network unless declared)
and can only do what their `plugin.json` lists, after you switch them on.

To try one, copy its folder into the app's plugins folder (Settings → Plugins →
**Open folder**), click **Reload**, and switch it on. Its commands then show up in the
command palette (`Ctrl+K`).

| Plugin | What it does | Permissions |
|---|---|---|
| [`docker-containers`](docker-containers/) | "Docker: containers on host…" lists a host's containers | `hosts:exec` |

How plugins work, the permissions and the `bssh` API: [docs/plugin-system.md](../../docs/plugin-system.md)
(German).
