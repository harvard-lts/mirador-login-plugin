import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  root: 'demo',
  server: {
    port: 9000,
    // Fail loudly instead of silently sliding to 9001. Other Mirador plugin
    // demos in this org also default to 9000, and a fallback port would make
    // the restricted demo fetch its manifest from whatever else is listening.
    strictPort: true,
    open: true,
  },
  resolve: {
    extensions: ['.js', '.jsx'],
  },
  optimizeDeps: {
    rolldownOptions: {
      moduleTypes: {
        '.js': 'jsx',
      },
    },
  },
  build: {
    outDir: 'dist',
  },
});
