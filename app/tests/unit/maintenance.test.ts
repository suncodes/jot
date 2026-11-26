import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { writeFileAtomic } from '../../electron/util/fs'
import { deferred, testApp } from '../helpers/test-app'

let app: Awaited<ReturnType<typeof testApp>>
beforeEach(async () => { app = await testApp(); await app.core.quiesce() })
afterEach(async () => { vi.restoreAllMocks(); await app.close() })
const DAY = 24 * 60 * 60 * 1000
const now = new Date('2026-11-19T12:00:00+08:00')
function temporary(target: string, text = '暂存正文', age = 2 * DAY): string {
  const file = path.join(path.dirname(target), '.jot-write.' + path.basename(target) + '.' + process.pid + '.' + randomUUID() + '.tmp')
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text)
  fs.utimesSync(file, new Date(now.getTime() - age), new Date(now.getTime() - age))
  return file
}
const policy = (days: 0 | 30) => app.call('settings:set', { maintenance: { trashRetentionDays: days } })

it('维护占用按内容、成果、配置、回收和数据库分开统计，默认手动且不调用模型', async () => {
  app.write('ideas/2026/11/无属性.md', '长期灵感')
  app.write('inbox/2026/11/资料.txt', '待归档原件')
  app.write('journal/2026/2026-11-19.md', '---\ntype: daily\n---\n人工保留的总结')
  app.write('.jot/skills/自建/SKILL.md', '技能正文')
  await app.call('vault:refreshIndex', {})
  const conversation = await app.call('agent:create', undefined)
  const usage = await app.call('maintenance:usage', undefined)
  expect(usage).toMatchObject({ vaultPath: app.root, conversations: { count: 1, messages: 0 }, trash: { items: 0, expiredItems: 0 }, temporary: { files: 0 } })
  expect(usage.contentBytes).toBe(Buffer.byteLength('长期灵感待归档原件'))
  expect(usage.derivedBytes).toBeGreaterThan(0)
  expect(usage.configurationBytes).toBeGreaterThan(0)
  expect(usage.databases.map(db => db.kind)).toEqual(['index', 'state'])
  expect(usage.databases.every(db => db.bytes > 0 && db.walBytes >= 0 && db.reclaimableBytes >= 0)).toBe(true)
  expect((await app.call('settings:get', undefined)).maintenance).toEqual({ trashRetentionDays: 0 })
  expect((await app.call('agent:get', { conversationId: conversation.conversationId })).info).toEqual(conversation)
  expect(app.fake.requests).toHaveLength(0)
})

it('回收默认不删除；开启后按实际满 30 天判断，当前项和未满期限保留，空年月收口', async () => {
  app.clock('2026-10-20T12:00:00+08:00')
  const first = await app.call('doc:create', { title: '满期限', dir: 'content/工作' })
  const expired = await app.call('library:delete', { path: first.path, scope: 'entry' })
  app.clock('2026-10-20T12:00:01+08:00')
  const next = await app.call('doc:create', { title: '差一秒', dir: 'content/工作' })
  const retained = await app.call('library:delete', { path: next.path, scope: 'entry' })
  app.clock('2026-11-19T12:00:00+08:00')
  const current = await app.call('doc:create', { title: '当日', dir: 'content/工作' })
  const recent = await app.call('library:delete', { path: current.path, scope: 'entry' })
  app.core.maintenance.reset(); await app.core.maintenance.tick()
  expect((await app.call('trash:list', {})).total).toBe(3)
  expect((await app.call('maintenance:usage', undefined)).trash.expiredItems).toBe(1)
  await policy(30)
  app.core.maintenance.reset(); await app.core.maintenance.tick()
  expect((await app.call('trash:list', {})).items.map(i => i.trashId).sort()).toEqual([retained.trashId, recent.trashId].sort())
  await expect(app.call('doc:restore', { trashId: expired.trashId })).rejects.toThrow('NOT_FOUND')
  const restored = await app.call('doc:restore', { trashId: retained.trashId })
  expect(fs.existsSync(app.file(restored.path))).toBe(true)
  await app.call('trash:purge', { trashIds: [recent.trashId] })
  expect(fs.readdirSync(app.file('.jot/trash'))).toEqual([])
})

