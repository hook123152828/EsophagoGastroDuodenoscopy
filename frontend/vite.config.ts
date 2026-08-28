import { fileURLToPath, URL } from 'node:url'

import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  /**
   * The gateway is reached through this server, never directly.
   *
   * The page is not always opened at localhost: a VS Code dev tunnel, a LAN
   * address or any other forwarding puts it on a different origin, and an
   * absolute `http://127.0.0.1:8080` then points at the *viewer's* machine —
   * which is why uploads from a tunnelled page failed with a bare network
   * error. Proxying keeps every backend call same-origin, so it works
   * wherever the page is opened from, with no CORS list to maintain and no
   * mixed content over https.
   */
  server: {
    port: 5173,
    proxy: Object.fromEntries(
      ['/api', '/files', '/media'].map((path) => [
        path,
        {
          target: process.env.GATEWAY_TARGET ?? 'http://127.0.0.1:8080',
          changeOrigin: true,
          // Procedure recordings are several GB and the scan streams over SSE;
          // neither must be cut off by a proxy timeout.
          timeout: 0,
          proxyTimeout: 0,
        },
      ]),
    ),
  },
})
