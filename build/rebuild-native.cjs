// electron-builder `beforePack` hook: rebuild native modules for Electron the way
// electron-builder itself does (app-builder-lib/out/util/yarn.js), except node-pty.
//
// node-pty (local terminals) is N-API and ships prebuilt binaries for Windows and macOS
// (built on install on Linux), so it loads in Electron as it is. electron-builder's own
// rebuild would hand it to node-gyp, which fails on a machine without a full C++
// toolchain and gains nothing where it succeeds — and electron-builder has no way to
// leave one module out. So its rebuild is off (`npmRebuild: false`) and this one runs
// instead, before the app's files are copied; everything else (ssh2's optional crypto
// binding) is still rebuilt for Electron as before.
const fs = require('node:fs');
const path = require('node:path');
const { rebuild } = require('@electron/rebuild');
const { getProjectRootPath } = require('@electron/rebuild/lib/search-module');
const { Arch } = require('builder-util');

exports.default = async function beforePack(context) {
  const appDir = context.packager.info.appDir;
  await rebuild({
    buildPath: appDir,
    electronVersion: context.packager.info.framework.version,
    arch: Arch[context.arch],
    platform: context.electronPlatformName,
    projectRootPath: await getProjectRootPath(appDir),
    mode: 'sequential',
    disablePreGypCopy: true,
    ignoreModules: ['node-pty']
  });
  console.log(`  • rebuilt native modules for Electron ${context.packager.info.framework.version} (node-pty kept as shipped)`);

  // node-pty 1.1.0's npm package ships macOS's spawn-helper without the executable bit,
  // and every local shell on macOS starts through it — so the app would ship unable to
  // open one. Set it before the files are copied into the app.
  if (context.electronPlatformName === 'darwin') {
    const nodePty = path.dirname(require.resolve('node-pty/package.json', { paths: [appDir] }));
    for (const arch of ['x64', 'arm64']) {
      const helper = path.join(nodePty, 'prebuilds', `darwin-${arch}`, 'spawn-helper');
      if (fs.existsSync(helper)) fs.chmodSync(helper, 0o755);
    }
  }
};