it('策略关闭跨重启保留过期回收组、原件和 sidecar 及摘要可一起恢复', async () => {
  app.clock('2026-09-01T10:00:00+08:00')
  const source = 'content/工作/资料.txt', summary = 'wiki/sources/2026/09/资料.md'
  app.write(source, '原件不丢')
  app.write(source + '.meta.yaml', 'tags: [人工]\n')
  app.write(summary, '---\ntype: source-summary\nsource: ' + source + '\n---\n人工摘要')
  await app.call('vault:refreshIndex', {})
  const removed = await app.call('library:delete', { path: source, scope: 'entry' })
  await policy(30); await policy(0)
  app.clock('2026-11-19T12:00:00+08:00')
  await app.reopen()
  expect((await app.call('settings:get', undefined)).maintenance.trashRetentionDays).toBe(0)
  expect((await app.call('trash:list', {})).items[0]!.trashId).toBe(removed.trashId)
  await app.call('doc:restore', { trashId: removed.trashId })
  expect(fs.readFileSync(app.file(source), 'utf8')).toBe('原件不丢')
  expect(fs.readFileSync(app.file(source + '.meta.yaml'), 'utf8')).toContain('人工')
  expect(fs.readFileSync(app.file(summary), 'utf8')).toContain('人工摘要')
})

it('满期限目录回收组按组清理，另一个未到期附件组保留且可恢复', async () => {
  app.clock('2026-09-01T10:00:00+08:00')
  await app.call('vault:createFolder', { parent: 'content/工作', name: '过期目录' })
  app.write('content/工作/过期目录/笔记.md', '笔记')
  app.write('content/工作/过期目录/附件.txt', '附件')
  app.write('content/工作/过期目录/附件.txt.meta.yaml', 'tags: [资料]\n')
  await app.call('vault:refreshIndex', {})
  const removed = await app.call('folder:delete', { path: 'content/工作/过期目录' })
  app.clock('2026-11-19T12:00:00+08:00')
  app.write('inbox/2026/11/近期.txt', '近期原件')
  await app.call('vault:refreshIndex', {})
  const kept = await app.call('library:delete', { path: 'inbox/2026/11/近期.txt', scope: 'entry' })
  await policy(30)
  app.core.maintenance.reset(); await app.core.maintenance.tick()
  expect((await app.call('trash:list', {})).items.map(i => i.trashId)).toEqual([kept.trashId])
  await expect(app.call('folder:restore', { trashId: removed.trashId })).rejects.toThrow('NOT_FOUND')
  await app.call('doc:restore', { trashId: kept.trashId })
  expect(fs.readFileSync(app.file('inbox/2026/11/近期.txt'), 'utf8')).toBe('近期原件')
})

it('回收时间无效时保留；真正删除前回读时间，后来修改的回收项不会被自动清理', async () => {
  app.clock('2026-09-01T10:00:00+08:00')
  const note = await app.call('doc:create', { title: '时间待核对', dir: 'content/工作' })
  const { trashId } = await app.call('library:delete', { path: note.path, scope: 'entry' })
  const meta = app.file('.jot/trash/2026/09/' + trashId + '/meta.json')
  const original = JSON.parse(fs.readFileSync(meta, 'utf8'))
  fs.writeFileSync(meta, JSON.stringify({ ...original, deletedAt: '不是有效时间' }))
  app.clock('2026-11-19T12:00:00+08:00'); await policy(30)
  app.core.maintenance.reset(); await app.core.maintenance.tick()
  expect((await app.call('trash:list', {})).total).toBe(1)
  fs.writeFileSync(meta, JSON.stringify(original))
  const purge = app.core.vault.purgeTrash.bind(app.core.vault)
  vi.spyOn(app.core.vault, 'purgeTrash').mockImplementationOnce(async (ids, predicate) => {
    fs.writeFileSync(meta, JSON.stringify({ ...original, deletedAt: '2026-11-19T12:00:00+08:00' }))
    await purge(ids, predicate)
  })
  app.core.maintenance.reset(); await app.core.maintenance.tick()
  expect((await app.call('trash:list', {})).total).toBe(1)
})

it('临时清理只删可识别过期残留；近期、最终文件缺失、普通 tmp 与用户成果保留', async () => {
  const note = app.file('ideas/2026/11/灵感.md')
  app.write('ideas/2026/11/灵感.md', '永久正文')
  const eligible = temporary(note)
  app.write('.jot/assistant.json', '{"agents":[]}')
  const configTemporary = temporary(app.file('.jot/assistant.json'), '配置残留')
  const recent = temporary(note, '近期未完成', DAY - 1)
  const missing = temporary(app.file('content/工作/只剩临时.md'))
  const userTmp = app.file('content/工作/我自己的.tmp')
  fs.writeFileSync(userTmp, '我的文件')
  app.write('wiki/sources/2026/11/摘要.md', '人工摘要')
  app.write('journal/2026/2026-11-19.md', '人工日总结')
  const before = await app.call('maintenance:usage', undefined)
  expect(before.temporary).toMatchObject({ files: 2, retainedFiles: 2, bytes: Buffer.byteLength('暂存正文配置残留') })
  const result = await app.call('maintenance:clearTemporary', { vaultPath: app.root, confirmed: true })
  expect(result).toEqual({ removed: 2, freedBytes: Buffer.byteLength('暂存正文配置残留'), failures: [] })
  expect(fs.existsSync(eligible)).toBe(false)
  expect(fs.existsSync(configTemporary)).toBe(false)
  expect(fs.readFileSync(app.file('.jot/assistant.json'), 'utf8')).toBe('{"agents":[]}')
  for (const file of [note, recent, missing, userTmp, app.file('wiki/sources/2026/11/摘要.md'), app.file('journal/2026/2026-11-19.md')]) expect(fs.existsSync(file)).toBe(true)
  expect(app.fake.requests).toHaveLength(0)
})

