import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// base: './' keeps the build working when hosted under a sub-path (e.g. GitHub Pages).
export default defineConfig({
  base: './',
  plugins: [react()],
  // scripts/clean.mjs empties dist instead: Vite's own emptying uses fs.rmSync, which crashes
  // Node 24 on Windows for this project's non-ASCII path.
  build: { emptyOutDir: false },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
