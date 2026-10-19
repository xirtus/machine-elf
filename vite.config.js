import { defineConfig } from 'vite';

export default defineConfig({
  server: { port: 5183, host: true },
  build: { target: 'esnext', sourcemap: true },
  esbuild: { target: 'esnext' },
  optimizeDeps: { esbuildOptions: { target: 'esnext' } },
});
