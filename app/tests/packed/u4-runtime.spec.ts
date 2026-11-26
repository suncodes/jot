import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'
import { startFakeLlm } from '../helpers/fake-llm'
import { callOnPage } from '../e2e/file-fixture'
import { windowByUrl } from '../e2e/helpers'
import { localDay } from '../../electron/util/time'

test('U4候选包：实际插件资源、推理请求、日总结保存和重启保留', async () => {
  const exe = path.resolve(process.env.JOT_PACKED_EXE ?? '')
  expect(fs.existsSync(exe)).toBe(true)
  expect(fs.readFileSync(path.join(path.dirname(exe), 'resources/plugins/jot-core/skills/daily-review/SKILL.md'), 'utf8')).toContain('每日回顾')
  const fake = await startFakeLlm(() => JSON.stringify({ oneLine: '你完成了候选包验证', done: ['完成验证'], highlights: [], followUps: [] }))
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'jot-u4-packed-data-'))
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'jot-u4-packed-work-')), vault = path.join(work, '库')
  const now = new Date(); now.setHours(12, 0, 0, 0)
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && !entry[0].startsWith('JOT_')))
  Object.assign(env, { JOT_USER_DATA: data, JOT_NO_DOTENV: '1', JOT_TEST_NOW: now.toISOString() })
  let app = await electron.launch({ executablePath: exe, env })
  try {
    let page = await windowByUrl(app, 'index.html')
    await page.getByTestId('vault-path').fill(vault); await page.getByTestId('vault-use').click()
    await page.getByTestId('model-skip').click(); await page.getByTestId('onboarding-start').click()
    await expect(page.getByTestId('shell')).toBeVisible()
    await callOnPage(page, 'settings:set', { model: { baseUrl: fake.baseUrl, model: 'packed-u4', apiKey: 'fake', reasoningEffort: 'high' }, daily: { enabled: false }, classify: { enabled: false } })
    const catalog = await callOnPage(page, 'capabilities:catalog', undefined)
    expect(catalog.taskBindings.find(binding => binding.task === 'daily')).toMatchObject({ skillId: 'jot-core:daily-review', issues: [] })
    await callOnPage(page, 'capture:save', { text: '今天明确完成候选包验证', source: 'main-window' })
    const date = localDay(now), { jobId } = await callOnPage(page, 'timeline:generateDaily', { date })
    await expect.poll(async () => (await callOnPage(page, 'jobs:list', { state: 'done' })).items.some(job => job.jobId === jobId)).toBe(true)
    expect(fake.requests).toHaveLength(1)
    expect(fake.requests[0]?.reasoning_effort).toBe('high')
    expect(fs.readFileSync(path.join(vault, 'journal', date.slice(0, 4), date + '.md'), 'utf8')).toContain('你完成了候选包验证')
    const job = (await callOnPage(page, 'jobs:list', { state: 'done' })).items.find(job => job.jobId === jobId)!
    expect(job.execution).toMatchObject({ model: 'packed-u4', skillId: 'jot-core:daily-review', reasoning: { requested: 'high', parameters: { reasoning_effort: 'high' } } })
    await app.evaluate(({ app }) => app.exit(0)); await app.close()
    app = await electron.launch({ executablePath: exe, env })
    page = await windowByUrl(app, 'index.html'); await expect(page.getByTestId('shell')).toBeVisible()
    expect((await callOnPage(page, 'settings:get', undefined)).model.reasoningEffort).toBe('high')
    expect((await callOnPage(page, 'jobs:list', { state: 'done' })).items.find(job => job.jobId === jobId)?.execution).toEqual(job.execution)
  } finally {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); await app.close().catch(() => {})
    await fake.close()
    await fs.promises.rm(data, { recursive: true, force: true }); await fs.promises.rm(work, { recursive: true, force: true })
  }
})