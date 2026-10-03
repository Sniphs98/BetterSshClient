// Builds the importable test automations in this folder from one definition, and checks
// each against the app's own validation before writing it. Run from the repo root after
// `npm run build`:  node examples/test-automations/generate.cjs
//
// Local steps run in cmd.exe on Windows (where these were made); anything needing Linux
// runs in WSL. Every remote step goes to the host chosen when the automation runs —
// the SSH test container (docker/ssh-test-target) is what they were tested against.

const { writeFileSync } = require('node:fs');
const { join } = require('node:path');
const dist = join(__dirname, '..', '..', 'packages', 'electron', 'dist', 'core', 'automation');
const { validateAutomation } = require(join(dist, 'engine.js'));
const { buildAutomationBundle, buildLibraryBundle, parseBundle } = require(join(dist, 'bundle.js'));

const snippet = (id, name, command, timeoutSecs = 120) => ({ id: `test-${id}`, name: `Test: ${name}`, command, timeoutSecs });
const S = {
  ok: snippet('ok', 'say ok', 'echo all good'),
  fail: snippet('fail', 'fail on purpose', 'echo this step fails on purpose && exit /b 1'),
  afterFail: snippet('after-fail', 'runs only if the one before worked', 'echo you should not see this'),
  carryOn: snippet('carry-on', 'runs anyway', 'echo the failed step was set to continue on error'),
  ticks: snippet('ticks', 'count to 60 (cancel me)', 'for i in $(seq 1 60); do echo "tick $i"; sleep 1; done', 120),
  makeFile: snippet('make-1gb', 'make a 1 GB file in WSL', 'fallocate -l 1G /tmp/test-1gb.bin && ls -lh /tmp/test-1gb.bin'),
  checkRemote: snippet('check-remote', 'check the upload on the host, then remove it', 'ls -lh {{nodes.upload.output}} && rm {{nodes.upload.output}}'),
  cleanWsl: snippet('clean-wsl', 'remove the 1 GB file in WSL', 'rm -f /tmp/test-1gb.bin && echo removed'),
  build: snippet('build', 'build (on the host)', 'echo "building {{params.tag}} on $(hostname)"'),
  gotIt: snippet('got-it', 'show what the called automation put out', 'echo got: {{nodes.release.output}}'),
  prod: snippet('prod', 'deploy to prod', 'echo deploying to {{params.env}}'),
  notProd: snippet('not-prod', 'skip the deploy', 'echo not prod, nothing to deploy'),
  greet: snippet('greet', 'use a fixed variable', 'echo {{params.greeting}} from a fixed variable'),
  line: snippet('line', 'print a few lines', 'echo line one && echo line two && echo line three'),
  slow: snippet('slow', 'take 5 seconds (WSL)', 'echo start on $(hostname); sleep 5; echo done after 5 s'),
  join: snippet('join', 'after both branches', 'echo both branches are done')
};

const node = (id, snippetId, label, extra = {}) => ({ id, snippetId, label, continueOnError: false, target: 'local', ...extra });
const host = { name: 'host', kind: 'host', label: 'Host (e.g. test-container)' };
let x = 0;
const at = () => ({ x: (x++ % 6) * 280, y: Math.floor((x - 1) / 6) * 200 });

