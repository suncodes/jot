import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AiTaskKind } from '../../shared/ai-tasks'
import type { AssistantContext } from '../../shared/assistant'
import { renderConversation } from '../../electron/agent/export'
import { agentScript, chunkIds, isAgentRequest, isCompactionRequest, type FakeChatRequest } from '../helpers/fake-llm'
import { testApp } from '../helpers/test-app'

let app: Awaited<ReturnType<typeof testApp>>
beforeEach(async () => { app = await testApp() })
afterEach(async () => { await app.close() })
const date = '2026-11-19', folder = 'content/工作/组合验收'
const taskReply = (request: FakeChatRequest): string => {
  const system = String(request.messages[0]?.content)
  return JSON.stringify(system.includes('任务技能：jot-core:content-organize')
    ? { directoryPath: folder, tags: ['验收'], people: [], place: null, confidence: 0.9, reason: '明确的验收资料' }
    : system.includes('任务技能：jot-core:term-organize')
      ? { groups: [{ names: ['验收', '验收工作'], suggested: '验收', reason: '同一工作名称' }] }
      : system.includes('任务技能：jot-core:daily-review')
        ? { oneLine: '你完成了验收记录', done: ['明确完成接口评审'], highlights: [], followUps: [] }
        : { oneLine: '接口评审资料', points: ['采用方案甲，预算0.3万元'], entities: null })
}
async function ask(id: string, text: string, context?: AssistantContext) {
  const { runId } = app.core.agent.send(id, text, context)
  await app.core.agent.wait(runId)
  const answer = app.core.agent.get(id).messages.at(-1)!
  expect(answer.error).toBeUndefined()
  return answer
}