it('在用原子写即使 mtime 很旧仍保留；完成后没有残留，写入失败也清理自己的临时文件', async () => {
  const rel = 'ideas/2026/11/正在保存.md', absolute = app.file(rel)
  app.write(rel, '旧内容')
  const gate = deferred(), arrived = deferred()
  const rename = fs.promises.rename.bind(fs.promises)
  let holding = ''
  vi.spyOn(fs.promises, 'rename').mockImplementationOnce(async (from, to) => {
    holding = String(from)
    fs.utimesSync(holding, new Date('2026-01-01'), new Date('2026-01-01'))
    arrived.release(); await gate.promise; await rename(from, to)
  })
  const writing = writeFileAtomic(absolute, '新的完整内容')
  try {
    await arrived.promise
    expect((await app.call('maintenance:usage', undefined)).temporary.retainedFiles).toBe(1)
    expect((await app.call('maintenance:clearTemporary', { vaultPath: app.root, confirmed: true })).removed).toBe(0)
    expect(fs.existsSync(holding)).toBe(true)
  } finally { gate.release(); await writing }
  expect(fs.readFileSync(absolute, 'utf8')).toBe('新的完整内容')
  expect(fs.existsSync(holding)).toBe(false)
  const write = fs.promises.writeFile.bind(fs.promises)
  vi.spyOn(fs.promises, 'writeFile').mockImplementationOnce(async (...args: Parameters<typeof fs.promises.writeFile>) => {
    await write(...args); throw new Error('模拟写入失败')
  })
  await expect(writeFileAtomic(absolute, '失败内容')).rejects.toThrow('模拟写入失败')
  expect((await app.call('maintenance:usage', undefined)).temporary.files).toBe(0)
  expect(fs.readFileSync(absolute, 'utf8')).toBe('新的完整内容')
})

it('清理不跟随库内链接，单个文件被占用时返回部分失败并保留该文件', async () => {
  const absolute = app.file('content/工作/正式.md')
  app.write('content/工作/正式.md', '最终正文')
  const first = temporary(absolute), second = temporary(absolute, '可删除')
  fs.mkdirSync(path.join(app.tmp.dir, 'outside'), { recursive: true })
  const outside = path.join(app.tmp.dir, 'outside', '外部.md')
  fs.writeFileSync(outside, '外部不碰')
  const linked = temporary(outside)
  fs.symlinkSync(path.dirname(outside), app.file('ideas/链接'), 'junction')
  const unlink = fs.promises.unlink.bind(fs.promises)
  vi.spyOn(fs.promises, 'unlink').mockImplementation(async (target) => {
    if (target === first) throw Object.assign(new Error('文件被占用'), { code: 'EBUSY' })
    await unlink(target)
  })
  const result = await app.call('maintenance:clearTemporary', { vaultPath: app.root, confirmed: true })
  expect(result.removed).toBe(1)
  expect(result.failures[0]?.message).toBe('文件被占用')
  expect(fs.existsSync(first)).toBe(true)
  expect(fs.existsSync(second)).toBe(false)
  expect(fs.existsSync(linked)).toBe(true)
})

it('自动维护启动不压缩、在线按阈值压缩；运行中推迟且未完成和失败任务保留', async () => {
  const index = vi.spyOn(app.core.index, 'maintainStorage'), state = vi.spyOn(app.core.state, 'maintainStorage')
  app.core.maintenance.reset(); await app.core.maintenance.tick()
  expect(index).toHaveBeenLastCalledWith(false, true)
  expect(state).toHaveBeenLastCalledWith(false, true)
  app.clock('2026-11-19T12:11:00+08:00'); await app.core.maintenance.tick()
  expect(index).toHaveBeenLastCalledWith(true, true)
  app.clock('2026-11-19T12:22:00+08:00')
  const gate = deferred(), arrived = deferred()
  app.core.jobs.register('reindex', async () => { arrived.release(); await gate.promise })
  const id = app.core.jobs.enqueue('reindex', {})
  const running = app.core.jobs.drain()
  try {
    await arrived.promise
    await app.core.maintenance.tick()
    expect(index).toHaveBeenCalledTimes(2)
    await expect(app.call('maintenance:optimizeDatabases', { vaultPath: app.root })).rejects.toThrow('CONFLICT')
    expect(app.core.jobs.list({ state: 'running' }).items[0]?.jobId).toBe(id)
  } finally { gate.release(); await running }
  await app.core.maintenance.tick()
  expect(index).toHaveBeenCalledTimes(3)
})

