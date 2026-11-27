import { modelSettings } from '../helpers/models'
import fs from 'node:fs'
import path from 'node:path'
import { expect, type Page } from '@playwright/test'
import type { ChatMessage } from '../../shared/types'
import type { WorkReportOptions, WorkReportPlan, WorkReportRequest, WorkReportSource } from '../../shared/work-reports'
import { agentScript, type FakeLlm } from '../helpers/fake-llm'
import { callOnPage } from './file-fixture'

export const W5_NOW = new Date(2026, 0, 2, 12)
export const W5_RESTART = new Date(2026, 0, 5, 12)
const command = 'extension:work-diary:today:today'
const row = (page: Page) => page.locator('[data-testid="extension-row"][data-extension="work-diary"]')
const rail = (page: Page) => page.locator('[data-testid="quick-command"][data-command="' + command + '"]')
const skillId = 'work-report:work-report'
const root = 'content/研发/W5工作'
const source: WorkReportSource = { kind: 'profile', extensionId: 'work-diary', profileId: 'today' }
const draft = root + '/草稿/2026年/01月/2、日报/02日草稿.md'
const daily = root + '/提交/2026-01/2、日报/2026-01-02.md'
const weekly = root + '/提交/2026-01/3、周报/2025-12-29~2026-01-02.md'
const monthly = root + '/提交/2025-12/4、月报/2025-12月报.md'
const okr = root + '/提交/2025-12/1、OKR/2025年12月OKR.md'
const decemberDaily = root + '/提交/2025-12/2、日报/2025-12-31.md'
const januaryOkr = root + '/草稿/2026年/01月/1、OKR/2026年01月OKR.md'
const decemberOkr = root + '/草稿/2025年/12月/1、OKR/2025年12月OKR.md'
const engineering = 'content/工程进展/工程甲/2026/2026-01/2026-01-02.md'
const template = 'templates/W5/原始OKR.md'
const reportPaths = [daily, weekly, monthly, okr]

export interface WorkReportState {
  options: WorkReportOptions
  configuration: string
  contents: Record<string, string>
  conversationId: string
}
const file = (vault: string, relative: string) => path.join(vault, relative)
const read = (vault: string, relative: string) => fs.readFileSync(file(vault, relative), 'utf8')
function write(vault: string, relative: string, text: string) {
  const target = file(vault, relative)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, text)
}
async function assistant(page: Page) {
  if (!await page.getByTestId('agent-input').isVisible()) await page.keyboard.press('Control+l')
  if (await page.getByTestId('settings-sidebar').isVisible()) await page.getByTestId('settings-back').click()
}

async function generate(page: Page, fake: FakeLlm, request: WorkReportRequest, materials: string[], summary: string, selected: WorkReportSource = source): Promise<ChatMessage> {
  const writeIndex = 5 + materials.length
  fake.setResponder(agentScript([
    () => ({ toolCall: { name: 'use_skill', arguments: { name: skillId, path: 'references/' + request.kind + '.md' } } }),
    () => ({ toolCall: { name: 'app_help', arguments: { name: 'work_reports.write' } } }),
    () => ({ toolCall: { name: 'app_manage', arguments: { operation: 'work_reports.profiles', args: {} } } }),
    () => ({ toolCall: { name: 'app_manage', arguments: { operation: 'work_reports.prepare', args: { source: selected, request } } } }),
    () => ({ toolCall: { name: 'find_files', arguments: { directory: root, pattern: '**/*.md', limit: 100 } } }),
    ...materials.map(material => () => ({ toolCall: { name: 'read', arguments: { path: material } } })),
    results => {
      const plan = JSON.parse(results[3]!) as WorkReportPlan
      const links = materials.map(material => '- [来源](' + path.posix.relative(path.posix.dirname(plan.path), material).split('/').map(encodeURIComponent).join('/') + ')').join('\n')
      return { toolCall: { name: 'app_manage', arguments: { operation: 'work_reports.write', args: {
        source: selected, request: plan.request, body: '# W5 ' + request.kind + '\n\n' + summary + '\n\n' + links,
      } } } }
    },
    results => {
      const result = JSON.parse(results[writeIndex]!) as { link?: string; failed: unknown[] }
      return result.failed.length ? '保存失败，见工具结果。' : '已保存 ' + result.link + '。' + summary
    },
  ]))
  await assistant(page)
  const input = page.getByTestId('agent-input')
  const previous = await page.getByTestId('agent-answer').count()
  await input.fill('$work-report')
  await page.getByRole('option').filter({ hasText: '工作总结' }).click()
  await input.fill('$' + skillId + ' 生成并保存' + request.kind + '，日期' + request.date + '。'
    + (selected.kind === 'paths' ? '使用以下明确路径：' + JSON.stringify(selected.paths) : '使用已配置的W5工作入口。'))
  await page.getByTestId('agent-send').click()
  await expect(page.getByTestId('agent-answer')).toHaveCount(previous + 1)
  await expect(page.getByTestId('agent-stop')).toHaveCount(0)
  await expect(page.getByTestId('agent-answer').last()).toContainText('已保存')
  await expect(page.getByTestId('agent-confirmation')).toHaveCount(0)
  const id = (await callOnPage(page, 'agent:conversations', {})).items[0]!.conversationId
  const reply = (await callOnPage(page, 'agent:get', { conversationId: id })).messages.at(-1)!
  expect(reply.error).toBeUndefined()
  expect(reply.context?.skillIds).toEqual([skillId])
  expect(reply.toolCalls).toHaveLength(writeIndex + 1)
  expect(reply.toolCalls?.every(tool => tool.ok)).toBe(true)
  const plan = JSON.parse(reply.toolCalls![3]!.output!) as WorkReportPlan
  expect(plan.kind).toBe(request.kind)
  expect(plan.worklogDirectory).toBe('content/工程进展')
  for (const material of materials) expect(reply.toolCalls?.some(tool => tool.name === 'read' && (tool.input as { path?: string }).path === material)).toBe(true)
  expect(reply.toolCalls!.at(-1)!.confirmation).toBeUndefined()
  return reply
}

