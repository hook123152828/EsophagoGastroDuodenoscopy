import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// `host: true` binds 0.0.0.0 so other machines can reach the dev server.
// The `/api` proxy forwards backend calls to the gateway on the same host, so
// only this one port needs to be exposed and there is no cross-origin/CORS
// concern. `allowedHosts: true` lets it also be served through a tunnel
// (ngrok/cloudflared) domain — fine for a demo; tighten it for anything public.
export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 2026,
    allowedHosts: true,
    proxy: {
      '/api': 'http://localhost:8080',
    },
  },
})