it('数据库维护回收空闲页但保留会话、建议和正文，删除历史对话后实际释放空间', async () => {
  const { conversationId } = await app.call('agent:create', undefined)
  const keep = await app.call('agent:create', undefined)
  const statement = app.core.state.raw.prepare('INSERT INTO messages(id,conversation_id,role,text,created_at) VALUES (?,?,?,?,?)')
  const body = '大段虚构问答'.repeat(600)
  app.core.state.raw.transaction(() => {
    for (let i = 0; i < 600; i++) statement.run('message-' + i, conversationId, 'user', body, now.toISOString())
    statement.run('keep', keep.conversationId, 'user', '保留的问答', now.toISOString())
  })()
  app.write('content/工作/正文.md', '不参与数据库清理')
  app.core.state.setSuggestion('content/工作/正文.md', { kind: 'properties', properties: { tags: ['待确认'] }, confidence: 0.5, reason: '保留建议' })
  await app.call('vault:refreshIndex', {})
  const before = (await app.call('maintenance:usage', undefined)).databases.find(db => db.kind === 'state')!
  await app.call('agent:delete', { conversationId })
  const compact = await app.call('maintenance:optimizeDatabases', { vaultPath: app.root })
  expect(compact.failures).toEqual([])
  expect(compact.freedBytes).toBeGreaterThan(0)
  const after = (await app.call('maintenance:usage', undefined)).databases.find(db => db.kind === 'state')!
  expect(after.bytes + after.walBytes).toBeLessThan(before.bytes + before.walBytes)
  expect((await app.call('agent:get', { conversationId: keep.conversationId })).messages[0]?.text).toBe('保留的问答')
  expect(app.core.state.getSuggestion('content/工作/正文.md', 'properties')).not.toBeNull()
  expect(fs.readFileSync(app.file('content/工作/正文.md'), 'utf8')).toBe('不参与数据库清理')
  await app.reopen()
  expect((await app.call('agent:conversations', {})).total).toBe(1)
})

it('维护拒绝未确认清理、任意删除路径、非法保留期限以及换库前旧目标', async () => {
  for (const args of [{}, { vaultPath: app.root, confirmed: false }, { vaultPath: app.root, confirmed: true, path: app.file('content') }]) {
    await expect(app.call('maintenance:clearTemporary', args as { vaultPath: string; confirmed: true })).rejects.toThrow('INVALID_INPUT')
  }
  await expect(app.call('settings:set', { maintenance: { trashRetentionDays: 1 } } as never)).rejects.toThrow('INVALID_INPUT')
  await expect(app.call('maintenance:clearTemporary', { vaultPath: app.tmp.dir, confirmed: true })).rejects.toThrow('CONFLICT')
  await expect(app.call('maintenance:optimizeDatabases', { vaultPath: app.tmp.dir })).rejects.toThrow('CONFLICT')
})

it('自动临时清理按在线周期运行，策略重新加载仍只保存 0 或 30 天', async () => {
  const rel = 'ideas/2026/11/灵感.md'
  app.write(rel, '长期内容')
  const stale = temporary(app.file(rel))
  app.core.maintenance.reset(); await app.core.maintenance.tick()
  expect(fs.existsSync(stale)).toBe(false)
  await policy(30); await app.reopen()
  expect((await app.call('settings:get', undefined)).maintenance.trashRetentionDays).toBe(30)
  expect(fs.readFileSync(app.file(rel), 'utf8')).toBe('长期内容')
  expect(app.fake.requests).toHaveLength(0)
})

it('默认手动的目录回收内容不参与临时清理，回收内过期 tmp 成组恢复', async () => {
  const directory = 'content/工作/保留目录'
  app.write(directory + '/正文.md', '连同临时残留保留')
  const file = temporary(app.file(directory + '/正文.md'))
  await app.call('vault:refreshIndex', {})
  const removed = await app.call('folder:delete', { path: directory })
  expect((await app.call('maintenance:usage', undefined)).temporary.files).toBe(0)
  expect((await app.call('maintenance:clearTemporary', { vaultPath: app.root, confirmed: true })).removed).toBe(0)
  app.core.maintenance.reset(); await app.core.maintenance.tick()
  await app.call('folder:restore', { trashId: removed.trashId })
  expect(fs.existsSync(file)).toBe(true)
  expect(fs.readFileSync(app.file(directory + '/正文.md'), 'utf8')).toBe('连同临时残留保留')
})
