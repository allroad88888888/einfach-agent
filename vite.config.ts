/// <reference types="vitest/config" />

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const aiComponentsRoot = '/Volumes/work/web/ai-components/packages'
const appNodeModules = '/Volumes/work/ai/web-agent/node_modules'

const aiComponentAliases = {
  '@ai-components/markdown': `${aiComponentsRoot}/markdown/src/index.ts`,
  '@ai-components/title': `${aiComponentsRoot}/title/src/index.ts`,
  '@ai-components/table': `${aiComponentsRoot}/table/src/index.ts`,
  '@ai-components/code': `${aiComponentsRoot}/code/src/index.ts`,
  '@ai-components/blockquote': `${aiComponentsRoot}/blockquote/src/index.ts`,
  '@ai-components/list': `${aiComponentsRoot}/list/src/index.ts`,
  '@ai-components/paragraph': `${aiComponentsRoot}/paragraph/src/index.ts`,
  '@ai-components/link': `${aiComponentsRoot}/link/src/index.ts`,
  '@ai-components/layout': `${aiComponentsRoot}/layout/src/index.ts`,
  '@ai-components/textarea-base': `${aiComponentsRoot}/textarea/src/textarea.tsx`,
}

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      react: `${appNodeModules}/react`,
      'react-dom': `${appNodeModules}/react-dom`,
      '@': '/Volumes/work/ai/web-agent/src',
      ...aiComponentAliases,
    },
    dedupe: ['react', 'react-dom'],
  },
  server: {
    fs: {
      allow: ['/Volumes/work/ai/web-agent', '/Volumes/work/web/ai-components'],
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    css: true,
    restoreMocks: true,
    fileParallelism: false,
  },
})
