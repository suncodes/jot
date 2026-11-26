import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import path from 'node:path'
import { Type } from 'typebox'
import { cleanReasoningPayload, reasoningFailure, resolveReasoning, trustedModel } from '../../electron/agent/reasoning'
import { resolveModelLimits } from '../../electron/agent/budget'
import { loadPi, PiHost } from '../../electron/agent/pi'
import type { ResolvedReasoning } from '../../shared/reasoning'
import { startFakeLlm, type FakeLlm } from '../helpers/fake-llm'
import { makeTmpDir } from '../helpers/tmp'

const config = { baseUrl: 'https://api.openai.com/v1', model: 'gpt-5', reasoningEffort: 'high' as const }
const catalog = [{ ...config, id: 'gpt-5', api: 'openai-responses', reasoning: true, thinkingLevelMap: { off: null, minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: null, max: null } }]
let fake: FakeLlm, tmp: ReturnType<typeof makeTmpDir>
beforeAll(async () => { fake = await startFakeLlm(); tmp = makeTmpDir('reasoning') })
afterAll(async () => { await fake.close(); tmp.cleanup() })

describe('U4 推理强度解析与最终请求', () => {
  it('只信任同来源精确模型和可映射协议，代理只提供四个可验证档位', () => {
    expect(resolveReasoning(config, catalog)).toMatchObject({ requested: 'high', source: 'global', supported: ['auto', 'minimal', 'low', 'medium', 'high'], availability: 'known' })
    expect(resolveReasoning(config, catalog, 'auto')).toMatchObject({ requested: 'auto', source: 'conversation' })
    expect(resolveReasoning(config, catalog, undefined, true)).toMatchObject({ requested: 'low', source: 'internal' })
    const proxy = { ...config, baseUrl: fake.baseUrl }
    expect(resolveReasoning(proxy, catalog)).toMatchObject({ supported: ['auto', 'low', 'medium', 'high'], availability: 'unverified' })
    expect(() => resolveReasoning(proxy, catalog, 'off')).toThrow('没有声明支持')
    expect(trustedModel(config, [{ ...catalog[0]!, api: 'anthropic-messages' }])).toBeUndefined()
    expect(resolveReasoning({ ...config, model: 'plain' }, [{ ...catalog[0]!, id: 'plain', reasoning: false }], 'auto').supported).toEqual(['auto'])
  })

  it('模型默认清除强度和开关，不删除无关模板参数，原对象不变', () => {
    const original = { messages: [], reasoning_effort: 'none', thinking: { type: 'disabled' }, enable_thinking: false,
      reasoning: { effort: 'low' }, chat_template_kwargs: { enable_thinking: false, custom: 'keep' }, chat_template_args: { thinking: true } }
    expect(cleanReasoningPayload(original)).toEqual({ messages: [], chat_template_kwargs: { custom: 'keep' } })
    expect(original.reasoning_effort).toBe('none')
  })

  it('明确参数拒绝才报告强度不支持，普通400、额度和网络错误保持原错误', () => {
    expect(reasoningFailure('400 unsupported parameter reasoning_effort', 'high').code).toBe('LLM_REASONING_UNSUPPORTED')
    for (const message of ['400 context length exceeded', '401 invalid api key', '429 quota exceeded', 'fetch failed', '500 reasoning_effort service unavailable'])
      expect(reasoningFailure(message, 'high').code).toBe('LLM_UNAVAILABLE')
    expect(reasoningFailure('400 unsupported reasoning_effort', 'auto').code).toBe('LLM_UNAVAILABLE')
  })

  it('高强度自动增加输出预留，尊重可信限制和窗口，不需要最大输出设置', () => {
    expect(resolveModelLimits({ baseUrl: fake.baseUrl, model: 'proxy', reasoningEffort: 'high', contextWindow: 131072 }, []).maxOutputTokens).toBe(32768)
    expect(resolveModelLimits({ ...config, contextWindow: 131072 }, [{ ...catalog[0]!, contextWindow: 131072, maxTokens: 20000 }]).maxOutputTokens).toBe(20000)
    const small = resolveModelLimits({ ...config, contextWindow: 4096 }, [])
    expect(small.maxOutputTokens).toBeLessThan(4096)
    expect(small.maxOutputTokens).toBeGreaterThan(1024)
  })

  it('全局high、对话low及显式auto实际发送，内部压缩独立且没有档位探测', async () => {
    const host = new PiHost(path.join(tmp.dir, 'choices'), () => ({ baseUrl: fake.baseUrl, apiKey: 'fake', model: 'proxy', reasoningEffort: 'high' }))
    const choices = [{}, { reasoningEffort: 'low' as const }, { reasoningEffort: 'auto' as const }, { internalReasoning: true }]
    const start = fake.requests.length
    fake.setResponder(() => '完成')
    for (const [i, choice] of choices.entries()) {
      const recorded: ResolvedReasoning[] = []
      const session = await host.createSession({ cwd: tmp.dir, systemPrompt: '简答', tools: [], ...choice, onReasoning: value => recorded.push(value) })
      try {
        expect(fake.requests.length).toBe(start + i)
        await session.prompt('测试')
        const request = fake.requests.at(-1)!
        if (i < 2) {
          expect(request.reasoning_effort).toBe(i === 0 ? 'high' : 'low')
          expect(recorded.at(-1)?.parameters).toEqual({ reasoning_effort: request.reasoning_effort })
        } else {
          for (const key of ['reasoning_effort', 'reasoning', 'thinking', 'enable_thinking', 'chat_template_kwargs'])
            expect(request).not.toHaveProperty(key)
          expect(recorded.at(-1)?.parameters).toBeUndefined()
        }
        expect(recorded.at(-1)?.reported).toBeUndefined()
      } finally { session.dispose() }
    }
    expect(fake.requests.length - start).toBe(4)
  })

  it('可信映射off发送none，xhigh保持原档，不被SDK静默降档', async () => {
    const host = new PiHost(path.join(tmp.dir, 'known'), () => ({ baseUrl: config.baseUrl, apiKey: 'fake', model: 'gpt-5.4' }))
    fake.setResponder(() => '完成')
    for (const effort of ['off', 'xhigh'] as const) {
      const session = await host.createSession({ cwd: tmp.dir, systemPrompt: '测试', tools: [], reasoningEffort: effort })
      // 保持真实SDK资料和映射，仅将本测试的传输目的地址切换为本地假接口。
      session.model!.baseUrl = fake.baseUrl
      try {
        await session.prompt('测试')
        expect(fake.requests.at(-1)?.reasoning_effort).toBe(effort === 'off' ? 'none' : 'xhigh')
      } finally { session.dispose() }
    }
  })

  it('可信Chat Completions适配发送原生开关与档位，记录全部实际参数', async () => {
    const host = new PiHost(path.join(tmp.dir, 'deepseek'), () => ({ baseUrl: 'https://api.deepseek.com', apiKey: 'fake', model: 'deepseek-flash' }))
    expect((await host.reasoningOptions({ baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash' })).supported).toContain('max')
    fake.setResponder(() => '完成')
    for (const effort of ['auto', 'max'] as const) {
      const recorded: ResolvedReasoning[] = []
      const session = await host.createSession({ cwd: tmp.dir, systemPrompt: '测试', tools: [], reasoningEffort: effort, onReasoning: value => recorded.push(value) })
      session.model!.baseUrl = fake.baseUrl
      try {
        await session.prompt('测试')
        const request = fake.requests.at(-1)!
        if (effort === 'auto') {
          expect(request).not.toHaveProperty('thinking')
          expect(request).not.toHaveProperty('reasoning_effort')
        } else {
          expect(request.thinking).toEqual({ type: 'enabled' })
          expect(request.reasoning_effort).toBe('max')
          expect(recorded.at(-1)?.parameters).toEqual({ reasoning_effort: 'max', thinking: { type: 'enabled' } })
        }
      } finally { session.dispose() }
    }
  })

  it('工具续跑固定启动档位，即使中途全局设置改变', async () => {
    let effort: 'high' | 'low' = 'high'
    const host = new PiHost(path.join(tmp.dir, 'tools'), () => ({ baseUrl: fake.baseUrl, apiKey: 'fake', model: 'proxy', reasoningEffort: effort }))
    const pi = await loadPi(), start = fake.requests.length
    const tool = pi.defineTool({ name: 'check', label: '核对', description: '返回测试事实', parameters: Type.Object({}),
      async execute() { effort = 'low'; return { content: [{ type: 'text', text: '事实' }], details: undefined } } })
    fake.setResponder((_req, i) => i === start ? { toolCall: { name: 'check', arguments: {} } } : '完成')
    const session = await host.createSession({ cwd: tmp.dir, systemPrompt: '测试', tools: [tool] })
    try {
      await session.prompt('测试工具')
      expect(fake.requests.slice(start).map(req => req.reasoning_effort)).toEqual(['high', 'high'])
    } finally { session.dispose() }
  })

  it('接口拒绝档位只发一次，不降档或移除参数重试', async () => {
    const host = new PiHost(path.join(tmp.dir, 'reject'), () => ({ baseUrl: fake.baseUrl, apiKey: 'fake', model: 'proxy', reasoningEffort: 'high' }))
    fake.setResponder(() => ({ status: 400, body: '{"error":{"message":"unsupported reasoning_effort high"}}' }))
    const start = fake.requests.length
    const session = await host.createSession({ cwd: tmp.dir, systemPrompt: '测试', tools: [] })
    try {
      await session.prompt('测试拒绝')
      expect(fake.requests.length - start).toBe(1)
      expect(session.messages.at(-1)).toMatchObject({ stopReason: 'error', errorMessage: expect.stringContaining('reasoning_effort') })
    } finally { session.dispose() }
  })
})