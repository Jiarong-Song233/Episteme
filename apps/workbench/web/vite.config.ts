import { defineConfig } from 'vite'

// JSX needs no plugin here: Vite reads `jsx` from tsconfig. The service serves `dist` from any path, so
// asset links stay relative.
export default defineConfig({
  base: './',
  build: { outDir: 'dist', emptyOutDir: true },
})
