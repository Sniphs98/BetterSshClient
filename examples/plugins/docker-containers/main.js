// Docker containers: an example BetterSshClient plugin (plugin API 1).
//
// Adds "Docker: containers on host…" to the command palette (Ctrl+K). Pick a host,
// and it shows that host's containers with their image and status.
//
// The code runs in a sandbox: `bssh` is all it can reach. `hosts.exec` needs the
// `hosts:exec` permission from plugin.json, which the user grants by switching the
// plugin on in Settings.

const FORMAT = '{{.Names}}\t{{.Image}}\t{{.Status}}';

/** Lays rows out as aligned columns. */
function table(rows) {
  const widths = rows[0].map((_, col) => Math.max(...rows.map((row) => (row[col] ?? '').length)));
  return rows.map((row) => row.map((cell, col) => (cell ?? '').padEnd(widths[col])).join('   ').trimEnd()).join('\n');
}

await bssh.commands.register('containers', 'Docker: containers on host…', { needsHost: true }, async ({ host }) => {
  const result = await bssh.hosts.exec(host, `docker ps -a --format '${FORMAT}'`);
  const title = `Docker containers on ${host}`;

  if (!result.ok) {
    await bssh.ui.showText(title, `docker ps failed:\n\n${result.output || result.error}`);
    return;
  }
  const rows = result.output
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => line.split('\t'));
  await bssh.ui.showText(title, rows.length === 0 ? 'No containers.' : table([['NAME', 'IMAGE', 'STATUS'], ...rows]));
});
