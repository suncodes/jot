import { defaultModel } from '../helpers/models'
import { modelSettings } from '../helpers/models'
import fs from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { test, expect, callOnPage } from './file-fixture'
import { launch, selectOption, shot } from './helpers'
import { agentScript, chunkIds, isAgentRequest, startFakeLlm, type FakeChatRequest } from '../helpers/fake-llm'
import { localDay } from '../../electron/util/time'

const folder = 'content/工作/试用验收'
const background = (request: FakeChatRequest): string => JSON.stringify(String(request.messages[0]?.content).includes('任务技能：jot-core:content-organize')
  ? { directoryPath: folder, tags: ['已核对'], people: [], place: null, confidence: 0.9, reason: '验收材料' }
  : String(request.messages[0]?.content).includes('任务技能：jot-core:daily-review')
    ? { oneLine: '你记录了验收进展', done: ['完成验收记录'], highlights: [], followUps: [] }
    : { oneLine: '验收资料摘要', points: ['预算0.3万元'], entities: null })
async function ask(page: Page, text: string, count: number) {
  await page.getByTestId('agent-input').fill(text); await page.getByTestId('agent-send').click()
  await expect(page.getByTestId('agent-answer')).toHaveCount(count); await expect(page.getByTestId('agent-stop')).toHaveCount(0)
}

test('U7单一助手、后台全局档位、独立整理确认、改名引用和索引丢失后的重启续聊', async ({ jot }) => {
  const { page, call, launched, vault } = jot
  let resumed: Awaited<ReturnType<typeof launch>> | undefined
  const date = localDay(new Date())
  const fake = await startFakeLlm(agentScript([
    () => ({ toolCall: { name: 'create_folder', arguments: { parent: 'content/工作', name: '试用验收' } } }),
    () => ({ toolCall: { name: 'write_files', arguments: { files: [{ path: folder + '/规则.md', body: '保留原规则。\n\n[材料](材料.txt)' }] } } }),
    () => ({ toolCall: { name: 'app_manage', arguments: { operation: 'records.idea', args: { text: '完成验收记录 #验收' } } } }),
    () => ({ toolCall: { name: 'app_manage', arguments: { operation: 'daily.generate', args: { date } } } }),
    () => '记录已保存，后台任务已安排，请查看实际结果。',
  ], background))
  try {
    await call('settings:set', { ...modelSettings({ baseUrl: fake.baseUrl, apiKey: 'fake', model: 'u7-model', reasoningEffort: 'high', contextWindow: 65536 }, await call('settings:get', undefined)), classify: { enabled: true } })
    await page.keyboard.press('Control+l')
    await expect(page.getByTestId('agent-select')).toHaveText('通用助手')
    await selectOption(page, 'agent-reasoning-effort', 'low')
    await ask(page, '新建验收目录、规则笔记、灵感，并安排今天的日总结。', 1)
    expect(fake.requests.filter(isAgentRequest).every(request => request.reasoning_effort === 'low')).toBe(true)
    await expect.poll(async () => (await call('jobs:list', { state: 'done' })).items.some(job => job.type === 'daily')).toBe(true)
    const external = path.join(launched.workDir, '材料.txt'), raw = '预算0.3万元，确认采用方案甲。\r\n'
    fs.writeFileSync(external, raw)
    const source = (await call('files:import', { paths: [external] })).imported[0]!
    await expect.poll(async () => (await call('classify:inbox', {})).items.find(item => item.doc.path === source)?.suggestions.length).toBe(2)
    const summary = (await call('files:list', {})).items.find(item => item.path === source)!.summaryPath!
    await page.getByTestId('ribbon-library').click(); await page.getByTestId('library-pending').click(); await page.getByTestId('library-review').click()
    await page.locator('[data-testid="inbox-item"][data-path=' + JSON.stringify(source) + ']').click()
    await expect(page.getByTestId('inbox-accept-directory')).toBeVisible(); await expect(page.getByTestId('inbox-accept-properties')).toBeVisible()
    await shot(page, 'u7-review-light')
    await page.getByTestId('inbox-accept-properties').click()
    await expect.poll(async () => (await call('doc:get', { ref: { path: source } })).classification.tags).toContain('已核对')
    expect(fs.readFileSync(path.join(vault, source), 'utf8')).toBe(raw)
    await page.getByTestId('inbox-accept-directory').click()
    await expect.poll(() => fs.existsSync(path.join(vault, folder, '材料.txt'))).toBe(true)
    const jobs = (await call('jobs:list', { state: 'done' })).items
    expect(jobs.every(job => job.execution?.reasoning?.requested === 'high')).toBe(true)
    await call('content:move', { path: folder, targetPath: folder + '归档' })
    const moved = folder + '归档/材料.txt', note = folder + '归档/规则.md'
    expect((await call('doc:get', { ref: { path: summary } })).sourcePath).toBe(moved)
    expect((await call('doc:resolveLink', { from: note, target: '材料.txt', kind: 'markdown' })).path).toBe(moved)
    const id = (await call('agent:conversations', {})).items[0]!.conversationId
    await launched.close()
    for (const suffix of ['', '-wal', '-shm']) {
      const index = path.join(vault, '.jot/index.db' + suffix)
      if (fs.existsSync(index)) fs.unlinkSync(index)
    }
    const before = fake.requests.length
    resumed = await launch({ reuse: launched, isolateHotkey: true })
    const next = resumed.page; await expect(next.getByTestId('shell')).toBeVisible()
    expect(fake.requests).toHaveLength(before)
    expect((await callOnPage(next, 'library:resolve', { path: summary }))?.path).toBe(moved)
    expect((await callOnPage(next, 'agent:get', { conversationId: id })).context?.reasoningEffort).toBe('low')
    fake.setResponder(agentScript([
      () => ({ toolCall: { name: 'read', arguments: { path: moved } } }),
      results => '当前归档材料预算0.3万元[^' + chunkIds(results[0]!)[0] + ']。',
    ], background))
    if (!await next.getByTestId('agent').isVisible()) await next.keyboard.press('Control+l')
    await next.getByTestId('agent-history').click(); await next.getByTestId('agent-conversation').first().locator('.history-main').click()
    await ask(next, '接着读取归档后的资料', 2)
    await expect(next.getByTestId('agent-answer').last().locator('a.cite.valid')).toHaveCount(1)
    expect((await callOnPage(next, 'agent:get', { conversationId: id })).messages.at(-1)?.toolCalls?.[0]?.output).toContain('方案甲')
    await callOnPage(next, 'settings:set', { appearance: { theme: 'dark' } }); await next.setViewportSize({ width: 740, height: 820 })
    await shot(next, 'u7-resumed-dark-narrow')
  } finally { await resumed?.close(); await fake.close() }
})