describe('U7 通用助手交付组合', () => {
  it('同一对话创建记录并安排四类后台，全局与对话档位分开，人工整理及改名后可从文件重建', async () => {
    await app.call('settings:set', { model: { reasoningEffort: 'high', contextWindow: 65536 }, classify: { enabled: true } })
    const external = path.join(app.tmp.dir, '评审.txt'), raw = '采用方案甲，预算0.3万元。\r\n'
    fs.writeFileSync(external, raw)
    app.core.operations.setPlatform({ trashItem: async () => { throw new Error('未配置系统回收站测试') }, pickFiles: async () => [external], saveFile: async () => null })
    app.fake.setResponder(agentScript([
      () => ({ toolCall: { name: 'create_folder', arguments: { parent: 'content/工作', name: '组合验收' } } }),
      () => ({ toolCall: { name: 'app_manage', arguments: { operation: 'records.idea', args: { text: '明确完成接口评审 #验收' } } } }),
      () => ({ toolCall: { name: 'app_manage', arguments: { operation: 'records.note', args: { title: '规则', body: '规则已确认，保留原文。', dir: folder } } } }),
      () => ({ toolCall: { name: 'app_manage', arguments: { operation: 'files.import', args: {} } } }),
      () => ({ toolCall: { name: 'app_manage', arguments: { operation: 'terms.create', args: { kind: 'tag', name: '验收工作' } } } }),
      () => ({ toolCall: { name: 'app_manage', arguments: { operation: 'terms.analyze', args: { kind: 'tag' } } } }),
      () => ({ toolCall: { name: 'app_manage', arguments: { operation: 'daily.generate', args: { date } } } }),
      () => '记录已经保存，摘要、整理、同义分析及日总结已安排，等待实际任务结果。',
    ], taskReply))
    const id = app.core.agent.create().conversationId
    const answer = await ask(id, '创建验收目录、记录、笔记和导入资料，安排后台处理。', { agentId: 'default', references: [], strict: false, skillIds: [], reasoningEffort: 'low' })
    expect(answer.toolCalls!.every(call => call.ok)).toBe(true)
    expect(app.fake.requests.filter(isAgentRequest).every(request => request.reasoning_effort === 'low')).toBe(true)
    expect(app.core.jobs.list({ state: 'done' }).total).toBe(0)
    const source = JSON.parse(answer.toolCalls![3]!.output!).imported[0] as string
    expect(source).toMatch(/^inbox\/2026\/11\//)
    await app.core.jobs.drain(); await app.core.idle()
    const jobs = app.core.jobs.list({ state: 'done' }).items
    expect(new Set(jobs.map(job => job.type))).toEqual(new Set(['summarize-file', 'classify', 'find-synonyms', 'daily']))
    for (const job of jobs) expect(job.execution).toMatchObject({ model: 'fake', reasoning: { requested: 'high', source: 'global' } })
    expect(app.core.taxonomy.synonyms()).toHaveLength(1)
    expect((await app.call('doc:get', { ref: { path: source } })).classification.tags).toEqual([])
    expect(fs.readFileSync(app.file(source), 'utf8')).toBe(raw)
    await app.call('classify:accept', { ref: { path: source }, kind: 'properties' })
    expect(fs.existsSync(app.file(source))).toBe(true)
    const filed = await app.call('classify:accept', { ref: { path: source }, kind: 'directory' })
    const summary = app.core.files.summaries(filed.path)[0]!
    await app.call('content:move', { path: folder, targetPath: folder + '归档' })
    const moved = filed.path.replace(folder, folder + '归档')
    expect((await app.call('doc:get', { ref: { path: summary } })).sourcePath).toBe(moved)
    const before = app.fake.requests.length
    await app.reopen({ removeIndex: true })
    expect(app.fake.requests).toHaveLength(before)
    expect((await app.call('library:resolve', { path: summary }))?.path).toBe(moved)
    expect((await app.call('doc:get', { ref: { path: moved } })).classification.tags).toEqual(['验收'])
    expect(fs.readFileSync(app.file(moved), 'utf8')).toBe(raw)
    expect(app.core.agent.get(id).context?.reasoningEffort).toBe('low')
    expect(app.core.jobs.list({ state: 'done' }).items.map(job => job.execution)).toEqual(jobs.map(job => job.execution))
    app.fake.setResponder(agentScript([
      () => ({ toolCall: { name: 'read', arguments: { path: moved } } }),
      results => '当前资料采用方案甲[^' + chunkIds(results[0]!)[0] + ']。',
    ], taskReply))
    const next = await ask(id, '接着读取归档后的当前资料')
    expect(next.citations?.[0]).toMatchObject({ valid: true, chunk: { path: moved } })
    expect(next.context?.reasoning).toMatchObject({ requested: 'low', source: 'conversation' })
    const catalog = await app.call('capabilities:catalog', undefined)
    expect(catalog.agents.map(agent => agent.id)).toEqual(['default'])
    expect(catalog.tools).toHaveLength(18)
    expect(catalog.skills).toHaveLength(9)
    expect(catalog.taskBindings.every(binding => !binding.issues.length)).toBe(true)
  })

  it.each(['daily', 'summarize-file', 'classify', 'find-synonyms'] as const)('%s明确拒绝高档后保持失败，主动改模型默认重试只发默认参数并保存实际记录', async (task: AiTaskKind) => {
    await app.call('settings:set', { model: { reasoningEffort: 'high' } })
    await app.call('vault:createFolder', { parent: 'content/工作', name: '组合验收' })
    app.write('inbox/2026/11/资料.txt', '资料正文'); await app.core.syncIndex()
    await app.call('capture:save', { text: '明确完成接口评审', source: 'main-window' })
    app.core.state.confirmTerms('tag', ['验收', '验收工作'], 'preset')
    app.fake.setResponder(() => ({ status: 400, body: JSON.stringify({ error: { message: 'unsupported reasoning_effort high' } }) }))
    const jobId = task === 'daily' ? (await app.core.daily.request(date)).jobId : task === 'summarize-file'
      ? (await app.core.files.reprocess('inbox/2026/11/资料.txt')).jobId : task === 'classify'
        ? (await app.call('classify:rerun', { ref: { path: 'inbox/2026/11/资料.txt' } })).jobId : app.core.taxonomy.requestSynonyms('tag').jobId
    await app.core.jobs.drain()
    expect(app.core.jobs.info(jobId)).toMatchObject({ state: 'failed', error: expect.stringContaining('未自动降档'), execution: { reasoning: { requested: 'high' } } })
    expect(app.fake.requests).toHaveLength(1)
    await app.call('settings:set', { model: { reasoningEffort: 'auto' } })
    app.fake.setResponder(taskReply)
    app.core.jobs.retry(jobId); await app.core.jobs.drain()
    expect(app.core.jobs.info(jobId)).toMatchObject({ state: 'done', execution: { reasoning: { requested: 'auto', source: 'model-default' } } })
    expect(app.fake.requests).toHaveLength(2)
    for (const key of ['reasoning_effort', 'thinking', 'reasoning', 'enable_thinking']) expect(app.fake.requests[1]).not.toHaveProperty(key)
    expect(app.core.jobs.info(jobId).execution?.reasoning).not.toHaveProperty('reported')
  })

  it('同一长对话的默认覆盖、独立压缩、后台全局高档和导出跨索引重建保持', async () => {
    await app.call('settings:set', { model: { contextWindow: 26624, reasoningEffort: 'high' } })
    const compressed = '用户在核对组合验收，后续按当前文件回答，保留原始记录和实际出处。'
    app.fake.setResponder(agentScript([
      () => ({ toolCall: { name: 'calculator', arguments: { expression: '0.1+0.2' } } }),
      () => '计算得到0.3，继续按实际材料核对。',
    ], request => isCompactionRequest(request) ? compressed : taskReply(request)))
    const id = app.core.agent.create().conversationId
    for (let turn = 0; turn < 6; turn++) await ask(id, '第' + turn + '轮，' + '方案细节'.repeat(300), turn === 0
      ? { agentId: 'default', references: [], strict: false, skillIds: [], reasoningEffort: 'auto' } : undefined)
    await expect.poll(() => app.core.state.raw.prepare('SELECT count(*) AS count FROM conversation_summaries').get(), { timeout: 10000 }).toEqual({ count: 1 })
    await app.call('capture:save', { text: '明确完成接口评审', source: 'main-window' })
    const { jobId } = await app.core.daily.request(date)
    await app.core.jobs.drain()
    expect(app.core.jobs.info(jobId)).toMatchObject({ state: 'done', execution: { reasoning: { requested: 'high', source: 'global' } } })
    expect(app.fake.requests.filter(isAgentRequest).every(request => request.reasoning_effort === undefined)).toBe(true)
    expect(app.fake.requests.filter(isCompactionRequest).every(request => request.reasoning_effort === undefined)).toBe(true)
    await app.reopen({ removeIndex: true })
    const next = await ask(id, '接续核对')
    expect(next.budget?.summarizedTurns).toBeGreaterThanOrEqual(4)
    expect(app.core.agent.get(id).messages).toHaveLength(14)
    const snapshot = app.core.agent.exportSnapshot(id)
    const jsonl = renderConversation(snapshot, 'jsonl', app.root, path.join(app.tmp.dir, '完整对话.jsonl'))
    const rows = jsonl.trim().split('\n').map(line => JSON.parse(line))
    expect(rows.filter(row => row.type === 'message').map(row => row.message)).toEqual(snapshot.messages)
    expect(rows.some(row => row.type === 'summary' && row.summary === compressed)).toBe(true)
    expect(renderConversation(snapshot, 'markdown', app.root, path.join(app.tmp.dir, '完整对话.md'))).toContain('calculator · 成功')
  })
})
