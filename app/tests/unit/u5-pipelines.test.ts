import { modelSettings } from '../helpers/models'
import fs from 'node:fs'
import path from 'node:path'
import { JotError } from '@shared/result'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { testApp, deferred } from '../helpers/test-app'
import { agentScript, isAgentRequest, type FakeChatRequest } from '../helpers/fake-llm'
import { TASK_LIMITS, coverageNote } from '../../electron/agent/executor'
import { pathJobKey } from '../../electron/jobs/queue'

let app: Awaited<ReturnType<typeof testApp>>
beforeEach(async () => { app = await testApp() })
afterEach(async () => { vi.restoreAllMocks(); await app.close() })
const source = 'inbox/2026/11/长资料.txt'
const summaryReply = { oneLine: '按原文归纳', points: ['正文明确事实'], entities: null }
const classifyReply = { directoryPath: 'content/工作', tags: ['模型建议'], people: ['小周'], place: null, confidence: 0.8, reason: '业务材料' }
const taskKind = (req: FakeChatRequest) => String(req.messages[0]?.content).match(/任务技能：[^\n]+/)?.[0] ?? ''
const requestText = (req: FakeChatRequest) => JSON.stringify(req.messages)
const model = (effort: 'auto' | 'low' | 'high' = 'high', contextWindow = 32768) => app.call('settings:set', { ...modelSettings({ baseUrl: app.fake.baseUrl, model: 'fake', apiKey: 'fake', reasoningEffort: effort, contextWindow }, app.core.settings.get()) })

