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

## Documenting a plugin

Put a `README.md` next to `plugin.json`. The plugin's card then gets a **Docs** button that
shows it. It is rendered as Markdown with everything risky taken out — no scripts, no
images, and links open in your browser. See
[`docker-containers/README.md`](docker-containers/README.md) for an example.
