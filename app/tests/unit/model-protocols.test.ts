import { modelSettings } from '../helpers/models'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Type } from 'typebox'
import { z } from 'zod'
import { PiHost, loadPi } from '../../electron/agent/pi'
import { fitModelRequest } from '../../electron/agent/budget'
import { cleanReasoningPayload, resolveReasoning } from '../../electron/agent/reasoning'
import { protocolBaseUrl } from '../../shared/model-protocol'
import type { ContextBudget } from '../../shared/model-budget'
import type { ResolvedReasoning } from '../../shared/reasoning'
import { agentScript, isCompactionRequest } from '../helpers/fake-llm'
import { startProtocolLlm } from '../helpers/fake-protocols'
import { makeTmpDir } from '../helpers/tmp'
import { testApp } from '../helpers/test-app'

const protocols = ['openai-responses', 'anthropic-messages'] as const
const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })

describe.each(protocols)('%s 实际协议链', protocol => {
  it('原生流式工具续跑、完整历史和系统提示计入预算，默认档不发送推理开关', async () => {
    const fake = await startProtocolLlm(protocol, agentScript([
      () => ({ toolCall: { name: 'check', arguments: { value: '事实' } } }),
      results => '收到' + results[0],
    ]))
    cleanups.push(() => fake.close())
    const tmp = makeTmpDir('protocol'); cleanups.push(tmp.cleanup)
    const pi = await loadPi(), budgets: ContextBudget[] = []
    const host = new PiHost(path.join(tmp.dir, 'pi'), () => ({ protocol, baseUrl: fake.baseUrl, model: 'fixture', apiKey: 'protocol-fixture-key' }))
    const tool = pi.defineTool({ name: 'check', label: '核对', description: '返回实际参数', parameters: Type.Object({ value: Type.String() }),
      async execute(_id, args) { return { content: [{ type: 'text', text: args.value }], details: undefined } } })
    const history = Array.from({ length: 9 }, (_, index) => '第' + index + '轮：' + '过去'.repeat(80))
    const session = await host.createSession({ cwd: tmp.dir, systemPrompt: '核对系统说明', tools: [tool], history, onBudget: value => budgets.push(value) })
    try {
      await session.prompt('核对当前材料')
      expect(session.messages.at(-1)).not.toHaveProperty('errorMessage')
      expect(session.getLastAssistantText()).toBe('收到事实')
      expect(fake.wireRequests).toHaveLength(2)
      expect(budgets).toHaveLength(2)
      expect(budgets.every(value => !value.blocked)).toBe(true)
      expect(JSON.stringify(fake.wireRequests[1]!.body)).toContain('第0轮：')
      expect(JSON.stringify(fake.wireRequests[1]!.body)).toContain('事实')
      for (const { body, headers } of fake.wireRequests) {
        expect(body).not.toHaveProperty('reasoning'); expect(body).not.toHaveProperty('thinking')
        expect(body).not.toHaveProperty('max_completion_tokens')
        if (protocol === 'openai-responses') {
          expect(body.input?.length).toBeGreaterThan(0); expect(body.messages).toBeUndefined()
          expect(body.max_output_tokens).toBe(budgets[0]!.maxOutputTokens); expect(body.max_tokens).toBeUndefined()
          expect(body.store).toBe(false); expect(headers.authorization).toBe('Bearer protocol-fixture-key')
        } else {
          expect(JSON.stringify(body.system)).toContain('核对系统说明')
          expect(body.max_tokens).toBe(budgets[0]!.maxOutputTokens); expect(body.max_output_tokens).toBeUndefined()
          expect(headers['x-api-key']).toBe('protocol-fixture-key'); expect(headers['anthropic-version']).toBeDefined()
        }
      }
    } finally { session.dispose() }
  })

  it('明确推理档位生成原生参数，输出预算与思考预算保持有效', async () => {
    const fake = await startProtocolLlm(protocol); cleanups.push(() => fake.close())
    const tmp = makeTmpDir('protocol-reasoning'); cleanups.push(tmp.cleanup)
    const host = new PiHost(path.join(tmp.dir, 'pi'), () => ({ protocol, baseUrl: fake.baseUrl, model: 'fixture', apiKey: 'fake', contextWindow: 4096, reasoningEffort: 'high' }))
    const reasoning: ResolvedReasoning[] = []
    const session = await host.createSession({ cwd: tmp.dir, systemPrompt: '简答', tools: [], onReasoning: value => reasoning.push(value) })
    try {
      await session.prompt('测试')
      expect(session.messages.at(-1)).not.toHaveProperty('errorMessage')
      expect(session.getLastAssistantText()).toBe('好')
      const body = fake.wireRequests[0]!.body
      if (protocol === 'openai-responses') expect(body.reasoning).toMatchObject({ effort: 'high' })
      else {
        expect(body.thinking).toMatchObject({ type: 'enabled' })
        expect(body.thinking!.budget_tokens).toBeLessThan(body.max_tokens!)
        expect(body.thinking!.budget_tokens).toBeGreaterThanOrEqual(1024)
      }
      expect(reasoning.at(-1)?.parameters).toBeDefined()
    } finally { session.dispose() }
  })

  it('后台技能与压缩沿所选协议运行，重启后配置保持', async () => {
    const fake = await startProtocolLlm(protocol); cleanups.push(() => fake.close())
    const app = await testApp(); cleanups.push(() => app.close())
    await app.call('settings:set', { ...modelSettings({ protocol, baseUrl: fake.baseUrl, model: 'fixture', apiKey: 'fake', contextWindow: 32768 }, app.core.settings.get()) })
    fake.setResponder(() => JSON.stringify({ value: '后台已完成' }))
    const task = await app.core.executor.prepare('daily')
    expect(await task.run('虚构材料', z.object({ value: z.string() }), '{"value":"结果"}')).toEqual({ value: '后台已完成' })
    const summary = '用户要求基于当前文件连续核对，保留材料来源与未完成事项，下轮继续讨论明确步骤。'
    fake.setResponder(agentScript([() => '已记录要求'], req => isCompactionRequest(req) ? summary : '好'))
    const id = app.core.agent.create().conversationId
    for (let index = 0; index < 6; index++) {
      const { runId } = await app.call('agent:send', { conversationId: id, text: '第' + index + '轮，' + '方案细节'.repeat(240) })
      await app.core.agent.wait(runId)
      expect(app.core.agent.get(id).messages.at(-1)?.error).toBeUndefined()
    }
    await expect.poll(() => app.core.state.raw.prepare('SELECT summary FROM conversation_summaries WHERE conversation_id=?').get(id), { timeout: 5000 }).toMatchObject({ summary })
    expect(fake.requests.some(isCompactionRequest)).toBe(true)
    await app.reopen()
    expect(app.core.settings.getModelConfig()!.protocol).toBe(protocol)
    expect(app.core.agent.get(id).messages).toHaveLength(12)
  })

  it('接口拒绝推理参数保留失败，不切协议或降档重试', async () => {
    const fake = await startProtocolLlm(protocol, () => ({ status: 400, body: JSON.stringify({ error: { type: 'invalid_request_error', message: 'unsupported thinking reasoning effort' } }) }))
    cleanups.push(() => fake.close())
    const tmp = makeTmpDir('protocol-error'); cleanups.push(tmp.cleanup)
    const host = new PiHost(path.join(tmp.dir, 'pi'), () => ({ protocol, baseUrl: fake.baseUrl, model: 'fixture', apiKey: 'fake', reasoningEffort: 'high' }))
    const session = await host.createSession({ cwd: tmp.dir, systemPrompt: '简答', tools: [] })
    try { await session.prompt('测试'); expect(session.messages.at(-1)).toMatchObject({ stopReason: 'error' }); expect(fake.requests).toHaveLength(1) }
    finally { session.dispose() }
  })

  it('官方模型资料映射原生推理档位，模型默认保持无显式强度', async () => {
    const fake = await startProtocolLlm(protocol); cleanups.push(() => fake.close())
    const tmp = makeTmpDir('protocol-known'); cleanups.push(tmp.cleanup)
    const config = protocol === 'openai-responses'
      ? { protocol, baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.4', apiKey: 'fake' }
      : { protocol, baseUrl: 'https://api.anthropic.com', model: 'claude-opus-4-6', apiKey: 'fake' }
    const host = new PiHost(path.join(tmp.dir, 'pi'), () => config)
    for (const effort of ['auto', 'high'] as const) {
      const recorded: ResolvedReasoning[] = []
      const session = await host.createSession({ cwd: tmp.dir, systemPrompt: '简答', tools: [], reasoningEffort: effort, onReasoning: value => recorded.push(value) })
      session.model!.baseUrl = protocol === 'anthropic-messages' ? fake.baseUrl.replace(/\/v1$/, '') : fake.baseUrl
      try {
        await session.prompt('测试')
        expect(session.messages.at(-1)).not.toHaveProperty('errorMessage')
        const body = fake.wireRequests.at(-1)!.body
        if (effort === 'auto') {
          expect(body.thinking).toBeUndefined(); expect(body.reasoning).toBeUndefined(); expect(body.output_config).toBeUndefined()
        } else if (protocol === 'openai-responses') expect(body.reasoning).toMatchObject({ effort: 'high' })
        else expect(body).toMatchObject({ thinking: { type: 'adaptive' }, output_config: { effort: 'high' } })
        expect(recorded.at(-1)?.availability).toBe('known')
      } finally { session.dispose() }
    }
  })
})

it('Responses 工具和 Anthropic 独立系统正文超限均阻止发送，长历史定向缩减', () => {
  const limits = { contextWindow: 4096, maxOutputTokens: 1024, compactionThreshold: 0.7 as const, source: 'custom' as const }
  const responses = { input: [{ role: 'user', content: [{ type: 'input_text', text: '当前请求' }] }, { type: 'function_call_output', call_id: 'a', output: '材料'.repeat(2000) }] }
  expect(fitModelRequest(responses, [], limits, 'fixture').error).toContain('工具返回')
  expect(fitModelRequest({ messages: [{ role: 'user', content: '问题' }], system: [{ type: 'text', text: '系统材料'.repeat(2000) }] }, [], limits, 'fixture').budget.blocked).toBe(true)
  const result = fitModelRequest({ input: responses.input.slice(0, 1), instructions: '按范围回答' }, Array.from({ length: 8 }, (_, index) => '第' + index + '轮' + '历史'.repeat(250)), limits, 'fixture')
  expect(result.budget.omittedHistoryTurns).toBeGreaterThan(0)
  expect(JSON.stringify(result.payload.input)).toContain('第7轮')
  expect(JSON.stringify(result.payload.input)).not.toContain('第0轮')
  expect(result.payload).not.toHaveProperty('messages')
})

it('协议身份隔离可信模型映射，Anthropic 原生参数与地址规则可核对', () => {
  const config = { protocol: 'anthropic-messages' as const, baseUrl: 'https://api.anthropic.com', model: 'fixture' }
  const catalog = [{ id: 'fixture', baseUrl: config.baseUrl, api: config.protocol, reasoning: true, thinkingLevelMap: { off: null, xhigh: 'xhigh', max: 'max' } }]
  expect(resolveReasoning(config, catalog).supported).toContain('max')
  expect(resolveReasoning({ ...config, protocol: 'openai-responses' }, catalog).availability).toBe('unverified')
  expect(protocolBaseUrl({ ...config, baseUrl: 'https://proxy.example/anthropic/v1/' })).toBe('https://proxy.example/anthropic')
  expect(cleanReasoningPayload({ thinking: { type: 'disabled' }, output_config: { effort: 'low', format: 'preserve' } })).toEqual({ output_config: { format: 'preserve' } })
})
