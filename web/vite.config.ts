import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: here,
  plugins: [react(), tailwindcss()],
  build: {
    outDir: path.resolve(here, '../dist/web'),
    emptyOutDir: true,
    sourcemap: false,
    chunkSizeWarningLimit: 900,
  },
  server: {
    port: 5173,
    // changeOrigin: false conserva la cabecera Host del navegador, así la comprobación de origen (CSRF)
    // del servidor acepta las peticiones del servidor de desarrollo sin tener que definir APP_URL.
    proxy: { '/api': { target: 'http://localhost:3000', changeOrigin: false } },
  },
});
