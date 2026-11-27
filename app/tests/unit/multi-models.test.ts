import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { ModelCatalogInput } from '../../shared/models'
import { agentScript, chunkIds, isCompactionRequest } from '../helpers/fake-llm'
import { startProtocolLlm, type ProtocolLlm } from '../helpers/fake-protocols'
import { deferred, testApp } from '../helpers/test-app'

let app: Awaited<ReturnType<typeof testApp>>, responses: ProtocolLlm, anthropic: ProtocolLlm
function catalog(): ModelCatalogInput {
  return { defaultModelId: 'chat', channels: [
    { id: 'channel-chat', name: '默认渠道', protocol: 'openai-completions', baseUrl: app.fake.baseUrl, apiKey: 'chat-key', models: [{ id: 'chat', name: '默认模型', model: 'same-name', reasoningEffort: 'auto', contextWindow: 32768 }] },
    { id: 'channel-responses', name: 'Responses渠道', protocol: 'openai-responses', baseUrl: responses.baseUrl, apiKey: 'responses-key', models: [{ id: 'responses', name: '推理模型', model: 'same-name', reasoningEffort: 'auto', contextWindow: 32768 }] },
    { id: 'channel-anthropic', name: 'Anthropic渠道', protocol: 'anthropic-messages', baseUrl: anthropic.baseUrl, apiKey: 'anthropic-key', models: [{ id: 'anthropic', name: '写作模型', model: 'same-name', reasoningEffort: 'auto', contextWindow: 32768 }] },
  ] }
}
async function send(id: string, text: string) {
  const run = await app.call('agent:send', { conversationId: id, text })
  await app.core.agent.wait(run.runId)
  return app.core.agent.get(id).messages.at(-1)!
}
beforeEach(async () => {
  app = await testApp()
  responses = await startProtocolLlm('openai-responses')
  anthropic = await startProtocolLlm('anthropic-messages')
  await app.call('settings:set', { models: catalog() })
})
afterEach(async () => { await app.close(); await responses.close(); await anthropic.close() })
describe('会话按渠道与模型独立路由', () => {
  it('三协议切换保留历史、材料与实际模型快照，恢复后仍保持选择', async () => {
    app.fake.setResponder(() => '第一轮已记录')
    responses.setResponder(() => '第二轮已记录')
    anthropic.setResponder(() => '第三轮已记录')
    const id = app.core.agent.create().conversationId
    expect((await send(id, '第一轮目标')).error).toBeUndefined()
    await app.call('agent:setModel', { conversationId: id, modelId: 'responses' })
    await app.call('agent:setReasoning', { conversationId: id, effort: 'high' })
    expect((await send(id, '第二轮接着做')).error).toBeUndefined()
    expect(responses.wireRequests.at(-1)?.body.reasoning).toMatchObject({ effort: 'high' })
    expect(JSON.stringify(responses.requests.at(-1)?.messages)).toContain('第一轮目标')
    await app.call('agent:setModel', { conversationId: id, modelId: 'anthropic' })
    expect(app.core.agent.get(id).context?.reasoningEffort).toBeUndefined()
    expect((await send(id, '第三轮继续')).error).toBeUndefined()
    expect(JSON.stringify(anthropic.requests.at(-1)?.messages)).toContain('第二轮接着做')
    const data = app.core.agent.get(id)
    expect(data.messages.filter(message => message.role === 'assistant').map(message => message.context?.modelUse?.channelName)).toEqual(['默认渠道', 'Responses渠道', 'Anthropic渠道'])
    await app.reopen()
    expect(app.core.agent.get(id).context?.modelId).toBe('anthropic')
    expect(app.core.agent.get(id).messages).toHaveLength(6)
    expect(responses.wireRequests[0]?.headers.authorization).toBe('Bearer responses-key')
    expect(anthropic.wireRequests[0]?.headers['x-api-key']).toBe('anthropic-key')
  })
  it('独立会话不互相覆盖，后台任务使用全局默认，跟随的会话从下一轮切换', async () => {
    app.fake.setResponder(() => '{"value":"默认后台"}')
    const explicit = app.core.agent.create().conversationId, follow = app.core.agent.create().conversationId
    await app.call('agent:setModel', { conversationId: explicit, modelId: 'responses' })
    expect((await send(explicit, '独立模型')).context?.modelUse?.id).toBe('responses')
    const task = await app.core.executor.prepare('daily')
    expect(await task.run('虚构材料', z.object({ value: z.string() }), '{"value":"结果"}')).toEqual({ value: '默认后台' })
    const changed = catalog(); changed.defaultModelId = 'anthropic'
    await app.call('settings:set', { models: changed })
    expect((await send(follow, '跟随新默认')).context?.modelUse?.id).toBe('anthropic')
    expect((await send(explicit, '仍使用显式模型')).context?.modelUse?.id).toBe('responses')
    expect(app.core.agent.get(explicit).context?.modelId).toBe('responses')
    expect(app.core.agent.get(follow).context?.modelId).toBeUndefined()
  })
  it('在途工具续跑固定配置，修改其他渠道和默认均不打断，生成中拒绝切换', async () => {
    const entered = deferred(), release = deferred()
    app.write('content/工作/核对.md', ['# 核对', '真实虚构材料'].join(String.fromCharCode(10)))
    await app.core.syncIndex()
    responses.setResponder(agentScript([
      async () => { entered.release(); await release.promise; return { toolCall: { name: 'read', arguments: { path: 'content/工作/核对.md' } } } },
      results => '核对完毕[^' + chunkIds(results[0]!)[0] + ']。',
    ]))
    const id = app.core.agent.create().conversationId
    await app.call('agent:setModel', { conversationId: id, modelId: 'responses' })
    const run = app.core.agent.send(id, '请读取核对文档')
    try {
      await entered.promise
      await expect(app.call('agent:setModel', { conversationId: id, modelId: 'anthropic' })).rejects.toThrow('请先停止')
      const changed = catalog(); changed.defaultModelId = 'anthropic'; changed.channels[1]!.apiKey = 'changed-key'
      await app.call('settings:set', { models: changed })
    } finally { release.release() }
    await app.core.agent.wait(run.runId)
    expect(app.core.agent.get(id).messages.at(-1)?.error).toBeUndefined()
    expect(responses.wireRequests.map(request => request.headers.authorization)).toEqual(['Bearer responses-key', 'Bearer responses-key'])
    expect(app.core.agent.get(id).messages.at(-1)?.citations?.[0]?.valid).toBe(true)
  })
  it('删除显式模型后不静默回退，选回默认后可继续且历史保留', async () => {
    const id = app.core.agent.create().conversationId
    await app.call('agent:setModel', { conversationId: id, modelId: 'responses' })
    await send(id, '已有历史')
    const changed = catalog(); changed.channels = changed.channels.filter(channel => channel.id !== 'channel-responses')
    await app.call('settings:set', { models: changed })
    const count = app.fake.requests.length
    expect((await send(id, '不会自动换渠道')).error).toContain('重新选择')
    expect(app.fake.requests).toHaveLength(count)
    await app.call('agent:setModel', { conversationId: id, modelId: null })
    app.fake.setResponder(() => '继续')
    expect((await send(id, '明确回到默认')).error).toBeUndefined()
    expect(app.core.agent.get(id).messages).toHaveLength(6)
  })
  it('未设全局默认也可显式选择模型，重试旧问题采用当前选择', async () => {
    const settings = catalog(); settings.defaultModelId = null
    await app.call('settings:set', { models: settings })
    const id = app.core.agent.create().conversationId
    await app.call('agent:setModel', { conversationId: id, modelId: 'responses' })
    expect((await send(id, '原问题')).context?.modelUse?.id).toBe('responses')
    const question = app.core.agent.get(id).messages[0]!
    await app.call('agent:setModel', { conversationId: id, modelId: 'anthropic' })
    const retry = await app.call('agent:send', { conversationId: id, text: '忽略', retryMessageId: question.messageId })
    await app.core.agent.wait(retry.runId)
    expect(app.core.agent.get(id).messages.at(-1)?.context?.modelUse?.id).toBe('anthropic')
    await expect(app.core.executor.prepare('daily')).rejects.toMatchObject({ code: 'LLM_NOT_CONFIGURED' })
    expect(app.fake.requests).toHaveLength(0)
  })
  it('对话压缩使用该会话模型，默认模型只承担独立任务', async () => {
    const summary = '保留用户目标、当前限制、已确认决定及尚未解决的工作，后续根据当前资料继续核对。'
    responses.setResponder(request => isCompactionRequest(request) ? summary : '已记录')
    const id = app.core.agent.create().conversationId
    await app.call('agent:setModel', { conversationId: id, modelId: 'responses' })
    for (let index = 0; index < 6; index++) expect((await send(id, '第' + index + '轮' + '方案细节'.repeat(240))).error).toBeUndefined()
    await expect.poll(() => app.core.state.raw.prepare('SELECT summary FROM conversation_summaries WHERE conversation_id=?').get(id), { timeout: 5000 }).toMatchObject({ summary })
    expect(responses.requests.some(isCompactionRequest)).toBe(true)
    expect(app.fake.requests).toHaveLength(0)
  })
})
