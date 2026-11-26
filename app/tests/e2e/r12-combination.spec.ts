import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Page } from '@playwright/test'
import type { ContentScope } from '../../shared/storage'
import { test, expect, callOnPage } from './file-fixture'
import { launch, shot, showSide } from './helpers'
import { agentScript, chunkIds, startFakeLlm } from '../helpers/fake-llm'

const ideas: ContentScope = { selection: { kind: 'collection', name: 'ideas' } }
const pending: ContentScope = { selection: { kind: 'collection', name: 'pending' } }
const doc = (page: Page) => page.locator('[data-testid="doc-view"]:visible')
const libraryRow = (page: Page, rel: string) => page.locator('[data-testid="library-item"][data-path=' + JSON.stringify(rel) + ']')
async function openLibrary(page: Page, scope: 'all' | 'ideas' | 'pending'): Promise<void> {
  await page.getByTestId('ribbon-library').click()
  await page.getByTestId('library-' + scope).click()
}
async function ask(page: Page, question: string, answers: number): Promise<void> {
  await page.getByTestId('agent-input').fill(question)
  await page.getByTestId('agent-send').click()
  await expect(page.getByTestId('agent-answer')).toHaveCount(answers)
  await expect(page.getByTestId('agent-stop')).toHaveCount(0)
}

test('R12 随手记与外部纯 Markdown 跨列表、时间线、搜索、严格 @ 和索引丢失恢复', async ({ jot }) => {
  const { launched, page, call, write, vault } = jot
  const phrase = '白鹭内河观察计划'
  const outside = 'content/工作/另一份资料.md'
  const fake = await startFakeLlm()
  let resumed: Awaited<ReturnType<typeof launch>> | undefined
  try {
    await openLibrary(page, 'ideas')
    await page.getByTestId('ideas-write').click()
    await page.getByTestId('capture-input').fill(phrase)
    await page.getByTestId('capture-save').click()
    const saved = page.getByTestId('toast').filter({ hasText: '已保存到灵感' })
    await saved.getByTestId('toast-action').click()
    await expect(doc(page).getByTestId('doc-preview')).toContainText(phrase)
    const recorded = (await doc(page).getAttribute('data-path'))!
    expect(recorded).toMatch(/^ideas\/\d{4}\/\d{2}\/[^/]+\.md$/)
    const month = recorded.split('/').slice(0, 3).join('/')
    const plain = month + '/外部无属性.md'
    const unfiled = 'inbox/' + month.slice('ideas/'.length) + '/外部待归档.md'
    write(plain, '纯正文的外部观察记录')
    write(unfiled, '需要归档的外部资料')
    write(outside, '另一份工作资料')
    await openLibrary(page, 'ideas')
    await expect(libraryRow(page, plain)).toBeVisible()
    await expect(page.getByTestId('library-item')).toHaveCount(2)
    await openLibrary(page, 'pending')
    await expect(libraryRow(page, unfiled)).toBeVisible()
    await expect(page.getByTestId('library-item')).toHaveCount(1)

    await page.getByTestId('ribbon-today').click()
    const timelineEntry = page.getByTestId('today-entry').filter({ hasText: phrase })
    await expect(timelineEntry).toHaveCount(1)
    await timelineEntry.click()
    await expect(doc(page)).toHaveAttribute('data-path', recorded)
    await showSide(page, 'search')
    await page.getByTestId('search-input').fill(phrase)
    await expect(page.getByTestId('search-hit')).toHaveCount(1)
    await page.getByTestId('search-hit').click()
    await expect(doc(page)).toHaveAttribute('data-path', recorded)

    await call('settings:set', { model: { baseUrl: fake.baseUrl, model: 'fake', apiKey: 'fake' } })
    const responder = agentScript([
      () => ({ toolCall: { name: 'read', arguments: { path: recorded } } }),
      () => ({ toolCall: { name: 'read', arguments: { path: outside } } }),
      results => '核对观察记录[^' + chunkIds(results[0]!)[0] + ']。',
    ])
    fake.setResponder(responder)
    await page.keyboard.press('Control+l')
    await page.getByTestId('agent-input').fill('只看 @' + phrase)
    await page.getByTestId('agent-candidates').locator('[data-kind="file"][data-path=' + JSON.stringify(recorded) + ']').click()
    await expect(page.getByTestId('agent-unrestrict')).toBeVisible()
    await ask(page, '这条观察计划写了什么？', 1)
    await expect(page.getByTestId('agent-answer').locator('.cite.valid')).toHaveCount(1)
    const conversationId = (await call('agent:conversations', {})).items[0]!.conversationId
    const first = (await call('agent:get', { conversationId })).messages.at(-1)!
    expect(first.toolCalls?.map(tool => tool.ok)).toEqual([true, false])
    expect(first.citations?.[0]).toMatchObject({ valid: true, chunk: { path: recorded } })
    await shot(page, 'r12-idea-assistant')

    await launched.close()
    const index = path.join(vault, '.jot', 'index.db')
    expect(fs.existsSync(index)).toBe(true)
    for (const suffix of ['', '-wal', '-shm']) {
      const file = index + suffix
      if (fs.existsSync(file)) fs.unlinkSync(file)
    }
    fs.appendFileSync(path.join(vault, recorded), '\n次日更新：增加记录潮位。', 'utf8')
    const modelRequests = fake.requests.length
    resumed = await launch({ reuse: launched })
    const next = resumed.page
    await expect(next.getByTestId('shell')).toBeVisible()
    const listed = await callOnPage(next, 'library:query', { scope: ideas })
    expect(listed.items.map(item => item.path).sort()).toEqual([recorded, plain].sort())
    expect((await callOnPage(next, 'classify:inbox', {})).items.map(item => ({ path: item.doc.path, reasons: item.reasons })))
      .toEqual([{ path: unfiled, reasons: ['directory'] }])
    expect((await callOnPage(next, 'library:query', {})).total).toBe(4)
    expect(fs.readFileSync(path.join(vault, plain), 'utf8')).toBe('纯正文的外部观察记录')
    expect(fs.readFileSync(path.join(vault, unfiled), 'utf8')).toBe('需要归档的外部资料')
    expect(fake.requests).toHaveLength(modelRequests)
    if (!(await next.getByTestId('agent').isVisible())) await next.keyboard.press('Control+l')
    await next.getByTestId('agent-history').click()
    await next.getByTestId('agent-conversation').locator('.history-main').click()
    await expect(next.getByTestId('agent-unrestrict')).toBeVisible()
    await ask(next, '继续核对当前正文。', 2)
    const followUp = (await callOnPage(next, 'agent:get', { conversationId })).messages.at(-1)!
    expect(followUp.toolCalls?.[0]?.output).toContain('增加记录潮位')
    expect(followUp.toolCalls?.map(tool => tool.ok)).toEqual([true, false])
    expect(followUp.citations?.[0]?.chunk?.path).toBe(recorded)
  } finally {
    await resumed?.close()
    await fake.close()
  }
})

