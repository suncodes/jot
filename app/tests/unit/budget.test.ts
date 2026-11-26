import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../../shared/types'
import { conversationHistory, estimateInputTokens, fitModelRequest, resolveModelLimits } from '../../electron/agent/budget'

const config = { model: 'example', baseUrl: 'https://models.example/v1' }
const catalog = [{ id: 'example', baseUrl: config.baseUrl, contextWindow: 131072, maxTokens: 16384 }]
const payload = { messages: [{ role: 'system', content: '系统说明' }, { role: 'user', content: '当前问题' }], tools: [{ function: { name: 'read', parameters: { path: 'string' } } }] }

describe('模型窗口及输入预算', () => {
  it('同来源精确模型采用资料，未知或代理别名使用保守默认，手动覆盖优先', () => {
    expect(resolveModelLimits(config, catalog)).toEqual({ contextWindow: 131072, maxOutputTokens: 8192, source: 'catalog', compactionThreshold: 0.7 })
    expect(resolveModelLimits({ ...config, baseUrl: 'https://proxy.example/v1' }, catalog)).toEqual({ contextWindow: 32768, maxOutputTokens: 4096, source: 'default', compactionThreshold: 0.7 })
    expect(resolveModelLimits({ ...config, model: 'alias' }, catalog).source).toBe('default')
    expect(resolveModelLimits({ ...config, contextWindow: 8192, compactionThreshold: 0.8 }, catalog)).toEqual({ contextWindow: 8192, maxOutputTokens: 2048, source: 'custom', compactionThreshold: 0.8 })
    expect(resolveModelLimits({ ...config, contextWindow: 4096 }, catalog).maxOutputTokens).toBe(1024)
    expect(resolveModelLimits({ ...config, compactionThreshold: 0.6 }, catalog)).toMatchObject({ contextWindow: 131072, maxOutputTokens: 8192, compactionThreshold: 0.6, source: 'catalog' })
  })

  it('中文、工具定义、调用参数和返回值都计入，增加内容增加估算量', () => {
    const baseline = estimateInputTokens(payload.messages)
    expect(estimateInputTokens(payload.messages, payload.tools)).toBeGreaterThan(baseline)
    expect(estimateInputTokens([{ role: 'user', content: '中'.repeat(1000) }])).toBeGreaterThan(2000)
    expect(estimateInputTokens([{ role: 'user', content: 'a'.repeat(1000) }])).toBeLessThan(1000)
    const toolMessages = [...payload.messages, { role: 'assistant', tool_calls: [{ id: 'call', function: { name: 'read', arguments: '{"path":"content/工作/规则.md"}' } }] }, { role: 'tool', tool_call_id: 'call', content: '工具返回'.repeat(1000) }]
    expect(estimateInputTokens(toolMessages, payload.tools)).toBeGreaterThan(baseline + 3000)
  })

  it('预算足够时全部保留，超过十二条和两千字的历史不再固定截断', () => {
    const history = Array.from({ length: 15 }, (_, i) => '用户：第' + i + '问\n助手：' + '内容'.repeat(1100) + '末尾保留')
    const result = fitModelRequest(payload, history, { contextWindow: 131072, maxOutputTokens: 1024, source: 'custom', compactionThreshold: 0.7 }, 'large')
    expect(result.error).toBeUndefined()
    expect(result.budget.omittedHistoryTurns).toBe(0)
    expect(JSON.stringify(result.payload)).toContain('第0问')
    expect(JSON.stringify(result.payload)).toContain('第14问')
    expect(JSON.stringify(result.payload)).toContain('末尾保留')
  })

  it('小窗口只保留最近完整问答，工具续跑增大后继续缩减，不改原 payload 和记录', () => {
    const history = Array.from({ length: 8 }, (_, i) => '第' + i + '轮：' + '历史'.repeat(180))
    const limits = { contextWindow: 4096, maxOutputTokens: 512, source: 'custom' as const, compactionThreshold: 0.7 as const }
    const before = JSON.stringify(payload)
    const first = fitModelRequest(payload, history, limits, 'small')
    expect(first.budget.omittedHistoryTurns).toBeGreaterThan(0)
    expect(first.budget.inputTokens).toBeLessThanOrEqual(first.budget.inputBudget)
    expect(JSON.stringify(first.payload)).not.toContain('第0轮：')
    expect(JSON.stringify(first.payload)).toContain('第7轮：')
    const next = fitModelRequest({ ...payload, messages: [...payload.messages, { role: 'tool', content: '当前材料'.repeat(200) }] }, history, limits, 'small')
    expect(next.budget.omittedHistoryTurns).toBeGreaterThan(first.budget.omittedHistoryTurns)
    expect(next.error).toBeUndefined()
    expect(JSON.stringify(payload)).toBe(before)
    expect(history).toHaveLength(8)
  })

  it('本轮必要内容过大时明确失败，不截断问题或工具正文，并保留真实调用关系', () => {
    const messages = [...payload.messages, { role: 'assistant', tool_calls: [{ id: 'a', function: { name: 'read', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 'a', content: '大材料'.repeat(2000) }]
    const result = fitModelRequest({ ...payload, messages }, [], { contextWindow: 4096, maxOutputTokens: 512, source: 'custom', compactionThreshold: 0.7 }, 'small')
    expect(result.budget.blocked).toBe(true)
    expect(result.error).toContain('工具返回或累计材料')
    expect(result.error).toContain('分段读取')
    expect(result.payload.messages).toEqual(messages)
  })

  it('严格材料历史只承接用户问题，不重新带入旧助手文件事实和工具正文', () => {
    const messages = [
      { role: 'user', text: '只看选中的文件', toolCalls: [] },
      { role: 'assistant', text: '旧回答中的事实', toolCalls: [{ output: '旧工具正文' }] },
      { role: 'user', text: '继续比较', toolCalls: [] },
    ] as unknown as ChatMessage[]
    expect(conversationHistory(messages, true)).toEqual(['用户：只看选中的文件', '用户：继续比较'])
    const normal = conversationHistory(messages, false).join('\n')
    expect(normal).toContain('旧回答中的事实')
    expect(normal).not.toContain('旧工具正文')
  })
})
