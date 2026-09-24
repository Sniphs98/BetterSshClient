// File-type icons for the SFTP browser, from the vscode-icons set (MIT, Roberto
// Huertas — see static/file-icons/LICENSE.txt). Both the icons and the lookup table are
// copied into this repo, so nothing is fetched at runtime and the VS Code extension
// itself is not a dependency.
//
// `fileIconMap.json` is generated from that extension's *Zed* theme rather than its
// VS Code one: the VS Code manifest resolves common types like `.py` and `Dockerfile`
// through the editor's language registry, which we don't have, so half the everyday
// extensions would have fallen back to the generic icon. The Zed variant maps suffixes
// directly.

import map from './fileIconMap.json';

interface IconMap {
  defaultFile: string;
  defaultFolder: string;
  extensions: Record<string, string>;
  fileNames: Record<string, string>;
  folderNames: Record<string, string>;
  /** Icons that would vanish on a light background have a light-theme twin. */
  lightByDark: Record<string, string>;
}

const icons = map as IconMap;

/** Where the SVGs are served from — `static/` is copied to the app root at build time. */
const BASE = '/file-icons';

/** The longest suffix that matches, so `.d.ts` wins over `.ts`. Compound archive names
 *  like `.tar.gz` resolve to `gz`, which is what the icon set itself does. */
function extensionIcon(lowerName: string): string | undefined {
  const parts = lowerName.split('.');
  for (let i = 1; i < parts.length; i++) {
    const hit = icons.extensions[parts.slice(i).join('.')];
    if (hit) return hit;
  }
  return undefined;
}

/** The icon file name (no path, no extension) for a directory entry. An exact filename
 *  wins over a suffix, because `package.json` and `Dockerfile.prod` mean something more
 *  specific than `.json` and `.prod` do. */
export function fileIconName(name: string, isDir: boolean, theme: 'light' | 'dark' = 'dark'): string {
  const lower = name.toLowerCase();
  const dark = isDir
    ? (icons.folderNames[lower] ?? icons.defaultFolder)
    : (icons.fileNames[lower] ?? extensionIcon(lower) ?? icons.defaultFile);
  return theme === 'light' ? (icons.lightByDark[dark] ?? dark) : dark;
}

/** The URL to render, ready for an `<img src>`. */
export function fileIconUrl(name: string, isDir: boolean, theme: 'light' | 'dark' = 'dark'): string {
  return `${BASE}/${fileIconName(name, isDir, theme)}.svg`;
}
