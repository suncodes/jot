import fs from 'node:fs'
import path from 'node:path'
import { test, expect } from './file-fixture'
import { launch, selectOption, shot, showSide } from './helpers'
import { agentScript, chunkIds, startFakeLlm } from '../helpers/fake-llm'

test('R8 外部灵感与待归档可搜索和打开，新增月份实时出现，主导航仍只展示 content', async ({ jot }) => {
  const { page, call, write, vault } = jot
  const day = (await page.getByTestId('today-view').getAttribute('data-date'))!
  const idea = 'ideas/' + day.slice(0, 4) + '/' + day.slice(5, 7) + '/外部灵感.md'
  write(idea, '---\ncreated: ' + day + '\ntags: [灵感标签]\n---\n来自外部文件的灵感证据')
  write('inbox/2026/11/待归档.md', '待归档证据')
  write('content/工作/正式.md', '正式内容证据')
  await call('vault:refreshIndex', {})
  await expect(page.getByTestId('today-entry').filter({ hasText: '来自外部文件的灵感证据' })).toHaveCount(1)
  await page.getByTestId('today-entry').filter({ hasText: '来自外部文件的灵感证据' }).click()
  await expect(page.locator('[data-testid="doc-view"]:visible')).toHaveAttribute('data-path', idea)
  await page.getByTestId('ribbon-library').click()
  await page.getByTestId('library-all').click()
  await expect(page.getByTestId('library-item')).toHaveCount(3)
  expect(await page.getByTestId('library-sidebar').locator('[data-path]').evaluateAll(nodes => nodes.map(n => n.getAttribute('data-path')))).toEqual(expect.arrayContaining(['content/工作']))
  await expect(page.getByTestId('library-sidebar').locator('[data-path^="ideas"], [data-path^="inbox"]')).toHaveCount(0)
  await showSide(page, 'search')
  await page.getByTestId('search-filters-toggle').click()
  await selectOption(page, 'filter-directory', 'ideas')
  await page.getByTestId('search-input').fill('证据')
  await expect(page.getByTestId('search-hit')).toHaveCount(1)
  await expect(page.getByTestId('search-hit')).toHaveAttribute('data-path', idea)
  await page.getByTestId('filter-from').fill(day)
  await page.getByTestId('filter-to').fill(day)
  await expect(page.getByTestId('search-count')).toContainText('1')
  await shot(page, 'r8-search-ideas-light')
  await page.getByTestId('search-hit').click()
  await expect(page.locator('[data-testid="doc-view"]:visible')).toHaveAttribute('data-path', idea)
  // 搜索组件已经挂载后出现的新月份也要可选。
  write('ideas/2027/01/新月份.md', '---\ncreated: 2027-01-02\n---\n新月份证据')
  await call('vault:refreshIndex', {})
  await page.getByTestId('filter-clear').click()
  await selectOption(page, 'filter-directory', 'ideas/2027/01')
  await expect(page.getByTestId('search-hit')).toHaveCount(1)
  await expect(page.getByTestId('search-hit')).toContainText('新月份证据')
  await selectOption(page, 'filter-directory', 'inbox')
  await expect(page.getByTestId('search-hit')).toHaveCount(1)
  await expect(page.getByTestId('search-hit')).toHaveAttribute('data-path', 'inbox/2026/11/待归档.md')
  await page.getByTestId('theme-toggle').click()
  await page.setViewportSize({ width: 980, height: 800 })
  await shot(page, 'r8-search-inbox-dark-narrow')
  await call('vault:rebuildIndex', undefined)
  expect((await call('library:query', { scope: { selection: { kind: 'collection', name: 'ideas' } } })).total).toBe(2)
  expect((await call('classify:inbox', {})).total).toBe(1)
  expect(fs.readFileSync(path.join(vault, idea), 'utf8')).toContain('灵感证据')
})

