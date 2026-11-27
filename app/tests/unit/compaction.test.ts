import { modelSettings } from '../helpers/models'
import path from 'node:path'
import { PiHost } from '../../electron/agent/pi'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ConversationCompactor } from '../../electron/agent/compaction'
import { estimateInputTokens } from '../../electron/agent/budget'
import type { ChatMessage } from '../../shared/types'
import type { ContextBudget } from '../../shared/model-budget'
import { deferred, testApp } from '../helpers/test-app'
import { isCompactionRequest } from '../helpers/fake-llm'

let app: Awaited<ReturnType<typeof testApp>>, compactor: ConversationCompactor
let id: string, messages: ChatMessage[]
const host = () => new PiHost(path.join(app.tmp.dir, 'compaction-test'), () => app.core.settings.getModelConfig())
const limits = { contextWindow: 16384, maxOutputTokens: 4096, compactionThreshold: 0.7 as const, source: 'custom' as const }
const pressure: ContextBudget = { ...limits, model: 'fake', safetyTokens: 820, inputBudget: 11468, inputTokens: 14000, percent: 85, historyTurns: 6, omittedHistoryTurns: 0, blocked: false }
const payload = { messages: [{ role: 'system', content: '本轮系统说明' }, { role: 'user', content: '本轮用户问题' }] }
const summaryText = '用户希望整理方案，明确要求保留原始文件。继续比较实现选择，并在执行下一步前确认目标目录。'
const rows = () => app.core.state.raw.prepare('SELECT * FROM conversation_summaries WHERE conversation_id=? ORDER BY mode').all(id) as { mode: string; through_message_id: string; summary: string }[]
function seed(turns = 6): ChatMessage[] {
  const insert = app.core.state.raw.prepare('INSERT INTO messages(id,conversation_id,role,text,created_at) VALUES (?,?,?,?,?)')
  const result: ChatMessage[] = []
  for (let i = 0; i < turns; i++) {
    for (const role of ['user', 'assistant'] as const) {
      const message = { messageId: id + ':' + role + ':' + i, role,
        text: (role === 'user' ? '用户目标' : '旧助手秘密事实') + i + '；' + '讨论细节'.repeat(150), createdAt: '2026-11-21T12:00:00+08:00' }
      insert.run(message.messageId, id, role, message.text, message.createdAt)
      result.push(message)
    }
  }
  return result
}
beforeEach(async () => {
  app = await testApp()
  await app.call('settings:set', { ...modelSettings({ baseUrl: app.fake.baseUrl, apiKey: 'fake', model: 'fake', contextWindow: limits.contextWindow }, app.core.settings.get()) })
  id = app.core.agent.create().conversationId
  messages = seed()
  compactor = new ConversationCompactor({ state: app.core.state, pi: host(), cwd: () => app.core.vault.path }, { requestMs: 15_000, waitMs: 30 })
})
afterEach(async () => { compactor.cancel(); await app.close() })

