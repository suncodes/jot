import { modelSettings } from '../helpers/models'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'
import { agentScript, chunkIds, isAgentRequest, startFakeLlm, type FakeChatRequest } from '../helpers/fake-llm'
import { callOnPage } from '../e2e/file-fixture'
import { selectOption, windowByUrl } from '../e2e/helpers'
import { localDay } from '../../electron/util/time'

test('U7发布包：完整能力资源、建库捕获、助手写入、四类后台、独立整理及重建后保留', async () => {
  const exe = path.resolve(process.env.JOT_PACKED_EXE ?? path.join(import.meta.dirname, '../../dist/win-unpacked/Jot.exe'))
  expect(fs.existsSync(exe)).toBe(true)
  const plugins = path.join(path.dirname(exe), 'resources/plugins')
  expect(fs.readdirSync(plugins).sort()).toEqual(['jot-core', 'jot-productivity', 'work-review'])
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jot-u7-release-')), data = path.join(root, 'data'), vault = path.join(root, '虚构库')
  const folder = 'content/工作/交付', now = new Date(); now.setHours(12, 0, 0, 0)
  const background = (request: FakeChatRequest): string => {
    const system = String(request.messages[0]?.content)
    return JSON.stringify(system.includes('任务技能：jot-core:content-organize')
      ? { directoryPath: folder, tags: ['Jot'], people: [], place: null, confidence: 0.9, reason: '明确记录' }
      : system.includes('任务技能：jot-core:daily-review')
        ? { oneLine: '你完成了交付核对', done: ['完成接口验收'], highlights: [], followUps: [] }
        : system.includes('任务技能：jot-core:term-organize')
          ? { groups: [{ names: ['Jot', 'Jot笔记'], suggested: 'Jot', reason: '同一软件' }] }
          : { oneLine: '交付附件摘要', points: ['采用接口甲，预算0.3万元'], entities: null })
  }
  const fake = await startFakeLlm(agentScript([
    () => ({ toolCall: { name: 'create_folder', arguments: { parent: 'content/工作', name: '交付' } } }),
    () => ({ toolCall: { name: 'write_files', arguments: { files: [{ path: folder + '/规则.md', body: '保留原规则。\n\n[附件](附件.txt)' }] } } }),
    () => ({ toolCall: { name: 'read', arguments: { path: folder + '/规则.md' } } }),
    results => '已创建目录和当前规则[^' + chunkIds(results[2]!)[0] + ']。',
  ], background))
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && !entry[0].startsWith('JOT_')))
  Object.assign(env, { JOT_USER_DATA: data, JOT_NO_DOTENV: '1', JOT_TEST_NOW: now.toISOString() })
  let app = await electron.launch({ executablePath: exe, env })
  try {
    await app.evaluate(({ globalShortcut }) => { globalShortcut.unregisterAll(); globalShortcut.register = () => true })
    let page = await windowByUrl(app, 'index.html')
    expect(await app.evaluate(({ app }) => app.isPackaged)).toBe(true)
    await page.getByTestId('vault-path').fill(vault); await page.getByTestId('vault-use').click()
    await expect(page.getByTestId('dev-model')).toHaveCount(0)
    await page.getByTestId('model-skip').click(); await page.getByTestId('onboarding-start').click()
    await expect(page.getByTestId('shell')).toBeVisible()
    expect(await callOnPage(page, 'settings:testModel', { baseUrl: fake.baseUrl, model: 'u7-release', apiKey: 'release-fake-secret', reasoningEffort: 'auto' })).toMatchObject({ ok: true })
    expect(fake.requests[0]).not.toHaveProperty('reasoning_effort')
    await callOnPage(page, 'settings:set', { ...modelSettings({ baseUrl: fake.baseUrl, model: 'u7-release', apiKey: 'release-fake-secret', contextWindow: 65536, reasoningEffort: 'high' }, await callOnPage(page, 'settings:get', undefined)), daily: { enabled: false }, classify: { enabled: true } })
    const catalog = await callOnPage(page, 'capabilities:catalog', undefined)
    expect(catalog.agents.map(agent => agent.id)).toEqual(['default'])
    expect(catalog.tools).toHaveLength(18); expect(catalog.skills).toHaveLength(9)
    expect(catalog.plugins.every(plugin => plugin.enabled && !plugin.issues.length)).toBe(true)
    for (const skill of catalog.skills) {
      expect((await callOnPage(page, 'capabilities:readResource', { owner: 'skill', id: skill.id, path: 'SKILL.md' })).length).toBeGreaterThan(50)
    }
    for (const [skill, file] of [['skill-manager', 'actions'], ['research-brief', 'evidence'], ['knowledge-organize', 'outline']])
      expect(fs.readFileSync(path.join(plugins, 'jot-productivity/skills', skill!, 'references', file + '.md'), 'utf8').length).toBeGreaterThan(100)
    expect(fs.readFileSync(path.join(plugins, 'work-review/skills/weekly-report/references/outline.md'), 'utf8')).toContain('本周完成')
    await page.keyboard.press('Control+l')
    await selectOption(page, 'agent-reasoning-effort', 'low')
    await expect(page.getByTestId('agent-reasoning-effort')).toBeVisible()
    await expect(page.getByTestId('agent-reasoning-effort')).toHaveText('低')
    await expect(page.getByTestId('app-dialog')).toHaveCount(0)
    await page.getByTestId('agent-input').fill('新建交付目录和规则笔记，并回读核对。'); await page.getByTestId('agent-send').click()
    await expect(page.getByTestId('agent-stop')).toHaveCount(0)
    await expect(page.getByTestId('agent-answer').locator('a.cite.valid')).toHaveCount(1)
    const id = (await callOnPage(page, 'agent:conversations', {})).items[0]!.conversationId
    expect(fake.requests.filter(isAgentRequest).every(request => request.reasoning_effort === 'low')).toBe(true)
    const capture = page.getByTestId('capture-bar')
    await capture.getByTestId('capture-input').fill('今天明确完成接口验收。')
    const bounds = await capture.boundingBox(), content = await page.getByTestId('content').boundingBox()
    await capture.getByTestId('capture-input').press('Enter')
    await expect(page.getByTestId('toast').filter({ hasText: '已保存到灵感' })).toBeVisible()
    expect(await capture.boundingBox()).toEqual(bounds); expect(await page.getByTestId('content').boundingBox()).toEqual(content)
    await expect.poll(async () => (await callOnPage(page, 'classify:inbox', {})).items.length).toBe(1)
    const idea = (await callOnPage(page, 'classify:inbox', {})).items[0]!.doc.path
    await expect.poll(async () => (await callOnPage(page, 'classify:inbox', {})).items[0]?.suggestions.length).toBe(1)
    await callOnPage(page, 'classify:accept', { ref: { path: idea }, kind: 'properties' })
    expect(idea).toMatch(/^ideas\/\d{4}\/\d{2}\//)
    const sourceFile = path.join(root, '附件.txt'), raw = '采用接口甲，预算0.3万元。\r\n'
    fs.writeFileSync(sourceFile, raw)
    const source = (await callOnPage(page, 'files:import', { paths: [sourceFile] })).imported[0]!
    await expect.poll(async () => (await callOnPage(page, 'classify:inbox', {})).items.find(item => item.doc.path === source)?.suggestions.length).toBe(2)
    const summary = (await callOnPage(page, 'files:list', {})).items.find(item => item.path === source)!.summaryPath!
    await callOnPage(page, 'classify:accept', { ref: { path: source }, kind: 'properties' })
    expect(fs.existsSync(path.join(vault, source))).toBe(true)
    await callOnPage(page, 'classify:accept', { ref: { path: source }, kind: 'directory' })
    await callOnPage(page, 'taxonomy:create', { kind: 'tag', name: 'Jot笔记' })
    const synonyms = await callOnPage(page, 'taxonomy:findSynonyms', { kind: 'tag' })
    const daily = await callOnPage(page, 'timeline:generateDaily', { date: localDay(now) })
    for (const jobId of [synonyms.jobId, daily.jobId])
      await expect.poll(async () => (await callOnPage(page, 'jobs:list', { state: 'done' })).items.some(job => job.jobId === jobId)).toBe(true)
    const jobs = (await callOnPage(page, 'jobs:list', { state: 'done' })).items
    expect(new Set(jobs.map(job => job.type))).toEqual(new Set(['daily', 'classify', 'summarize-file', 'find-synonyms']))
    expect(jobs.every(job => job.execution?.reasoning?.requested === 'high')).toBe(true)
    await callOnPage(page, 'content:move', { path: folder, targetPath: folder + '归档' })
    const moved = folder + '归档/附件.txt'
    expect(fs.readFileSync(path.join(vault, moved), 'utf8')).toBe(raw)
    expect((await callOnPage(page, 'doc:get', { ref: { path: summary } })).sourcePath).toBe(moved)
    await app.evaluate(({ app }) => app.exit(0)); await app.close()
    for (const suffix of ['', '-wal', '-shm']) {
      const index = path.join(vault, '.jot/index.db' + suffix)
      if (fs.existsSync(index)) fs.unlinkSync(index)
    }
    const before = fake.requests.length
    app = await electron.launch({ executablePath: exe, env })
    page = await windowByUrl(app, 'index.html'); await expect(page.getByTestId('shell')).toBeVisible()
    expect(fake.requests).toHaveLength(before)
    expect((await callOnPage(page, 'library:resolve', { path: summary }))?.path).toBe(moved)
    expect((await callOnPage(page, 'agent:get', { conversationId: id })).context?.reasoningEffort).toBe('low')
    expect((await callOnPage(page, 'jobs:list', { state: 'done' })).items.map(job => job.execution)).toEqual(jobs.map(job => job.execution))
    expect((await callOnPage(page, 'taxonomy:synonyms', undefined))).toHaveLength(1)
    expect((await callOnPage(page, 'doc:resolveLink', { from: folder + '归档/规则.md', target: '附件.txt', kind: 'markdown' })).path).toBe(moved)
    expect(fs.readFileSync(path.join(data, 'settings.json'), 'utf8')).not.toContain('release-fake-secret')
  } finally {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); await app.close().catch(() => {})
    await fake.close(); await fs.promises.rm(root, { recursive: true, force: true })
  }
})
