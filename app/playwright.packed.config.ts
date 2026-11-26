import { defineConfig } from '@playwright/test'

// 对打包好的程序（dist/win-unpacked）做冒烟测试。先运行 pnpm app:dir。
export default defineConfig({
  testDir: 'tests/packed',
  timeout: 90000,
  workers: 1,
  reporter: [['list']],
  outputDir: '../tmp/packed-results',
})