describe('后台压缩、持久化和并发', () => {
  it('压缩独立于全局高强度，未知接口使用模型默认并保留输出空间', async () => {
    await app.call('settings:set', { ...modelSettings({ reasoningEffort: 'high' }, app.core.settings.get()) })
    app.fake.setResponder(() => summaryText)
    compactor.schedule(id, messages, false, pressure, '本轮结束')
    await expect.poll(() => rows().length, { timeout: 10000 }).toBe(1)
    const request = app.fake.requests.find(isCompactionRequest)!
    expect(request.reasoning_effort).toBeUndefined()
    expect(request.max_tokens ?? request.max_completion_tokens).toBe(4096)
  })
  it.each([0.6, 0.7, 0.8] as const)('按整个窗口的 %s 触发，与自动输出预留无关', async threshold => {
    app.fake.setResponder(() => summaryText)
    const answer = '本轮已结束', added = estimateInputTokens([{ role: 'assistant', content: answer }])
    const at = Math.ceil(limits.contextWindow * threshold) - added
    const budget = { ...pressure, compactionThreshold: threshold, inputTokens: at - 1, omittedHistoryTurns: 0 }
    compactor.schedule(id, messages, false, budget, answer)
    expect(compactor.isRunning).toBe(false)
    compactor.schedule(id, messages, false, { ...budget, maxOutputTokens: 1024, inputBudget: 14540 }, answer)
    expect(compactor.isRunning).toBe(false)
    compactor.schedule(id, messages, false, { ...budget, inputTokens: at }, answer)
    await expect.poll(() => rows().length, { timeout: 10_000 }).toBe(1)
    expect(rows()[0]?.through_message_id).toBe(messages[7]!.messageId)
  })

  it('摘要实际加载旧问答但无工具，保留最近两轮与完整历史，重启仍用摘要及覆盖点', async () => {
    app.fake.setResponder(() => summaryText)
    compactor.schedule(id, messages, false, pressure, '回答结束')
    await expect.poll(() => rows().length, { timeout: 10_000 }).toBe(1)
    expect(rows()[0]).toMatchObject({ mode: 'normal', through_message_id: messages[7]!.messageId, summary: summaryText })
    const request = app.fake.requests.find(isCompactionRequest)!
    expect(request.tools).toBeUndefined()
    expect(request.max_tokens ?? request.max_completion_tokens).toBe(4096)
    expect(request.reasoning_effort).toBeUndefined()
    expect(JSON.stringify(request.messages)).toContain('用户目标0')
    expect(JSON.stringify(request.messages)).not.toContain('用户目标4')
    expect(app.core.agent.get(id).messages).toHaveLength(12)
    await app.reopen({ removeIndex: true })
    compactor = new ConversationCompactor({ state: app.core.state, pi: host(), cwd: () => app.core.vault.path })
    const fitted = await compactor.prepare(id, messages, false, payload, limits, 'fake', new AbortController().signal, () => {})
    expect(fitted.budget.summarizedTurns).toBe(4)
    expect(JSON.stringify(fitted.payload)).toContain(summaryText)
    expect(JSON.stringify(fitted.payload)).toContain('用户目标5')
    expect(JSON.stringify(fitted.payload)).not.toContain('用户目标0')
  })

  it('摘要在后台时预算足够不等待，必须裁剪时短等后回退，同一历史不重复建任务，完成后可使用', async () => {
    const arrived = deferred(), release = deferred()
    app.fake.setResponder(async () => { arrived.release(); await release.promise; return summaryText })
    compactor.schedule(id, messages, false, pressure, '回答')
    await arrived.promise
    const noWait: boolean[] = []
    const room = await compactor.prepare(id, messages, false, payload, { ...limits, contextWindow: 65536 }, 'fake', new AbortController().signal, value => noWait.push(value))
    expect(room.budget.omittedHistoryTurns).toBe(0)
    expect(noWait).toEqual([])
    const tooLarge = { messages: [{ role: 'user', content: '本轮必要材料'.repeat(2000) }] }
    const blocked = await compactor.prepare(id, messages, false, tooLarge, { ...limits, contextWindow: 4096, maxOutputTokens: 1024 }, 'fake', new AbortController().signal, value => noWait.push(value))
    expect(blocked.budget.blocked).toBe(true)
    expect(noWait).toEqual([])
    const waiting: boolean[] = []
    const start = Date.now()
    const fitted = await compactor.prepare(id, messages, false, payload, { ...limits, contextWindow: 4096, maxOutputTokens: 1024 }, 'fake', new AbortController().signal, value => waiting.push(value))
    expect(Date.now() - start).toBeLessThan(1000)
    expect(waiting).toEqual([true, false])
    expect(fitted.budget.blocked).toBe(false)
    expect(fitted.budget.omittedHistoryTurns).toBeGreaterThan(0)
    expect(rows()).toEqual([])
    compactor.schedule(id, messages, false, pressure, '回答')
    expect(app.fake.requests.filter(isCompactionRequest)).toHaveLength(1)
    release.release()
    await expect.poll(() => rows().length, { timeout: 10_000 }).toBe(1)
  })

  it('等待期间取消立即返回，不写新会话消息；后台可完成并保存供后续使用', async () => {
    const arrived = deferred(), release = deferred()
    app.fake.setResponder(async () => { arrived.release(); await release.promise; return summaryText })
    compactor.schedule(id, messages, false, pressure, '回答')
    await arrived.promise
    const controller = new AbortController(), entered = deferred()
    const request = compactor.prepare(id, messages, false, payload, { ...limits, contextWindow: 4096, maxOutputTokens: 1024 }, 'fake', controller.signal, value => { if (value) entered.release() })
    await entered.promise
    controller.abort()
    await expect(request).rejects.toMatchObject({ code: 'CANCELLED' })
    expect(app.core.agent.get(id).messages).toHaveLength(12)
    release.release()
    await expect.poll(() => rows().length, { timeout: 10_000 }).toBe(1)
  })

  it.each(['timeout', 'error', 'empty'] as const)('摘要 %s 保留旧摘要和完整历史，不重复压缩同一批；新增轮次可再次尝试', async failure => {
    // 先保存一个真实成功的较早摘要。
    app.fake.setResponder(() => summaryText)
    compactor.schedule(id, messages, false, pressure, '回答')
    await expect.poll(() => rows().length, { timeout: 10_000 }).toBe(1)
    const saved = rows()[0]!
    const more = { messageId: id + ':extra:user', role: 'user' as const, text: '新增讨论'.repeat(200), createdAt: messages[0]!.createdAt }
    const answer = { ...more, messageId: id + ':extra:assistant', role: 'assistant' as const, text: '新增回答'.repeat(200) }
    for (const message of [more, answer]) app.core.state.raw.prepare('INSERT INTO messages(id,conversation_id,role,text,created_at) VALUES (?,?,?,?,?)').run(message.messageId, id, message.role, message.text, message.createdAt)
    messages.push(more, answer)
    const timing = { requestMs: failure === 'timeout' ? 60 : 15_000, waitMs: 20 }
    compactor = new ConversationCompactor({ state: app.core.state, pi: host(), cwd: () => app.core.vault.path }, timing)
    const release = deferred()
    app.fake.setResponder(async () => {
      if (failure === 'timeout') { await release.promise; return summaryText }
      if (failure === 'error') return { status: 400, body: '{"error":{"message":"虚构摘要失败"}}' }
      return ''
    })
    const count = app.fake.requests.length
    compactor.schedule(id, messages, false, pressure, '回答')
    await expect.poll(() => compactor.isRunning).toBe(false)
    expect(rows()[0]).toEqual(saved)
    const attempts = app.fake.requests.length - count
    compactor.schedule(id, messages, false, pressure, '回答')
    expect(compactor.isRunning).toBe(false)
    expect(app.fake.requests.length - count).toBe(attempts)
    expect(app.core.agent.get(id).messages).toHaveLength(14)
    release.release()
    const user = { ...more, messageId: id + ':retry:user', text: '失败后新增一轮用户问题' }
    const assistant = { ...answer, messageId: id + ':retry:assistant', text: '继续讨论' }
    for (const message of [user, assistant]) app.core.state.raw.prepare('INSERT INTO messages(id,conversation_id,role,text,created_at) VALUES (?,?,?,?,?)').run(message.messageId, id, message.role, message.text, message.createdAt)
    messages.push(user, assistant)
    app.fake.setResponder(() => summaryText)
    timing.requestMs = 15_000
    compactor.schedule(id, messages, false, pressure, '回答')
    await expect.poll(() => rows()[0]?.through_message_id, { timeout: 10_000 }).toBe(messages[11]!.messageId)
    expect(rows()[0]?.summary).toBe(summaryText)
  })

  it('严格材料摘要只读取用户问题，不能复用普通摘要；普通和严格模式分别持久化', async () => {
    app.fake.setResponder(() => summaryText)
    compactor.schedule(id, messages, false, pressure, '回答')
    await expect.poll(() => rows().length, { timeout: 10_000 }).toBe(1)
    const before = await compactor.prepare(id, messages, true, payload, { ...limits, contextWindow: 65536 }, 'fake', new AbortController().signal, () => {})
    expect(before.budget.summarizedTurns).toBeUndefined()
    expect(JSON.stringify(before.payload)).not.toContain(summaryText)
    compactor.schedule(id, messages, true, pressure, '回答')
    await expect.poll(() => rows().length, { timeout: 10_000 }).toBe(2)
    const request = app.fake.requests.filter(isCompactionRequest).at(-1)!
    expect(JSON.stringify(request.messages)).toContain('用户目标0')
    expect(JSON.stringify(request.messages)).not.toContain('旧助手秘密事实')
    expect(JSON.stringify(request.messages)).not.toContain('既有摘要：')
    expect(rows().map(row => row.mode)).toEqual(['normal', 'strict'])
    const strict = await compactor.prepare(id, messages, true, payload, limits, 'fake', new AbortController().signal, () => {})
    expect(strict.budget.summarizedTurns).toBe(4)
    expect(JSON.stringify(strict.payload)).toContain(summaryText)
    expect(JSON.stringify(strict.payload)).not.toContain('旧助手秘密事实')
  })

  it('取消并删除后迟到结果无保存资格；切库后也不能写入新数据库', async () => {
    const arrived = deferred(), release = deferred()
    app.fake.setResponder(async () => { arrived.release(); await release.promise; return summaryText })
    compactor.schedule(id, messages, false, pressure, '回答')
    await arrived.promise
    compactor.cancel(id)
    await app.call('agent:delete', { conversationId: id })
    release.release()
    await expect.poll(() => compactor.isRunning).toBe(false)
    expect(rows()).toEqual([])
    expect(app.core.agent.conversations().total).toBe(0)
  })
})
