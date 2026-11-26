import fs from 'node:fs'
import path from 'node:path'
import { test, expect } from './file-fixture'
import { launch, selectOption, shot } from './helpers'
import { startFakeLlm } from '../helpers/fake-llm'

test('R9 无模型手动选目录与重名冲突，暂缓不隐藏，等待可取消，窄窗仍可归档', async ({ jot }) => {
  const { page, call, write, vault } = jot
  const rel = 'inbox/2026/11/待归档.md'
  write(rel, '尚未确定目录的资料')
  write('content/工作/待归档.md', '不能覆盖的原文')
  await call('vault:refreshIndex', {})
  await page.getByTestId('ribbon-library').click()
  await page.getByTestId('library-pending').click()
  await page.getByTestId('library-review').click()
  await page.getByTestId('inbox-analyze').click()
  await expect(page.getByTestId('inbox-analysis-status')).toHaveAttribute('data-state', 'waiting-model')
  await expect(page.getByTestId('inbox-analysis-status')).toContainText('还没有配置模型')
  await page.getByTestId('inbox-skip-directory').click()
  await expect(page.getByTestId('inbox-item')).toHaveCount(1)
  await page.getByTestId('inbox-choose-directory').click()
  await selectOption(page, 'inbox-directory-target', 'content/工作')
  await page.getByTestId('inbox-confirm-directory').click()
  await expect(page.getByTestId('inbox-action-error')).toContainText('已存在')
  expect(fs.readFileSync(path.join(vault, rel), 'utf8')).toBe('尚未确定目录的资料')
  expect(fs.readFileSync(path.join(vault, 'content/工作/待归档.md'), 'utf8')).toBe('不能覆盖的原文')
  await shot(page, 'r9-waiting-manual-conflict-light')
  await page.getByTestId('theme-toggle').click()
  await page.setViewportSize({ width: 980, height: 800 })
  await page.getByTestId('inbox-item').click()
  await expect(page.getByTestId('inbox-confirm-directory')).toBeVisible()
  await selectOption(page, 'inbox-directory-target', 'content/生活')
  await shot(page, 'r9-manual-directory-dark-narrow')
  await page.getByTestId('inbox-confirm-directory').click()
  await expect(page.getByTestId('inbox-item')).toHaveAttribute('data-path', 'content/生活/待归档.md')
  await expect(page.getByTestId('inbox-directory-decision')).toHaveCount(0)
  await page.getByTestId('inbox-skip-properties').click()
  await expect(page.getByTestId('inbox-item')).toHaveCount(0)
  expect(fs.readFileSync(path.join(vault, 'content/生活/待归档.md'), 'utf8')).toBe('尚未确定目录的资料')
})

test('R9 低把握建议先确认，属性可调整；更换目录实际移动并保留属性事项', async ({ jot }) => {
  const { page, call, write, vault } = jot
  const fake = await startFakeLlm(() => JSON.stringify({ directoryPath: 'content/工作', tags: ['业务'], place: '公司', people: ['林舟'], confidence: 0.25, reason: '目录只有部分依据，请确认' }))
  const rel = 'inbox/2026/11/业务规则.md'
  try {
    await call('settings:set', { model: { baseUrl: fake.baseUrl, model: 'fake', apiKey: 'fake' } })
    write(rel, '---\ntags: [人工标签]\n---\n虚构业务规则')
    await call('vault:refreshIndex', {})
    await page.getByTestId('ribbon-library').click()
    await page.getByTestId('library-pending').click()
    await page.getByTestId('library-review').click()
    await page.getByTestId('inbox-analyze').click()
    await expect(page.getByTestId('inbox-accept-directory')).toBeVisible()
    await expect(page.getByTestId('inbox-accept-properties')).toBeVisible()
    await expect(page.getByTestId('inbox-properties-decision')).toContainText('把握 25%')
    expect(fs.readFileSync(path.join(vault, rel), 'utf8')).not.toContain('林舟')
    await page.getByTestId('inbox-adjust-properties').click()
    await expect(page.getByTestId('inbox-panel').getByTestId('props-form')).toBeVisible()
    await page.getByTestId('inbox-panel').getByTestId('props-place-input').fill('用户地点')
    await page.getByTestId('inbox-panel').getByTestId('props-place-input').press('Tab')
    await expect(page.getByTestId('inbox-properties-decision')).not.toContainText('公司')
    await expect(page.getByTestId('inbox-accept-properties')).toBeVisible()
    await page.getByTestId('inbox-choose-directory').click()
    await selectOption(page, 'inbox-directory-target', 'content/生活')
    await shot(page, 'r9-independent-low-confidence-light')
    await page.getByTestId('inbox-confirm-directory').click()
    await expect(page.getByTestId('inbox-item')).toHaveAttribute('data-path', 'content/生活/业务规则.md')
    await expect(page.getByTestId('inbox-directory-decision')).toHaveCount(0)
    await page.getByTestId('inbox-accept-properties').click()
    await expect(page.getByTestId('inbox-item')).toHaveCount(0)
    expect(fs.existsSync(path.join(vault, rel))).toBe(false)
    const result = fs.readFileSync(path.join(vault, 'content/生活/业务规则.md'), 'utf8')
    expect(result).toContain('人工标签'); expect(result).toContain('业务'); expect(result).toContain('用户地点'); expect(result).toContain('林舟')
  } finally { await fake.close() }
})