const automations = [
  {
    name: 'Test: success, failure, skip',
    params: [],
    nodes: [
      node('a', S.ok.id, 'first'),
      node('b', S.fail.id, 'fails'),
      node('c', S.afterFail.id, 'skipped'),
      node('d', S.fail.id, 'fails-but-continues', { continueOnError: true }),
      node('e', S.carryOn.id, 'runs-anyway')
    ],
    edges: [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c' },
      { from: 'a', to: 'd' },
      { from: 'd', to: 'e' }
    ]
  },
  {
    name: 'Test: long run to cancel',
    params: [],
    nodes: [node('t', S.ticks.id, 'ticks', { target: 'wsl' }), node('after', S.ok.id, 'after')],
    edges: [{ from: 't', to: 'after' }]
  },
  {
    name: 'Test: upload 1 GB from WSL',
    params: [host],
    nodes: [
      node('mk', S.makeFile.id, 'make-file', { target: 'wsl' }),
      node('up', '', 'upload', { target: 'remote', upload: { from: '/tmp/test-1gb.bin', source: 'wsl', to: '/tmp/' } }),
      node('chk', S.checkRemote.id, 'check', { target: 'remote' }),
      node('cl', S.cleanWsl.id, 'clean-wsl', { target: 'wsl' })
    ],
    edges: [
      { from: 'mk', to: 'up' },
      { from: 'up', to: 'chk' },
      { from: 'chk', to: 'cl' }
    ]
  },
  {
    name: 'Test: if',
    params: [{ name: 'env', kind: 'text', label: 'Environment (type prod or something else)', default: 'prod' }],
    nodes: [
      node('if', '', 'is-prod', { condition: { kind: 'compare', left: '{{params.env}}', op: 'equals', right: 'prod' } }),
      node('yes', S.prod.id, 'deploy'),
      node('no', S.notProd.id, 'skip')
    ],
    edges: [
      { from: 'if', to: 'yes', branch: 'yes' },
      { from: 'if', to: 'no', branch: 'no' }
    ]
  },
  {
    name: 'Test: release (called by ship)',
    params: [
      { name: 'server', kind: 'host' },
      { name: 'tag', kind: 'text', default: 'v1.0' }
    ],
    nodes: [node('b', S.build.id, 'build', { target: 'remote' })],
    edges: []
  },
  {
    name: 'Test: ship (runs release)',
    params: [host],
    nodes: [
      node('r', '', 'release', { call: { automation: 'Test: release (called by ship)', params: { server: '{{params.host}}', tag: 'v1.2' } } }),
      node('g', S.gotIt.id, 'show')
    ],
    edges: [{ from: 'r', to: 'g' }]
  },
  {
    name: 'Test: fixed variable',
    params: [{ name: 'greeting', kind: 'fixed', default: 'hello' }],
    nodes: [node('g', S.greet.id, 'greet')],
    edges: []
  },
  {
    name: 'Test: many steps (scrolling)',
    params: [],
    nodes: Array.from({ length: 25 }, (_, i) => node(`s${i + 1}`, S.line.id, `step-${i + 1}`)),
    edges: Array.from({ length: 24 }, (_, i) => ({ from: `s${i + 1}`, to: `s${i + 2}` }))
  },
  {
    // Two branches of 5 s each: today they run one after the other (~10 s in all);
    // with parallel branches it would be ~5 s.
    name: 'Test: parallel branches',
    params: [],
    nodes: [
      node('start', S.ok.id, 'start'),
      node('left', S.slow.id, 'left', { target: 'wsl' }),
      node('right', S.slow.id, 'right', { target: 'wsl' }),
      node('join', S.join.id, 'join')
    ],
    edges: [
      { from: 'start', to: 'left' },
      { from: 'start', to: 'right' },
      { from: 'left', to: 'join' },
      { from: 'right', to: 'join' }
    ]
  }
];
for (const a of automations) for (const n of a.nodes) n.position = at();

const snippets = Object.values(S);
const snippetsById = new Map(snippets.map((s) => [s.id, s]));
const byName = new Map(automations.map((a) => [a.name, a]));
let bad = false;
for (const a of automations) {
  const problems = validateAutomation(a, snippetsById, byName);
  if (problems.length > 0) {
    bad = true;
    console.error(`${a.name}: ${problems.join('; ')}`);
  }
}
if (bad) process.exit(1);

const write = (file, bundle) => {
  parseBundle(JSON.parse(JSON.stringify(bundle))); // as the app reads it on import
  writeFileSync(join(__dirname, file), JSON.stringify(bundle, null, 2) + '\n');
  console.log('wrote', file);
};
write('all-test-automations.remoty-library.json', buildLibraryBundle(automations, snippets));
const slug = (name) => name.replace(/^Test: /, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
for (const a of automations) {
  // One automation that runs another needs both: those two only come in the library file.
  if (a.nodes.some((n) => n.call) || automations.some((o) => o.nodes.some((n) => n.call?.automation === a.name))) continue;
  write(`${slug(a.name)}.remoty-automation.json`, buildAutomationBundle(a, snippetsById));
}
