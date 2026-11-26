import fs from 'node:fs'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { AssistantContext } from '@shared/assistant'
import { agentScript, chunkIds } from '../helpers/fake-llm'
import { testApp } from '../helpers/test-app'

let app: Awaited<ReturnType<typeof testApp>>
beforeEach(async () => { app = await testApp() })
afterEach(async () => { await app.close() })

it('目录、关联、标签、附件组与日总结跨重启和索引丢失仍由文件重建', async () => {
  const folder = 'content/工作/客户', source = folder + '/会议.txt', note = folder + '/规则.md'
  await app.call('vault:createFolder', { parent: 'content/工作', name: '客户' })
  await app.call('vault:createFolder', { parent: folder, name: '空目录' })
  app.write(source, '会议资料：明确采用方案甲。')
  app.write(note, '---\ncreated: 2026-11-19\n---\n[会议](会议.txt#决定)\n\n笔记的规则正文。')
  await app.core.syncIndex()
  await app.call('doc:patchProperties', { path: source, patch: { tags: ['规则'], custom: { reviewed: true } } })
  await app.call('doc:setClassification', { ref: { path: note }, patch: { tags: ['规则'] } })
  const record = await app.call('capture:save', { text: '今天明确完成客户评审', source: 'main-window' })
  await app.call('doc:patchProperties', { path: record.path, patch: { related: [folder], tags: ['业务'] } })
  await app.core.files.summarize(source)
  await app.core.idle()
  const summary = app.core.files.summaries(source)[0]!
  expect(await app.call('taxonomy:rename', { kind: 'tag', from: '规则', to: '业务' })).toMatchObject({ affected: 2, failed: [] })
  expect((await app.call('taxonomy:terms', { kind: 'tag' })).find(tag => tag.name === '业务')?.count).toBe(3)
  await app.core.daily.run('2026-11-19')
  const daily = 'journal/2026/2026-11-19.md'
  await app.call('folder:move', { path: folder, toDir: 'content/工作', name: '客户归档' })
  const moved = 'content/工作/客户归档', movedSource = moved + '/会议.txt'
  expect((await app.call('doc:get', { ref: { path: summary } })).sourcePath).toBe(movedSource)
  expect((await app.call('doc:get', { ref: { path: record.path } })).properties?.related).toEqual([folder])
  const raw = fs.readFileSync(app.file(movedSource), 'utf8')
  const originalDaily = fs.readFileSync(app.file(daily), 'utf8')
  expect(decodeURI(originalDaily)).toContain('客户归档/规则.md')
  await app.reopen({ removeIndex: true })
  expect((await app.call('library:query', {})).total).toBe(3)
  expect((await app.call('library:resolve', { path: summary }))?.path).toBe(movedSource)
  expect((await app.call('doc:properties', { path: movedSource })).data).toMatchObject({ tags: ['业务'], custom: { reviewed: true } })
  expect((await app.call('doc:resolveLink', { from: moved + '/规则.md', target: '会议.txt#决定', kind: 'markdown' })).path).toBe(movedSource)
  expect((await app.call('content:directories', { recursive: true })).map(dir => dir.path)).toContain(moved + '/空目录')
  expect((await app.call('timeline:day', { date: '2026-11-19' })).daily?.body).toContain('客户评审')
  expect(fs.readFileSync(app.file(daily), 'utf8')).toBe(originalDaily)

  const trash = await app.call('library:delete', { path: movedSource, scope: 'entry' })
  await app.reopen()
  expect(fs.existsSync(app.file(summary))).toBe(false)
  expect(fs.existsSync(app.file(movedSource + '.meta.yaml'))).toBe(false)
  const restored = await app.call('doc:restore', trash)
  await app.call('vault:rebuildIndex', undefined)
  expect(restored.path).toBe(movedSource)
  expect(fs.readFileSync(app.file(restored.path), 'utf8')).toBe(raw)
  expect((await app.call('library:resolve', { path: summary }))?.path).toBe(movedSource)
  expect((await app.call('taxonomy:terms', { kind: 'tag' })).find(tag => tag.name === '业务')?.count).toBe(3)
})

it('真实助手写入、引用移动与追问跨重启；脱离索引可直接阅读当前资料', async () => {
  const file = 'content/工作/规则.md', moved = 'content/工作/规则新版.md'
  app.write(file, '原规则：保留此段。\n补充段：尚待确认。\n')
  await app.core.syncIndex()
  const context: AssistantContext = { agentId: 'default', strict: true, skillIds: [], references: [{ kind: 'file', value: file, title: '规则' }] }
  const conversation = app.core.agent.create()
  app.fake.setResponder(agentScript([
    () => ({ toolCall: { name: 'read', arguments: { path: file } } }),
    () => ({ toolCall: { name: 'edit_file', arguments: { path: file, before: '尚待确认', after: '已经确认' } } }),
    () => ({ toolCall: { name: 'move', arguments: { path: file, targetPath: moved } } }),
    () => ({ toolCall: { name: 'read', arguments: { path: moved } } }),
    results => '已修改并核对[^' + chunkIds(results[3]!)[0] + ']。',
  ]))
  let run = await app.call('agent:send', { conversationId: conversation.conversationId, text: '确认补充段并改名为规则新版', context })
  await app.core.agent.wait(run.runId)
  let message = app.core.agent.get(conversation.conversationId).messages.at(-1)!
  expect(message.error).toBeUndefined()
  expect(message.toolCalls?.map(call => call.ok)).toEqual([true, true, true, true])
  expect(message.citations?.[0]).toMatchObject({ valid: true, chunk: { path: moved } })
  expect((await app.call('doc:get', { ref: { path: moved } })).body).toContain('已经确认')
  await app.reopen({ removeIndex: true })
  expect(app.core.agent.get(conversation.conversationId).context?.references[0]?.value).toBe(moved)
  app.write(moved, '用户在软件外更新后的当前规则。')
  app.core.index.clear()
  app.fake.setResponder(agentScript([
    () => ({ toolCall: { name: 'read', arguments: { path: moved } } }),
    results => '当前规则[^' + chunkIds(results[0]!)[0] + ']。',
  ]))
  run = await app.call('agent:send', { conversationId: conversation.conversationId, text: '接着核对当前内容' })
  await app.core.agent.wait(run.runId)
  message = app.core.agent.get(conversation.conversationId).messages.at(-1)!
  expect(message.error).toBeUndefined()
  expect(message.toolCalls?.[0]?.output).toContain('用户在软件外更新')
  expect(message.context?.references[0]?.value).toBe(moved)
  expect(fs.existsSync(app.file('.jot/sessions'))).toBe(false)
  expect(app.core.state.raw.pragma('user_version', { simple: true })).toBe(11)
})
