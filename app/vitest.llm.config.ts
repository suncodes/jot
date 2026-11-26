import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

// 用 .env 里的真实模型做验证，数据全部是虚构内容。不属于常规测试。
export default defineConfig({
  resolve: { alias: { '@shared': resolve(import.meta.dirname, 'shared') } },
  test: { include: ['tests/llm/**/*.llm.test.ts'], environment: 'node', testTimeout: 180000, fileParallelism: false },
})
