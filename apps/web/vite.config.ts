import { defaultClientConditions, defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Bundle workspace packages from their TypeScript sources (`rootcamp-src` export condition).
  resolve: { conditions: ['rootcamp-src', ...defaultClientConditions] },
  server: {
    port: 5173,
    // Local `pnpm dev` without the compose stand: proxy API calls to a local api.
    proxy: { '/api': 'http://localhost:3000' },
  },
});
