import fs from 'node:fs'
import path from 'node:path'
import { test, expect, callOnPage } from './file-fixture'
import { startFakeLlm, type FakeChatRequest } from '../helpers/fake-llm'
import { launch, selectOption, shot } from './helpers'

const kind = (req: FakeChatRequest) => String(req.messages[0]?.content)
const summary = { oneLine: '接口资料摘要', points: ['明确采用接口甲'], entities: { projects: ['项目甲'], people: [], dates: [], numbers: [] } }
const classified = { directoryPath: 'content/工作', tags: ['项目甲'], people: [], place: null, confidence: 0.9, reason: '规则资料' }

test('四类技能绑定可用，导入摘要和整理建议用全局档位，任务详情和重启保留', async ({ jot }) => {
  const { page, call, launched, vault } = jot
  let resumed: Awaited<ReturnType<typeof launch>> | undefined
  const fake = await startFakeLlm(req => JSON.stringify(kind(req).includes('jot-core:content-organize') ? classified : summary))
  try {
    await call('settings:set', { model: { baseUrl: fake.baseUrl, model: 'u5-model', apiKey: 'fake', reasoningEffort: 'high' }, classify: { enabled: true } })
    const external = path.join(launched.workDir, '接口资料.txt')
    fs.writeFileSync(external, '项目甲明确采用接口甲')
    const { imported } = await call('files:import', { paths: [external] })
    await expect.poll(async () => (await call('jobs:list', { state: 'done' })).items.filter(job => job.type === 'summarize-file' || job.type === 'classify').length).toBe(2)
    const source = imported[0]!
    const item = (await call('files:list', {})).items.find(item => item.path === source)!
    expect(item.summaryPath).toBeTruthy()
    expect(fs.readFileSync(path.join(vault, item.summaryPath!), 'utf8')).toContain('skill: jot-core:source-summary')
    expect(fs.readFileSync(path.join(vault, source), 'utf8')).toBe('项目甲明确采用接口甲')
    expect(fake.requests.every(req => req.reasoning_effort === 'high')).toBe(true)
    await page.getByTestId('ribbon-library').click()
    await page.getByTestId('library-pending').click()
    await page.getByTestId('library-review').click()
    await expect(page.getByTestId('inbox-accept-directory')).toBeVisible()
    await expect(page.getByTestId('inbox-accept-properties')).toBeVisible()
    await shot(page, 'u5-summary-classification-light')
    await page.getByTestId('inbox-accept-properties').click()
    await expect.poll(async () => (await call('doc:get', { ref: { path: source } })).classification.tags).toContain('项目甲')
    expect(fs.existsSync(path.join(vault, source))).toBe(true)
    await page.getByTestId('inbox-accept-directory').click()
    await expect(page.getByTestId('inbox-item')).toHaveCount(0)
    expect(fs.readFileSync(path.join(vault, 'content/工作/接口资料.txt'), 'utf8')).toBe('项目甲明确采用接口甲')
    await page.getByTestId('jobs-open').click()
    await page.locator('[data-testid="jobs-filter"][data-filter="done"]').click()
    const job = page.getByTestId('job').filter({ hasText: '生成摘要' })
    await job.getByTestId('job-execution').locator('summary').click()
    await expect(job).toContainText('jot-core:source-summary')
    await expect(job.getByTestId('reasoning-details')).toContainText('全局设置')
    await shot(page, 'u5-job-execution-light')
    await page.getByTestId('jobs-close').click()
    await page.getByTestId('ribbon-capabilities').click(); await page.getByTestId('cap-tab-skills').click()
    await page.getByTestId('cap-task-bindings').click()
    const dialog = page.getByTestId('app-dialog')
    await expect(dialog).not.toContainText('技能不存在')
    for (const [task, skill] of [['daily', 'daily-review'], ['summarize-file', 'source-summary'], ['classify', 'content-organize'], ['find-synonyms', 'term-organize']])
      await expect(page.getByTestId('cap-task-' + task)).toHaveAttribute('data-value', 'jot-core:' + skill)
    await call('settings:set', { appearance: { theme: 'dark' } }); await page.setViewportSize({ width: 740, height: 820 })
    await shot(page, 'u5-task-bindings-dark-narrow')
    await dialog.getByRole('button', { name: '关闭', exact: true }).click()
    const jobs = (await call('jobs:list', { state: 'done' })).items
    await launched.close(); resumed = await launch({ reuse: launched, isolateHotkey: true })
    await expect(resumed.page.getByTestId('shell')).toBeVisible()
    expect((await callOnPage(resumed.page, 'jobs:list', { state: 'done' })).items.map(job => job.execution)).toEqual(jobs.map(job => job.execution))
  } finally { await resumed?.close(); await fake.close() }
})

