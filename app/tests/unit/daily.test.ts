import fs from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { testApp, deferred } from '../helpers/test-app'
let app: Awaited<ReturnType<typeof testApp>>
beforeEach(async () => { app = await testApp() })
afterEach(async () => { await app.close() })
const date = '2026-11-19'
describe('当前日期时间线与普通 Markdown 日总结', () => {
  it('不再按固定1200字截断正文，预算允许时保留末尾事实', async () => {
    await app.call('capture:save', { text: '明确想法'.repeat(400) + '尾部明确完成验收', source: 'main-window' })
    await app.core.idle(); await app.core.daily.run(date)
    expect(JSON.stringify(app.fake.requests)).toContain('尾部明确完成验收')
    const saved = await app.core.vault.read({ path: 'journal/2026/' + date + '.md' })
    expect(saved.body).not.toContain('前 1200 字')
  })
  it('发生日优先，跨日补记按相交日期出现，同文件同日只计一次', async () => {
    const idea = await app.call('capture:save', { text: '回顾昨天的想法', source: 'main-window' })
    await app.call('doc:setOccurredAt', { ref: { path: idea.path }, occurredAt: '2026-11-18' })
    await app.call('capture:saveLog', { text: '跨日出行', start: '2026-11-18', end: '2026-11-20' })
    expect((await app.core.daily.view('2026-11-18')).stats).toMatchObject({ ideas: 1, logs: 1 })
    expect((await app.core.daily.view(date)).stats).toMatchObject({ ideas: 0, logs: 1 })
    expect(app.core.daily.daysWithRecords('2026-11')).toEqual(expect.arrayContaining(['2026-11-18', date, '2026-11-20']))
  })
  it('仅当前创建日和最后修改日，不保存中间修改历史', async () => {
    app.write('content/工作/规则.md', '---\ncreated: 2026-11-10\n---\n当前规则')
    fs.utimesSync(app.file('content/工作/规则.md'), new Date('2026-11-19T09:00:00+08:00'), new Date('2026-11-19T09:00:00+08:00'))
    await app.core.syncIndex()
    expect((await app.core.daily.view(date)).entries).toMatchObject([{ basis: 'updated', preview: '文件有更新，具体变化未确认' }])
    fs.utimesSync(app.file('content/工作/规则.md'), new Date('2026-11-20T09:00:00+08:00'), new Date('2026-11-20T09:00:00+08:00'))
    await app.core.syncIndex()
    expect((await app.core.daily.view(date)).entries).toEqual([])
    expect((await app.core.daily.view('2026-11-10')).entries).toHaveLength(1)
  })
  it('只有资料更新时照常生成，不让模型推断项目进展', async () => {
    app.write('content/工作/规则.md', '---\ncreated: 2026-11-19\n---\n整个项目的所有历史成果')
    await app.core.syncIndex()
    expect(await app.core.daily.run(date)).toBe('written')
    const summary = await app.core.vault.read({ path: 'journal/2026/' + date + '.md' })
    expect(summary.body).toContain('具体变化未确认')
    expect(summary.body).toContain('../../content/')
    expect(summary.body).not.toContain('整个项目的所有历史成果')
    expect(app.fake.requests).toHaveLength(0)
  })
  it('实际用户提问按提问时间取材，失败回答不影响提问事实，助手建议不作为事实', async () => {
    app.fake.setResponder(() => ({ status: 400, body: '{"error":{"message":"fake failure"}}' }))
    const conversation = app.core.agent.create()
    const run = app.core.agent.send(conversation.conversationId, '如何整理规则？')
    await app.core.agent.wait(run.runId)
    const entries = (await app.core.daily.view(date)).entries
    expect(entries).toMatchObject([{ kind: 'conversation', title: '如何整理规则？', basis: 'question' }])
    expect(entries).toHaveLength(1)
  })
  it('日总结保存普通来源链接，后台再次运行保留原文件；主动替换需确认', async () => {
    await app.call('capture:save', { text: '今天明确完成需求评审', source: 'main-window' })
    await app.core.idle()
    await app.core.daily.run(date)
    const path = 'journal/2026/' + date + '.md'
    const original = fs.readFileSync(app.file(path), 'utf8')
    expect((await app.core.daily.view(date)).entries).toHaveLength(1)
    expect(await app.core.daily.run(date)).toBe('kept')
    expect(fs.readFileSync(app.file(path), 'utf8')).toBe(original)
    await expect(app.core.daily.request(date)).rejects.toMatchObject({ code: 'CONFLICT' })
    const tables = app.core.state.raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()
    expect(tables).not.toContainEqual({ name: 'dailies' })
  })
  it('生成期间的人工目标变化即使 force 也不会被覆盖', async () => {
    await app.call('capture:save', { text: '今天完成评审', source: 'main-window' }); await app.core.idle()
    const started = deferred(), hold = deferred()
    app.fake.setResponder(async () => { started.release(); await hold.promise; return JSON.stringify({ oneLine: '生成文字' }) })
    const pending = app.core.daily.run(date, { force: true })
    const check = expect(pending).rejects.toMatchObject({ code: 'CONFLICT' })
    await started.promise
    await app.core.vault.writeGenerated('journal/2026/' + date + '.md', { type: 'daily', date }, '人工正文')
    hold.release(); await check
    expect((await app.core.vault.read({ path: 'journal/2026/' + date + '.md' })).body).toBe('人工正文')
  })
  it('定时补最近七天，只补缺失总结，失败任务等主动重试', async () => {
    await app.call('capture:saveLog', { text: '昨天完成整理', start: '2026-11-18', end: '2026-11-18' }); await app.core.idle()
    await app.core.settings.set({ daily: { enabled: true } })
    await app.core.jobs.stop()
    const queued = await app.core.daily.tick()
    expect(queued).toContain('2026-11-18')
    await app.core.jobs.drain(); await app.core.idle()
    expect(await app.core.daily.tick()).toEqual([])
  })
  it('摘要和日总结不独立重复统计来源事实', async () => {
    app.write('content/附件.txt', '规则'); app.write('content/附件.txt.meta.yaml', 'kind: attachment\ncreated: 2026-11-19\n'); await app.core.syncIndex()
    await app.core.files.summarize('content/附件.txt'); await app.core.idle()
    const view = await app.core.daily.view(date)
    expect(view.stats).toMatchObject({ files: 1, notes: 0 })
    expect(view.entries).toHaveLength(1)
  })
})
