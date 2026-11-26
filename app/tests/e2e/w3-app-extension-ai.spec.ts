import fs from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { test, expect, callOnPage } from './file-fixture'
import { launch, shot } from './helpers'

const row = (page: Page) => page.locator('[data-testid="extension-row"][data-extension="work-diary"]')
async function settings(page: Page) {
  if (!(await page.getByTestId('settings-sidebar').isVisible())) await page.getByTestId('ribbon-settings').click()
  await page.getByTestId('settings-nav-extensions').click()
}
async function preview(page: Page) {
  await settings(page)
  await page.getByTestId('extensions-tab-bundled').click()
  await row(page).getByTestId('extension-install').click()
  await expect(page.getByTestId('extension-ai-plugin')).toContainText('工作报告')
}
async function configure(page: Page) {
  await settings(page)
  if (await page.getByTestId('extensions-back').isVisible()) await page.getByTestId('extensions-back').click()
  await row(page).getByTestId('extension-configure').click()
  await expect(page.getByTestId('extension-ai-plugin')).toBeVisible()
}

test('W3：安装预览可选联装，深浅色窄窗、真实状态及智能体管理跳转', async ({ jot }) => {
  const { page, call, vault } = jot
  await preview(page)
  await expect(page.getByTestId('extension-ai-select')).not.toBeChecked()
  await page.getByTestId('extension-ai-plugin').getByText('能力包文件', { exact: false }).click()
  await expect(page.getByTestId('extension-ai-plugin')).toContainText('references/daily.md')
  await shot(page, 'w3-joint-install-light')
  await call('settings:set', { appearance: { theme: 'dark' } })
  await page.setViewportSize({ width: 760, height: 820 })
  expect(await page.getByTestId('app-dialog').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  await shot(page, 'w3-joint-install-dark-narrow')
  await page.getByTestId('extension-ai-select').check()
  await page.getByTestId('extension-import-confirm').click()
  await expect(page.getByTestId('app-dialog')).toHaveCount(0)
  await row(page).getByTestId('extension-configure').click()
  await expect(page.getByTestId('extension-ai-state')).toHaveText('已安装 · 已停用')
  expect(fs.existsSync(path.join(vault, '.jot/plugins/work-report/skills/work-report/references/okr.md'))).toBe(true)
  expect((await call('extensions:catalog', undefined)).installed[0]?.enabled).toBe(false)
  await page.getByTestId('extension-ai-manage').click()
  await expect(page.getByTestId('settings-sidebar')).toBeHidden()
  await expect(page.getByTestId('cap-plugin-detail')).toContainText('work-report')
  await expect(page.getByTestId('cap-plugin-toggle')).toHaveText('启用')
  await page.getByTestId('cap-plugin-toggle').click()
  await expect(page.getByTestId('cap-plugin-toggle')).toHaveText('停用')
  await configure(page)
  await expect(page.getByTestId('extension-ai-state')).toHaveText('已安装 · 已启用')
  await page.getByTestId('extension-enable-detail').click()
  expect((await call('capabilities:catalog', undefined)).plugins.find(plugin => plugin.id === 'work-report')?.enabled).toBe(true)
})

test('W3：跳过联装后可补装；取消不落盘，重启保留两类包独立状态', async ({ jot }) => {
  const { page, call, vault, launched } = jot
  await preview(page)
  await page.getByTestId('extension-import-confirm').click()
  await expect(page.getByTestId('app-dialog')).toHaveCount(0)
  await row(page).getByTestId('extension-configure').click()
  await expect(page.getByTestId('extension-ai-state')).toHaveText('尚未安装')
  await page.getByTestId('extension-ai-install').click()
  await expect(page.getByTestId('app-dialog')).toContainText('references/monthly.md')
  await shot(page, 'w3-later-install-light')
  await page.getByTestId('app-dialog').getByRole('button', { name: '取消', exact: true }).click()
  await expect(page.getByTestId('app-dialog')).toHaveCount(0)
  expect(fs.existsSync(path.join(vault, '.jot/plugins/work-report'))).toBe(false)
  await page.getByTestId('extension-ai-install').click()
  await page.getByTestId('extension-ai-confirm').click()
  await expect(page.getByTestId('extension-ai-state')).toHaveText('已安装 · 已停用')
  await call('extensions:setEnabled', { id: 'work-diary', enabled: true })
  await launched.close()
  const resumed = await launch({ isolateHotkey: true, reuse: launched })
  try {
    await configure(resumed.page)
    await expect(resumed.page.getByTestId('extension-ai-state')).toHaveText('已安装 · 已停用')
    expect((await callOnPage(resumed.page, 'extensions:catalog', undefined)).installed[0]?.enabled).toBe(true)
    await resumed.page.getByTestId('extension-ai-manage').click()
    await expect(resumed.page.getByTestId('cap-plugin-detail')).toContainText('work-report')
    await resumed.page.getByTestId('cap-detail-more').click()
    await resumed.page.getByRole('menuitem', { name: '卸载', exact: true }).click()
    await resumed.page.getByTestId('cap-uninstall-confirm').click()
    await expect(resumed.page.getByTestId('app-dialog')).toHaveCount(0)
    expect(fs.existsSync(path.join(vault, '.jot/app-extensions/work-diary'))).toBe(true)
    await configure(resumed.page)
    await expect(resumed.page.getByTestId('extension-ai-state')).toHaveText('尚未安装')
    await resumed.page.getByTestId('extension-ai-install').click()
    await resumed.page.getByTestId('extension-ai-confirm').click()
    await expect(resumed.page.getByTestId('app-dialog')).toHaveCount(0)
    await resumed.page.getByTestId('extensions-back').click()
    await row(resumed.page).getByTestId('extension-more').click()
    await resumed.page.getByRole('menuitem', { name: '卸载', exact: true }).click()
    await resumed.page.getByTestId('extension-remove-confirm').click()
    await expect(resumed.page.getByTestId('app-dialog')).toHaveCount(0)
    expect(fs.existsSync(path.join(vault, '.jot/app-extensions/work-diary'))).toBe(false)
    expect(fs.existsSync(path.join(vault, '.jot/plugins/work-report/plugin.json'))).toBe(true)
  } finally { await resumed.close() }
})

test('W3：已有同标识能力包只显示真实停用状态，不提供重复联装', async ({ jot }) => {
  const { page, call, vault } = jot
  await call('capabilities:changePlugin', { action: 'save', manifest: { schemaVersion: 1, id: 'work-report', name: '我的工作报告', description: '用户自己维护的规则', agents: [], skills: ['custom'], requiredTools: [] }, files: [
    { path: 'skills/custom/SKILL.md', content: '---\nname: custom\ndescription: 用户自己的规则\n---\n# 已有工作报告技能' },
  ], enabled: false })
  const file = path.join(vault, '.jot/plugins/work-report/plugin.json')
  const original = fs.readFileSync(file, 'utf8')
  await preview(page)
  await expect(page.getByTestId('extension-ai-state')).toHaveText('已安装 · 已停用')
  await expect(page.getByTestId('extension-ai-select')).toHaveCount(0)
  await page.getByTestId('extension-import-confirm').click()
  await expect(page.getByTestId('app-dialog')).toHaveCount(0)
  await row(page).getByTestId('extension-configure').click()
  await expect(page.getByTestId('extension-ai-install')).toHaveCount(0)
  await expect(page.getByTestId('extension-ai-manage')).toBeVisible()
  expect(fs.readFileSync(file, 'utf8')).toBe(original)
  expect((await call('capabilities:catalog', undefined)).plugins.find(plugin => plugin.id === 'work-report')?.enabled).toBe(false)
})

test('W3：损坏的附带包单独报错，普通日记配置仍可使用', async ({ jot }) => {
  const { page, call } = jot
  const pending = await call('extensions:previewImport', { source: { kind: 'bundled', id: 'work-diary' } })
  await call('extensions:confirmImport', { token: pending!.token })
  jot.write('.jot/app-extensions/work-diary/ai/work-report/plugin.json', '{broken')
  await configure(page)
  await expect(page.getByTestId('extension-ai-state')).toHaveText('包不可用')
  await expect(page.getByTestId('extension-ai-plugin')).toContainText('有效的 JSON')
  await expect(page.getByTestId('extension-ai-install')).toHaveCount(0)
  await expect(page.getByTestId('extension-profile-edit')).toBeEnabled()
  await page.getByTestId('extension-profile-edit').click()
  await expect(page.getByTestId('work-diary-fields')).toBeVisible()
})
