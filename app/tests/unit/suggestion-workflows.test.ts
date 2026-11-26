import fs from 'node:fs'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { testApp, deferred } from '../helpers/test-app'
import { pathJobKey } from '../../electron/jobs/queue'

let app: Awaited<ReturnType<typeof testApp>>
beforeEach(async () => { app = await testApp() })
afterEach(async () => { await app.close() })
const pending = 'inbox/2026/11/资料.md'
const props = { kind: 'properties' as const, properties: { tags: ['候选'] }, confidence: 0.3, reason: '属性依据' }
function reply(values: Record<string, unknown> = {}) {
  app.fake.setResponder(() => JSON.stringify({ directoryPath: null, tags: [], people: [], place: null, confidence: 0.3, reason: '无法确定目录', ...values }))
}
async function queue(rel: string) {
  await app.call('classify:rerun', { ref: { path: rel } })
  await app.core.jobs.drain()
  return app.core.jobs.latestForPaths('classify').get(rel.toLocaleLowerCase())!
}

it('低把握目录和属性均只形成建议，确认属性不移动文件，确认目录不丢另一项', async () => {
  app.write(pending, '业务规则资料'); await app.core.syncIndex()
  reply({ directoryPath: 'content/工作', tags: ['工作'], confidence: 0.2 })
  const job = await queue(pending)
  expect(job).toMatchObject({ state: 'done' })
  const item = app.core.classify.inbox({}).items[0]!
  expect(item.reasons).toEqual(['directory', 'properties'])
  expect(item.suggestions).toHaveLength(2)
  expect(fs.readFileSync(app.file(pending), 'utf8')).toBe('业务规则资料')
  const moved = await app.call('classify:accept', { ref: { path: pending }, kind: 'directory' })
  expect(moved.path).toBe('content/工作/资料.md')
  expect(app.core.classify.inbox({}).items[0]).toMatchObject({ reasons: ['properties'], suggestions: [expect.objectContaining({ kind: 'properties', properties: { tags: ['工作'] }, confidence: 0.2 })] })
  await app.call('classify:accept', { ref: { path: moved.path }, kind: 'properties' })
  expect(app.core.classify.inbox({}).total).toBe(0)
  expect((await app.core.vault.read({ path: moved.path })).classification.tags).toEqual(['工作'])
})

it('无目录建议仍保留属性；错误属性字段不丢有效目录和其他属性', async () => {
  app.write(pending, '可供分析的正文'); await app.core.syncIndex()
  reply({ directoryPath: 'content/不存在', tags: ['业务'] })
  await queue(pending)
  expect(app.core.classify.inbox({}).items[0]).toMatchObject({
    reasons: ['directory', 'properties'], suggestions: [expect.objectContaining({ kind: 'properties', properties: { tags: ['业务'] } })],
    analysis: { state: 'done', note: expect.stringContaining('推荐目录不可用') },
  })
  reply({ directoryPath: 'content/工作', tags: '错误数组', people: ['林舟'] })
  expect(await queue(pending)).toMatchObject({ state: 'failed', error: expect.stringContaining('标签返回格式无效') })
  expect(app.core.state.getSuggestions(pending)).toEqual([
    expect.objectContaining({ kind: 'directory', directoryPath: 'content/工作' }),
    expect.objectContaining({ kind: 'properties', properties: { tags: ['业务'], people: ['林舟'] } }),
  ])
})

it('空属性不制造待办，无推荐原因保存到任务，重启仍能显示', async () => {
  app.write(pending, '目录尚不确定')
  const idea = 'ideas/2026/11/灵感.md'
  app.write(idea, '无需归档的灵感'); await app.core.syncIndex()
  reply()
  const job = await queue(pending)
  await queue(idea)
  expect(job.note).toContain('未推荐存放目录')
  expect(job.note).toContain('空属性无需处理')
  expect(app.core.classify.inbox({}).items.map(i => i.doc.path)).toEqual([pending])
  await app.reopen({ removeIndex: true })
  expect(app.core.classify.inbox({}).items[0]).toMatchObject({ reasons: ['directory'], analysis: { state: 'done', note: job.note } })
  expect(app.core.content.library({ pending: true }).total).toBe(1)
})

