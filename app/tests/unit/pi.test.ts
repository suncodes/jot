import fs from 'node:fs'
import path from 'node:path'
import { Type } from 'typebox'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadPi, PiHost } from '../../electron/agent/pi'
import { startFakeLlm, type FakeLlm } from '../helpers/fake-llm'
import { makeTmpDir } from '../helpers/tmp'
import type { ContextBudget } from '../../shared/model-budget'

let fake: FakeLlm
let tmp: ReturnType<typeof makeTmpDir>
beforeAll(async () => {
  fake = await startFakeLlm()
  tmp = makeTmpDir('pi')
})
afterAll(async () => {
  await fake.close()
  tmp.cleanup()
})

describe('Pi 宿主', () => {
  it('官方接口精确模型使用 SDK 本地模型资料，创建会话不发网络请求', async () => {
    const before = fake.requests.length
    const host = new PiHost(path.join(tmp.dir, 'catalog'), () => ({ baseUrl: 'https://api.openai.com/v1', apiKey: 'fake', model: 'gpt-4o' }))
    expect(await host.resolveLimits({ baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o' })).toMatchObject({ contextWindow: 128000, source: 'catalog', compactionThreshold: 0.7 })
    expect(await host.resolveLimits({ baseUrl: fake.baseUrl, model: 'unknown', compactionThreshold: 0.8 })).toMatchObject({ contextWindow: 32768, source: 'default', compactionThreshold: 0.8 })
    const session = await host.createSession({ cwd: tmp.dir, systemPrompt: '测试', tools: [] })
    try {
      expect(session.model?.contextWindow).toBe(128000)
      expect(session.model?.maxTokens).toBe(8192)
      expect(fake.requests.length).toBe(before)
    } finally { session.dispose() }
  })

  it('小窗口在首次及工具后实际请求都裁剪历史，输出上限一致，无后台压缩请求', async () => {
    const pi = await loadPi()
    const budgets: ContextBudget[] = []
    const start = fake.requests.length
    const history = Array.from({ length: 10 }, (_, i) => '第' + i + '轮：' + '过去'.repeat(160))
    const read = pi.defineTool({
      name: 'read', label: '读取', description: '读取虚构资料',
      parameters: Type.Object({ path: Type.String() }),
      async execute() { return { content: [{ type: 'text', text: '当前材料'.repeat(180) }], details: undefined } },
    })
    fake.setResponder((_req, index) => index === start ? { toolCall: { name: 'read', arguments: { path: 'content/虚构.md' } } } : '已读取当前材料')
    const host = new PiHost(path.join(tmp.dir, 'budget'), () => ({ baseUrl: fake.baseUrl, model: 'small', apiKey: 'fake', contextWindow: 4096 }))
    const session = await host.createSession({ cwd: tmp.dir, systemPrompt: '按当前材料回答', tools: [read], history, onBudget: value => budgets.push(value) })
    try {
      await session.prompt('读取虚构资料')
      expect(session.getLastAssistantText()).toBe('已读取当前材料')
      expect(fake.requests.length - start).toBe(2)
      expect(budgets).toHaveLength(2)
      expect(budgets.every(value => !value.blocked && value.inputTokens <= value.inputBudget)).toBe(true)
      expect(budgets[1]!.omittedHistoryTurns).toBeGreaterThan(budgets[0]!.omittedHistoryTurns)
      for (const request of fake.requests.slice(start)) {
        expect(request.max_tokens ?? request.max_completion_tokens).toBe(1024)
        expect(JSON.stringify(request.messages)).toContain('第9轮：')
        expect(JSON.stringify(request.messages)).not.toContain('第0轮：')
      }
      expect(history).toHaveLength(10)
    } finally { session.dispose() }
  })

  it('工具返回超过小窗口时结束为错误，保留真实工具结果且不发送超预算续跑', async () => {
    const pi = await loadPi(), budgets: ContextBudget[] = []
    const start = fake.requests.length
    const read = pi.defineTool({
      name: 'read', label: '读取', description: '大量虚构资料',
      parameters: Type.Object({}),
      async execute() { return { content: [{ type: 'text', text: '大材料'.repeat(3000) }], details: undefined } },
    })
    fake.setResponder(() => ({ toolCall: { name: 'read', arguments: {} } }))
    const host = new PiHost(path.join(tmp.dir, 'overflow'), () => ({ baseUrl: fake.baseUrl, model: 'small', apiKey: 'fake', contextWindow: 4096 }))
    const session = await host.createSession({ cwd: tmp.dir, systemPrompt: '读取资料', tools: [read], onBudget: value => budgets.push(value) })
    try {
      await session.prompt('读取材料')
      expect(fake.requests.length - start).toBe(1)
      expect(budgets.at(-1)?.blocked).toBe(true)
      const last = session.messages.findLast(message => message.role === 'assistant')
      expect(last).toMatchObject({ stopReason: 'error', errorMessage: expect.stringContaining('分段读取') })
      const tool = session.messages.find(message => message.role === 'toolResult')
      expect(JSON.stringify(tool)).toContain('大材料'.repeat(3000))
    } finally { session.dispose() }
  })

  it('初始问题过大不会发出模型请求，保留输入并返回正常失败生命周期', async () => {
    const start = fake.requests.length, budgets: ContextBudget[] = []
    const host = new PiHost(path.join(tmp.dir, 'initial-overflow'), () => ({ baseUrl: fake.baseUrl, model: 'small', apiKey: 'fake', contextWindow: 4096 }))
    const session = await host.createSession({ cwd: tmp.dir, systemPrompt: '简单说明', tools: [], onBudget: value => budgets.push(value) })
    try {
      const events: string[] = []
      session.subscribe(event => events.push(event.type))
      await session.prompt('长问题'.repeat(2000))
      expect(fake.requests.length).toBe(start)
      expect(budgets.at(-1)?.blocked).toBe(true)
      expect(session.messages.findLast(message => message.role === 'assistant')).toMatchObject({ stopReason: 'error' })
      expect(events).toContain('agent_end')
    } finally { session.dispose() }
  })

  it('没配置模型时报 LLM_NOT_CONFIGURED', async () => {
    const host = new PiHost(path.join(tmp.dir, 'agent0'), () => null)
    await expect(host.createSession({ cwd: tmp.dir, systemPrompt: '', tools: [] })).rejects.toMatchObject({ code: 'LLM_NOT_CONFIGURED' })
  })

  it('用配置的接口完成一次带工具调用的对话，只开放我们自己的工具，密钥不落盘', async () => {
    const pi = await loadPi()
    const agentDir = path.join(tmp.dir, 'agent')
    const host = new PiHost(agentDir, () => ({ baseUrl: fake.baseUrl, apiKey: 'sk-test-secret', model: 'fake-model' }))

    const calls: unknown[] = []
    const search = pi.defineTool({
      name: 'search',
      label: '搜索',
      description: '按关键词搜索笔记',
      parameters: Type.Object({ query: Type.String() }),
      async execute(_id, params) {
        calls.push(params)
        return { content: [{ type: 'text', text: '[a1b2c3] inbox/x.md:1\n过年要买零食。' }], details: undefined }
      },
    })

    const start = fake.requests.length
    fake.setResponder((_req, i) => (i === start ? { toolCall: { name: 'search', arguments: { query: '过年' } } } : '你打算买零食[^a1b2c3]。'))

    const session = await host.createSession({ cwd: tmp.dir, systemPrompt: '你是笔记助手。', tools: [search] })
    let streamed = ''
    const toolEvents: string[] = []
    session.subscribe((e) => {
      if (e.type === 'message_update' && e.assistantMessageEvent.type === 'text_delta') streamed += e.assistantMessageEvent.delta
      if (e.type === 'tool_execution_start') toolEvents.push(e.toolName)
    })
    try {
      expect(session.getActiveToolNames()).toEqual(['search'])
      await session.prompt('我过年打算买什么？')
      expect(calls).toEqual([{ query: '过年' }])
      expect(toolEvents).toEqual(['search'])
      expect(streamed).toBe('你打算买零食[^a1b2c3]。')
      expect(session.getLastAssistantText()).toBe('你打算买零食[^a1b2c3]。')
    } finally {
      session.dispose()
    }

    // 发给模型的请求：系统提示词是我们给的，工具只有 search
    const first = fake.requests[start]!
    expect(first.model).toBe('fake-model')
    expect(JSON.stringify(first.messages[0])).toContain('你是笔记助手。')
    expect((first.tools as { function: { name: string } }[]).map((t) => t.function.name)).toEqual(['search'])

    // 密钥只在运行时传给 Pi，配置目录里不出现
    for (const f of fs.readdirSync(agentDir)) {
      expect(fs.readFileSync(path.join(agentDir, f), 'utf8')).not.toContain('sk-test-secret')
    }
  })
})
