import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

// Proving artifacts for both networks are served from ../artifacts: ./dev/ (testnet key)
// and ./mainnet/ (mainnet key). The app picks the set for the selected network.
const here = (p) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  base: './',
  publicDir: '../artifacts',
  resolve: {
    alias: {
      buffer: here('./node_modules/buffer/index.js'),
      assert: here('./src/shims/assert.ts'),
      crypto: here('./src/shims/empty.ts'),
    },
  },
  define: { global: 'globalThis', 'process.env.NODE_DEBUG': 'false' },
  build: { target: 'es2022', chunkSizeWarningLimit: 6000 },
});
