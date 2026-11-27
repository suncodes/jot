import { afterEach, describe, expect, it, vi } from 'vitest'
import { discoverModels } from '../../electron/llm/model-discovery'
import { MODEL_PROTOCOLS } from '../../shared/model-protocol'
import { startModelList } from '../helpers/fake-models'
import { testApp } from '../helpers/test-app'

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const close of cleanups.splice(0).reverse()) await close()
})
async function listing(responder: Parameters<typeof startModelList>[0]) {
  const server = await startModelList(responder)
  cleanups.push(() => server.close())
  return server
}
const openai = { protocol: 'openai-completions' as const }

describe('模型列表发现', () => {
  it.each(MODEL_PROTOCOLS)('%s 使用协议地址和鉴权，不发送模型生成请求', async protocol => {
    const server = await listing(() => ({ body: { data: [{ id: 'model-z' }, { id: 'model-a', display_name: '模型 A' }] } }))
    const result = await discoverModels({ protocol, baseUrl: server.baseUrl + '/', apiKey: 'fixture-secret' })
    expect(result).toEqual({ models: [{ id: 'model-a', name: '模型 A' }, { id: 'model-z', name: 'model-z' }], truncated: false })
    const request = server.requests[0]!, url = new URL(request.url, server.baseUrl)
    expect(url.pathname).toBe('/v1/models')
    if (protocol === 'anthropic-messages') {
      expect(request.headers['x-api-key']).toBe('fixture-secret')
      expect(request.headers['anthropic-version']).toBe('2023-06-01')
      expect(request.headers.authorization).toBeUndefined()
      expect(url.searchParams.get('limit')).toBe('100')
    } else {
      expect(request.headers.authorization).toBe('Bearer fixture-secret')
      expect(request.headers['x-api-key']).toBeUndefined()
    }
    expect(server.requests).toHaveLength(1)
  })

  it('Anthropic 基础地址不带 /v1 也只拼接一次；自定义前缀保留', async () => {
    const server = await listing(() => ({ body: { data: [] } }))
    const root = server.baseUrl.replace(/\/v1$/, '')
    await discoverModels({ protocol: 'anthropic-messages', baseUrl: root })
    await discoverModels({ protocol: 'anthropic-messages', baseUrl: root + '/proxy/v1' })
    expect(server.requests.map(request => new URL(request.url, root).pathname)).toEqual(['/v1/models', '/proxy/v1/models'])
    expect(server.requests[0]!.headers['x-api-key']).toBeUndefined()
  })

  it.each(MODEL_PROTOCOLS)('%s 跟随分页、按 ID 去重且保留服务模型标识', async protocol => {
    const cursorName = protocol === 'anthropic-messages' ? 'after_id' : 'after'
    const server = await listing((_request, index) => ({ body: index === 0
      ? { data: [{ id: 'vendor/model-a', name: '模型 A' }, { id: 'model-b' }], has_more: true, last_id: 'page-one' }
      : { data: [{ id: 'model-b' }, { id: 'model-c' }], has_more: false } }))
    const result = await discoverModels({ protocol, baseUrl: server.baseUrl })
    expect(result.models.map(model => model.id)).toEqual(['model-b', 'model-c', 'vendor/model-a'])
    expect(new URL(server.requests[1]!.url, server.baseUrl).searchParams.get(cursorName)).toBe('page-one')
    expect(server.requests).toHaveLength(2)
    expect(result.truncated).toBe(false)
  })

  it('没有 last_id 时使用最后一个模型作为游标', async () => {
    const server = await listing((_request, index) => ({ body: { data: [{ id: index ? 'second' : 'first' }], has_more: index === 0 } }))
    expect((await discoverModels({ ...openai, baseUrl: server.baseUrl })).models).toHaveLength(2)
    expect(new URL(server.requests[1]!.url, server.baseUrl).searchParams.get('after')).toBe('first')
  })

  it.each([401, 403, 404, 405, 429, 500])('HTTP %i 返回可理解错误，不泄露服务正文或密钥、不自动换接口重试', async status => {
    const server = await listing(() => ({ status, body: 'fixture-private-upstream-details' }))
    const error = await discoverModels({ ...openai, baseUrl: server.baseUrl, apiKey: 'fixture-secret' }).catch(error => error)
    expect(error).toMatchObject({ code: 'LLM_UNAVAILABLE' })
    expect(error.message).toContain('HTTP ' + status)
    expect(error.message).not.toMatch(/fixture-private|fixture-secret/)
    expect(server.requests).toHaveLength(1)
  })

  it.each([
    { headers: { 'content-type': 'text/html' }, body: '<html>not a models API</html>' },
    { body: '{broken json' },
    { body: { models: ['unsupported'] } },
    { body: null },
    { body: { data: [{ id: '' }] } },
    { body: { data: [{ id: 42 }] } },
  ])('非 JSON 或不支持的列表格式不进入配置', async reply => {
    const server = await listing(() => reply)
    await expect(discoverModels({ ...openai, baseUrl: server.baseUrl })).rejects.toMatchObject({ code: 'LLM_BAD_OUTPUT' })
  })

  it('未声明 JSON Content-Type 的合法列表仍可获取', async () => {
    const server = await listing(() => ({ headers: {}, body: { data: [{ id: 'proxy-model' }] } }))
    expect((await discoverModels({ ...openai, baseUrl: server.baseUrl })).models).toEqual([{ id: 'proxy-model', name: 'proxy-model' }])
  })

  it.each([
    { data: [{ id: 'same' }], has_more: true, last_id: 'same-cursor' },
    { data: [], has_more: true },
  ])('重复或缺失分页游标明确失败，不留下不完整候选', async body => {
    const server = await listing(() => ({ body }))
    await expect(discoverModels({ ...openai, baseUrl: server.baseUrl })).rejects.toMatchObject({ code: 'LLM_BAD_OUTPUT', message: expect.stringContaining('分页') })
    expect(server.requests.length).toBeLessThanOrEqual(2)
  })

  it('模型数和页数达到上限时返回截断标记', async () => {
    const server = await listing(() => ({ body: { data: Array.from({ length: 10001 }, (_, index) => ({ id: 'model-' + index })) } }))
    const large = await discoverModels({ ...openai, baseUrl: server.baseUrl })
    expect(large.truncated).toBe(true)
    expect(large.models).toHaveLength(10000)
    server.setResponder((_request, index) => ({ body: { data: [{ id: 'page-' + index }], has_more: true } }))
    const result = await discoverModels({ ...openai, baseUrl: server.baseUrl })
    expect(result.models).toHaveLength(100)
    expect(result.truncated).toBe(true)
  })

  it('不跟随 HTTP 重定向，不将渠道凭证发送到跳转目标', async () => {
    const target = await listing(() => ({ body: { data: [] } }))
    const server = await listing(() => ({ status: 302, headers: { location: target.baseUrl + '/models' }, body: '' }))
    await expect(discoverModels({ ...openai, baseUrl: server.baseUrl, apiKey: 'fixture-secret' })).rejects.toMatchObject({ code: 'LLM_UNAVAILABLE' })
    expect(server.requests).toHaveLength(1)
    expect(target.requests).toHaveLength(0)
  })

  it('超时返回明确提示，正文解析超时也保持同一语义', async () => {
    const server = await listing(() => ({ body: { data: [] } }))
    const signal = AbortSignal.abort()
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(signal)
    await expect(discoverModels({ ...openai, baseUrl: server.baseUrl })).rejects.toMatchObject({ code: 'LLM_UNAVAILABLE', message: expect.stringContaining('超时') })
    const response = new Response(null, { status: 200 })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response)
    vi.spyOn(response, 'json').mockRejectedValue(new Error('aborted body'))
    await expect(discoverModels({ ...openai, baseUrl: server.baseUrl })).rejects.toMatchObject({ code: 'LLM_UNAVAILABLE', message: expect.stringContaining('超时') })
  })

  it('无效基础地址在联网前拒绝', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    for (const baseUrl of ['file:///D:/notes', 'https://name:password@example.invalid/v1', 'https://example.invalid/v1?key=secret', 'bad-url']) {
      await expect(discoverModels({ ...openai, baseUrl })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    }
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('IPC 使用当前渠道的已存或临时密钥，获取列表不保存设置或修改默认', async () => {
    const server = await listing(() => ({ body: { data: [{ id: 'new-model' }] } }))
    const app = await testApp(); cleanups.push(() => app.close())
    const saved = app.core.settings.get().models, channelId = saved.channels[0]!.id
    const before = JSON.stringify(app.core.settings.get())
    const input = { ...openai, baseUrl: server.baseUrl, channelId }
    expect((await app.call('settings:discoverModels', input)).models[0]!.id).toBe('new-model')
    expect(server.requests[0]!.headers.authorization).toBe('Bearer fake')
    await app.call('settings:discoverModels', { ...input, apiKey: 'unsaved-secret' })
    expect(server.requests[1]!.headers.authorization).toBe('Bearer unsaved-secret')
    await app.call('settings:discoverModels', { ...input, apiKey: '' })
    expect(server.requests[2]!.headers.authorization).toBeUndefined()
    await app.call('settings:discoverModels', { ...openai, baseUrl: server.baseUrl })
    expect(server.requests[3]!.headers.authorization).toBeUndefined()
    await expect(app.call('settings:discoverModels', { ...input, channelId: 'deleted-channel' })).rejects.toThrow('渠道已删除')
    expect(server.requests).toHaveLength(4)
    expect(JSON.stringify(app.core.settings.get())).toBe(before)
  })
})