it('无模型的主动分析列入属性待处理并显示等待，取消后灵感不再待办，inbox仍待归档', async () => {
  app.write('ideas/灵感.md', '灵感')
  app.write(pending, '资料'); await app.core.syncIndex()
  // 仅测试配置可用性，避免把假模型与真实用户配置混用。
  app.core.model.refresh()
  const original = app.core.settings.getModelConfig.bind(app.core.settings)
  app.core.settings.getModelConfig = () => null
  try {
    await queue('ideas/灵感.md'); await queue(pending)
    expect(app.core.classify.inbox({}).total).toBe(2)
    expect(app.core.classify.inbox({}).items).toEqual(expect.arrayContaining([
      expect.objectContaining({ doc: expect.objectContaining({ path: 'ideas/灵感.md' }), reasons: ['properties'], analysis: expect.objectContaining({ state: 'waiting-model', error: '还没有配置模型' }) }),
    ]))
    await app.call('classify:skip', { ref: { path: 'ideas/灵感.md' }, kind: 'properties' })
    await app.call('classify:skip', { ref: { path: pending }, kind: 'properties' })
    expect(app.core.classify.inbox({}).items[0]?.reasons).toEqual(['directory'])
    expect(app.core.classify.inbox({}).total).toBe(1)
    expect(app.fake.requests).toHaveLength(0)
  } finally { app.core.settings.getModelConfig = original }
})

it.each([['空白.md', '   '], ['资料.pdf', Buffer.from([1, 0, 2])], ['伪文本.txt', '正文\u0000二进制']])('没有可分析正文时不请求模型，保留明确失败供人工处理：%s', async (name, body) => {
  const rel = 'inbox/2026/11/' + name
  app.write(rel, body); await app.core.syncIndex()
  const job = await queue(rel)
  expect(job).toMatchObject({ state: 'failed', attempts: 1, error: expect.stringMatching(/正文|格式/) })
  expect(app.fake.requests).toHaveLength(0)
  const moved = await app.call('classify:accept', { ref: { path: rel }, kind: 'directory', toDir: 'content/生活' })
  expect(moved.path).toBe('content/生活/' + name)
  expect(app.core.classify.inbox({}).items[0]?.reasons).toEqual(['properties'])
  await app.call('classify:skip', { ref: { path: moved.path }, kind: 'properties' })
  expect(app.core.classify.inbox({}).total).toBe(0)
})

it('无效模型结果只修正请求一次，随后显示失败，重试成功才替换旧建议', async () => {
  app.write(pending, '需整理'); await app.core.syncIndex()
  app.core.state.setSuggestion(pending, props)
  app.fake.setResponder(() => '无效 JSON')
  const failed = await queue(pending)
  expect(failed.state).toBe('failed')
  expect(app.fake.requests).toHaveLength(2)
  expect(app.core.state.getSuggestion(pending, 'properties')).toEqual(props)
  await app.reopen()
  expect(app.core.classify.inbox({}).items[0]?.analysis?.state).toBe('failed')
  reply({ tags: ['更新候选'] })
  await queue(pending)
  expect(app.core.state.getSuggestion(pending, 'properties')).toMatchObject({ properties: { tags: ['更新候选'] } })
  expect(app.core.classify.inbox({}).items[0]?.analysis?.state).toBe('done')
})

it('没有模型建议也可手动归档附件，sidecar和普通链接一起维护，属性事项保留', async () => {
  const rel = 'inbox/2026/11/附件.txt'
  app.write(rel, '附件字节'); app.write(rel + '.meta.yaml', 'tags: [现有标签]\n')
  app.write('ideas/入口.md', '[附件](../inbox/2026/11/附件.txt)')
  await app.core.syncIndex()
  app.core.state.setSuggestion(rel, props)
  const moved = await app.call('classify:accept', { ref: { path: rel }, kind: 'directory', toDir: 'content/工作' })
  expect(moved.path).toBe('content/工作/附件.txt')
  expect(fs.readFileSync(app.file(moved.path), 'utf8')).toBe('附件字节')
  expect(fs.existsSync(app.file(moved.path + '.meta.yaml'))).toBe(true)
  expect(decodeURI(fs.readFileSync(app.file('ideas/入口.md'), 'utf8'))).toContain('../content/工作/附件.txt')
  expect(app.core.state.getSuggestion(moved.path, 'properties')).toEqual(props)
  await app.reopen({ removeIndex: true })
  expect(app.core.classify.inbox({}).items[0]?.reasons).toEqual(['properties'])
})

it('目标不存在或有同名文件时不移动，保留原文和两个独立建议', async () => {
  app.write(pending, '保留资料'); app.write('content/工作/资料.md', '已有目标')
  await app.core.syncIndex()
  reply({ directoryPath: 'content/工作', tags: ['建议'] })
  await queue(pending)
  for (const toDir of ['ideas', 'content', 'content/不存在', 'content/../inbox']) {
    await expect(app.call('classify:accept', { ref: { path: pending }, kind: 'directory', toDir })).rejects.toThrow('NOT_FOUND')
  }
  await expect(app.call('classify:accept', { ref: { path: pending }, kind: 'directory' })).rejects.toThrow('CONFLICT')
  expect(fs.readFileSync(app.file(pending), 'utf8')).toBe('保留资料')
  expect(fs.readFileSync(app.file('content/工作/资料.md'), 'utf8')).toBe('已有目标')
  expect(app.core.state.getSuggestions(pending)).toHaveLength(2)
  await expect(app.call('classify:accept', { ref: { path: pending }, kind: 'properties', toDir: 'content/工作' })).rejects.toThrow('INVALID_INPUT')
})

