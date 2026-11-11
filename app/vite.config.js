import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

// Proving artifacts are served from ../artifacts/<set> (dev for testnet, mainnet for mainnet).
const set = process.env.VITE_NETWORK === 'mainnet' ? 'mainnet' : 'dev';
const here = (p) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  base: './',
  publicDir: `../artifacts/${set}`,
  resolve: {
    alias: {
      buffer: here('./node_modules/buffer/index.js'),
      assert: here('./src/shims/assert.js'),
    },
  },
  define: { global: 'globalThis', 'process.env.NODE_DEBUG': 'false' },
  build: { target: 'es2022', chunkSizeWarningLimit: 6000 },
});
