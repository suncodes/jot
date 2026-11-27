import { modelSettings } from '../helpers/models'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'
import { startFakeLlm } from '../helpers/fake-llm'
import { callOnPage } from '../e2e/file-fixture'
import { windowByUrl } from '../e2e/helpers'

test('U5候选包：四类技能资源、三类实际后台任务及全局档位，结果重启保留', async () => {
  const exe = path.resolve(process.env.JOT_PACKED_EXE ?? '')
  expect(fs.existsSync(exe)).toBe(true)
  for (const skill of ['daily-review', 'source-summary', 'content-organize', 'term-organize'])
    expect(fs.readFileSync(path.join(path.dirname(exe), 'resources/plugins/jot-core/skills', skill, 'SKILL.md'), 'utf8')).toContain('name: ' + skill)
  const fake = await startFakeLlm(req => {
    const system = String(req.messages[0]?.content)
    return JSON.stringify(system.includes('任务技能：jot-core:content-organize')
      ? { directoryPath: 'content/工作', tags: ['Jot'], people: [], place: null, confidence: 0.9, reason: '工作资料' }
      : system.includes('任务技能：jot-core:term-organize')
        ? { groups: [{ names: ['Jot', 'Jot笔记'], suggested: 'Jot', reason: '同一软件' }] }
        : { oneLine: '候选包真实资料摘要', points: ['采用接口甲'], entities: null })
  })
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'jot-u5-packed-data-'))
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'jot-u5-packed-work-')), vault = path.join(work, '库')
  const now = new Date(); now.setHours(12, 0, 0, 0)
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && !entry[0].startsWith('JOT_')))
  Object.assign(env, { JOT_USER_DATA: data, JOT_NO_DOTENV: '1', JOT_TEST_NOW: now.toISOString() })
  let app = await electron.launch({ executablePath: exe, env })
  try {
    let page = await windowByUrl(app, 'index.html')
    await page.getByTestId('vault-path').fill(vault); await page.getByTestId('vault-use').click()
    await page.getByTestId('model-skip').click(); await page.getByTestId('onboarding-start').click()
    await expect(page.getByTestId('shell')).toBeVisible()
    await callOnPage(page, 'settings:set', { ...modelSettings({ baseUrl: fake.baseUrl, model: 'packed-u5', apiKey: 'fake', reasoningEffort: 'high' }, await callOnPage(page, 'settings:get', undefined)), daily: { enabled: false }, classify: { enabled: false } })
    const catalog = await callOnPage(page, 'capabilities:catalog', undefined)
    expect(catalog.taskBindings).toHaveLength(4)
    expect(catalog.taskBindings.every(binding => binding.issues.length === 0)).toBe(true)
    const external = path.join(work, '材料.txt'); fs.writeFileSync(external, '原件采用接口甲')
    const source = (await callOnPage(page, 'files:import', { paths: [external] })).imported[0]!
    await expect.poll(async () => (await callOnPage(page, 'jobs:list', { state: 'done' })).items.filter(job => job.type === 'summarize-file').length).toBe(1)
    const summary = (await callOnPage(page, 'files:list', {})).items.find(item => item.path === source)!.summaryPath!
    expect(fs.readFileSync(path.join(vault, summary), 'utf8')).toContain('候选包真实资料摘要')
    const classification = await callOnPage(page, 'classify:rerun', { ref: { path: source } })
    for (const name of ['Jot', 'Jot笔记']) await callOnPage(page, 'taxonomy:create', { kind: 'tag', name })
    const synonyms = await callOnPage(page, 'taxonomy:findSynonyms', { kind: 'tag' })
    for (const jobId of [classification.jobId, synonyms.jobId])
      await expect.poll(async () => (await callOnPage(page, 'jobs:list', { state: 'done' })).items.some(job => job.jobId === jobId)).toBe(true)
    const jobs = (await callOnPage(page, 'jobs:list', { state: 'done' })).items.filter(job => ['summarize-file', 'classify', 'find-synonyms'].includes(job.type))
    expect(jobs).toHaveLength(3)
    for (const job of jobs) expect(job.execution).toMatchObject({ model: 'packed-u5', reasoning: { requested: 'high', source: 'global', parameters: { reasoning_effort: 'high' } } })
    expect(new Set(jobs.map(job => job.execution!.skillId))).toEqual(new Set(['jot-core:source-summary', 'jot-core:content-organize', 'jot-core:term-organize']))
    expect(fake.requests).toHaveLength(3)
    expect(fake.requests.every(req => req.reasoning_effort === 'high')).toBe(true)
    expect(fs.readFileSync(path.join(vault, source), 'utf8')).toBe('原件采用接口甲')
    expect((await callOnPage(page, 'taxonomy:synonyms', undefined))).toHaveLength(1)
    expect((await callOnPage(page, 'classify:inbox', {})).items).toHaveLength(1)
    await app.evaluate(({ app }) => app.exit(0)); await app.close()
    app = await electron.launch({ executablePath: exe, env })
    page = await windowByUrl(app, 'index.html'); await expect(page.getByTestId('shell')).toBeVisible()
    expect((await callOnPage(page, 'jobs:list', { state: 'done' })).items.filter(job => jobs.some(previous => previous.jobId === job.jobId)).map(job => job.execution)).toEqual(jobs.map(job => job.execution))
    expect((await callOnPage(page, 'taxonomy:synonyms', undefined))).toHaveLength(1)
    expect((await callOnPage(page, 'classify:inbox', {})).items).toHaveLength(1)
    expect(fs.readFileSync(path.join(vault, summary), 'utf8')).toContain('skill: jot-core:source-summary')
  } finally {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); await app.close().catch(() => {})
    await fake.close()
    await fs.promises.rm(data, { recursive: true, force: true }); await fs.promises.rm(work, { recursive: true, force: true })
  }
})