it('更换推荐目标实际移动；暂缓和忽略属性后仍可从路径恢复归档事项', async () => {
  app.write(pending, '资料'); await app.core.syncIndex()
  reply({ directoryPath: 'content/工作', tags: ['建议'] }); await queue(pending)
  await app.call('classify:skip', { ref: { path: pending }, kind: 'directory' })
  await app.call('classify:skip', { ref: { path: pending }, kind: 'properties' })
  await app.reopen({ removeIndex: true })
  expect(app.core.classify.inbox({}).items[0]?.reasons).toEqual(['directory'])
  const moved = await app.call('classify:accept', { ref: { path: pending }, kind: 'directory', toDir: 'content/生活' })
  expect(moved.path).toBe('content/生活/资料.md')
  expect(app.core.classify.inbox({}).total).toBe(0)
})

it('排队与在途整理按原件路径去重；取消期间不丢旧建议、不落盘', async () => {
  app.write(pending, '原文'); await app.core.syncIndex()
  app.core.state.setSuggestion(pending, props)
  const start = deferred(), hold = deferred()
  app.fake.setResponder(async () => { start.release(); await hold.promise; return JSON.stringify({ directoryPath: 'content/工作', tags: ['迟到'], confidence: 0.9 }) })
  const { jobId } = await app.call('classify:rerun', { ref: { path: pending } })
  const running = app.core.jobs.drain()
  await start.promise
  await expect(app.call('classify:rerun', { ref: { path: pending } })).rejects.toThrow('CONFLICT')
  await app.call('jobs:cancel', { jobId })
  hold.release(); await running
  expect(app.core.jobs.latestByKey(pathJobKey('classify', pending))?.state).toBe('cancelled')
  expect(app.core.state.getSuggestion(pending, 'properties')).toEqual(props)
  expect(fs.readFileSync(app.file(pending), 'utf8')).toBe('原文')
})

it('摘要和原件统一分析任务目标，原件属性与摘要证据分开管理', async () => {
  const source = 'inbox/2026/11/附件.txt', summary = 'wiki/sources/2026/11/摘要.md'
  app.write(source, '原件'); app.write(summary, '---\ntype: source-summary\nsource: ' + source + '\n---\n可分析摘要')
  await app.core.syncIndex()
  const fromSummary = await app.call('classify:rerun', { ref: { path: summary } })
  expect(app.core.jobs.latestByKey(pathJobKey('classify', source))?.jobId).toBe(fromSummary.jobId)
  reply({ tags: ['摘要支持'] })
  await app.core.jobs.drain()
  expect(JSON.stringify(app.fake.requests.at(-1)?.messages[1]?.content)).toContain('可分析摘要')
  expect(app.core.classify.inbox({}).total).toBe(1)
  await app.call('classify:accept', { ref: { path: source }, kind: 'properties' })
  expect(fs.readFileSync(app.file(source), 'utf8')).toBe('原件')
  expect((await app.core.vault.metadata.read(source)).data.tags).toEqual(['摘要支持'])
  expect(fs.readFileSync(app.file(summary), 'utf8')).not.toContain('tags:')
})

it('建议补充保留已有标签和人物，目录移动后任务与建议仍指向当前路径', async () => {
  app.write(pending, '---\ntags: [人工]\npeople: [家人]\n---\n原文')
  await app.core.syncIndex()
  reply({ directoryPath: 'content/工作', tags: ['模型'], people: ['同事'] }); await queue(pending)
  expect(app.core.state.getSuggestion(pending, 'properties')).toMatchObject({ properties: { tags: ['人工', '模型'], people: ['家人', '同事'] } })
  const moved = await app.call('classify:accept', { ref: { path: pending }, kind: 'directory' })
  expect(app.core.jobs.latestForPaths('classify').get(moved.path.toLocaleLowerCase())?.state).toBe('done')
  await app.call('classify:accept', { ref: { path: moved.path }, kind: 'properties' })
  expect((await app.core.vault.read({ path: moved.path })).classification).toMatchObject({ tags: ['人工', '模型'], people: ['家人', '同事'] })
})