test('R9 内容菜单发起灵感分析，错误反馈跨重启，重试成功无需强制归档', async ({ jot }) => {
  const { page, call, write, launched } = jot
  const rel = 'ideas/2026/11/灵感.md'
  const fake = await startFakeLlm(() => '错误 JSON')
  let resumed: Awaited<ReturnType<typeof launch>> | undefined
  try {
    await call('settings:set', { model: { baseUrl: fake.baseUrl, model: 'fake', apiKey: 'fake' } })
    write(rel, '一条长期灵感')
    await call('vault:refreshIndex', {})
    await page.getByTestId('ribbon-library').click()
    await page.getByTestId('library-all').click()
    await page.locator('[data-testid="library-item"][data-path="' + rel + '"]').getByTestId('content-more').click()
    await page.getByTestId('content-analyze').click()
    await page.getByTestId('library-pending').click()
    await page.getByTestId('library-review').click()
    await expect(page.getByTestId('inbox-analysis-status')).toHaveAttribute('data-state', 'failed')
    await expect(page.getByTestId('inbox-analysis-status')).toContainText('模型两次返回')
    await expect(page.getByTestId('inbox-directory-decision')).toHaveCount(0)
    expect(fake.requests).toHaveLength(2)
    await shot(page, 'r9-failed-idea-light')
    await launched.close()
    resumed = await launch({ reuse: launched })
    const next = resumed.page
    await expect(next.getByTestId('shell')).toBeVisible()
    await next.getByTestId('ribbon-library').click()
    await next.getByTestId('library-pending').click()
    await next.getByTestId('library-review').click()
    await expect(next.getByTestId('inbox-analysis-status')).toHaveAttribute('data-state', 'failed')
    fake.setResponder(() => JSON.stringify({ directoryPath: null, tags: [], people: [], confidence: 0.4, reason: '无需补充属性' }))
    await next.getByTestId('inbox-analyze').click()
    await expect(next.getByTestId('inbox-item')).toHaveCount(0)
    await next.getByTestId('jobs-open').click()
    await next.getByTestId('jobs-filter').filter({ hasText: '近期完成' }).click()
    await expect(next.getByTestId('job-note')).toContainText('空属性无需处理')
    expect(fs.existsSync(path.join(jot.vault, rel))).toBe(true)
  } finally { await resumed?.close(); await fake.close() }
})

test('R9 无推荐结果留说明，空正文不调用模型，人工仍可整理', async ({ jot }) => {
  const { page, call, write } = jot
  const fake = await startFakeLlm(() => JSON.stringify({ directoryPath: null, tags: [], people: [], confidence: 0.1, reason: '正文缺少归属线索' }))
  try {
    await call('settings:set', { model: { baseUrl: fake.baseUrl, model: 'fake', apiKey: 'fake' } })
    write('inbox/2026/11/无推荐.md', '尚不确定用途')
    await call('vault:refreshIndex', {})
    await page.getByTestId('ribbon-library').click()
    await page.getByTestId('library-pending').click()
    await page.getByTestId('library-review').click()
    await page.getByTestId('inbox-analyze').click()
    await expect(page.getByTestId('inbox-analysis-status')).toHaveAttribute('data-state', 'done')
    await expect(page.getByTestId('inbox-analysis-status')).toContainText('未推荐存放目录')
    await expect(page.getByTestId('inbox-properties-decision')).toHaveCount(0)
    await expect(page.getByTestId('inbox-item')).toHaveCount(1)
    const count = fake.requests.length
    write('inbox/2026/11/空白.md', ' ')
    await call('vault:refreshIndex', {})
    await page.getByTestId('inbox-item').filter({ hasText: '空白' }).click()
    await page.getByTestId('inbox-analyze').click()
    await expect(page.getByTestId('inbox-analysis-status')).toHaveAttribute('data-state', 'failed')
    await expect(page.getByTestId('inbox-analysis-status')).toContainText('没有可分析的正文')
    expect(fake.requests).toHaveLength(count)
  } finally { await fake.close() }
})
