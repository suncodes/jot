import fs from 'node:fs'
import path from 'node:path'
import { test as base, expect, type Page } from '@playwright/test'
import type { Args, Channel, Ret } from '../../shared/ipc'
import type { Result } from '../../shared/result'
import { cleanup, launch, type Launched } from './helpers'

export async function callOnPage<K extends Channel>(page: Page, channel: K, args: Args<K>): Promise<Ret<K>> {
  const result = await page.evaluate(async payload => (window.jot.invoke as (name: string, data: unknown) => Promise<unknown>)(payload.channel, payload.args), { channel, args }) as Result<Ret<K>>
  if (!result.ok) throw new Error(result.error.code + ': ' + result.error.message)
  return result.data
}

interface FileApp {
  launched: Launched; page: Page; vault: string
  call: <K extends Channel>(channel: K, args: Args<K>) => Promise<Ret<K>>
  write: (rel: string, text: string) => void
  select: (rel: string) => Promise<void>
  open: (rel: string) => Promise<void>
}
export const test = base.extend<{ jot: FileApp }>({
  jot: async ({}, use) => {
    const launched = await launch({ isolateHotkey: true }), page = launched.page
    const vault = path.join(launched.workDir, 'R2虚构库')
    const call: FileApp['call'] = (channel, args) => callOnPage(page, channel, args)
    try {
      await page.getByTestId('vault-path').fill(vault); await page.getByTestId('vault-use').click()
      await page.getByTestId('model-skip').click(); await page.getByTestId('onboarding-start').click()
      await expect(page.getByTestId('shell')).toBeVisible()
      await call('settings:set', { classify: { enabled: false }, daily: { enabled: false } })
      await page.setViewportSize({ width: 1440, height: 940 })
      const row = (rel: string) => page.getByTestId('library-sidebar').locator('[data-path=' + JSON.stringify(rel) + ']')
      async function select(rel: string): Promise<void> {
        await page.getByTestId('ribbon-library').click()
        const parts = rel.split('/')
        for (let i = 2; i < parts.length; i++) {
          const toggle = row(parts.slice(0, i).join('/')).getByTestId('library-toggle')
          if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click()
        }
        await row(rel).getByTestId('library-directory').click()
        await expect(page.getByTestId('library-title')).toHaveText(parts.at(-1)!)
      }
      await use({
        launched, page, vault, call, select,
        write: (rel, text) => { const absolute = path.join(vault, rel); fs.mkdirSync(path.dirname(absolute), { recursive: true }); fs.writeFileSync(absolute, text) },
        open: async rel => {
          await page.getByTestId('ribbon-library').click(); await page.getByTestId('library-all').click()
          await page.locator('[data-testid="library-item"][data-path=' + JSON.stringify(rel) + ']').getByTestId('library-item-open').click()
        },
      })
    } finally { await launched.close(); cleanup(launched.userData, launched.workDir) }
  },
})
export { expect }
