// Whether the SFTP "Open" action opens an entry in the Monaco editor, and which
// language to highlight it with (tech-gui.md §3.2). Kept pure/framework-free so it's
// unit-testable without mounting the editor or monaco-editor itself (this app's Monaco
// build already registers ~80 languages — see monaco-editor's own
// esm/vs/basic-languages/monaco.contribution.js — so `LANGUAGE_BY_EXTENSION` just needs
// to route a filename to an id Monaco already knows, not to configure a language
// itself). Gated two ways: a short binary-extension denylist (an unknown extension is
// *allowed* — read as UTF-8/plaintext, same as VS Code opening anything as text — but a
// known-binary one is refused, since reading it as UTF-8 would already be lossy and
// writing that back would corrupt it) and a size cap (so a multi-hundred-MB file never
// gets pulled whole into memory and the renderer).

const MAX_EDITABLE_BYTES = 2 * 1024 * 1024; // 2 MiB

/** Recognised filenames with no extension — config files that are conventionally
 *  plain text regardless of what's in them. Includes the SSH/server admin files this
 *  app's own users are most likely to open over SFTP. */
const TEXT_FILENAMES = new Set([
  'dockerfile',
  'makefile',
  'jenkinsfile',
  'procfile',
  'vagrantfile',
  '.gitignore',
  '.gitattributes',
  '.dockerignore',
  '.gitconfig',
  '.npmrc',
  '.yarnrc',
  '.eslintrc',
  '.prettierrc',
  '.babelrc',
  '.nvmrc',
  '.env',
  '.bashrc',
  '.bash_profile',
  '.zshrc',
  '.zprofile',
  '.profile',
  '.editorconfig',
  'sshd_config',
  'ssh_config',
  'known_hosts',
  'authorized_keys',
  'hosts',
  'hostname',
  'fstab',
  'crontab',
  'exports',
  'sudoers',
  'passwd',
  'group',
  'shadow',
  'resolv.conf'
]);

/** Extension (without the dot) -> Monaco language id — every id here is already
 *  registered by the Monaco build this app ships, so adding a row is purely "recognise
 *  this extension", never "teach Monaco a new language". */
const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  yml: 'yaml',
  yaml: 'yaml',
  json: 'json',
  jsonc: 'json',
  json5: 'json',
  toml: 'ini',
  ini: 'ini',
  cfg: 'ini',
  conf: 'ini',
  properties: 'ini',
  env: 'ini',
  desktop: 'ini',
  service: 'ini',
  unit: 'ini',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  ksh: 'shell',
  fish: 'shell',
  txt: 'plaintext',
  log: 'plaintext',
  csv: 'plaintext',
  tsv: 'plaintext',
  md: 'markdown',
  markdown: 'markdown',
  xml: 'xml',
  xsd: 'xml',
  xsl: 'xml',
  xslt: 'xml',
  svg: 'xml',
  plist: 'xml',
  html: 'html',
  htm: 'html',
  vue: 'html',
  css: 'css',
  scss: 'scss',
  sass: 'scss',
  less: 'less',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  py: 'python',
  pyw: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  sql: 'sql',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  hh: 'cpp',
  hxx: 'cpp',
  cs: 'csharp',
  java: 'java',
  php: 'php',
  kt: 'kotlin',
  kts: 'kotlin',
  swift: 'swift',
  lua: 'lua',
  pl: 'perl',
  pm: 'perl',
  r: 'r',
  dart: 'dart',
  graphql: 'graphql',
  gql: 'graphql',
  ps1: 'powershell',
  psm1: 'powershell',
  psd1: 'powershell',
  bat: 'bat',
  cmd: 'bat',
  tf: 'hcl',
  tfvars: 'hcl',
  hcl: 'hcl',
  proto: 'protobuf',
  scala: 'scala',
  clj: 'clojure',
  cljs: 'clojure',
  coffee: 'coffeescript',
  m: 'objective-c',
  mm: 'objective-c',
  pas: 'pascal',
  hbs: 'handlebars',
  handlebars: 'handlebars',
  twig: 'twig',
  jl: 'julia',
  sol: 'solidity',
  tcl: 'tcl',
  vb: 'vb',
  diff: 'diff',
  patch: 'diff',
  dockerfile: 'dockerfile'
};

/** Filenames (lowercased, no extension involved) that get a specific language instead
 *  of the `TEXT_FILENAMES` default of plaintext. */
const LANGUAGE_BY_FILENAME: Record<string, string> = {
  dockerfile: 'dockerfile',
  '.bashrc': 'shell',
  '.bash_profile': 'shell',
  '.zshrc': 'shell',
  '.zprofile': 'shell',
  '.profile': 'shell',
  sshd_config: 'ini',
  ssh_config: 'ini',
  crontab: 'shell'
};

/** Extensions that are essentially always binary — images, archives, executables,
 *  fonts, compiled/media formats. The one thing `isEditableFile` still refuses, since
 *  decoding one as UTF-8 is lossy and saving it back would corrupt it. Everything else,
 *  known or not, is treated as text (VS Code's own default) so a config file with an
 *  extension nobody thought to list still opens — just as `plaintext` instead of a
 *  highlighted language. */
const BINARY_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'bmp',
  'ico',
  'webp',
  'heic',
  'tif',
  'tiff',
  'mp4',
  'mov',
  'avi',
  'mkv',
  'webm',
  'flv',
  'wmv',
  'mp3',
  'wav',
  'flac',
  'ogg',
  'm4a',
  'aac',
  'zip',
  'tar',
  'gz',
  'tgz',
  'bz2',
  'xz',
  '7z',
  'rar',
  'exe',
  'dll',
  'so',
  'dylib',
  'bin',
  'o',
  'obj',
  'class',
  'jar',
  'war',
  'pyc',
  'wasm',
  'ttf',
  'otf',
  'woff',
  'woff2',
  'eot',
  'pdf',
  'doc',
  'docx',
  'xls',
  'xlsx',
  'ppt',
  'pptx',
  'db',
  'sqlite',
  'sqlite3',
  'iso',
  'dmg',
  'img'
]);

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot <= 0 ? '' : filename.slice(dot + 1).toLowerCase();
}

/** Whether the SFTP "Open" action should load this entry into the editor: small enough
 *  to read whole, and not a known-binary extension. An unrecognised extension (or none
 *  at all) is still editable — it just highlights as `plaintext`. */
export function isEditableFile(filename: string, sizeBytes: number): boolean {
  if (sizeBytes > MAX_EDITABLE_BYTES) return false;
  const lower = filename.toLowerCase();
  if (TEXT_FILENAMES.has(lower)) return true;
  return !BINARY_EXTENSIONS.has(extensionOf(lower));
}

/** The Monaco language id to highlight `filename` with: a specific match by full
 *  filename first (`Dockerfile`, `.bashrc`, …), then by extension, then `plaintext`. */
export function languageForFile(filename: string): string {
  const lower = filename.toLowerCase();
  return LANGUAGE_BY_FILENAME[lower] ?? LANGUAGE_BY_EXTENSION[extensionOf(lower)] ?? 'plaintext';
}
