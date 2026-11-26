import fs from 'node:fs'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { testApp, deferred } from '../helpers/test-app'
import { StateStore } from '../../electron/state/state'
import { pathJobKey } from '../../electron/jobs/queue'
let app: Awaited<ReturnType<typeof testApp>>
beforeEach(async () => { app = await testApp() })
afterEach(async () => { await app.close() })
it('新状态库仅包含应用资料，旧格式原样拒绝而不是自动清空', () => {
  const names = (app.core.state.raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(t => t.name)
  expect(names.sort()).toEqual(['jobs', 'suggestions', 'vocab', 'synonyms', 'conversations', 'messages', 'conversation_summaries'].sort())
  const file = app.tmp.dir + '/old.db', db = new Database(file)
  db.exec("CREATE TABLE messages(text TEXT); INSERT INTO messages VALUES ('保留的历史'); PRAGMA user_version=9")
  db.close()
  const state = new StateStore()
  expect(() => state.open(file)).toThrow('不会自动迁移或清空对话')
  const original = new Database(file, { readonly: true })
  expect(original.prepare('SELECT text FROM messages').get()).toEqual({ text: '保留的历史' }); original.close()
})
it('路径任务去重、目录移动更新未完成目标，重启按当前路径恢复', async () => {
  app.write('content/工作/A/资料.txt', '规则'); await app.core.syncIndex()
  const id = app.core.jobs.enqueuePath('summarize-file', 'content/工作/A/资料.txt')
  expect(app.core.jobs.enqueuePath('summarize-file', 'content/工作/A/资料.txt')).toBe(id)
  await app.call('folder:move', { path: 'content/工作/A', toDir: 'content/生活', name: 'B' })
  expect(app.core.jobs.latestByKey(pathJobKey('summarize-file', 'content/生活/B/资料.txt'))).toMatchObject({ jobId: id, target: 'content/生活/B/资料.txt' })
  await app.reopen(); await app.core.quiesce()
  expect(app.core.files.summaries('content/生活/B/资料.txt')).toHaveLength(1)
})
it('外部移动导致旧路径任务取消，不猜测同内容身份', async () => {
  app.write('content/旧.txt', '相同内容'); await app.core.syncIndex()
  app.core.jobs.enqueuePath('summarize-file', 'content/旧.txt')
  fs.renameSync(app.file('content/旧.txt'), app.file('content/新.txt')); await app.core.syncIndex()
  await app.core.jobs.drain()
  expect(app.core.jobs.latestByKey(pathJobKey('summarize-file', 'content/旧.txt'))?.state).toBe('cancelled')
  expect(app.core.files.summaries('content/新.txt')).toEqual([])
})
it('模型等待期间移动目录不阻塞；在途生成取消，不往旧路径写摘要', async () => {
  app.write('content/工作/A/资料.txt', '规则'); await app.core.syncIndex()
  const started = deferred(), hold = deferred()
  app.fake.setResponder(async () => { started.release(); await hold.promise; return JSON.stringify({ oneLine: '摘要', points: ['要点'] }) })
  const id = app.core.jobs.enqueuePath('summarize-file', 'content/工作/A/资料.txt')
  const pending = app.core.jobs.drain(); await started.promise
  await app.call('folder:move', { path: 'content/工作/A', toDir: 'content/生活', name: 'B' })
  hold.release(); await pending
  expect(app.core.jobs.list({ state: 'cancelled' }).items.map(j => j.jobId)).toContain(id)
  expect(app.core.files.summaries('content/工作/A/资料.txt')).toEqual([])
})
it('临时建议与当前应用内路径一起移动，属性不落状态表', async () => {
  const doc = await app.call('capture:save', { text: '记录', source: 'main-window' })
  app.core.state.setSuggestion(doc.path, { kind: 'properties', properties: { tags: ['候选'] }, confidence: 0.3, reason: '待确认' })
  await app.call('doc:move', { ref: { path: doc.path }, toDir: 'content/工作' })
  const path = 'content/工作/' + doc.path.split('/').pop()
  expect(app.core.state.getSuggestion(doc.path, 'properties')).toBeNull()
  expect(app.core.state.getSuggestions(path).find(s => s.kind === 'properties')?.properties.tags).toEqual(['候选'])
})
it('排队重做摘要时，原件和明确选中的摘要路径一起跟随目录移动', async () => {
  app.write('content/工作/A/资料.txt', '更新规则')
  app.write('content/工作/A/摘要.md', '---\ntype: source-summary\nsource: content/工作/A/资料.txt\n---\n原摘要')
  await app.core.syncIndex()
  const id = app.core.jobs.enqueuePath('summarize-file', 'content/工作/A/资料.txt', { force: true, summaryPath: 'content/工作/A/摘要.md' })
  await app.call('folder:move', { path: 'content/工作/A', toDir: 'content/生活', name: 'B' })
  await app.core.jobs.drain()
  const job = app.core.jobs.latestByKey(pathJobKey('summarize-file', 'content/生活/B/资料.txt'))
  expect(job?.error).toBeUndefined()
  expect(job).toMatchObject({ jobId: id, state: 'done' })
  expect((await app.core.vault.read({ path: 'content/生活/B/摘要.md' })).body).toContain('材料中的明确事实')
  expect(app.core.files.summaries('content/生活/B/资料.txt')).toEqual(['content/生活/B/摘要.md'])
})
