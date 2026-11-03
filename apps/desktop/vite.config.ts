import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Renderer: shared React Native components rendered with react-native-web.
export default defineConfig({
  root: 'src/renderer',
  base: './',
  plugins: [react()],
  resolve: {
    alias: [
      { find: /^react-native$/, replacement: 'react-native-web' },
      // Same Lucide components rendered as DOM SVG (no react-native-svg on the web renderer).
      { find: /^lucide-react-native$/, replacement: 'lucide-react' },
    ],
    extensions: ['.web.tsx', '.web.ts', '.tsx', '.ts', '.web.js', '.js'],
  },
  define: { __DEV__: 'false', 'process.env.NODE_ENV': '"production"' },
  build: { outDir: '../../dist/renderer', emptyOutDir: true, sourcemap: false },
});
