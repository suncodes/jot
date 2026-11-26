import fs from 'node:fs'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import type { Args, Channel, Ret } from '../../shared/ipc'
import type { Result } from '../../shared/result'
import { cleanup, launch, shot, type Launched } from './helpers'

let launched: Launched
let page: Page
let vault: string
const doc = () => page.locator('[data-testid="doc-view"]:visible')
const fileView = () => page.locator('[data-testid="file-view"]:visible')
async function call<K extends Channel>(channel: K, args: Args<K>): Promise<Ret<K>> {
  const result = await page.evaluate(async payload =>
    (window.jot.invoke as (name: string, data: unknown) => Promise<unknown>)(payload.channel, payload.args), { channel, args }) as Result<Ret<K>>
  if (!result.ok) throw new Error(result.error.code + ': ' + result.error.message)
  return result.data
}
function write(rel: string, text: string): void {
  const absolute = path.join(vault, rel)
  fs.mkdirSync(path.dirname(absolute), { recursive: true })
  fs.writeFileSync(absolute, text)
}
async function openItem(rel: string): Promise<void> {
  await page.getByTestId('ribbon-library').click()
  await page.getByTestId('library-all').click()
  await page.locator('[data-testid="library-item"][data-path=' + JSON.stringify(rel) + ']').getByTestId('library-item-open').click()
}
test.beforeEach(async () => {
  launched = await launch()
  page = launched.page
  vault = path.join(launched.workDir, 'R1虚构库')
  await page.getByTestId('vault-path').fill(vault)
  await page.getByTestId('vault-use').click()
  await page.getByTestId('model-skip').click()
  await page.getByTestId('onboarding-start').click()
  await expect(page.getByTestId('shell')).toBeVisible()
  await call('settings:set', { classify: { enabled: false }, daily: { enabled: false } })
  await page.setViewportSize({ width: 1440, height: 940 })
})
test.afterEach(async () => { await launched.close(); cleanup(launched.userData, launched.workDir) })

test('外部无 ID 笔记可打开、标准相对链接可跳转，编辑保存不补 ID', async () => {
  write('content/工作/入口.md', '# 入口\n\n[规则](规则.md)')
  write('content/工作/规则.md', '# 规则\n\n原规则')
  await call('vault:refreshIndex', {})
  await openItem('content/工作/入口.md')
  await doc().getByTestId('doc-preview').getByRole('link', { name: '规则', exact: true }).click()
  await expect(doc()).toHaveAttribute('data-path', 'content/工作/规则.md')
  await doc().getByTestId('doc-toggle').click()
  await doc().getByTestId('editor').locator('.cm-content').fill('# 规则\n\n真实修改')
  await expect.poll(() => fs.readFileSync(path.join(vault, 'content/工作/规则.md'), 'utf8')).toContain('真实修改')
  expect(fs.readFileSync(path.join(vault, 'content/工作/规则.md'), 'utf8')).not.toMatch(/^---\nid:/)
  await doc().getByTestId('doc-toggle').click()
  await shot(page, 'r1-note-relative-link')
})

test('导入 Markdown 属性写 sidecar；原文可编辑，改名后附属文件一起移动', async () => {
  const outside = path.join(launched.workDir, '会议资料.md')
  const source = '---\ntype: daily\ntags: [原资料]\n---\n需要讨论的接口'
  fs.writeFileSync(outside, source)
  const imported = await call('files:import', { paths: [outside], toDir: 'content/工作' })
  expect(imported.skipped).toEqual([])
  await openItem(imported.imported[0]!)
  await expect(fileView()).toBeVisible()
  await fileView().getByTestId('props-summary').click()
  await fileView().getByTestId('props-tags-input').fill('接口')
  await fileView().getByTestId('props-tags-input').press('Enter')
  await expect.poll(() => fs.readFileSync(path.join(vault, 'content/工作/会议资料.md.meta.yaml'), 'utf8')).toContain('接口')
  expect(fs.readFileSync(path.join(vault, 'content/工作/会议资料.md'), 'utf8')).toBe(source)
  await doc().getByTestId('doc-toggle').click()
  await doc().getByTestId('editor').locator('.cm-content').fill(source + '\n用户明确补充')
  await expect.poll(() => fs.readFileSync(path.join(vault, 'content/工作/会议资料.md'), 'utf8')).toContain('用户明确补充')
  await fileView().getByTestId('content-more').click()
  await page.getByTestId('content-rename').click()
  await page.getByTestId('content-name-input').fill('会议资料新版.md')
  await page.getByTestId('content-confirm').click()
  await expect(fileView()).toHaveAttribute('data-path', 'content/工作/会议资料新版.md')
  expect(fs.existsSync(path.join(vault, 'content/工作/会议资料新版.md.meta.yaml'))).toBe(true)
  expect(fs.existsSync(path.join(vault, 'content/工作/会议资料.md.meta.yaml'))).toBe(false)
  await shot(page, 'r1-attachment-light')
  await page.getByTestId('theme-toggle').click()
  await shot(page, 'r1-attachment-dark')
})

test('外部 sidecar 修改和删除直接刷新属性；空目录及共享侧栏保留', async () => {
  write('content/工作/清单.txt', '接口甲')
  write('content/工作/清单.txt.meta.yaml', 'kind: attachment\ntags: [旧标签]\n')
  await call('vault:createFolder', { parent: 'content/工作', name: '空目录' })
  await call('vault:refreshIndex', {})
  await openItem('content/工作/清单.txt')
  await expect(fileView().getByTestId('props-summary')).toHaveAttribute('title', /#旧标签/)
  write('content/工作/清单.txt.meta.yaml', 'kind: attachment\ntags: [外部修改]\n')
  await expect(fileView().getByTestId('props-summary')).toHaveAttribute('title', /#外部修改/)
  fs.unlinkSync(path.join(vault, 'content/工作/清单.txt.meta.yaml'))
  await expect(fileView().getByTestId('props-summary')).not.toHaveAttribute('title', /#外部修改/)
  expect((await call('jobs:list', {})).total).toBe(0)
  await page.getByTestId('ribbon-library').click()
  const width = await page.getByTestId('side-panel').evaluate(el => el.getBoundingClientRect().width)
  expect(width).toBe(224)
  await page.getByTestId('ribbon-capabilities').click()
  expect(await page.getByTestId('side-panel').evaluate(el => el.getBoundingClientRect().width)).toBe(width)
  await page.setViewportSize({ width: 980, height: 800 })
  await shot(page, 'r1-sidebar-narrow')
})
