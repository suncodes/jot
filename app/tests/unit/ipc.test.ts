import { describe, expect, it } from 'vitest'
import { CHANNELS } from '@shared/ipc'
import { JotError } from '@shared/result'
import { dispatch, registerIpc, type Handlers } from '../../electron/ipc/register'
import { argSchemas } from '../../electron/ipc/schemas'

const notUsed = () => {
  throw new Error('不应该被调用')
}

function makeHandlers(over: Partial<Handlers>): Handlers {
  const base = Object.fromEntries(CHANNELS.map((c) => [c, notUsed])) as unknown as Handlers
  return { ...base, ...over }
}

describe('IPC 分发', () => {
  it('推理设置和对话覆盖使用有界档位，预览不接受密钥或任意参数', () => {
    for (const reasoningEffort of ['auto', 'low', 'medium', 'high', 'off', 'minimal', 'xhigh', 'max']) {
      expect(argSchemas['settings:set'].safeParse({ model: { reasoningEffort } }).success).toBe(true)
      expect(argSchemas['agent:setReasoning'].safeParse({ conversationId: 'test', effort: reasoningEffort }).success).toBe(true)
    }
    expect(argSchemas['agent:setReasoning'].safeParse({ conversationId: 'test', effort: null }).success).toBe(true)
    expect(argSchemas['settings:set'].safeParse({ model: { reasoningEffort: 'arbitrary' } }).success).toBe(false)
    expect(argSchemas['settings:reasoning'].safeParse({ baseUrl: '', model: '', apiKey: 'secret' }).success).toBe(false)
  })
  it('模型窗口／比例严格校验，输出配置已移除，预算预览不接受密钥', () => {
    for (const model of [{ contextWindow: 4096, compactionThreshold: 0.6 }, { contextWindow: null, compactionThreshold: null }, { compactionThreshold: 0.7 }, { compactionThreshold: 0.8 }]) {
      expect(argSchemas['settings:set'].safeParse({ model }).success).toBe(true)
    }
    for (const model of [{ contextWindow: 100 }, { contextWindow: 3_000_000 }, { compactionThreshold: 0.75 }, { compactionThreshold: '70%' }, { maxOutputTokens: 512 }, { context: 8192 }]) {
      expect(argSchemas['settings:set'].safeParse({ model }).success).toBe(false)
    }
    expect(argSchemas['settings:modelBudget'].safeParse({ baseUrl: '', model: '', compactionThreshold: 0.7 }).success).toBe(true)
    for (const extra of [{ apiKey: '不得传入' }, { contextWindow: 3 }, { compactionThreshold: 0.9 }, { maxOutputTokens: 512 }]) {
      expect(argSchemas['settings:modelBudget'].safeParse({ baseUrl: '', model: '', ...extra }).success).toBe(false)
    }
  })

  it('每个通道都有参数校验', () => {
    expect(Object.keys(argSchemas).sort()).toEqual([...CHANNELS].sort())
  })

  it('成功时返回 ok 和数据', async () => {
    const h = makeHandlers({ 'vault:status': () => ({ open: false }) })
    expect(await dispatch(h, 'vault:status', undefined)).toEqual({ ok: true, data: { open: false } })
  })

  it('参数不对时返回 INVALID_INPUT，不调用处理函数', async () => {
    const r = await dispatch(makeHandlers({}), 'vault:open', { path: '', create: 'yes' })
    expect(r).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
  })

  it('业务错误原样带回错误码', async () => {
    const h = makeHandlers({
      'vault:tree': () => {
        throw new JotError('VAULT_NOT_OPEN', '还没有打开库')
      },
    })
    expect(await dispatch(h, 'vault:tree', {})).toEqual({
      ok: false,
      error: { code: 'VAULT_NOT_OPEN', message: '还没有打开库', detail: undefined },
    })
  })

  it('未预期的错误返回 INTERNAL', async () => {
    const h = makeHandlers({
      'settings:get': () => {
        throw new TypeError('boom')
      },
    })
    const r = await dispatch(h, 'settings:get', undefined)
    expect(r).toMatchObject({ ok: false, error: { code: 'INTERNAL', message: 'boom' } })
  })

  it('设置的参数校验：移除自动落属性阈值，仍校验日期和窗口关闭行为', async () => {
    const h = makeHandlers({ 'settings:set': (input) => input as never })
    expect((await dispatch(h, 'settings:set', { classify: { threshold: 1.5 } })).ok).toBe(false)
    expect((await dispatch(h, 'settings:set', { daily: { time: '25:00' } })).ok).toBe(false)
    expect((await dispatch(h, 'settings:set', { window: { closeBehavior: 'hide' } })).ok).toBe(false)
    expect((await dispatch(h, 'settings:set', { window: { closeBehavior: 'tray' } })).ok).toBe(true)
    expect((await dispatch(h, 'settings:set', { daily: { time: '21:30' }, classify: { enabled: false } })).ok).toBe(true)
  })

  it('注册时为每个通道挂上处理函数', async () => {
    const registered = new Map<string, (e: unknown, a: unknown) => Promise<unknown>>()
    registerIpc({ handle: (c, l) => void registered.set(c, l) }, makeHandlers({ 'vault:status': () => ({ open: false }) }))
    expect([...registered.keys()].sort()).toEqual([...CHANNELS].sort())
    expect(await registered.get('vault:status')!(null, undefined)).toEqual({ ok: true, data: { open: false } })
  })
})

describe('R6 收口后的目录与建议契约', () => {
  it('灵感集合无需附加字段，目录／属性操作显式区分', () => {
    expect(argSchemas['library:query'].safeParse({ scope: { selection: { kind: 'collection', name: 'ideas' } } }).success).toBe(true)
    expect(argSchemas['classify:accept'].safeParse({ ref: { path: 'inbox/资料.md' } }).success).toBe(false)
    for (const kind of ['directory', 'properties']) {
      expect(argSchemas['classify:accept'].safeParse({ ref: { path: 'inbox/资料.md' }, kind }).success).toBe(true)
      expect(argSchemas['classify:skip'].safeParse({ ref: { path: 'inbox/资料.md' }, kind }).success).toBe(true)
    }
  })
  it('旧领域、状态、目录扩散参数不再静默接受', () => {
    for (const filter of [{ domain: '工作' }, { status: '待整理' }, { scope: { selection: { kind: 'collection', name: 'all' }, includeRelated: true } }]) {
      expect(argSchemas['search:query'].safeParse({ filter }).success).toBe(false)
    }
    expect(argSchemas['settings:set'].safeParse({ domains: ['工作'] }).success).toBe(false)
    expect(argSchemas['library:query'].safeParse({ relatedOnly: true }).success).toBe(false)
    expect(argSchemas['agent:send'].safeParse({ conversationId: 'test', text: '问题', context: { agentId: 'default', references: [{ kind: 'folder', value: 'content/工作', title: '工作', includeRelated: true }], strict: true, skillIds: [] } }).success).toBe(false)
    expect(CHANNELS).not.toContain('taxonomy:domains')
  })
})
