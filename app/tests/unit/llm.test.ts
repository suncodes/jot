import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PiHost } from '../../electron/agent/pi'
import { extractJson } from '../../electron/agent/structured'
import { ModelDiagnostics } from '../../electron/llm/diagnostics'
import { makeTmpDir } from '../helpers/tmp'
import { startFakeLlm, type FakeLlm } from '../helpers/fake-llm'

const tmp = makeTmpDir('model-diagnostics')
let fake: FakeLlm
beforeAll(async () => { fake = await startFakeLlm() })
afterAll(async () => { await fake.close(); tmp.cleanup() })
const config = () => ({ baseUrl: fake.baseUrl, apiKey: 'fake', model: 'fake' })
const host = () => new PiHost(tmp.dir, config)
const diagnostics = () => new ModelDiagnostics(config)

describe('JSON提取与模型诊断', () => {
  it('接受裸JSON、代码块及带说明的对象；无对象抛错', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 })
    const fence = String.fromCharCode(96).repeat(3)
    expect(extractJson(fence + 'json\n{"a":1}\n' + fence)).toEqual({ a: 1 })
    expect(extractJson('说明：{"a":{"b":2}}')).toEqual({ a: { b: 2 } })
    expect(() => extractJson('无JSON')).toThrow()
  })
  it('连接测试按档位给预算，明确拒绝仅一次并返回原因', async () => {
    fake.setResponder(() => '好')
    expect((await diagnostics().test(host(), tmp.dir, { reasoningEffort: 'high' })).ok).toBe(true)
    expect(fake.requests.at(-1)?.reasoning_effort).toBe('high')
    expect(fake.requests.at(-1)?.max_tokens ?? fake.requests.at(-1)?.max_completion_tokens).toBeGreaterThan(4096)
    const before = fake.requests.length
    fake.setResponder(() => ({ status: 400, body: '{"error":{"message":"unsupported reasoning_effort high"}}' }))
    expect(await diagnostics().test(host(), tmp.dir, { reasoningEffort: 'high' })).toMatchObject({ ok: false, message: expect.stringContaining('未自动降档') })
    expect(fake.requests.length - before).toBe(1)
  })
  it('缺配置返回说明；未保存的表单配置可测试，默认不带推理参数', async () => {
    const model = new ModelDiagnostics(() => null)
    expect(model.status()).toBe('not-configured')
    expect(await model.test(host(), tmp.dir)).toMatchObject({ ok: false })
    fake.setResponder(() => '好')
    expect((await model.test(host(), tmp.dir, config())).ok).toBe(true)
    expect(fake.requests.at(-1)?.reasoning_effort).toBeUndefined()
  })
  it('真实调用失败与恢复更新当前模型状态，旧模型迟到结果不影响新模型', async () => {
    let current = config()
    const model = new ModelDiagnostics(() => current), changes: string[] = []
    model.onStatus(state => changes.push(state))
    fake.setResponder(() => ({ status: 401, body: 'unauthorized' }))
    expect((await model.test(host(), tmp.dir)).ok).toBe(false)
    expect(model.status()).toBe('unavailable')
    fake.setResponder(() => '好')
    expect((await model.test(host(), tmp.dir)).ok).toBe(true)
    expect(changes).toEqual(['unavailable', 'ok'])
    const old = current
    current = { ...current, model: 'other' }
    model.report(old, 'unavailable')
    expect(model.status()).toBe('ok')
  })
})