test('R12 附件导入、独立归档与属性、链接和摘要跟随，回收组跨维护与重建恢复', async ({ jot }) => {
  const { launched, page, call, write, vault } = jot
  const target = 'content/工作/评审归档'
  const raw = '虚构会议：确认采用灰度方案。\r\n'
  const filename = '评审纪要.txt'
  const outside = path.join(launched.workDir, filename)
  const fake = await startFakeLlm(req => {
    const prompt = String(req.messages[0]?.content)
    return prompt.includes('仅提出建议')
      ? JSON.stringify({ directoryPath: target, tags: ['归档评审'], place: null, people: [], confidence: 0.8, reason: '该文件是评审纪要' })
      : JSON.stringify({ oneLine: '会议确认灰度方案', points: ['会议决定采用灰度方案'], entities: null })
  })
  try {
    await call('settings:set', { model: { baseUrl: fake.baseUrl, model: 'fake', apiKey: 'fake' } })
    await call('vault:createFolder', { parent: 'content/工作', name: '评审归档' })
    fs.writeFileSync(outside, raw)
    await openLibrary(page, 'all')
    await page.getByTestId('library-import').click()
    await expect(page.getByTestId('import-target')).toContainText('待归档')
    const chooser = page.waitForEvent('filechooser')
    await page.getByTestId('import-choose').click()
    await (await chooser).setFiles(outside)
    await expect(page.getByTestId('library-title')).toHaveText('待处理')
    await expect(page.getByTestId('library-item')).toHaveCount(1)
    const imported = (await page.getByTestId('library-item').getAttribute('data-path'))!
    expect(imported).toMatch(/^inbox\/\d{4}\/\d{2}\/评审纪要\.txt$/)
    await expect.poll(async () => (await call('library:resolve', { path: imported }))?.summaryPath).toBeTruthy()
    const summary = (await call('library:resolve', { path: imported }))!.summaryPath!
    expect(summary).toMatch(/^wiki\/sources\/\d{4}\/\d{2}\/[^/]+\.md$/)
    expect(await call('library:query', { scope: pending })).toMatchObject({ total: 1, items: [{ path: imported, summaryPath: summary }] })

    const note = 'content/工作/规则.md'
    const daily = 'journal/2026/2026-11-19.md'
    write(note, '规则正文。\n\n[评审纪要](' + path.posix.relative(path.posix.dirname(note), imported) + ')\n')
    write(daily, '---\ntype: daily\n---\n应保留的人工日总结')
    await call('vault:refreshIndex', {})
    await page.getByTestId('library-review').click()
    await page.getByTestId('inbox-analyze').click()
    await expect(page.getByTestId('inbox-accept-directory')).toBeVisible()
    await expect(page.getByTestId('inbox-properties-decision')).toContainText('#归档评审')
    const filed = target + '/' + filename
    expect(fs.existsSync(path.join(vault, filed))).toBe(false)
    expect((await call('doc:properties', { path: imported })).data.tags).toBeUndefined()
    await page.getByTestId('inbox-accept-directory').click()
    await expect(page.getByTestId('inbox-item')).toHaveAttribute('data-path', filed)
    await expect(page.getByTestId('inbox-directory-decision')).toHaveCount(0)
    await expect(page.getByTestId('inbox-accept-properties')).toBeVisible()
    expect(fs.readFileSync(path.join(vault, filed), 'utf8')).toBe(raw)
    expect(fs.existsSync(path.join(vault, imported))).toBe(false)
    expect(fs.existsSync(path.join(vault, imported + '.meta.yaml'))).toBe(false)
    expect(await call('links:list', { path: note, direction: 'outgoing' })).toMatchObject([{ path: filed, missing: false }])
    expect((await call('doc:get', { ref: { path: summary } })).sourcePath).toBe(filed)
    await shot(page, 'r12-filing-properties')

    await page.getByTestId('inbox-accept-properties').click()
    await expect(page.getByTestId('inbox-item')).toHaveCount(0)
    expect((await call('doc:properties', { path: filed })).data.tags).toEqual(['归档评审'])
    const savedGroup = [filed, filed + '.meta.yaml', summary]
    const bytes = savedGroup.map(rel => fs.readFileSync(path.join(vault, rel)))
    const dailyText = fs.readFileSync(path.join(vault, daily), 'utf8')
    await openLibrary(page, 'all')
    await expect(page.getByTestId('library-item')).toHaveCount(2)
    await libraryRow(page, filed).getByTestId('content-more').click()
    await page.getByTestId('content-delete').click()
    await page.getByTestId('content-confirm').click()
    await expect(libraryRow(page, filed)).toHaveCount(0)
    expect((await call('trash:list', {})).items).toMatchObject([{ originalPath: filed, paths: expect.arrayContaining(savedGroup) }])
    expect(savedGroup.every(rel => !fs.existsSync(path.join(vault, rel)))).toBe(true)

    const stale = path.join(vault, path.posix.dirname(note), '.jot-write.' + path.posix.basename(note) + '.' + process.pid + '.' + randomUUID() + '.tmp')
    fs.writeFileSync(stale, '可清理的组合测试残留')
    const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000)
    fs.utimesSync(stale, twoDaysAgo, twoDaysAgo)
    const requests = fake.requests.length
    await page.getByTestId('ribbon-settings').click()
    await page.getByTestId('settings-nav-storage').click()
    await expect(page.getByTestId('storage-retention')).toHaveAttribute('data-value', '0')
    await page.getByTestId('storage-clear').click()
    await page.getByTestId('storage-confirm').click()
    await expect(page.getByTestId('storage-temporary-count')).toContainText('0 个可清理')
    expect(fs.existsSync(stale)).toBe(false)
    await page.getByTestId('storage-optimize').click()
    await expect(page.getByTestId('toast').filter({ hasText: '数据库维护完成' })).toBeVisible()
    await page.getByTestId('storage-trash').click()
    await expect(page.getByTestId('trash-item')).toHaveAttribute('data-path', filed)
    await page.getByTestId('trash-restore').click()
    await expect(page.getByTestId('trash-item')).toHaveCount(0)
    await call('vault:rebuildIndex', undefined)

    expect(savedGroup.map(rel => fs.readFileSync(path.join(vault, rel)))).toEqual(bytes)
    expect(fs.readFileSync(path.join(vault, daily), 'utf8')).toBe(dailyText)
    expect(await call('links:list', { path: note, direction: 'outgoing' })).toMatchObject([{ path: filed, missing: false }])
    expect(await call('library:query', { filter: { tags: ['归档评审'] } })).toMatchObject({ total: 1, items: [{ path: filed, summaryPath: summary }] })
    expect((await call('classify:inbox', {})).total).toBe(0)
    expect(fake.requests).toHaveLength(requests)
  } finally {
    await fake.close()
  }
})
