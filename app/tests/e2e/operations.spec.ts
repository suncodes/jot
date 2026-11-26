import fs from 'node:fs'
import path from 'node:path'
import { test, expect } from './file-fixture'
import { shot } from './helpers'
test('笔记按路径改名、移动与回收恢复；不依赖对象登记', async ({ jot }) => {
  const { page, call, open, vault } = jot
  const doc = await call('doc:create', { dir: 'content/工作', title: '操作样本', body: '保留正文' })
  await open(doc.path)
  const view = page.locator('[data-testid="doc-view"]:visible')
  await view.getByTestId('content-more').click(); await page.getByTestId('content-rename').click()
  await page.getByTestId('content-name-input').fill('改名样本'); await page.getByTestId('content-confirm').click()
  await expect(view).toHaveAttribute('data-path', 'content/工作/改名样本.md')
  await call('doc:move', { ref: { path: 'content/工作/改名样本.md' }, toDir: 'content/生活' })
  await expect(view).toHaveAttribute('data-path', 'content/生活/改名样本.md')
  const trash = await call('doc:delete', { ref: { path: 'content/生活/改名样本.md' } })
  await call('doc:restore', trash)
  expect(fs.readFileSync(path.join(vault, 'content/生活/改名样本.md'), 'utf8')).toContain('保留正文')
  await call('vault:rebuildIndex', undefined)
  expect((await call('library:query', {})).items.map(i => i.path)).toEqual(['content/生活/改名样本.md'])
})

test('改名拖选越过弹窗边缘或点击遮罩仍保留输入，支持 × 和 Esc 关闭', async ({ jot }) => {
  const { page, call, open } = jot
  const name = '需要改名的示例笔记'
  const doc = await call('doc:create', { dir: 'content/工作', title: name, body: '样本正文' })
  await open(doc.path)
  const view = page.locator('[data-testid="doc-view"]:visible')
  const dialog = page.getByRole('dialog', { name: '改名', exact: true })
  const input = dialog.getByTestId('content-name-input')
  async function openRename() {
    await view.getByTestId('content-more').click()
    await page.getByTestId('content-rename').click()
    await expect(input).toBeFocused()
  }

  if (await page.locator('html').getAttribute('data-theme') !== 'light') {
    await page.getByTestId('theme-toggle').click()
  }
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await openRename()
  expect(await input.evaluate((el: HTMLInputElement) => [el.selectionStart, el.selectionEnd])).toEqual([0, name.length])
  const { x, y, width, height } = (await dialog.boundingBox())!
  const field = (await input.boundingBox())!
  const outside = { x: x + width + 24, y: field.y + field.height / 2 }
  await page.mouse.move(field.x + 3, outside.y)
  await page.mouse.down()
  await page.mouse.move(outside.x, outside.y, { steps: 10 })
  await page.mouse.up()
  await expect(dialog).toBeVisible()

  await input.fill('未保存的新名称')
  await page.mouse.click(x + 4, y + height / 2)
  await page.mouse.click(outside.x, outside.y)
  await expect(input).toHaveValue('未保存的新名称')
  await input.focus()
  await shot(page, 'rename-dialog-light')
  await dialog.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  expect((await call('doc:get', { ref: { path: doc.path } })).title).toBe(name)

  if (await page.locator('html').getAttribute('data-theme') !== 'dark') {
    await page.getByTestId('theme-toggle').click()
  }
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await page.setViewportSize({ width: 980, height: 800 })
  await openRename()
  await expect(input).toHaveValue(name)
  await shot(page, 'rename-dialog-dark')
  await input.press('Escape')
  await expect(dialog).toHaveCount(0)
})

test('分类管理可预置三类词条，属性面板可使用这些值', async ({ jot }) => {
  const { page, write, call, open } = jot
  await page.getByTestId('ribbon-library').click()
  await page.getByTestId('projects-manage').click()
  const preset = [
    { kind: 'tag', label: '标签', value: '客户项目', field: 'props-tags-input' },
    { kind: 'place', label: '地点', value: '会议室', field: 'props-place-input' },
    { kind: 'person', label: '人物', value: '小周', field: 'props-people-input' },
  ]
  for (const { kind, label, value } of preset) {
    await page.getByTestId('taxonomy-kind-' + kind).click()
    await page.getByTestId('taxonomy-create').click()
    const dialog = page.getByRole('dialog', { name: '新增词条 · ' + label })
    const name = dialog.getByTestId('taxonomy-create-name')
    await expect(name).toBeFocused()
    await expect(dialog.getByTestId('taxonomy-create-confirm')).toBeDisabled()
    await name.fill(value)
    await dialog.getByTestId('taxonomy-create-confirm').click()
    await expect(dialog).toHaveCount(0)
    const row = page.getByTestId('taxonomy-row')
    await expect(row.getByTestId('taxonomy-name')).toHaveText(value)
    await expect(row.getByTestId('taxonomy-count')).toHaveText('0 条')
  }
  await page.getByTestId('taxonomy-create').click()
  await shot(page, 'taxonomy-create-term')
  const name = page.getByTestId('taxonomy-create-name')
  await name.fill('小周')
  await page.getByTestId('taxonomy-create-confirm').click()
  await expect(page.getByTestId('taxonomy-create-error')).toHaveText('已有同名词条')
  await expect(name).toHaveValue('小周')
  await name.press('Escape')
  await expect(page.getByTestId('taxonomy-row')).toHaveCount(1)

  const rel = 'content/工作/属性演练.md'
  write(rel, '演练正文')
  await call('vault:refreshIndex', {})
  await open(rel)
  const doc = page.locator('[data-testid="doc-view"]:visible')
  await doc.getByTestId('props-summary').click()
  for (const { field, value } of preset) {
    const input = doc.getByTestId(field)
    await expect.poll(() => input.evaluate((el: HTMLInputElement) =>
      Array.from(el.list?.options ?? [], option => option.value))).toContain(value)
  }
  await doc.getByTestId('props-tags-input').fill('客户项目')
  await doc.getByTestId('props-tags-input').press('Enter')
  await expect(doc.getByTestId('props-tags').getByTestId('chip')).toHaveText('客户项目')
  await doc.getByTestId('props-place-input').fill('会议室')
  await doc.getByTestId('props-place-input').press('Tab')
  await expect.poll(async () => (await call('doc:get', { ref: { path: rel } })).classification.place).toBe('会议室')
  expect((await call('taxonomy:terms', { kind: 'tag' }))[0]).toMatchObject({ name: '客户项目', count: 1 })
})
