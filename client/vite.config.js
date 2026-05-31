import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // REST + Socket.IO + Voice Agent WS all live under /api on the backend.
      '/api': {
        target: 'http://localhost:5000',
        changeOrigin: true,
        ws: true
      },
      '/socket.io': {
        target: 'http://localhost:5000',
        changeOrigin: true,
        ws: true
      }
    }
  }
});