export async function installAndReport(page: Page, vault: string, fake: FakeLlm): Promise<WorkReportState> {
  await page.getByTestId('vault-path').fill(vault)
  await page.getByTestId('vault-use').click()
  await page.getByTestId('model-skip').click()
  await page.getByTestId('onboarding-start').click()
  await expect(page.getByTestId('shell')).toBeVisible()
  await page.setViewportSize({ width: 1440, height: 940 })
  await callOnPage(page, 'settings:set', { classify: { enabled: false }, daily: { enabled: false } })
  await page.getByTestId('ribbon-settings').click()
  await page.getByTestId('settings-nav-extensions').click()
  await page.getByTestId('extensions-tab-bundled').click()
  await row(page).getByTestId('extension-install').click()
  await expect(page.getByTestId('extension-ai-select')).not.toBeChecked()
  await page.getByTestId('extension-ai-select').check()
  await page.getByTestId('extension-import-confirm').click()
  await row(page).getByTestId('extension-configure').click()
  await expect(page.getByTestId('extension-ai-state')).toHaveText('已安装 · 已停用')
  await page.getByTestId('extension-profile-edit').click()
  await page.getByTestId('profile-name').fill('W5工作草稿')
  await page.getByTestId('work-root').fill(root)
  await page.getByTestId('work-draft-directory').fill('草稿/{{yyyy}}年/{{MM}}月')
  await page.getByTestId('work-report-directory').fill('提交/{{yyyy}}-{{MM}}')
  await page.getByTestId('work-log-directory').fill('content/工程进展')
  await page.getByTestId('profile-filename').fill('{{dd}}日草稿.md')
  await page.getByTestId('okr-template-copy').click()
  await page.getByTestId('okr-template-copy-target').fill(template)
  await page.getByTestId('okr-template-copy-confirm').click()
  await page.getByTestId('profile-pinned').check()
  await page.getByTestId('profile-save').click()
  await expect(page.getByTestId('extension-profile-editor')).toHaveCount(0)
  await page.getByTestId('extension-enable-detail').click()
  await rail(page).getByRole('button').click()
  const view = page.locator('[data-testid="doc-view"]:visible')
  await expect(view).toHaveAttribute('data-path', draft)
  await view.locator('.cm-content').fill('# 今日工作草稿\n\n工程甲完成静态检查，尚未真实联调，未发布。')
  await view.locator('.cm-content').press('Control+e')
  await expect.poll(() => read(vault, draft)).toContain('尚未真实联调')
  const saved = (await callOnPage(page, 'extensions:configuration', undefined)).extensions['work-diary']!.profiles[0]!
  if (!('root' in saved.options)) throw new Error('工作配置不符')
  const options = saved.options
  const preview = await callOnPage(page, 'extensions:previewWorkReport', options)
  expect(preview.date).toBe('2026-01-02')
  expect(preview.dailyDraft.path).toBe(draft)
  for (const directory of preview.directories) expect(fs.statSync(file(vault, directory)).isDirectory()).toBe(true)
  expect(fs.readdirSync(file(vault, preview.dailyDraft.directory))).toEqual(['02日草稿.md'])
  for (const directory of preview.directories.filter(directory => directory.startsWith(preview.reportDirectory + '/'))) expect(fs.readdirSync(file(vault, directory))).toEqual([])
  expect((await callOnPage(page, 'app:status', undefined)).modelState).toBe('not-configured')
  write(vault, januaryOkr, '# 2026年01月OKR\n\nO1 完成工程甲交付\nKR1 完成真实联调验收。')
  write(vault, decemberOkr, '# 2025年12月OKR\n\nO1 完成方案评审\nKR1 方案甲通过评审。')
  write(vault, decemberDaily, '# 12月31日报\n\n方案甲已通过评审；工程甲实现完成，但未真实联调。')
  write(vault, engineering, '# 工程甲进展\n\n静态检查通过。真实联调待进行，尚未发布。')
  const originalDraft = read(vault, draft), originalOkr = read(vault, decemberOkr), originalJanuaryOkr = read(vault, januaryOkr)
  await callOnPage(page, 'vault:refreshIndex', {})
  await page.getByTestId('ribbon-settings').click()
  await page.getByTestId('settings-nav-extensions').click()
  if (await page.getByTestId('extensions-back').isVisible()) await page.getByTestId('extensions-back').click()
  await row(page).getByTestId('extension-configure').click()
  await page.getByTestId('extension-ai-manage').click()
  await expect(page.getByTestId('cap-plugin-detail')).toContainText('work-report')
  await page.getByTestId('cap-plugin-toggle').click()
  await expect(page.getByTestId('cap-plugin-toggle')).toHaveText('停用')
  await callOnPage(page, 'settings:set', { ...modelSettings({ baseUrl: fake.baseUrl, apiKey: 'w5-fake-secret', model: 'w5-report', contextWindow: 65536 }, await callOnPage(page, 'settings:get', undefined)) })
  const dailyReply = await generate(page, fake, { kind: 'daily', date: '2026-01-02' }, [draft, engineering, januaryOkr], '静态检查通过，尚未真实联调，未发布。')
  expect((JSON.parse(dailyReply.toolCalls![3]!.output!) as WorkReportPlan).path).toBe(daily)
  await callOnPage(page, 'doc:patchProperties', { path: daily, patch: { custom: 'W5人工属性' } })
  const week = await generate(page, fake, { kind: 'weekly', date: '2025-12-31' }, [decemberDaily, daily, decemberOkr, januaryOkr], '跨年周完成方案评审和静态检查；联调待进行，不计为已发布。')
  const weeklyPlan = JSON.parse(week.toolCalls![3]!.output!) as WorkReportPlan
  expect(weeklyPlan).toMatchObject({ from: '2025-12-29', to: '2026-01-02', path: weekly })
  expect(weeklyPlan.months.map(month => month.month)).toEqual(['2025-12', '2026-01'])
  const month = await generate(page, fake, { kind: 'monthly', date: '2025-12-31' }, [weekly, decemberDaily, decemberOkr], '12月方案甲通过评审。仅采用跨年周报中的12月事实，不重复累计。')
  const monthlyPlan = JSON.parse(month.toolCalls![3]!.output!) as WorkReportPlan
  expect(monthlyPlan.path).toBe(monthly)
  expect(monthlyPlan.weekly.some(report => report.path === weekly)).toBe(true)
  await callOnPage(page, 'extensions:setEnabled', { id: 'work-diary', enabled: false })
  expect((await callOnPage(page, 'capabilities:catalog', undefined)).plugins.find(plugin => plugin.id === 'work-report')?.enabled).toBe(true)
  const okrReply = await generate(page, fake, { kind: 'okr', date: '2025-12-31' }, [decemberOkr, monthly], 'O1方案评审已完成。KR1方案甲通过评审；不估算完成百分比。')
  expect((JSON.parse(okrReply.toolCalls![3]!.output!) as WorkReportPlan).path).toBe(okr)
  await callOnPage(page, 'extensions:setEnabled', { id: 'work-diary', enabled: true })
  await callOnPage(page, 'capabilities:setPluginEnabled', { id: 'work-report', enabled: false })
  await rail(page).getByRole('button').click()
  await expect(page.locator('[data-testid="doc-view"]:visible')).toHaveAttribute('data-path', draft)
  await callOnPage(page, 'capabilities:setPluginEnabled', { id: 'work-report', enabled: true })
  for (const target of reportPaths) expect(fs.statSync(file(vault, target)).isFile()).toBe(true)
  expect(read(vault, daily)).toContain('custom: W5人工属性')
  expect(read(vault, decemberOkr)).toBe(originalOkr)
  expect(read(vault, januaryOkr)).toBe(originalJanuaryOkr)
  expect(read(vault, draft)).toBe(originalDraft)
  expect((await callOnPage(page, 'library:query', { scope: { selection: { kind: 'directory', path: root, recursive: true } } })).total).toBeGreaterThanOrEqual(7)
  const conversationId = (await callOnPage(page, 'agent:conversations', {})).items[0]!.conversationId
  await callOnPage(page, 'vault:rebuildIndex', undefined)
  return { options, conversationId, configuration: read(vault, '.jot/app-extensions.json'),
    contents: Object.fromEntries([...reportPaths, draft, decemberOkr, januaryOkr, template].map(relative => [relative, read(vault, relative)])) }
}

