import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: 'tests/e2e',
  // 文件优先后的有效场景；旧里程碑用例的替代关系见 tests/README.md。
  testMatch: [
    '**/w5-combination.spec.ts', '**/w4-work-reports.spec.ts', '**/w3-app-extension-ai.spec.ts', '**/w2-work-diary.spec.ts', '**/x3-date-notes.spec.ts', '**/x4-settings.spec.ts', '**/x5-commands.spec.ts', '**/x6-combination.spec.ts', '**/window-preferences.spec.ts',
    '**/r12-combination.spec.ts', '**/r11-maintenance.spec.ts', '**/r10-ideas.spec.ts', '**/r9-suggestions.spec.ts', '**/r8-ranges.spec.ts', '**/r7-storage.spec.ts', '**/r6-contracts.spec.ts', '**/file-first.spec.ts', '**/content-directories.spec.ts', '**/library-navigation.spec.ts', '**/storage-structure.spec.ts',
    '**/assistant-operations.spec.ts', '**/assistant-file-first.spec.ts', '**/ui-file-first.spec.ts', '**/operations.spec.ts',
    '**/u7-combination.spec.ts', '**/u6-productivity.spec.ts', '**/u5-pipelines.spec.ts', '**/u4-reasoning.spec.ts', '**/capability-management.spec.ts', '**/capabilities.spec.ts', '**/assistant-notes.spec.ts', '**/assistant-budget.spec.ts', '**/assistant-compaction.spec.ts', '**/assistant-export.spec.ts', '**/file-first-lifecycle.spec.ts',
  ],

  timeout: 60000,
  workers: 1,
  reporter: [['list']],
  outputDir: '../tmp/e2e-results',
})
