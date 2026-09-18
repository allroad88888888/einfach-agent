import { defineConfig } from 'tsup'
import { rawTextPlugin } from '../../../tsup.rawPlugin'
export default defineConfig({ entry: ['src/main.ts'], format: ['esm'], target: 'es2022', tsconfig: 'tsconfig.bundle.json', outDir: 'dist', clean: true, sourcemap: true, noExternal: [/.*/], removeNodeProtocol: false, define: { 'process.env.NODE_ENV': '"production"' }, esbuildPlugins: [rawTextPlugin()] })
