import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: { alias: { '@shared': resolve(import.meta.dirname, 'shared') } },
  test: { include: ['tests/unit/**/*.test.ts'], environment: 'node', testTimeout: 15000 },
})
