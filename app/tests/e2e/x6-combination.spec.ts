import fs from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { test, expect, callOnPage } from './file-fixture'
import { launch, shot } from './helpers'
import { workDiaryOptions } from '../helpers/app-extension'

const work = 'extension:work-diary:today:today', personal = 'extension:personal-diary:today:today'
const rail = (page: Page, id: string) => page.locator('[data-testid="quick-command"][data-command="' + id + '"]')
async function install(page: Page, id: string, template = { kind: 'package' as const, path: 'templates/default.md' }): Promise<void> {
  const pending = await callOnPage(page, 'extensions:previewImport', { source: { kind: 'bundled', id } })
  await callOnPage(page, 'extensions:confirmImport', { token: pending!.token })
  await callOnPage(page, 'extensions:saveProfile', { id, profile: { id: 'today', commandId: 'today', name: 'X6-' + id,
    options: id === 'work-diary' ? workDiaryOptions('content/工作/X6/' + id, { filename: '{{dd}}日.md', template }) : { directory: 'content/工作/X6/' + id + '/{{yyyy}}年-{{MM}}月', filename: '{{dd}}日.md', template } },
    shortcut: { pinned: true, hotkey: id === 'work-diary' ? 'Ctrl+Alt+D' : 'Ctrl+Alt+I' } })
  await callOnPage(page, 'extensions:setEnabled', { id, enabled: true })
  await expect(rail(page, 'extension:' + id + ':today:today')).toBeVisible()
}
async function switchVault(page: Page, target: string): Promise<void> {
  await page.evaluate(async path => {
    const root = document.getElementById('app') as HTMLElement & { __vue_app__: { config: { globalProperties: {
      $pinia: { _s: Map<string, { openVault(path: string, create: boolean): Promise<void> }> }
    } } } }
    await root.__vue_app__.config.globalProperties.$pinia._s.get('app')!.openVault(path, true)
  }, target)
  await expect(page.getByTestId('statusbar')).toContainText(target)
}

test('X6：两库隔离，迟到执行不打开旧文档，切回及删除索引重启恢复真实配置', async ({ jot }) => {
  const { page, call, launched, vault } = jot
  await install(page, 'work-diary')
  const config = fs.readFileSync(path.join(vault, '.jot/app-extensions.json'), 'utf8')
  const shortcuts = fs.readFileSync(path.join(vault, '.jot/shortcuts.json'), 'utf8')
  const target = (await call('extensions:previewWorkReport', workDiaryOptions('content/工作/X6/work-diary', { filename: '{{dd}}日.md' }))).dailyDraft
  await launched.app.evaluate(({ ipcMain }) => {
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (event: unknown, args: { id: string }) => Promise<unknown>> })._invokeHandlers
    const original = handlers.get('commands:execute')!
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const state = globalThis as unknown as { x6Ready: boolean; x6Release: () => void; x6Restore: () => void }
    state.x6Ready = false; state.x6Release = release
    state.x6Restore = () => { ipcMain.removeHandler('commands:execute'); ipcMain.handle('commands:execute', original) }
    ipcMain.removeHandler('commands:execute')
    ipcMain.handle('commands:execute', async (event, args: { id: string }) => {
      const result = await original(event, args)
      if (args.id === 'extension:work-diary:today:today') { state.x6Ready = true; await gate }
      return result
    })
  })
  await rail(page, work).getByRole('button').click()
  await expect.poll(() => launched.app.evaluate(() => (globalThis as unknown as { x6Ready: boolean }).x6Ready)).toBe(true)
  const oldText = fs.readFileSync(path.join(vault, target.path), 'utf8')
  const second = path.join(launched.workDir, 'X6另一虚构库')
  await switchVault(page, second)
  await expect(page.getByTestId('quick-rail')).toHaveCount(0)
  expect(await call('shortcuts:get', undefined)).toEqual({ schemaVersion: 1, pinned: [], bindings: [] })
  await install(page, 'personal-diary')
  await launched.app.evaluate(() => {
    const state = globalThis as unknown as { x6Release: () => void; x6Restore: () => void }
    state.x6Release(); state.x6Restore()
  })
  await expect(rail(page, work)).toHaveCount(0)
  await page.keyboard.press('Control+Shift+p')
  await expect(page.getByTestId('command-palette')).toBeVisible()
  await expect(page.locator('[data-testid="palette-command"][data-command="' + work + '"]')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(page.locator('[data-testid="tab"][data-path="' + target.path + '"]')).toHaveCount(0)
  expect(fs.existsSync(path.join(second, target.path))).toBe(false)
  await page.getByTestId('capture-input').focus()
  await page.keyboard.press('Control+Alt+i')
  await expect(page.locator('[data-testid="doc-view"]:visible')).toBeVisible()
  expect((await call('extensions:configuration', undefined)).extensions['work-diary']).toBeUndefined()
  await switchVault(page, vault)
  await expect(rail(page, work)).toBeVisible()
  await expect(rail(page, personal)).toHaveCount(0)
  expect(fs.readFileSync(path.join(vault, '.jot/app-extensions.json'), 'utf8')).toBe(config)
  expect(fs.readFileSync(path.join(vault, '.jot/shortcuts.json'), 'utf8')).toBe(shortcuts)
  expect(fs.readFileSync(path.join(vault, target.path), 'utf8')).toBe(oldText)
  await launched.close()
  for (const name of ['index.db', 'index.db-wal', 'index.db-shm']) {
    const file = path.join(vault, '.jot', name)
    if (fs.existsSync(file)) fs.unlinkSync(file)
  }
  const restarted = await launch({ isolateHotkey: true, reuse: { userData: launched.userData, workDir: launched.workDir } })
  try {
    await expect(rail(restarted.page, work)).toBeVisible()
    await expect(rail(restarted.page, personal)).toHaveCount(0)
    await rail(restarted.page, work).getByRole('button').click()
    await expect(restarted.page.locator('[data-testid="doc-view"]:visible')).toHaveAttribute('data-path', target.path)
    expect(fs.readFileSync(path.join(vault, target.path), 'utf8')).toBe(oldText)
    expect(fs.readFileSync(path.join(vault, '.jot/shortcuts.json'), 'utf8')).toBe(shortcuts)
  } finally { await restarted.close() }
})

