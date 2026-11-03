import { defineConfig, mergeConfig } from 'vite';
import base from '../vite.config';

// Same aliases/extensions as the renderer; separate root and output (never packaged).
export default mergeConfig(base, defineConfig({ root: 'preview', build: { outDir: '../dist-preview', emptyOutDir: true } }));
