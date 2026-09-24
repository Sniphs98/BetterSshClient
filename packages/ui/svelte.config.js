import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
export default {
  preprocess: vitePreprocess(),
  kit: {
    // SPA, served by Electron's main process over a custom `app://` origin
    // (packages/electron/src/appProtocol.ts) rather than a bare `file://` load,
    // so this build's root-absolute asset paths (`/_app/...`) resolve correctly.
    // The client-side router never needs the fallback page since the app always
    // starts at `/`, but adapter-static still wants one.
    adapter: adapter({ fallback: 'index.html' }),
    alias: { $lib: 'src/lib' }
  }
};