it('捕获按开关分析灵感属性，明确导入分析原件；外部刷新和普通编辑不重复排队', async () => {
  await app.call('settings:set', { classify: { enabled: true } })
  const record = await app.call('capture:save', { text: '捕获的工作灵感', source: 'main-window' })
  const recordJob = app.core.jobs.latestForPaths('classify').get(record.path.toLocaleLowerCase())!
  expect(recordJob.state).toBe('queued')
  await app.core.jobs.drain()
  expect(app.core.state.getSuggestion(record.path, 'directory')).toBeNull()
  expect(app.core.state.getSuggestion(record.path, 'properties')).not.toBeNull()
  const external = app.tmp.dir + '/导入原件.txt'
  fs.writeFileSync(external, '虚构的工作资料')
  const imported = await app.call('files:import', { paths: [external] })
  await app.core.jobs.drain(); await app.core.idle()
  const source = imported.imported[0]!
  expect(app.core.jobs.latestForPaths('classify').get(source.toLocaleLowerCase())?.state).toBe('done')
  expect(app.core.classify.inbox({}).items.find(item => item.doc.path === source)?.suggestions).toHaveLength(2)
  const count = app.fake.requests.length
  app.write('ideas/外部.md', '外部灵感')
  app.write(source, '更新原件')
  await app.core.syncIndex(true); await app.core.jobs.drain()
  expect(app.fake.requests).toHaveLength(count)
  expect(app.core.jobs.latestForPaths('classify').get('ideas/外部.md')).toBeUndefined()
})

it('普通编辑器和通用属性修改只处理本次字段，接受剩余建议保留最新人工标签', async () => {
  app.write(pending, '---\ntags: [初始]\n---\n资料'); await app.core.syncIndex()
  reply({ directoryPath: 'content/工作', tags: ['建议'], place: '公司' }); await queue(pending)
  app.write(pending, '---\ntags: [外部人工]\n---\n外部更新')
  await app.core.syncIndex()
  await app.call('classify:accept', { ref: { path: pending }, kind: 'properties' })
  expect((await app.core.vault.read({ path: pending })).classification.tags).toEqual(['外部人工', '初始', '建议'])
  expect(app.core.state.getSuggestion(pending, 'directory')).not.toBeNull()
})

it('目录在模型等待期间移动时取消分析，按新路径重试可恢复，不写旧路径', async () => {
  app.write(pending, '原文'); await app.core.syncIndex()
  const start = deferred(), hold = deferred()
  app.fake.setResponder(async () => { start.release(); await hold.promise; return JSON.stringify({ directoryPath: 'content/工作', tags: ['迟到'], confidence: 0.9 }) })
  const { jobId } = await app.call('classify:rerun', { ref: { path: pending } })
  const running = app.core.jobs.drain(); await start.promise
  const moved = await app.call('doc:move', { ref: { path: pending }, toDir: 'content/生活' })
  hold.release(); await running
  expect(app.core.jobs.latestByKey(pathJobKey('classify', moved.path))).toMatchObject({ jobId, state: 'cancelled', target: moved.path })
  expect(app.core.state.getSuggestions(pending)).toEqual([])
  expect(app.core.state.getSuggestions(moved.path)).toEqual([])
  reply({ tags: ['新路径'] }); await queue(moved.path)
  expect(app.core.state.getSuggestion(moved.path, 'properties')).toMatchObject({ properties: { tags: ['新路径'] } })
  expect(fs.existsSync(app.file(pending))).toBe(false)
})

it('返回的目录字段格式错误时保留旧目录和有效属性，记录真实原因而不冒充无推荐', async () => {
  app.write(pending, '资料'); await app.core.syncIndex()
  reply({ directoryPath: 'content/工作', tags: ['旧建议'] }); await queue(pending)
  reply({ directoryPath: ['content/工作'], tags: ['新建议'] })
  expect(await queue(pending)).toMatchObject({ state: 'done', note: expect.stringContaining('目录返回格式无效') })
  expect(app.core.state.getSuggestion(pending, 'directory')).toMatchObject({ directoryPath: 'content/工作' })
  expect(app.core.state.getSuggestion(pending, 'properties')).toMatchObject({ properties: { tags: ['新建议'] } })
})

it('目录格式异常和属性处理互不绑定，接受有效属性后仍只剩路径归档', async () => {
  app.write(pending, '资料'); await app.core.syncIndex()
  reply({ directoryPath: ['无效'], tags: ['可用属性'] })
  const job = await queue(pending)
  expect(job).toMatchObject({ state: 'done', note: expect.stringContaining('目录返回格式无效') })
  await app.call('classify:accept', { ref: { path: pending }, kind: 'properties' })
  expect(app.core.classify.inbox({}).items[0]?.reasons).toEqual(['directory'])
  await app.call('classify:accept', { ref: { path: pending }, kind: 'directory', toDir: 'content/工作' })
  expect(app.core.classify.inbox({}).total).toBe(0)
})