describe('U5 四类业务AI统一执行', () => {
  it('新库四个任务绑定可用，实际任务记录模型/技能/全局强度，聊天覆盖不泄漏', async () => {
    await model()
    expect((await app.call('capabilities:catalog', undefined)).taskBindings.every(binding => !binding.issues.length)).toBe(true)
    app.write(source, '真实业务资料'); await app.core.syncIndex()
    app.fake.setResponder(agentScript([() => '私人助手回答'], req => JSON.stringify(taskKind(req).includes('source-summary') ? summaryReply
      : taskKind(req).includes('content-organize') ? classifyReply : { groups: [{ names: ['Jot', 'Jot笔记'], suggested: 'Jot', reason: '同一软件' }] })))
    const id = app.core.agent.create().conversationId
    const run = app.core.agent.send(id, '私人用户问题', { agentId: 'default', references: [], strict: false, skillIds: [], reasoningEffort: 'low' })
    await app.core.agent.wait(run.runId)
    const { jobId: summaryId } = await app.core.files.reprocess(source)
    await app.core.jobs.drain(); await app.core.idle()
    const { jobId: classifyId } = await app.call('classify:rerun', { ref: { path: source } })
    await app.core.jobs.drain()
    await app.call('taxonomy:create', { kind: 'tag', name: 'Jot' }); await app.call('taxonomy:create', { kind: 'tag', name: 'Jot笔记' })
    const { jobId: synonymsId } = app.core.taxonomy.requestSynonyms('tag')
    await app.core.jobs.drain()
    for (const [jobId, skill] of [[summaryId, 'source-summary'], [classifyId, 'content-organize'], [synonymsId, 'term-organize']]) {
      expect(app.core.jobs.info(jobId!)).toMatchObject({ state: 'done', execution: { model: 'fake', skillId: 'jot-core:' + skill, reasoning: { requested: 'high', source: 'global', parameters: { reasoning_effort: 'high' } } } })
    }
    const requests = app.fake.requests.filter(req => !isAgentRequest(req))
    expect(requests).toHaveLength(3)
    for (const req of requests) {
      expect(req.reasoning_effort).toBe('high')
      expect(requestText(req)).not.toContain('私人用户问题')
      expect(requestText(req)).not.toContain('私人助手回答')
      expect((req.tools as { function: { name: string } }[]).map(tool => tool.function.name)).toEqual(['use_skill'])
    }
    const summary = app.core.files.summaries(source)[0]!
    expect((await app.core.vault.read({ path: summary })).properties).toMatchObject({ skill: 'jot-core:source-summary', reasoning: { requested: 'high' } })
    expect(fs.readFileSync(app.file(source), 'utf8')).toBe('真实业务资料')
    expect(app.core.taxonomy.synonyms()).toHaveLength(1)
    expect((await app.core.vault.read({ path: source })).classification.tags).toEqual([])
    await app.reopen()
    expect(app.core.jobs.info(summaryId).execution?.skillId).toBe('jot-core:source-summary')
    expect(app.core.state.getSuggestions(source)).toHaveLength(2)
    expect(app.core.taxonomy.synonyms()).toHaveLength(1)
  })

  it('长资料按窗口分段，尾部参与最终摘要，同任务中途改档/技能仍使用启动值', async () => {
    await model('high', 16384)
    app.write(source, '材料开头' + '正文资料'.repeat(4500) + '尾部事实：预算25万元'); await app.core.syncIndex()
    const started = deferred(), hold = deferred(), before = app.fake.requests.length
    app.fake.setResponder(async (req, index) => {
      if (index === before) { started.release(); await hold.promise }
      const tail = requestText(req).includes('预算25万元')
      return JSON.stringify({ oneLine: '业务资料', points: [tail ? '预算25万元' : '其他明确事实'], entities: null })
    })
    const pending = app.core.files.summarize(source)
    await started.promise
    await model('low', 16384)
    await app.call('capabilities:changeSkill', { action: 'save', enabled: true, content: { name: 'custom-summary', title: '自定义摘要', description: '处理给定材料', body: '新技能不会影响在途任务', requiredTools: [] } })
    await app.call('capabilities:setTaskSkills', { 'summarize-file': 'custom-summary' })
    hold.release(); await pending
    const requests = app.fake.requests.slice(before)
    expect(requests.length).toBeGreaterThan(2)
    expect(requests.every(req => req.reasoning_effort === 'high' && taskKind(req) === '任务技能：jot-core:source-summary')).toBe(true)
    expect(requests.some(req => requestText(req).includes('预算25万元'))).toBe(true)
    const saved = await app.core.vault.read({ path: app.core.files.summaries(source)[0]! })
    expect(saved.body).toContain('预算25万元')
    expect(saved.body).toContain('已分段处理全部材料')
    expect(requests.every(req => (req.max_tokens ?? req.max_completion_tokens)! > 4096)).toBe(true)
  })

  it('分段按原文顺序保留空白及尾部，上限明示实际覆盖，不悄悄少算', async () => {
    await model('auto', 16384)
    const task = await app.core.executor.prepare('summarize-file')
    const text = '甲'.repeat(7000) + '\n\n' + '😀'.repeat(3000) + '\n尾部'
    const split = task.split(text, part => '材料：' + part, '{}')
    expect(split.parts.join('')).toBe(text)
    expect(split.processed).toBe(text.length)
    expect(split.parts.every(part => !/[\uD800-\uDBFF]$/.test(part))).toBe(true)
    const huge = task.split('大材料'.repeat(500_000), part => part, '{}')
    expect(huge.parts).toHaveLength(TASK_LIMITS.segments)
    expect(huge.processed).toBeLessThan(1_500_000)
    expect(coverageNote({ processed: huge.processed, total: 1_500_000, unit: 'characters', segmented: true })).toContain('其余未纳入分析')
  })

  it('超过4000字的整理材料尾部参与建议，不自动写属性或归档', async () => {
    await model('auto', 16384)
    const file = 'inbox/2026/11/整理.md'
    app.write(file, '开头材料'.repeat(2600) + '尾部特别事项：团队名星河'); await app.core.syncIndex()
    app.fake.setResponder(req => JSON.stringify({ ...classifyReply, tags: requestText(req).includes('星河') ? ['星河'] : ['普通'] }))
    const { jobId } = await app.call('classify:rerun', { ref: { path: file } })
    await app.core.jobs.drain()
    expect(app.core.jobs.info(jobId)).toMatchObject({ state: 'done', note: expect.stringContaining('已分段处理全部材料') })
    expect(app.core.state.getSuggestion(file, 'properties')).toMatchObject({ properties: { tags: ['星河'] } })
    expect(app.fake.requests.some(req => requestText(req).includes('尾部特别事项'))).toBe(true)
    expect((await app.core.vault.read({ path: file })).classification.tags).toEqual([])
    expect(fs.existsSync(app.file(file))).toBe(true)
  })

  it('词条超过300项仍参与比较，可识别跨批名称，建议不会自动合并', async () => {
    await model('auto', 16384)
    for (let i = 0; i < 330; i++) app.core.state.confirmTerms('tag', ['词条' + i.toString().padStart(3, '0') + '长名称'.repeat(4)], 'preset')
    const terms = app.core.classify.terms('tag'), first = terms[0]!.name, last = terms.at(-1)!.name
    app.fake.setResponder(req => JSON.stringify({ groups: requestText(req).includes(first) && requestText(req).includes(last) ? [{ names: [first, last], suggested: first, reason: '测试跨批候选' }] : [] }))
    const { jobId } = app.core.taxonomy.requestSynonyms('tag')
    await app.core.jobs.drain()
    expect(app.core.jobs.info(jobId)).toMatchObject({ state: 'done' })
    expect(app.fake.requests.length).toBeGreaterThan(1)
    expect(app.fake.requests.some(req => requestText(req).includes(last))).toBe(true)
    expect(app.core.taxonomy.synonyms()).toMatchObject([{ names: [first, last] }])
    expect(app.core.classify.terms('tag')).toHaveLength(330)
  })

  it.each(['summarize-file', 'classify', 'find-synonyms'] as const)('%s缺失绑定明确失败，零旧直连回退，修复绑定后可重试', async task => {
    await model('auto')
    app.write(source, '真实资料'); await app.core.syncIndex()
    app.core.state.confirmTerms('tag', ['Jot', 'Jot笔记'], 'preset')
    const config = await app.core.vault.getAssistantConfiguration()
    await app.core.vault.saveAssistantConfiguration({ ...config, taskSkills: { ...config.taskSkills, [task]: 'missing-skill' } })
    const jobId = task === 'summarize-file' ? (await app.core.files.reprocess(source)).jobId
      : task === 'classify' ? (await app.call('classify:rerun', { ref: { path: source } })).jobId : app.core.taxonomy.requestSynonyms('tag').jobId
    await app.core.jobs.drain()
    expect(app.core.jobs.info(jobId)).toMatchObject({ state: 'failed', error: expect.stringContaining('技能不存在') })
    expect(app.fake.requests).toHaveLength(0)
    const skill = task === 'summarize-file' ? 'source-summary' : task === 'classify' ? 'content-organize' : 'term-organize'
    await app.call('capabilities:setTaskSkills', { [task]: 'jot-core:' + skill })
    app.core.jobs.retry(jobId); await app.core.jobs.drain()
    expect(app.core.jobs.info(jobId)).toMatchObject({ state: 'done', execution: { skillId: 'jot-core:' + skill } })
  })

  it.each(['summarize-file', 'classify', 'find-synonyms'] as const)('%s取消后不落迟到结果，原摘要/建议保留', async task => {
    await model('auto')
    app.write(source, '真实资料'); await app.core.syncIndex()
    await app.core.files.summarize(source)
    const summary = app.core.files.summaries(source)[0]!, previous = fs.readFileSync(app.file(summary), 'utf8')
    app.core.state.setSuggestion(source, { kind: 'properties', properties: { tags: ['原建议'] }, confidence: 0.8, reason: '' })
    app.core.state.confirmTerms('tag', ['Jot', 'Jot笔记'], 'preset')
    const started = deferred(), hold = deferred()
    app.fake.setResponder(async () => { started.release(); await hold.promise; return JSON.stringify(task === 'summarize-file' ? summaryReply : task === 'classify' ? classifyReply : { groups: [] }) })
    const jobId = task === 'summarize-file' ? (await app.core.files.reprocess(source, true)).jobId
      : task === 'classify' ? (await app.call('classify:rerun', { ref: { path: source } })).jobId : app.core.taxonomy.requestSynonyms('tag').jobId
    const pending = app.core.jobs.drain()
    await started.promise
    await app.core.mutate(() => app.core.vault.createFolder('content', '等待可操作'))
    app.core.jobs.cancel(jobId); await pending; hold.release()
    expect(app.core.jobs.info(jobId).state).toBe('cancelled')
    expect(fs.readFileSync(app.file(summary), 'utf8')).toBe(previous)
    expect(app.core.state.getSuggestion(source, 'properties')).toMatchObject({ properties: { tags: ['原建议'] } })
    expect(app.core.taxonomy.synonyms()).toEqual([])
  })

  it('同义分析期间删除的词条不恢复为建议，后续确认仍使用当前词表', async () => {
    await model('auto')
    app.core.state.confirmTerms('tag', ['甲名称', '乙名称'], 'preset')
    const started = deferred(), hold = deferred()
    app.fake.setResponder(async () => { started.release(); await hold.promise; return JSON.stringify({ groups: [{ names: ['甲名称', '乙名称'], suggested: '甲名称', reason: '同义' }] }) })
    const pending = app.core.taxonomy.findSynonyms('tag')
    await started.promise
    await app.core.taxonomy.remove('tag', '乙名称')
    hold.release(); await pending
    expect(app.core.taxonomy.synonyms()).toEqual([])
  })

  it('小窗口且必要说明过大时明确失败，不退回旧引擎；模型错误重试记录清晰', async () => {
    await model('high', 4096)
    await app.call('capabilities:changeAgent', { action: 'configure-default', instructions: '很长的任务说明'.repeat(1500) })
    app.write(source, '实际材料'); await app.core.syncIndex()
    const { jobId } = await app.core.files.reprocess(source)
    await app.core.jobs.drain()
    expect(app.core.jobs.info(jobId)).toMatchObject({ state: 'failed', error: expect.stringContaining('模型输入预算') })
    expect(app.fake.requests).toHaveLength(0)
    expect(app.core.jobs.latestByKey(pathJobKey('summarize-file', source))?.jobId).toBe(jobId)
    expect(fs.existsSync(app.file('wiki/sources/2026/11/长资料.md'))).toBe(false)
  })

  it('分段任务结构失败最多纠正一次，失败不保存中间成果', async () => {
    await model('auto')
    app.write(source, '要归纳的资料'); await app.core.syncIndex()
    app.fake.setResponder(() => '无效JSON')
    const before = app.fake.requests.length
    await expect(app.core.files.summarize(source)).rejects.toMatchObject({ code: 'LLM_BAD_OUTPUT' })
    expect(app.fake.requests.length - before).toBe(2)
    expect(app.core.files.summaries(source)).toEqual([])
    await expect(app.core.executor.prepare('classify', AbortSignal.abort())).rejects.toMatchObject({ code: 'CANCELLED' })
  })

  it.each(['summarize-file', 'classify', 'find-synonyms'] as const)('%s在4096窗口可处理简短材料，不要求手动维护输出上限', async task => {
    await model('auto', 4096)
    app.write(source, '接口采用方案甲'); await app.core.syncIndex()
    app.core.state.confirmTerms('tag', ['Jot', 'Jot笔记'], 'preset')
    const jobId = task === 'summarize-file' ? (await app.core.files.reprocess(source)).jobId
      : task === 'classify' ? (await app.call('classify:rerun', { ref: { path: source } })).jobId : app.core.taxonomy.requestSynonyms('tag').jobId
    await app.core.jobs.drain()
    expect(app.core.jobs.info(jobId)).toMatchObject({ state: 'done' })
    expect(app.fake.requests).toHaveLength(1)
    expect(app.fake.requests[0]).not.toHaveProperty('reasoning_effort')
  })

  it.each(['summarize-file', 'classify', 'find-synonyms'] as const)('%s直接执行期间切库不把迟到成果写入同路径文件或新词表', async task => {
    await model('auto')
    app.write(source, '原库资料'); await app.core.syncIndex()
    app.core.state.confirmTerms('tag', ['Jot', 'Jot笔记'], 'preset')
    const started = deferred(), hold = deferred()
    app.fake.setResponder(async () => {
      started.release(); await hold.promise
      return JSON.stringify(task === 'summarize-file' ? summaryReply : task === 'classify' ? classifyReply
        : { groups: [{ names: ['Jot', 'Jot笔记'], suggested: 'Jot', reason: '同一软件' }] })
    })
    const pending = task === 'summarize-file' ? app.core.files.summarize(source)
      : task === 'classify' ? app.core.classify.run(source) : app.core.taxonomy.findSynonyms('tag')
    const check = expect(pending).rejects.toMatchObject({ code: 'CANCELLED' })
    await started.promise
    const other = path.join(app.tmp.dir, '另一个虚构库')
    fs.mkdirSync(path.dirname(path.join(other, source)), { recursive: true }); fs.writeFileSync(path.join(other, source), '新库同路径资料')
    await app.core.openVault(other, true); await app.core.jobs.stop()
    app.core.state.confirmTerms('tag', ['Jot', 'Jot笔记'], 'preset')
    hold.release(); await check
    expect(app.core.files.summaries(source)).toEqual([])
    expect(app.core.state.getSuggestions(source)).toEqual([])
    expect(app.core.taxonomy.synonyms()).toEqual([])
    expect(fs.readFileSync(path.join(other, source), 'utf8')).toBe('新库同路径资料')
    expect(fs.readFileSync(app.file(source), 'utf8')).toBe('原库资料')
  })

  it('真实分段摘要达到本次覆盖上限时仍可保存，并明确其余未分析', async () => {
    await model('auto', 8192)
    const text = '超长资料'.repeat(100_000) + '未覆盖尾部'
    app.write(source, text); await app.core.syncIndex()
    app.fake.setResponder(() => JSON.stringify(summaryReply))
    const { jobId } = await app.core.files.reprocess(source)
    await app.core.jobs.drain()
    expect(app.core.jobs.info(jobId)).toMatchObject({ state: 'done', note: expect.stringContaining('其余未纳入分析') })
    const saved = await app.core.vault.read({ path: app.core.files.summaries(source)[0]! })
    expect(saved.body).toContain('本次只处理前')
    expect(saved.body).toContain(text.length.toLocaleString())
    expect(app.fake.requests.length).toBeGreaterThan(TASK_LIMITS.segments)
    expect(app.fake.requests.length).toBeLessThanOrEqual(TASK_LIMITS.requests)
    expect(requestText(app.fake.requests.at(-1)!)).not.toContain('未覆盖尾部')
    expect(fs.readFileSync(app.file(source), 'utf8')).toBe(text)
  })

  it('日总结同样按窗口分段，长记录末尾事实参与最终归纳，完整来源仍保留', async () => {
    await model('auto', 16384)
    const idea = await app.call('capture:save', { text: '今天记录思考。'.repeat(2600) + '尾部明确完成验收', source: 'main-window' })
    await app.core.idle()
    app.fake.setResponder(req => JSON.stringify({ oneLine: '今日回顾', done: requestText(req).includes('尾部明确完成验收') ? ['尾部明确完成验收'] : [], highlights: [], followUps: [] }))
    await app.core.daily.run('2026-11-19')
    expect(app.fake.requests.length).toBeGreaterThan(2)
    const saved = await app.core.vault.read({ path: 'journal/2026/2026-11-19.md' })
    expect(saved.body).toContain('尾部明确完成验收')
    expect(saved.body).toContain('已分段处理全部材料')
    expect(saved.body).toContain(idea.path.split('/').map(encodeURIComponent).join('/'))
  })

  it('长用户提问跨段后仍标明讨论，和明确记录分开，不会把问题当完成', async () => {
    await model('auto', 16384)
    const id = app.core.agent.create().conversationId
    app.fake.setResponder(() => '本轮回答')
    const run = app.core.agent.send(id, '如何推进？' + '讨论方案'.repeat(2800) + '尾部提问事实')
    await app.core.agent.wait(run.runId)
    await app.call('capture:save', { text: '今天明确完成验收', source: 'main-window' }); await app.core.idle()
    const before = app.fake.requests.length
    app.fake.setResponder(() => JSON.stringify({ oneLine: '回顾', done: ['完成验收'], highlights: [], followUps: ['继续讨论方案'] }))
    await app.core.daily.run('2026-11-19')
    const requests = app.fake.requests.slice(before)
    expect(requests.length).toBeGreaterThan(2)
    for (const req of requests.filter(req => requestText(req).includes('讨论方案'.repeat(4))))
      expect(requestText(req)).toContain('用户讨论（不代表完成）')
    expect(requests.some(req => requestText(req).includes('尾部提问事实'))).toBe(true)
    expect(requests.some(req => requestText(req).includes('明确记录：今天明确完成验收'))).toBe(true)
    const saved = await app.core.vault.read({ path: 'journal/2026/2026-11-19.md' })
    expect(saved.body).toContain('完成验收')
    expect(saved.body).toContain('已分段处理全部材料')
  })

  it('无模型时三类任务保存并等待，重启恢复配置后继续，没有丢失原件或伪造结果', async () => {
    await model('auto')
    app.write(source, '没有模型也先保存资料'); await app.core.syncIndex()
    app.core.state.confirmTerms('tag', ['Jot', 'Jot笔记'], 'preset')
    vi.spyOn(app.core.pi, 'configuration').mockImplementation(() => { throw new JotError('LLM_NOT_CONFIGURED', '还没有配置模型') })
    const jobs = [(await app.core.files.reprocess(source)).jobId,
      (await app.call('classify:rerun', { ref: { path: source } })).jobId, app.core.taxonomy.requestSynonyms('tag').jobId]
    await app.core.jobs.drain()
    for (const jobId of jobs) expect(app.core.jobs.info(jobId)).toMatchObject({ state: 'waiting-model', attempts: 0 })
    expect(app.fake.requests).toHaveLength(0)
    expect(app.core.files.summaries(source)).toEqual([])
    expect(app.core.state.getSuggestions(source)).toEqual([])
    expect(fs.readFileSync(app.file(source), 'utf8')).toBe('没有模型也先保存资料')
    await app.reopen()
    app.core.jobs.kick(); await app.core.jobs.drain(); await app.core.idle()
    for (const jobId of jobs) expect(app.core.jobs.info(jobId)).toMatchObject({ state: 'done', execution: { model: 'fake' } })
    expect(app.core.files.summaries(source)).toHaveLength(1)
    expect(app.core.state.getSuggestions(source).length).toBeGreaterThan(0)
  })

  it('普通400归为模型等待，明确档位拒绝直接失败且不降档', async () => {
    await model('high')
    app.write(source, '内容'); await app.core.syncIndex()
    for (const [message, state] of [['400 context length exceeded', 'waiting-model'], ['unsupported reasoning_effort high', 'failed']] as const) {
      app.fake.setResponder(() => ({ status: 400, body: JSON.stringify({ error: { message } }) }))
      const { jobId } = await app.call('classify:rerun', { ref: { path: source } })
      const before = app.fake.requests.length
      await app.core.jobs.drain()
      expect(app.core.jobs.info(jobId).state).toBe(state)
      expect(app.fake.requests.length - before).toBe(1)
      expect(app.core.jobs.info(jobId).execution?.reasoning?.requested).toBe('high')
    }
  })
})