export async function resumeAndManage(page: Page, vault: string, fake: FakeLlm, state: WorkReportState): Promise<void> {
  await expect(page.getByTestId('shell')).toBeVisible()
  await page.setViewportSize({ width: 1440, height: 940 })
  expect(read(vault, '.jot/app-extensions.json')).toBe(state.configuration)
  for (const [relative, body] of Object.entries(state.contents)) expect(read(vault, relative)).toBe(body)
  const history = await callOnPage(page, 'agent:get', { conversationId: state.conversationId })
  expect(history.messages).toHaveLength(8)
  expect(history.messages.filter(message => message.role === 'assistant').every(message => message.toolCalls?.at(-1)?.ok)).toBe(true)
  await rail(page).getByRole('button').click()
  const today = await callOnPage(page, 'extensions:previewWorkReport', state.options)
  expect(today.date).toBe('2026-01-05')
  await expect(page.locator('[data-testid="doc-view"]:visible')).toHaveAttribute('data-path', today.dailyDraft.path)
  expect(fs.readdirSync(file(vault, today.dailyDraft.directory)).sort()).toEqual(['02日草稿.md', '05日草稿.md'])
  write(vault, draft, '# 外部更新的草稿\n\n工程甲真实联调通过，未发布。')
  await callOnPage(page, 'vault:refreshIndex', {})
  await assistant(page)
  await page.getByTestId('agent-history').click()
  await page.getByTestId('agent-conversation').first().locator('.history-main').click()
  const reply = await generate(page, fake, { kind: 'daily', date: '2026-01-02' }, [draft, engineering], '根据当前草稿，工程甲真实联调通过；仍未发布。')
  expect(reply.toolCalls![5]!.output).toContain('真实联调通过')
  expect(read(vault, daily)).toContain('真实联调通过')
  expect(read(vault, daily)).toContain('custom: W5人工属性')
  await page.getByTestId('agent-answer').last().getByRole('link', { name: '2026-01-02.md', exact: true }).click()
  await expect(page.locator('[data-testid="doc-view"]:visible')).toHaveAttribute('data-path', daily)
  await expect(page.locator('[data-testid="doc-view"]:visible')).toContainText('真实联调通过')
  await callOnPage(page, 'extensions:uninstall', { id: 'work-diary', confirmed: true })
  expect(fs.existsSync(file(vault, '.jot/app-extensions/work-diary'))).toBe(false)
  expect((await callOnPage(page, 'capabilities:catalog', undefined)).plugins.find(plugin => plugin.id === 'work-report')?.enabled).toBe(true)
  expect(read(vault, template)).toBe(state.contents[template])
  const independent = await generate(page, fake, { kind: 'monthly', date: '2025-12-31' }, [weekly, decemberDaily, decemberOkr],
    '12月方案甲通过评审。仅采用跨年周报中的12月事实，不重复累计。', { kind: 'paths', paths: {
      root: state.options.root, draftDirectory: state.options.draftDirectory, reportDirectory: state.options.reportDirectory,
      worklogDirectory: state.options.worklogDirectory, filename: state.options.filename,
    } })
  expect(JSON.parse(independent.toolCalls![2]!.output!)).toEqual({ profiles: [], issues: [] })
  expect(read(vault, monthly)).toBe(state.contents[monthly])
  await callOnPage(page, 'capabilities:changePlugin', { action: 'remove', id: 'work-report' })
  expect(fs.existsSync(file(vault, '.jot/plugins/work-report'))).toBe(false)
  for (const relative of reportPaths) expect(fs.statSync(file(vault, relative)).isFile()).toBe(true)
  expect(read(vault, decemberOkr)).toBe(state.contents[decemberOkr])
  expect(read(vault, template)).toBe(state.contents[template])
  await callOnPage(page, 'settings:set', { appearance: { theme: 'dark' } })
}

export function removeWorkReportIndex(vault: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    const index = file(vault, '.jot/index.db' + suffix)
    if (fs.existsSync(index)) fs.unlinkSync(index)
  }
}
