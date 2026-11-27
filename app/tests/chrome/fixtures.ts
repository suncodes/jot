import fs from 'node:fs'
import path from 'node:path'
import { chromium, test as base, expect } from '@playwright/test'

/** 显式启动本机 Chrome；用户数据仅位于本轮工作区临时目录。 */
export const test = base.extend({
  context: async ({}, use, info) => {
    const root = path.resolve(process.env.JOT_CHROME_TEST_ROOT ?? path.join(import.meta.dirname, '../../../tmp/chrome'))
    fs.mkdirSync(root, { recursive: true })
    const profile = fs.mkdtempSync(path.join(root, 'profile-'))
    let context: Awaited<ReturnType<typeof chromium.launchPersistentContext>> | undefined
    try {
      context = await chromium.launchPersistentContext(profile, {
        ...info.project.use.launchOptions, headless: true, viewport: { width: 1280, height: 900 },
      })
      await use(context)
    }
    finally {
      await context?.close()
      const absolute = path.resolve(profile)
      if (!absolute.startsWith(root + path.sep)) throw new Error('临时浏览器路径越界')
      fs.rmSync(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
    }
  },
  page: async ({ context }, use) => { await use(await context.newPage()) },
})
export { expect }
