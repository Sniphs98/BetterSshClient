# Example plugins

Plugins are **experimental**. They run sandboxed (no Node.js, no network unless declared)
and can only do what their `plugin.json` lists, after you switch them on.

To try one, open the **Plugins** page (the puzzle button next to Settings), click the
folder button to open the plugins folder, copy the plugin's folder into it, click reload,
and switch the plugin on. Its commands show up on its card and in the command palette
(`Ctrl+K`).

| Plugin | What it does | Permissions |
|---|---|---|
| [`docker-containers`](docker-containers/) | "Docker: containers on host…" lists a host's containers | `hosts:exec` |

How plugins work, the permissions and the `bssh` API: [docs/plugin-system.md](../../docs/plugin-system.md)
(German).