test('X6：模板缺失及包损坏撤销入口，修复恢复；另一插件、笔记和用户模板保留', async ({ jot }) => {
  const { page, call, vault } = jot
  await install(page, 'work-diary')
  await install(page, 'personal-diary')
  const template = 'templates/X6用户模板/工作.md'
  await call('extensions:copyTemplate', { id: 'work-diary', path: 'templates/default.md', targetPath: template })
  const originalTemplate = fs.readFileSync(path.join(vault, template), 'utf8')
  const profile = (await call('extensions:configuration', undefined)).extensions['work-diary']!.profiles[0]!
  await call('extensions:saveProfile', { id: 'work-diary', profile: { ...profile, options: { ...profile.options, template: { kind: 'user', path: template } } } })
  const shortcuts = await call('shortcuts:get', undefined)
  fs.unlinkSync(path.join(vault, template))
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(rail(page, work)).toHaveCount(0)
  await expect(rail(page, personal)).toBeVisible()
  expect(await call('shortcuts:get', undefined)).toEqual(shortcuts)
  await page.keyboard.press('Control+Shift+p')
  await expect(page.locator('[data-testid="palette-command"][data-command="' + work + '"]')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await page.getByTestId('ribbon-settings').click()
  await page.getByTestId('settings-nav-extensions').click()
  await page.locator('[data-testid="extension-row"][data-extension="work-diary"]').getByTestId('extension-configure').click()
  await expect(page.getByTestId('settings-extensions')).toContainText('模板不存在')
  await shot(page, 'x6-missing-template-light')
  fs.writeFileSync(path.join(vault, template), originalTemplate)
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(rail(page, work)).toBeVisible()
  await rail(page, work).getByRole('button').click()
  const note = await call('commands:execute', { id: work })
  if (note.kind !== 'open-note') throw new Error('命令结果不符')
  const original = fs.readFileSync(path.join(vault, note.path), 'utf8')
  fs.unlinkSync(path.join(vault, template))
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(rail(page, work)).toBeVisible()
  await rail(page, work).getByRole('button').click()
  expect(fs.readFileSync(path.join(vault, note.path), 'utf8')).toBe(original)
  fs.writeFileSync(path.join(vault, template), originalTemplate)
  const manifest = path.join(vault, '.jot/app-extensions/work-diary/extension.json')
  fs.writeFileSync(manifest, '{X6 broken')
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(rail(page, work)).toHaveCount(0)
  await expect(rail(page, personal)).toBeVisible()
  const preview = await call('extensions:previewImport', { source: { kind: 'bundled', id: 'work-diary' }, updating: 'work-diary' })
  expect(preview?.warnings.join(' ')).toContain('当前包损坏')
  await call('extensions:confirmImport', { token: preview!.token })
  await expect(rail(page, work)).toBeVisible()
  expect(await call('shortcuts:get', undefined)).toEqual(shortcuts)
  expect((await call('extensions:configuration', undefined)).extensions['work-diary']!.profiles[0]!.options.template).toEqual({ kind: 'user', path: template })
  await call('extensions:uninstall', { id: 'work-diary', confirmed: true })
  await expect(rail(page, work)).toHaveCount(0)
  await expect(rail(page, personal)).toBeVisible()
  expect(fs.readFileSync(path.join(vault, template), 'utf8')).toBe(originalTemplate)
  expect(fs.readFileSync(path.join(vault, note.path), 'utf8')).toBe(original)
})
