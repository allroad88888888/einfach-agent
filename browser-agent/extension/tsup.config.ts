import { defineConfig } from 'tsup'
import { rawTextPlugin } from '../../tsup.rawPlugin'
export default defineConfig({
  entry: ['src/service-worker.ts', 'src/content-script.ts', 'src/network-main.ts', 'src/sidepanel.tsx'],
  noExternal: [/.*/],
  splitting: false,
  format: ['esm'],
  // chrome.scripting.executeScript({ files }) evaluates these bundles as classic
  // scripts in the page world. Keep every evaluation's bundled `var` bindings
  // private so reinjection cannot replace state captured by an existing gateway.
  banner: { js: '(() => {' },
  footer: { js: '})();' },
  target: 'es2022',
  tsconfig: 'tsconfig.bundle.json',
  outDir: 'dist',
  sourcemap: true,
  clean: true,
  removeNodeProtocol: false,
  define: { 'process.env.NODE_ENV': '"production"' },
  esbuildPlugins: [rawTextPlugin()],
})
