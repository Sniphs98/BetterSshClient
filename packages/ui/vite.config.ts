import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

// Fixed dev port; the Electron main process loads it via OMNYSSH_DEV_SERVER_URL.
export default defineConfig({
  plugins: [sveltekit()],
  clearScreen: false,
  server: { port: 5173, strictPort: true },
  build: { target: 'esnext' }
});