test('U7界面明确强度拒绝不降档，用户直接改为低档后重试成功且保留原失败', async ({ jot }) => {
  const { page, call, write } = jot
  const fake = await startFakeLlm(() => ({ status: 400, body: '{"error":{"message":"unsupported reasoning_effort high"}}' }))
  try {
    write('content/工作/试用规则.md', '试用规则：先核对当前文件。'); await call('vault:refreshIndex', {})
    await call('settings:set', { ...modelSettings({ baseUrl: fake.baseUrl, model: 'u7-model', apiKey: 'fake', reasoningEffort: 'high' }, await call('settings:get', undefined)) })
    await page.keyboard.press('Control+l'); await ask(page, '核对试用规则', 1)
    await expect(page.getByTestId('agent-message-error')).toContainText('未自动降档')
    expect(fake.requests).toHaveLength(1)
    expect(defaultModel((await call('settings:get', undefined))).reasoningEffort).toBe('high')
    await selectOption(page, 'agent-reasoning-effort', 'low')
    fake.setResponder(agentScript([
      () => ({ toolCall: { name: 'read', arguments: { path: 'content/工作/试用规则.md' } } }),
      results => '先核对当前文件[^' + chunkIds(results[0]!)[0] + ']。',
    ]))
    await ask(page, '使用低档再次核对', 2)
    await expect(page.getByTestId('agent-answer').last().locator('a.cite.valid')).toHaveCount(1)
    for (const request of fake.requests.slice(1)) expect(request.reasoning_effort).toBe('low')
    const id = (await call('agent:conversations', {})).items[0]!.conversationId
    const data = await call('agent:get', { conversationId: id })
    expect(data.messages[1]?.context?.reasoning?.requested).toBe('high')
    expect(data.messages.at(-1)?.context?.reasoning?.requested).toBe('low')
    expect(data.messages[1]?.error).toContain('未自动降档')
    expect(data.messages.at(-1)?.error).toBeUndefined()
  } finally { await fake.close() }
})
