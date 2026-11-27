import { modelSettings } from '../helpers/models'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentEvent, ChatMessage } from '../../shared/types'
import { deferred, testApp } from '../helpers/test-app'
import { agentScript, isAgentRequest, isCompactionRequest } from '../helpers/fake-llm'

let app: Awaited<ReturnType<typeof testApp>>, events: AgentEvent[]
const summary = '用户持续比较实现方案，要求保留原始文件和完整历史。下一步继续核对待办，写入前明确实际存储目录。'
const summaryRows = () => app.core.state.raw.prepare('SELECT * FROM conversation_summaries').all() as { conversation_id: string; mode: string; summary: string; through_message_id: string }[]
async function ask(id: string, text: string) {
  const { runId } = await app.call('agent:send', { conversationId: id, text })
  await app.core.agent.wait(runId)
  return app.core.agent.get(id).messages.at(-1)!
}
async function fillConversation(id: string) {
  for (let i = 0; i < 6; i++) await ask(id, '第' + i + '轮，' + '方案细节'.repeat(240))
}
beforeEach(async () => {
  events = []
  app = await testApp((name, value) => { if (name === 'agent:event') events.push(structuredClone(value as AgentEvent)) })
  await app.call('settings:set', { ...modelSettings({ baseUrl: app.fake.baseUrl, apiKey: 'fake', model: 'fake', contextWindow: 16384 }, app.core.settings.get()) })
})
afterEach(async () => { await app.close() })

