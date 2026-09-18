import { defineConfig } from 'tsup'
import { rawTextPlugin } from '../../tsup.rawPlugin'
export default defineConfig({
  entry: ['src/service-worker.ts', 'src/content-script.ts', 'src/sidepanel.tsx'],
  noExternal: [/.*/],
  splitting: false,
  format: ['esm'],
  target: 'es2022',
  tsconfig: 'tsconfig.bundle.json',
  outDir: 'dist',
  sourcemap: true,
  clean: true,
  removeNodeProtocol: false,
  define: { 'process.env.NODE_ENV': '"production"' },
  esbuildPlugins: [rawTextPlugin()],
})
