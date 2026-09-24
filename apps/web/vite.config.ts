import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

/**
 * Emits /sw.js from sw/sw.js with the precache list (every built asset + shell files) and a
 * content version injected. In dev it serves the same worker with an empty precache.
 */
function dalizServiceWorker(): Plugin {
  const templatePath = fileURLToPath(new URL('./sw/sw.js', import.meta.url));
  const render = (precache: string[], version: string) =>
    readFileSync(templatePath, 'utf8').replace('self.__PRECACHE__', JSON.stringify(precache)).replace('self.__VERSION__', JSON.stringify(version));
  const SHELL = ['/index.html', '/manifest.webmanifest', '/favicon.svg', '/icons/icon-16.png', '/icons/icon-32.png', '/icons/icon-180.png', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/icon-maskable-512.png'];
  return {
    name: 'daliz-service-worker',
    configureServer(server) {
      server.middlewares.use('/sw.js', (_req, res) => {
        res.setHeader('Content-Type', 'application/javascript');
        res.setHeader('Cache-Control', 'no-cache');
        res.end(render([], 'dev'));
      });
    },
    generateBundle(_options, bundle) {
      const assets = Object.keys(bundle)
        .filter((f) => !f.endsWith('.map') && f !== 'index.html')
        .map((f) => `/${f}`);
      const precache = [...SHELL, ...assets];
      const version = createHash('sha256').update(precache.join('|')).digest('hex').slice(0, 12);
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: render(precache, version) });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), dalizServiceWorker()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: 'react', test: /node_modules[\\/](react|react-dom|react-router|scheduler)[\\/]/ },
            { name: 'vendor', test: /node_modules[\\/]/ },
          ],
        },
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    // Listen on all interfaces so tenant hosts such as acme.localhost:5173 resolve.
    host: true,
    allowedHosts: ['.localhost'],
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        // Keep the browser's Host header: the API resolves tenant subdomains from it.
        changeOrigin: false,
        // Realtime (socket.io) upgrades under /api/v1/realtime.
        ws: true,
      },
    },
  },
  preview: {
    port: 4173,
    host: true,
    allowedHosts: ['.localhost'],
    proxy: {
      '/api': { target: 'http://localhost:3000', changeOrigin: false, ws: true },
    },
  },
});
