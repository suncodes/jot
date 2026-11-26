import fs from 'node:fs'
import path from 'node:path'
import { test, expect } from './file-fixture'
import { shot } from './helpers'
import { startFakeLlm } from '../helpers/fake-llm'

test('R6 物理集合与契约校验：无属性灵感不归档，inbox 文件无需登记就待处理', async ({ jot }) => {
  const { page, call, write } = jot
  write('ideas/2026/11/想法.md', '一个无需属性的想法')
  write('inbox/2026/11/资料.md', '等待选择目录')
  write('content/工作/正式内容.md', '已经确定目录')
  await call('vault:refreshIndex', {})
  const ideas = await call('library:query', { scope: { selection: { kind: 'collection', name: 'ideas' } } })
  expect(ideas.items.map(item => item.path)).toEqual(['ideas/2026/11/想法.md'])
  expect((await call('library:query', {})).total).toBe(3)
  const pending = await call('classify:inbox', {})
  expect(pending.items.map(item => ({ path: item.doc.path, reasons: item.reasons }))).toEqual([{ path: 'inbox/2026/11/资料.md', reasons: ['directory'] }])
  await call('classify:skip', { ref: { path: 'inbox/2026/11/资料.md' }, kind: 'directory' })
  expect((await call('classify:inbox', {})).total).toBe(1)
  await expect(call('search:query', { filter: { domain: '工作' } } as never)).rejects.toThrow('INVALID_INPUT')
  await expect(call('settings:set', { domains: ['工作'] } as never)).rejects.toThrow('INVALID_INPUT')
  await call('vault:rebuildIndex', undefined)
  expect((await call('classify:inbox', {})).total).toBe(1)
  await page.getByTestId('ribbon-library').click()
  await page.getByTestId('library-pending').click()
  await page.getByTestId('library-review').click()
  await expect(page.getByTestId('inbox-item')).toHaveAttribute('data-path', 'inbox/2026/11/资料.md')
  await expect(page.getByTestId('inbox-item')).toContainText('待选择目录')
  await expect(page.getByTestId('inbox-item').locator('.type-badge')).toHaveText('笔记')
  await shot(page, 'r6-pending-path-light')
})

test('R6 真实待处理操作：属性确认不归档，目录确认移动实际文件', async ({ jot }) => {
  const fake = await startFakeLlm(() => JSON.stringify({ directoryPath: 'content/工作', tags: ['需求'], people: [], confidence: 0.9, reason: '虚构资料整理建议' }))
  const { page, call, write, vault } = jot
  try {
    await call('settings:set', { model: { baseUrl: fake.baseUrl, apiKey: 'fake', model: 'fake' } })
    write('inbox/2026/11/整理资料.md', '虚构资料正文')
    await call('vault:refreshIndex', {})
    await page.getByTestId('ribbon-library').click()
    await page.getByTestId('library-pending').click()
    await page.getByTestId('library-review').click()
    await call('classify:rerun', { ref: { path: 'inbox/2026/11/整理资料.md' } })
    await expect(page.getByTestId('inbox-accept-directory')).toBeVisible()
    await expect(page.getByTestId('inbox-accept-properties')).toBeVisible()
    expect(fs.readFileSync(path.join(vault, 'inbox/2026/11/整理资料.md'), 'utf8')).toBe('虚构资料正文')
    await shot(page, 'r6-independent-suggestions-light')
    await page.getByTestId('theme-toggle').click()
    await shot(page, 'r6-independent-suggestions-dark')
    await page.setViewportSize({ width: 980, height: 800 })
    await page.getByTestId('inbox-item').click()
    await shot(page, 'r6-independent-suggestions-narrow')
    await page.getByTestId('inbox-accept-properties').click()
    await expect(page.getByTestId('inbox-accept-properties')).toHaveCount(0)
    await expect(page.getByTestId('inbox-item')).toHaveCount(1)
    expect(fs.readFileSync(path.join(vault, 'inbox/2026/11/整理资料.md'), 'utf8')).toContain('需求')
    await page.getByTestId('inbox-accept-directory').click()
    await expect(page.getByTestId('inbox-item')).toHaveCount(0)
    expect(fs.existsSync(path.join(vault, 'inbox/2026/11/整理资料.md'))).toBe(false)
    expect(fs.readFileSync(path.join(vault, 'content/工作/整理资料.md'), 'utf8')).toContain('虚构资料正文')
  } finally { await fake.close() }
})
