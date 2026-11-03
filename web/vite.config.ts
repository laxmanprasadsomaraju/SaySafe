import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';

export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, path.resolve(__dirname), 'VITE_'), ...process.env };
  // The AG Studio chunk (~5 MB) is only built when a licence key (or the local-only eval switch) is set at build time.
  // Otherwise __AG_STUDIO_BUILD__ is the literal false and the dynamic import is dropped from the public bundle.
  const agStudio = Boolean(env.VITE_AG_STUDIO_LICENSE?.trim()) || env.VITE_AG_STUDIO_LOCAL_EVAL === '1';
  return {
    root: path.resolve(__dirname),
    plugins: [react(), tailwindcss()],
    define: { __AG_STUDIO_BUILD__: JSON.stringify(agStudio) },
    server: { port: 5173, proxy: { '/api': 'http://localhost:8787' } },
    build: { outDir: path.resolve(__dirname, 'dist'), emptyOutDir: true },
  };
});
