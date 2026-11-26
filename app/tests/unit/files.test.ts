import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { testApp, deferred } from '../helpers/test-app'
import { renderSummary } from '../../electron/pipelines/files'
let app: Awaited<ReturnType<typeof testApp>>
beforeEach(async () => { app = await testApp() })
afterEach(async () => { await app.close() })
async function source() {
  const external = path.join(app.tmp.dir, '资料.md')
  fs.writeFileSync(external, '# 资料\n虚构的业务规则')
  const result = await app.call('files:import', { paths: [external], toDir: 'content/工作' })
  await app.core.idle()
  return result.imported[0]!
}
describe('附件摘要：文件和 source 路径权威', () => {
  it('明确导入安排路径任务，摘要与来源链接可从重建恢复', async () => {
    const rel = await source()
    expect(app.core.jobs.list().items[0]).toMatchObject({ target: rel, type: 'summarize-file' })
    await app.core.jobs.drain(); await app.core.idle()
    const summary = app.core.files.summaries(rel)[0]!
    expect((await app.core.vault.read({ path: summary })).properties).toMatchObject({ source: rel })
    expect((await app.core.vault.read({ path: summary })).body).toContain('## 来源')
    await app.core.syncIndex(true); await app.reopen()
    expect(app.core.files.list().items).toMatchObject([{ path: rel, summaryPath: summary, state: 'done' }])
  })
  it('普通扫描、外部新增和原件修改不调用模型、不自动覆盖摘要', async () => {
    app.write('content/资料.txt', '版本一'); await app.core.syncIndex()
    expect(app.fake.requests).toHaveLength(0)
    await app.core.files.summarize('content/资料.txt')
    const summary = app.core.files.summaries('content/资料.txt')[0]!
    const before = fs.readFileSync(app.file(summary), 'utf8')
    app.write('content/资料.txt', '版本二'); await app.core.syncIndex()
    await app.core.files.summarize('content/资料.txt')
    expect(app.fake.requests).toHaveLength(1)
    expect(fs.readFileSync(app.file(summary), 'utf8')).toBe(before)
    await expect(app.core.files.reprocess('content/资料.txt')).rejects.toMatchObject({ code: 'CONFLICT' })
  })
  it('生成期间人工修改摘要，即使 force 也保留人工正文', async () => {
    const rel = await source()
    await app.core.jobs.drain(); await app.core.idle()
    const target = app.core.files.summaries(rel)[0]!, started = deferred(), hold = deferred()
    app.fake.setResponder(async () => { started.release(); await hold.promise; return JSON.stringify({ oneLine: '新摘要', points: ['新要点'] }) })
    const pending = app.core.files.summarize(rel, { force: true })
    const checked = expect(pending).rejects.toMatchObject({ code: 'CONFLICT' })
    await started.promise
    await app.core.vault.saveCurrentBody(target, '生成期间写入的人工摘要')
    hold.release(); await checked
    expect((await app.core.vault.read({ path: target })).body).toBe('生成期间写入的人工摘要')
  })
  it('同内容副本独立，多摘要需指定替换目标', async () => {
    app.write('content/甲.txt', '同样内容'); app.write('content/乙.txt', '同样内容')
    await app.core.syncIndex()
    await app.core.files.summarize('content/甲.txt'); await app.core.files.summarize('content/乙.txt')
    const original = app.core.files.summaries('content/甲.txt')[0]!
    app.write('wiki/sources/复制摘要.md', fs.readFileSync(app.file(original), 'utf8')); await app.core.syncIndex()
    await expect(app.core.files.reprocess('content/甲.txt', true)).rejects.toThrow('选择')
    await app.core.files.summarize('content/甲.txt', { force: true, summaryPath: 'wiki/sources/复制摘要.md' })
    expect(app.core.files.list().total).toBe(2)
  })
  it('不支持的格式保留原件及属性，不发模型请求', async () => {
    app.write('content/附件.pdf', Buffer.from([1, 0, 2])); await app.core.syncIndex()
    await app.core.files.handle('content/附件.pdf')
    expect(app.core.files.list().items[0]).toMatchObject({ state: 'unsupported', path: 'content/附件.pdf' })
    expect(app.fake.requests).toHaveLength(0)
  })
  it('固定摘要格式保留事实名称', () => {
    expect(renderSummary({ oneLine: '摘要', points: ['明确事实'], entities: { projects: [], people: ['小王'], dates: [], numbers: [] } })).toContain('人物：小王')
  })
})
it('自动生成不能把普通笔记或附件伪装成已有摘要后覆盖', async () => {
  app.write('content/普通笔记.md', '人工正文')
  app.write('content/导入原件.md', '---\ntype: source-summary\n---\n原件字节')
  await app.core.vault.metadata.markImported('content/导入原件.md', '2026-11-19')
  for (const path of ['content/普通笔记.md', 'content/导入原件.md']) {
    await expect(app.core.vault.writeGenerated(path, { type: 'source-summary' }, '覆盖')).rejects.toMatchObject({ code: 'WRITE_DENIED' })
  }
  expect((await app.core.vault.readRaw('content/普通笔记.md')).text).toBe('人工正文')
  expect((await app.core.vault.readRaw('content/导入原件.md')).text).toContain('原件字节')
})
