import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';
import { resolve } from 'node:path';

const hostProvidedDependencies = [
  '@tanstack/react-query',
  '@wealthfolio/addon-sdk',
  '@wealthfolio/addon-sdk/goal-progress',
  '@wealthfolio/addon-sdk/host-api',
  '@wealthfolio/addon-sdk/host-dependencies',
  '@wealthfolio/addon-sdk/manifest',
  '@wealthfolio/addon-sdk/permissions',
  '@wealthfolio/addon-sdk/query-keys',
  '@wealthfolio/addon-sdk/types',
  '@wealthfolio/addon-sdk/utils',
  '@wealthfolio/ui',
  '@wealthfolio/ui/chart',
  'date-fns',
  'lucide-react',
  'react',
  'react-dom',
  'react-dom/client',
  'react/jsx-dev-runtime',
  'react/jsx-runtime',
  'recharts',
];

// Wealthfolio's addon sandbox rewrites /\bimport\s*\(/g in addon code to
// intercept dynamic imports — and \b matches after a dot, so a method call
// like `activities.import(...)` gets mangled into
// `activities.globalThis.__wealthfolioImport(...)` and fails at runtime.
// Rewriting property calls to bracket notation in the emitted bundle dodges
// the regex ("[\"import\"](" doesn't match). Must run post-minify: esbuild
// normalizes a["import"] back to a.import if done in source.
const escapeImportPropertyCalls = {
  name: 'escape-import-property-calls',
  generateBundle(_: unknown, bundle: Record<string, { type: string; code?: string }>) {
    for (const chunk of Object.values(bundle)) {
      if (chunk.type === 'chunk' && chunk.code) {
        chunk.code = chunk.code.replace(/\.import\s*\(/g, '["import"](');
      }
    }
  },
};

export default defineConfig({
  plugins: [react(), tailwindcss(), escapeImportPropertyCalls],
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'shared'),
    },
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  build: {
    lib: {
      entry: 'src/addon.tsx',
      fileName: () => 'addon.js',
      formats: ['es'],
    },
    outDir: 'dist',
    minify: true,
    sourcemap: false,
    rollupOptions: {
      external: hostProvidedDependencies,
    },
  },
});