test('同义分析使用技能并显示真实结果，用户确认后才合并，缺技能可修复重试', async ({ jot }) => {
  const { page, call, write } = jot
  const fake = await startFakeLlm(() => JSON.stringify({ groups: [{ names: ['Jot', 'Jot笔记'], suggested: 'Jot', reason: '同一软件的名称' }] }))
  try {
    await call('settings:set', { model: { baseUrl: fake.baseUrl, model: 'u5-model', apiKey: 'fake', reasoningEffort: 'medium' } })
    write('content/工作/记录.md', '---\ntags: [Jot, Jot笔记]\n---\n正文保留')
    await call('vault:refreshIndex', {})
    await page.getByTestId('ribbon-library').click(); await page.getByTestId('projects-manage').click()
    await page.getByTestId('taxonomy-find').click()
    await expect(page.getByTestId('taxonomy-suggestion')).toHaveCount(1)
    await expect(page.getByTestId('taxonomy-analysis-note')).toContainText('发现 1 组')
    expect((await call('doc:get', { ref: { path: 'content/工作/记录.md' } })).classification.tags).toEqual(['Jot', 'Jot笔记'])
    const job = (await call('jobs:list', { state: 'done' })).items.find(job => job.type === 'find-synonyms')!
    expect(job.execution).toMatchObject({ skillId: 'jot-core:term-organize', reasoning: { requested: 'medium' } })
    expect(fake.requests[0]?.reasoning_effort).toBe('medium')
    await shot(page, 'u5-term-suggestions-light')
    await page.getByTestId('suggestion-merge').click()
    await expect.poll(async () => (await call('doc:get', { ref: { path: 'content/工作/记录.md' } })).classification.tags).toEqual(['Jot'])
    await call('taxonomy:create', { kind: 'tag', name: 'Jot笔记' })
    await call('capabilities:changeSkill', { action: 'enable', id: 'jot-core:term-organize', enabled: false })
    const before = fake.requests.length
    await page.getByTestId('taxonomy-find').click()
    await expect(page.getByTestId('toast').filter({ hasText: '任务技能不可用' })).toBeVisible()
    expect(fake.requests.length).toBe(before)
    const failed = (await call('jobs:list', { state: 'failed' })).items.find(job => job.type === 'find-synonyms')!
    await call('capabilities:changeSkill', { action: 'enable', id: 'jot-core:term-organize', enabled: true })
    await call('jobs:retry', { jobId: failed.jobId })
    await expect(page.getByTestId('taxonomy-suggestion')).toHaveCount(1)
  } finally { await fake.close() }
})

test('切换任务绑定真实改变下一次摘要，模型默认不发送推理参数，技能不保留旧直连', async ({ jot }) => {
  const { page, call, write, open } = jot
  const fake = await startFakeLlm(req => JSON.stringify({ ...summary, oneLine: kind(req).includes('custom-summary') ? '自定义技能已执行' : '基础技能已执行' }))
  try {
    await call('settings:set', { model: { baseUrl: fake.baseUrl, model: 'u5-model', apiKey: 'fake', reasoningEffort: 'auto' } })
    await call('capabilities:changeSkill', { action: 'save', enabled: true, content: { name: 'custom-summary', title: '自定义摘要', description: '仅处理提供资料', body: '从明确事实中整理摘要', requiredTools: [] } })
    await page.getByTestId('ribbon-capabilities').click(); await page.getByTestId('cap-tab-skills').click(); await page.getByTestId('cap-task-bindings').click()
    await selectOption(page, 'cap-task-summarize-file', 'custom-summary')
    await page.getByTestId('cap-manager-save').click()
    write('content/工作/材料.txt', '原件字节')
    await call('vault:refreshIndex', {})
    await open('content/工作/材料.txt')
    const { jobId } = await call('files:reprocess', { path: 'content/工作/材料.txt' })
    await expect.poll(async () => (await call('jobs:list', { state: 'done' })).items.some(job => job.jobId === jobId)).toBe(true)
    const view = page.locator('[data-testid="file-view"]:visible')
    await expect(view.getByTestId('file-summary')).toBeEnabled()
    await view.getByTestId('file-summary').click()
    await expect(view.getByTestId('doc-preview')).toContainText('自定义技能已执行')
    expect(fake.requests).toHaveLength(1)
    expect(fake.requests[0]).not.toHaveProperty('reasoning_effort')
    expect((await call('jobs:list', { state: 'done' })).items.find(job => job.jobId === jobId)?.execution?.skillId).toBe('custom-summary')
  } finally { await fake.close() }
})
