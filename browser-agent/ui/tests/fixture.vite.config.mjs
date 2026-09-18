import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

const fromRoot = (path) => fileURLToPath(new URL(`../../../${path}`, import.meta.url))
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)), plugins: [react()],
  resolve: { alias: { react: fromRoot('node_modules/react'), 'react-dom': fromRoot('node_modules/react-dom'), '@einfach-agent/ai': fromRoot('packages/agent-ai/src/index.ts'), '@einfach-agent/core': fromRoot('packages/agent-core/src'), '@einfach-agent/persistence-idb': fromRoot('packages/persistence-idb/src'), '@einfach-agent/react-plugin': fromRoot('packages/agent-react/src/index.ts'), '@einfach-agent/tools-skills': fromRoot('tools/skills/src/index.ts'), '@einfach-agent/tools-agents': fromRoot('tools/agents/src/index.ts'), '@einfach-agent/browser-agent': fromRoot('browser-agent/agent/src/index.ts') }, dedupe: ['react', 'react-dom'] },
  server: { host: '127.0.0.1', port: 4178, strictPort: true },
})
