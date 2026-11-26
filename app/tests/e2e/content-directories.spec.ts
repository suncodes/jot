import fs from 'node:fs'
import path from 'node:path'
import { test, expect } from './file-fixture'
import { shot } from './helpers'

test('content 侧栏多级目录、当前目录新建与已知改名，侧栏宽度保持一致', async ({ jot }) => {
  const { page, call, select, vault } = jot
  await call('vault:createFolder', { parent: 'content/工作', name: '客户A' })
  await call('vault:createFolder', { parent: 'content/工作/客户A', name: '规则' })
  await select('content/工作/客户A/规则')
  expect(await page.getByTestId('library-sidebar').innerText()).not.toMatch(/content|inbox|journal|wiki|\.jot/)
  await page.getByTestId('new-note').click()
  const doc = page.locator('[data-testid="doc-view"]:visible')
  await expect(doc).toHaveAttribute('data-path', 'content/工作/客户A/规则/未命名.md')
  await doc.getByTestId('editor').locator('.cm-content').fill('R2 规则正文')
  await doc.getByTestId('detail-back').click()
  await page.getByTestId('library-sidebar').locator('[data-path="content/工作/客户A"]').getByTestId('folder-more').click()
  await page.getByTestId('folder-rename').click()
  await page.getByTestId('folder-name').fill('客户B')
  await page.getByTestId('folder-confirm').click()
  await expect(page.getByTestId('app-dialog')).toHaveCount(0)
  await expect(page.getByTestId('library-title')).toHaveText('规则')
  await expect(page.getByTestId('library-child')).toHaveCount(0)
  await expect(page.getByTestId('library-item')).toContainText('未命名')
  expect(fs.readFileSync(path.join(vault, 'content/工作/客户B/规则/未命名.md'), 'utf8')).toContain('R2 规则正文')
  const width = await page.getByTestId('side-panel').evaluate(el => el.getBoundingClientRect().width)
  expect(width).toBe(224)
  await shot(page, 'r2-directories-light')
  await page.getByTestId('theme-toggle').click(); await shot(page, 'r2-directories-dark')
  await page.getByTestId('ribbon-capabilities').click()
  expect(await page.getByTestId('side-panel').evaluate(el => el.getBoundingClientRect().width)).toBe(width)
  await page.setViewportSize({ width: 980, height: 800 }); await shot(page, 'r2-sidebar-narrow')
})

test('旧目录关联只保留普通属性，目录页仅显示真实成员', async ({ jot }) => {
  const { page, call, write, open, select, vault } = jot
  await call('vault:createFolder', { parent: 'content/工作', name: '客户A' })
  write('inbox/旧关联记录.md', '---\nrelated: [content/工作/客户A]\n---\n今天讨论规则')
  write('content/工作/客户A/正式笔记.md', '正式内容')
  await call('vault:refreshIndex', {})
  await open('inbox/旧关联记录.md')
  const doc = page.locator('[data-testid="doc-view"]:visible')
  await doc.getByTestId('props-summary').click()
  await expect(doc.getByTestId('relations-manage')).toHaveCount(0)
  await expect(doc.getByTestId('props-domain')).toHaveCount(0)
  await doc.getByTestId('props-tags-input').fill('项目甲')
  await doc.getByTestId('props-tags-input').press('Enter')
  await expect.poll(() => fs.readFileSync(path.join(vault, 'inbox/旧关联记录.md'), 'utf8')).toContain('项目甲')
  await select('content/工作/客户A')
  await expect(page.getByTestId('directory-related')).toHaveCount(0)
  await expect(page.getByTestId('library-item')).toHaveCount(1)
  await expect(page.getByTestId('library-item')).toHaveAttribute('data-path', 'content/工作/客户A/正式笔记.md')
  await shot(page, 'r6-physical-directory')
})

test('内容目录标题旁可新建一级目录，空目录和满页的分页位置一致', async ({ jot }) => {
  const { page, call, write, select, vault } = jot
  await page.getByTestId('ribbon-library').click()
  const sidebar = page.getByTestId('library-sidebar')
  const directorySection = sidebar.getByRole('region', { name: '内容目录', exact: true })
  await expect(sidebar.getByTestId('tree-new')).toHaveCount(1)
  await directorySection.getByTestId('tree-new').click()
  await page.getByTestId('menu-folder').click()
  const directoryName = '试用目录'
  await page.getByTestId('folder-name').fill(directoryName)
  await page.getByTestId('folder-confirm').click()
  const relative = 'content/' + directoryName
  await expect(sidebar.locator('[data-path="content/试用目录"]')).toBeVisible()
  expect(fs.statSync(path.join(vault, relative)).isDirectory()).toBe(true)
  await select(relative)
  await expect(page.getByTestId('library-count')).toHaveText('0 条内容')
  await expect(page.getByTestId('library-empty')).toHaveText('这里还没有内容')
  const pager = page.getByTestId('library-page')
  const next = page.getByTestId('library-next')
  await expect(pager).toHaveText('1 / 1')
  await expect(next).toBeDisabled()
  const position = (await pager.boundingBox())!
  const viewport = (await page.getByTestId('library-view').boundingBox())!
  expect(position.y).toBeGreaterThanOrEqual(viewport.y + viewport.height)
  const capture = (await page.getByTestId('capture-bar').boundingBox())!
  const distance = capture.y - position.y - position.height
  expect(distance).toBeGreaterThan(0)
  expect(distance).toBeLessThan(40)
  await shot(page, 'library-pager-empty')

  for (let i = 1; i <= 31; i++) write(`${relative}/笔记 ${i}.md`, '测试正文')
  await call('vault:refreshIndex', {})
  await expect(page.getByTestId('library-count')).toHaveText('31 条内容')
  await expect(page.getByTestId('library-item')).toHaveCount(30)
  await expect(pager).toHaveText('1 / 2')
  expect((await pager.boundingBox())!.y).toBeCloseTo(position.y)
  await shot(page, 'library-pager-full')
  await next.click()
  await expect(pager).toHaveText('2 / 2')
  await expect(page.getByTestId('library-item')).toHaveCount(1)
  expect((await pager.boundingBox())!.y).toBeCloseTo(position.y)
})
