import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { testApp, deferred } from '../helpers/test-app'
import { extractHashtags } from '../../electron/pipelines/classify'
let app: Awaited<ReturnType<typeof testApp>>
beforeEach(async () => { app = await testApp() })
afterEach(async () => { await app.close() })
const idea = () => app.call('capture:save', { text: '今天讨论需求', source: 'main-window' })

describe('建议：物理归档与可选属性独立', () => {
  it('灵感不自动归档，模型只提属性建议不改文件', async () => {
    const doc = await idea()
    expect(doc.path).toMatch(/^ideas\//)
    const original = (await app.core.vault.readRaw(doc.path)).text
    expect(await app.core.classify.run(doc.path)).toMatchObject({ state: 'suggested' })
    expect((await app.core.vault.readRaw(doc.path)).text).toBe(original)
    expect(app.core.state.getSuggestions(doc.path)).toEqual([expect.objectContaining({ kind: 'properties', properties: { tags: ['需求'] } })])
    expect(app.core.classify.inbox({}).items[0]?.reasons).toEqual(['properties'])
    await app.call('classify:accept', { ref: { path: doc.path }, kind: 'properties' })
    expect((await app.core.vault.read({ path: doc.path })).classification.tags).toEqual(['需求'])
    expect(app.core.classify.inbox({}).total).toBe(0)
  })
  it('inbox 无属性资料自然待归档，暂缓或忽略属性不隐藏文件', async () => {
    app.write('inbox/外部.md', '待归档资料')
    await app.core.syncIndex()
    expect(app.core.classify.inbox({}).items[0]?.reasons).toEqual(['directory'])
    await app.core.classify.run('inbox/外部.md')
    expect(app.core.state.getSuggestions('inbox/外部.md')).toHaveLength(2)
    await app.call('classify:skip', { ref: { path: 'inbox/外部.md' }, kind: 'properties' })
    expect(app.core.classify.inbox({}).items[0]?.reasons).toEqual(['directory'])
    await app.call('classify:skip', { ref: { path: 'inbox/外部.md' }, kind: 'directory' })
    expect(app.core.classify.inbox({}).total).toBe(1)
  })
  it('确认真实目录移动后保留独立属性建议', async () => {
    app.write('inbox/规则.md', '资料')
    await app.core.syncIndex()
    await app.core.classify.run('inbox/规则.md')
    const moved = await app.call('classify:accept', { ref: { path: 'inbox/规则.md' }, kind: 'directory' })
    expect(moved.path).toBe('content/工作/规则.md')
    expect(app.core.state.getSuggestions(moved.path)).toEqual([expect.objectContaining({ kind: 'properties' })])
    expect(app.core.classify.inbox({}).items[0]?.reasons).toEqual(['properties'])
    await app.call('classify:accept', { ref: { path: moved.path }, kind: 'properties' })
    expect(app.core.classify.inbox({}).total).toBe(0)
  })
  it('模型等待期间人工属性继续保存，模型结果不自动覆盖', async () => {
    const doc = await idea(), started = deferred(), hold = deferred()
    app.fake.setResponder(async () => { started.release(); await hold.promise; return JSON.stringify({ directoryPath: null, tags: ['模型'], place: '北京', confidence: 0.95 }) })
    const pending = app.core.classify.run(doc.path)
    await started.promise
    await app.call('doc:patchProperties', { path: doc.path, patch: { tags: ['等待时填写'] } })
    hold.release()
    expect(await pending).toMatchObject({ state: 'suggested' })
    expect((await app.core.vault.read({ path: doc.path })).classification).toEqual({ tags: ['等待时填写'], people: [], place: undefined })
  })
  it('人工只修改一个字段，不丢弃其他属性和目录建议', async () => {
    app.write('inbox/资料.md', '资料')
    await app.core.syncIndex()
    app.core.state.setSuggestion('inbox/资料.md', { kind: 'directory', directoryPath: 'content/工作', confidence: 0.8, reason: '' })
    app.core.state.setSuggestion('inbox/资料.md', { kind: 'properties', properties: { tags: ['候选'], place: '公司' }, confidence: 0.8, reason: '' })
    await app.call('doc:setClassification', { ref: { path: 'inbox/资料.md' }, patch: { tags: ['人工'] } })
    expect(app.core.state.getSuggestions('inbox/资料.md')).toEqual([
      expect.objectContaining({ kind: 'directory' }),
      expect.objectContaining({ kind: 'properties', properties: { place: '公司' } }),
    ])
  })
  it('通用属性接口修改一项后，保留目录与其他字段的建议', async () => {
    app.write('inbox/通用属性.md', '资料')
    await app.core.syncIndex()
    app.core.state.setSuggestion('inbox/通用属性.md', { kind: 'directory', directoryPath: 'content/工作', confidence: 0.8, reason: '' })
    app.core.state.setSuggestion('inbox/通用属性.md', { kind: 'properties', properties: { tags: ['候选'], place: '公司' }, confidence: 0.8, reason: '' })
    await app.call('doc:patchProperties', { path: 'inbox/通用属性.md', patch: { tags: ['已填写'] } })
    expect(app.core.state.getSuggestions('inbox/通用属性.md')).toEqual([
      expect.objectContaining({ kind: 'directory' }),
      expect.objectContaining({ kind: 'properties', properties: { place: '公司' } }),
    ])
  })
  it('属性为空不创建待办，未知目录不创建文件夹', async () => {
    const doc = await idea()
    app.fake.setResponder(() => JSON.stringify({ directoryPath: 'content/未知', tags: [], people: [], confidence: 0.99 }))
    expect(await app.core.classify.run(doc.path)).toMatchObject({ state: 'skipped' })
    expect(app.core.classify.inbox({}).total).toBe(0)
    expect(app.core.content.directories(undefined, true).some(d => d.path === 'content/未知')).toBe(false)
  })
  it('附件属性确认仅写 sidecar，不改原件；摘要不重复生成待处理条目', async () => {
    app.write('content/资料.txt', '原件内容')
    await app.core.syncIndex()
    await app.core.files.summarize('content/资料.txt')
    await app.core.idle()
    const summary = app.core.files.summaries('content/资料.txt')[0]!
    await app.core.classify.run(summary)
    expect(app.core.classify.inbox({}).total).toBe(1)
    await app.call('classify:accept', { ref: { path: 'content/资料.txt' }, kind: 'properties' })
    expect((await app.core.vault.readRaw('content/资料.txt')).text).toBe('原件内容')
    expect((await app.core.vault.metadata.read('content/资料.txt')).data.tags).toEqual(['需求'])
    expect(app.core.classify.inbox({}).total).toBe(0)
  })
  it('旧字段可作为普通属性保留，但归类专用入口拒绝旧参数', async () => {
    const doc = await idea()
    await app.call('doc:patchProperties', { path: doc.path, patch: { domain: '旧领域', related: ['content/工作'], status: '自定义状态' } })
    const current = await app.call('doc:get', { ref: { path: doc.path } })
    expect(current.properties).toMatchObject({ domain: '旧领域', related: ['content/工作'], status: '自定义状态' })
    expect(current.classification).not.toHaveProperty('status')
    await expect(app.call('doc:create', { title: '旧参数', classification: { domain: '工作' } as never })).rejects.toThrow('INVALID_INPUT')
  })
  it('重新分析按类型替换建议，没有新建议时清除旧结果但保留目录待办', async () => {
    app.write('inbox/重试.md', '资料')
    await app.core.syncIndex()
    await app.core.classify.run('inbox/重试.md')
    expect(app.core.state.getSuggestions('inbox/重试.md')).toHaveLength(2)
    app.fake.setResponder(() => JSON.stringify({ directoryPath: null, tags: ['新候选'], confidence: 0.7 }))
    expect(await app.core.classify.run('inbox/重试.md', { force: true })).toMatchObject({ state: 'suggested' })
    expect(app.core.state.getSuggestions('inbox/重试.md')).toEqual([
      expect.objectContaining({ kind: 'properties', properties: { tags: ['新候选'] } }),
    ])
    app.fake.setResponder(() => JSON.stringify({ directoryPath: null, tags: [], people: [], confidence: 0.3 }))
    expect(await app.core.classify.run('inbox/重试.md', { force: true })).toMatchObject({ state: 'skipped' })
    expect(app.core.state.getSuggestions('inbox/重试.md')).toEqual([])
    expect(app.core.classify.inbox({}).items[0]?.reasons).toEqual(['directory'])
  })
  it('重新分析失败保留原有独立建议', async () => {
    app.write('inbox/失败.md', '资料')
    await app.core.syncIndex()
    await app.core.classify.run('inbox/失败.md')
    const previous = app.core.state.getSuggestions('inbox/失败.md')
    app.fake.setResponder(() => '不符合 JSON 格式')
    await expect(app.core.classify.run('inbox/失败.md', { force: true })).rejects.toThrow('模型两次返回')
    expect(app.core.state.getSuggestions('inbox/失败.md')).toEqual(previous)
  })
  it('正文标签和 Markdown 标题可区分', () => { expect(extractHashtags('# 标题\n#需求 #工作/需求')).toEqual(['需求', '工作/需求']) })
})
