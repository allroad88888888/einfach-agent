/// <reference types="vitest/config" />

import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 相对本配置文件解析（不再硬编码 /Volumes/... 绝对路径）——项目挪目录 / 换机器都不受影响。
const fromRoot = (relative: string) => fileURLToPath(new URL(relative, import.meta.url))

export default defineConfig({
  plugins: [react()],
  resolve: {
    // react/react-dom 强制解析到本 app 的 node_modules 并去重，避免多副本 React。
    alias: {
      react: fromRoot('./node_modules/react'),
      'react-dom': fromRoot('./node_modules/react-dom'),
      '@': fromRoot('./src'),
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