describe('正式助手压缩生命周期', () => {
  it('六轮接近预算时后台压缩，完整历史保留，重启沿用摘要，后续增量覆盖不丢已有摘要', async () => {
    app.fake.setResponder(agentScript([() => '回答中保留明确需求'], req => isCompactionRequest(req) ? summary : '好'))
    const id = app.core.agent.create().conversationId
    await fillConversation(id)
    await expect.poll(() => summaryRows().length, { timeout: 5000 }).toBe(1)
    const saved = summaryRows()[0]!
    expect(saved.through_message_id).toBe(app.core.agent.get(id).messages[7]!.messageId)
    expect(app.core.agent.get(id).messages).toHaveLength(12)
    expect(events.some(event => event.type === 'compacting')).toBe(false)
    await app.reopen({ removeIndex: true })
    app.fake.setResponder(agentScript([() => '接续回答'], req => isCompactionRequest(req) ? summary : '好'))
    const result = await ask(id, '继续讨论')
    expect(result.budget?.summarizedTurns).toBe(4)
    const request = app.fake.requests.filter(isAgentRequest).at(-1)!
    expect(JSON.stringify(request.messages)).toContain(summary)
    expect(JSON.stringify(request.messages)).toContain('第5轮，')
    expect(JSON.stringify(request.messages)).not.toContain('第0轮，')
    for (let i = 6; i < 12; i++) await ask(id, '第' + i + '轮，' + '新增细节'.repeat(240))
    await expect.poll(() => summaryRows()[0]?.through_message_id, { timeout: 5000 }).not.toBe(saved.through_message_id)
    const later = app.fake.requests.filter(isCompactionRequest).at(-1)!
    expect(JSON.stringify(later.messages)).toContain('既有摘要：')
    expect(JSON.stringify(later.messages)).toContain(summary)
    expect(app.core.agent.get(id).messages).toHaveLength(26)
  })

  it('后台未完仍能继续提问，预算不足才推送等待；用户停止后问题与既有步骤仍保留', async () => {
    await app.call('settings:set', { ...modelSettings({ contextWindow: 26624 }, app.core.settings.get()) })
    const arrived = deferred(), release = deferred()
    app.fake.setResponder(agentScript([() => '短回答'], async req => {
      if (isCompactionRequest(req)) { arrived.release(); await release.promise; return summary }
      return '好'
    }))
    const id = app.core.agent.create().conversationId
    try {
      await fillConversation(id)
      await arrived.promise
      expect(app.core.agent.get(id).running).toBeUndefined()
      expect(app.core.agent.isRunning).toBe(true)
      await expect(app.call('maintenance:optimizeDatabases', { vaultPath: app.root })).rejects.toThrow('CONFLICT')
      const next = await ask(id, '第七轮短追问')
      expect(next.error).toBeUndefined()
      expect(next.budget).toMatchObject({ omittedHistoryTurns: 0 })
      expect(events.some(event => event.type === 'compacting')).toBe(false)
      const { runId } = await app.call('agent:send', { conversationId: id, text: '第八轮需要空间' + '详细约束'.repeat(650) })
      await expect.poll(() => events.some(event => event.runId === runId && event.type === 'compacting' && event.waiting)).toBe(true)
      expect(app.core.agent.get(id).live?.waitingForCompaction).toBe(true)
      await app.core.agent.abort(runId)
      expect(app.core.agent.get(id).messages.at(-1)?.error).toBe('已停止')
      expect(app.core.agent.get(id).messages.at(-2)?.text).toContain('第八轮需要空间')
      release.release()
      await expect.poll(() => summaryRows().length, { timeout: 5000 }).toBe(1)
    } finally { release.release() }
  })

  it.each(['delete', 'model', 'vault'] as const)('%s 撤销在途摘要保存资格，迟到结果不写旧会话或新库', async action => {
    const arrived = deferred(), release = deferred()
    app.fake.setResponder(agentScript([() => '短回答'], async req => {
      if (isCompactionRequest(req)) { arrived.release(); await release.promise; return summary }
      return '好'
    }))
    const id = app.core.agent.create().conversationId
    try {
      await fillConversation(id)
      await arrived.promise
      if (action === 'delete') await app.call('agent:delete', { conversationId: id })
      else if (action === 'model') await app.call('settings:set', { ...modelSettings({ model: 'another' }, app.core.settings.get()) })
      else await app.core.openVault(path.join(app.tmp.dir, 'second-vault'), true)
      await expect.poll(() => app.core.agent.isRunning).toBe(false)
      release.release()
      // 等本地服务确实结束迟到的响应，避免只检查取消前瞬间。
      await app.fake.close()
      expect(summaryRows()).toEqual([])
      if (action === 'delete' || action === 'vault') expect(app.core.agent.conversations().total).toBe(0)
      else expect(app.core.agent.get(id).messages).toHaveLength(12)
    } finally { release.release() }
  })

  it('未结束的回答不会进入摘要；完整历史的中断状态恢复后仍可查', async () => {
    const id = app.core.agent.create().conversationId
    const db = app.core.state.raw
    const insert = db.prepare('INSERT INTO messages(id, conversation_id, role, text, tool_calls, created_at) VALUES (?,?,?,?,?,?)')
    for (let i = 0; i < 6; i++) {
      insert.run('user-' + i, id, 'user', '已完成用户目标' + i + '，' + '方案细节'.repeat(240), null, '2026-11-21')
      insert.run('answer-' + i, id, 'assistant', '完成回答', null, '2026-11-21')
    }
    insert.run('pending-user', id, 'user', '正在编辑的未结束用户问题', null, '2026-11-21')
    insert.run('pending-answer', id, 'assistant', '未结束回答秘密', JSON.stringify({ runState: 'running' }), '2026-11-21')
    app.fake.setResponder(agentScript([() => '新回答'], req => isCompactionRequest(req) ? summary : '好'))
    await ask(id, '继续')
    await expect.poll(() => summaryRows().length, { timeout: 5000 }).toBe(1)
    expect(JSON.stringify(app.fake.requests.filter(isCompactionRequest))).not.toContain('未结束回答秘密')
    expect((app.core.agent.get(id).messages as ChatMessage[]).some(message => message.messageId === 'answer-0')).toBe(true)
  })
})
