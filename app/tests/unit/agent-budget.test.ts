import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentEvent } from '../../shared/types'
import { agentScript, chunkIds, isAgentRequest } from '../helpers/fake-llm'
import { testApp } from '../helpers/test-app'

let app: Awaited<ReturnType<typeof testApp>>
let events: AgentEvent[]
const file = 'content/工作/范围内.md'
async function ask(id: string, text: string, strict = false) {
  const sent = await app.call('agent:send', { conversationId: id, text,
    context: { agentId: 'default', strict, references: strict ? [{ kind: 'file', value: file, title: '范围内' }] : [], skillIds: [] } })
  await app.core.agent.wait(sent.runId)
  return app.core.agent.get(id).messages.at(-1)!
}
beforeEach(async () => {
  events = []
  app = await testApp((name, value) => { if (name === 'agent:event') events.push(structuredClone(value as AgentEvent)) })
  app.write(file, '范围内当前内容')
  app.fake.setResponder(agentScript([() => '简短回答'], () => ''))
})
afterEach(async () => { await app.close() })

describe('助手输入预算与历史持久化', () => {
  it('较大模型保留超过十二条和两千字历史，小模型缩减完整问答，重启和切换大模型恢复可用历史', async () => {
    const id = app.core.agent.create().conversationId
    await app.call('settings:set', { model: { baseUrl: app.fake.baseUrl, model: 'large', apiKey: 'fake', contextWindow: 65536 } })
    for (let i = 0; i < 8; i++) await ask(id, '第' + i + '轮开头' + '历史'.repeat(1100) + '尾部证据' + i)
    const last = app.fake.requests.filter(isAgentRequest).at(-1)!
    expect(JSON.stringify(last.messages)).toContain('尾部证据0')
    expect(JSON.stringify(last.messages)).toContain('第6轮开头')
    expect(app.core.agent.get(id).messages).toHaveLength(16)
    await app.call('settings:set', { model: { model: 'small', contextWindow: 20480 } })
    const small = await ask(id, '继续讨论')
    expect(small.error).toBeUndefined()
    expect(small.budget).toMatchObject({ model: 'small', contextWindow: 20480, blocked: false })
    expect(small.budget!.omittedHistoryTurns).toBeGreaterThan(0)
    expect(small.budget!.inputTokens).toBeLessThanOrEqual(small.budget!.inputBudget)
    expect(JSON.stringify(app.fake.requests.filter(isAgentRequest).at(-1)!.messages)).not.toContain('第0轮开头')
    expect(JSON.stringify(app.fake.requests.filter(isAgentRequest).at(-1)!.messages)).toContain('尾部证据7')
    expect(app.core.agent.get(id).messages[0]!.text).toContain('尾部证据0')
    await app.reopen()
    expect(app.core.agent.get(id).messages.at(-1)!.budget).toEqual(small.budget)
    await app.call('settings:set', { model: { model: 'large', contextWindow: 65536 } })
    const large = await ask(id, '大窗口继续')
    expect(large.budget?.omittedHistoryTurns).toBe(0)
    expect(JSON.stringify(app.fake.requests.filter(isAgentRequest).at(-1)!.messages)).toContain('尾部证据0')
    expect(app.core.agent.get(id).messages).toHaveLength(20)
  })

  it('严格材料模式不重用旧助手事实，当前读取结果仍可引用，预算事件在请求前主动推送', async () => {
    const id = app.core.agent.create().conversationId
    app.fake.setResponder(agentScript([() => '旧回答秘密事实']))
    await ask(id, '第一问')
    app.fake.setResponder(agentScript([
      () => ({ toolCall: { name: 'read', arguments: { path: file } } }),
      results => '当前资料[^' + chunkIds(results[0]!)[0] + ']。',
    ]))
    const answer = await ask(id, '继续查看', true)
    const requests = app.fake.requests.filter(isAgentRequest).slice(-2)
    expect(JSON.stringify(requests)).toContain('第一问')
    expect(JSON.stringify(requests)).not.toContain('旧回答秘密事实')
    expect(answer.citations?.[0]).toMatchObject({ valid: true, chunk: { path: file } })
    expect(events.filter(event => event.runId === answer.runId && event.type !== 'text').map(event => event.type)).toEqual(['budget', 'tool-start', 'tool-end', 'budget', 'done'])
    expect(answer.budget).toBeDefined()
    app.core.agent.removeRecord(answer.runId!)
    expect(app.core.agent.get(id).messages.at(-1)!.budget).toEqual(answer.budget)
  })

  it('累计材料超限以明确错误结束，完整工具过程可查，用户改为分段读取后可继续', async () => {
    const id = app.core.agent.create().conversationId
    app.write('content/工作/大材料.md', Array.from({ length: 100 }, (_, i) => '第' + i + '行 ' + '材料'.repeat(70)).join('\n'))
    await app.call('settings:set', { model: { baseUrl: app.fake.baseUrl, model: 'small', apiKey: 'fake', contextWindow: 28672 } })
    app.fake.setResponder(agentScript([
      () => ({ toolCall: { name: 'read', arguments: { path: 'content/工作/大材料.md' } } }),
      () => ({ toolCall: { name: 'read', arguments: { path: 'content/工作/大材料.md', lineStart: 50 } } }),
      () => '不应该发出的第三次请求',
    ]))
    const count = app.fake.requests.filter(isAgentRequest).length
    const failed = await ask(id, '读取大材料')
    expect(failed.error).toContain('分段读取')
    expect(failed.budget?.blocked).toBe(true)
    expect(failed.toolCalls).toHaveLength(2)
    expect(failed.toolCalls!.every(call => call.ok)).toBe(true)
    expect(app.fake.requests.filter(isAgentRequest).length - count).toBe(2)
    expect(events.findLast(event => event.runId === failed.runId)).toMatchObject({ type: 'error', error: { code: 'LLM_CONTEXT_LIMIT' } })
    app.fake.setResponder(agentScript([
      () => ({ toolCall: { name: 'read', arguments: { path: 'content/工作/大材料.md', lineStart: 50, lineEnd: 51 } } }),
      () => '分段完成',
    ]))
    const next = await ask(id, '只读第50至51行')
    expect(next.error).toBeUndefined()
    expect(next.text).toBe('分段完成')
    expect(app.core.agent.get(id).messages[1]!.toolCalls).toHaveLength(2)
  })
})
