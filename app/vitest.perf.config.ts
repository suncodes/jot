import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

// 规模测试：几万条记录下搜索和统计的耗时。比较慢，不属于常规测试，用 pnpm test:perf 单独运行。
export default defineConfig({
  resolve: { alias: { '@shared': resolve(import.meta.dirname, 'shared') } },
  test: { include: ['tests/perf/**/*.perf.test.ts'], environment: 'node', testTimeout: 600000, hookTimeout: 600000 },
})
