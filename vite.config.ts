/// <reference types="vitest/config" />

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const appNodeModules = '/Volumes/work/ai/web-agent/node_modules'

export default defineConfig({
  plugins: [react()],
  resolve: {
    // react/react-dom 强制解析到本 app 的 node_modules 并去重，避免多副本 React。
    alias: {
      react: `${appNodeModules}/react`,
      'react-dom': `${appNodeModules}/react-dom`,
      '@': '/Volumes/work/ai/web-agent/src',
    },
    dedupe: ['react', 'react-dom'],
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    css: true,
    restoreMocks: true,
    // 运行时用模块级单例（如 abortRegistry / 每会话 store 缓存），测试串行避免共享态串扰。
    fileParallelism: false,
  },
})
