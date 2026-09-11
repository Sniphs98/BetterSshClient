// Whether the SFTP context menu offers "Edit" for an entry, and which Monaco language to
// highlight it with (tech-gui.md §3.2). Kept pure/framework-free so it's unit-testable
// without mounting the editor. Gated two ways: an extension/filename allowlist (so a
// binary with a misleading name doesn't get "edited" into garbage — reading it as UTF-8
// would already be lossy, and writing that back would corrupt it) and a size cap (so a
// multi-hundred-MB file never gets pulled whole into memory and the renderer).

const MAX_EDITABLE_BYTES = 2 * 1024 * 1024; // 2 MiB

/** Recognised filenames with no extension — config files that are conventionally
 *  plain text regardless of what's in them. */
const TEXT_FILENAMES = new Set([
  'dockerfile',
  'makefile',
  'jenkinsfile',
  'procfile',
  'vagrantfile',
  '.gitignore',
  '.gitattributes',
  '.dockerignore',
  '.env',
  '.bashrc',
  '.bash_profile',
  '.zshrc',
  '.profile',
  '.editorconfig'
]);

/** Extension (without the dot) -> Monaco language id. Covers the config/script formats
 *  someone managing a server actually opens, not a general-purpose IDE's full list. */
const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  yml: 'yaml',
  yaml: 'yaml',
  json: 'json',
  jsonc: 'json',
  toml: 'ini',
  ini: 'ini',
  cfg: 'ini',
  conf: 'ini',
  properties: 'ini',
  env: 'ini',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  txt: 'plaintext',
  log: 'plaintext',
  md: 'markdown',
  markdown: 'markdown',
  xml: 'xml',
  html: 'html',
  htm: 'html',
  css: 'css',
  scss: 'scss',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  py: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  sql: 'sql',
  service: 'ini'
};

/** Filenames (lowercased, no extension involved) that get a specific language instead
 *  of the `TEXT_FILENAMES` default of plaintext. */
const LANGUAGE_BY_FILENAME: Record<string, string> = {
  dockerfile: 'dockerfile',
  '.bashrc': 'shell',
  '.bash_profile': 'shell',
  '.zshrc': 'shell',
  '.profile': 'shell'
};

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot <= 0 ? '' : filename.slice(dot + 1).toLowerCase();
}

/** Whether the SFTP editor should offer this entry — a recognised text extension (or
 *  filename), and small enough to load whole. */
export function isEditableFile(filename: string, sizeBytes: number): boolean {
  if (sizeBytes > MAX_EDITABLE_BYTES) return false;
  const lower = filename.toLowerCase();
  if (TEXT_FILENAMES.has(lower)) return true;
  return extensionOf(filename) in LANGUAGE_BY_EXTENSION;
}

/** The Monaco language id to highlight `filename` with: a specific match by full
 *  filename first (`Dockerfile`, `.bashrc`, …), then by extension, then `plaintext`. */
export function languageForFile(filename: string): string {
  const lower = filename.toLowerCase();
  return LANGUAGE_BY_FILENAME[lower] ?? LANGUAGE_BY_EXTENSION[extensionOf(filename)] ?? 'plaintext';
}
