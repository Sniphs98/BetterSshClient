import { fileURLToPath } from 'node:url';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';

// Store/router unit tests only — no SvelteKit plugin, no Tauri runtime. The
// $lib alias mirrors svelte.config.js so tests resolve it the same way. The Svelte
// plugin compiles `.svelte.ts` modules, whose runes ($state…) need the compiler.
export default defineConfig({
  plugins: [svelte()],
  resolve: {
    alias: { $lib: fileURLToPath(new URL('./src/lib', import.meta.url)) }
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts']
  }
});