test('R8 @灵感根及年月目录可选择，严格材料在多轮和重启历史中保持', async ({ jot }) => {
  const { page, call, write, launched } = jot
  const fake = await startFakeLlm(agentScript([() => '完成']))
  let resumed: Awaited<ReturnType<typeof launch>> | undefined
  const selected = 'ideas/2026/11', file = selected + '/选中.md', outside = 'content/工作/范围外.md'
  try {
    await call('settings:set', { model: { baseUrl: fake.baseUrl, model: 'fake', apiKey: 'fake' } })
    write(file, '---\ncreated: 2026-11-19\ntags: [灵感标签]\n---\n本月灵感当前正文')
    write('ideas/2026/10/其他.md', '另月灵感')
    write(outside, '范围外正文')
    await call('vault:refreshIndex', {})
    await page.keyboard.press('Control+l')
    const agent = page.getByTestId('agent'), input = agent.getByTestId('agent-input')
    await input.fill('@灵感')
    const root = page.getByTestId('agent-candidates').locator('[data-kind="folder"][data-path="ideas"]')
    await expect(root).toBeVisible()
    await shot(page, 'r8-mention-ideas-light')
    await root.click()
    await expect(agent.getByTestId('agent-references')).toContainText('灵感')
    await agent.getByRole('button', { name: '移除引用 灵感', exact: true }).click()
    await input.fill('只看 @ideas/2026/11')
    await page.getByTestId('agent-candidates').locator('[data-kind="folder"][data-path="' + selected + '"]').click()
    await expect(agent.getByTestId('agent-unrestrict')).toBeVisible()
    const responder = () => agentScript([
      () => ({ toolCall: { name: 'search', arguments: { query: '灵感' } } }),
      () => ({ toolCall: { name: 'read', arguments: { path: outside } } }),
      () => ({ toolCall: { name: 'stats', arguments: { groupBy: 'type' } } }),
      results => '当前灵感证据[^' + chunkIds(results[0]!)[0] + ']。',
    ])
    fake.setResponder(responder())
    await input.fill('核对本月灵感')
    await agent.getByTestId('agent-send').click()
    await expect(agent.getByTestId('agent-answer')).toHaveCount(1)
    await expect(agent.getByTestId('agent-stop')).toHaveCount(0)
    const conversation = (await call('agent:conversations', {})).items[0]!.conversationId
    let data = await call('agent:get', { conversationId: conversation })
    expect(data.messages[1]!.toolCalls?.map(t => t.ok)).toEqual([true, false, true])
    expect(data.messages[1]!.toolCalls![2]!.output).toContain('合计：1')
    expect(data.context).toMatchObject({ strict: true, references: [{ kind: 'folder', value: selected }] })
    write(file, '外部更新后的本月灵感正文')
    await call('vault:refreshIndex', {})
    fake.setResponder(responder())
    await input.fill('继续核对')
    await agent.getByTestId('agent-send').click()
    await expect(agent.getByTestId('agent-answer')).toHaveCount(2)
    await expect(agent.getByTestId('agent-stop')).toHaveCount(0)
    data = await call('agent:get', { conversationId: conversation })
    expect(data.messages[3]!.toolCalls![0]!.output).toContain('外部更新')
    await page.getByTestId('theme-toggle').click()
    await page.setViewportSize({ width: 980, height: 800 })
    await input.fill('@inbox')
    await expect(page.getByTestId('agent-candidates').locator('[data-kind="folder"][data-path="inbox"]')).toBeVisible()
    await shot(page, 'r8-mention-inbox-dark-narrow')
    await page.keyboard.press('Escape')
    await input.fill('')
    await launched.close()
    resumed = await launch({ llmBaseUrl: fake.baseUrl, reuse: launched })
    const nextPage = resumed.page
    await expect(nextPage.getByTestId('shell')).toBeVisible()
    if (!(await nextPage.getByTestId('agent').isVisible())) await nextPage.keyboard.press('Control+l')
    await nextPage.getByTestId('agent-history').click()
    await nextPage.getByTestId('agent-conversation').first().locator('.history-main').click()
    await expect(nextPage.getByTestId('agent-unrestrict')).toBeVisible()
    await expect(nextPage.getByTestId('agent-references')).toContainText('11')
    fake.setResponder(responder())
    await nextPage.getByTestId('agent-input').fill('重启后继续')
    await nextPage.getByTestId('agent-send').click()
    await expect(nextPage.getByTestId('agent-answer')).toHaveCount(3)
    await expect(nextPage.getByTestId('agent-stop')).toHaveCount(0)
    const result = await nextPage.evaluate(async id => window.jot.invoke('agent:get', { conversationId: id }), conversation)
    expect(result.ok && result.data.messages[5]!.toolCalls![0]!.output).toContain('外部更新')
    expect(result.ok && result.data.messages[5]!.toolCalls![1]!.ok).toBe(false)
  } finally { await resumed?.close(); await fake.close() }
})
