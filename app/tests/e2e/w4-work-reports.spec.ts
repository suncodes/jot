import fs from 'node:fs'
import path from 'node:path'
import type { PluginDefinition } from '../../shared/capabilities'
import { createWorkReportOptions, type WorkReportSource } from '../../shared/work-reports'
import { test, expect } from './file-fixture'
import { shot } from './helpers'
import { agentScript, startFakeLlm } from '../helpers/fake-llm'

const options = { ...createWorkReportOptions(), root: 'content/工作(研发)#报告', worklogDirectory: null }
const request = { kind: 'daily' as const, date: '2026-11-19' }
const draft = options.root + '/草稿/2026年11月/2、日报/2026-11-19.md'
const target = options.root + '/AI总结/2026年11月/2、日报/2026-11-19.md'
const source: WorkReportSource = { kind: 'profile', extensionId: 'work-diary', profileId: 'today' }
const report = '# 工作日报\n\n已完成静态检查，尚未真实联调。\n\n[草稿](../../../' + encodeURIComponent('草稿') + '/2026%E5%B9%B411%E6%9C%88/2%E3%80%81%E6%97%A5%E6%8A%A5/2026-11-19.md)'
const nextRead = (text: string) => JSON.parse(text.match(/nextRead: (.+)$/)![1]!)

test('W4：$选择工作总结，默认32K读取唯一配置并直接覆盖正式报告，库内及来源链接可打开', async ({ jot }) => {
  const { page, call, write, vault } = jot
  const fake = await startFakeLlm(agentScript([
    () => ({ toolCall: { name: 'use_skill', arguments: { name: 'work-report:work-report', path: 'references/daily.md' } } }),
    () => ({ toolCall: { name: 'app_help', arguments: { name: 'work_reports.write' } } }),
    () => ({ toolCall: { name: 'app_manage', arguments: { operation: 'work_reports.profiles', args: {} } } }),
    () => ({ toolCall: { name: 'app_manage', arguments: { operation: 'work_reports.prepare', args: { source, request } } } }),
    () => ({ toolCall: { name: 'find_files', arguments: { directory: options.root!, pattern: '**/*.md' } } }),
    () => ({ toolCall: { name: 'read', arguments: { path: draft } } }),
    () => ({ toolCall: { name: 'app_manage', arguments: { operation: 'work_reports.write', args: { source, request, body: report } } } }),
    results => ({ toolCall: { name: 'read', arguments: { path: JSON.parse(results[6]!).path } } }),
    results => '已保存并核对 ' + JSON.parse(results[6]!).link + '。真实联调尚未进行。',
  ]))
  try {
    await call('settings:set', { model: { baseUrl: fake.baseUrl, apiKey: 'fake', model: 'w4-32k', contextWindow: 32768 } })
    const pending = await call('extensions:previewImport', { source: { kind: 'bundled', id: 'work-diary' } })
    await call('extensions:confirmImport', { token: pending!.token, installAiPlugin: true })
    await call('extensions:saveProfile', { id: 'work-diary', profile: { id: 'today', commandId: 'today', name: '真实研发配置', options } })
    await call('capabilities:setPluginEnabled', { id: 'work-report', enabled: true })
    write(draft, '今日进展：完成静态检查，真实联调待进行。')
    write(target, '---\ncustom: 人工保留\n---\n旧日报')
    await call('vault:refreshIndex', {})
    await page.keyboard.press('Control+l')
    const input = page.getByTestId('agent-input')
    await input.fill('$work-report')
    await page.getByRole('option').filter({ hasText: '工作总结' }).click()
    await expect(input).toHaveValue('$work-report:work-report ')
    await input.fill('$work-report:work-report 生成并保存2026-11-19的正式日报。')
    await page.getByTestId('agent-send').click()
    await expect(page.getByTestId('agent-answer')).toHaveCount(1)
    await expect(page.getByTestId('agent-stop')).toHaveCount(0)
    const answer = page.getByTestId('agent-answer')
    await expect(answer).toContainText('已保存并核对')
    await expect(page.getByTestId('agent-confirmation')).toHaveCount(0)
    const id = (await call('agent:conversations', {})).items[0]!.conversationId
    const saved = (await call('agent:get', { conversationId: id })).messages.at(-1)!
    expect(saved.error).toBeUndefined()
    expect(saved.context?.skillIds).toEqual(['work-report:work-report'])
    expect(saved.toolCalls?.every(call => call.ok)).toBe(true)
    expect(saved.toolCalls?.at(-1)).toMatchObject({ name: 'read', input: { path: target }, output: expect.stringContaining('尚未真实联调') })
    expect(saved.budget).toMatchObject({ contextWindow: 32768, blocked: false })
    expect(fs.readFileSync(path.join(vault, target), 'utf8')).toContain('custom: 人工保留')
    expect(fs.readFileSync(path.join(vault, draft), 'utf8')).toBe('今日进展：完成静态检查，真实联调待进行。')
    await answer.getByRole('link', { name: '2026-11-19.md', exact: true }).click()
    const view = page.locator('[data-testid="doc-view"]:visible')
    await expect(view).toContainText('工作日报')
    await expect(view).toContainText('尚未真实联调')
    await shot(page, 'w4-report-link-light')
    await view.getByRole('link', { name: '草稿', exact: true }).click()
    await expect(page.locator('[data-testid="doc-view"]:visible')).toContainText('今日进展：完成静态检查')
  } finally { await fake.close() }
})

test('W4：/引用独立AI包，按明确路径和严格@范围连续读取长单行，保存到另一个目录', async ({ jot }) => {
  const { page, call, write, vault } = jot
  const explicit: WorkReportSource = { kind: 'paths', paths: {
    root: options.root, draftDirectory: options.draftDirectory, reportDirectory: options.reportDirectory,
    worklogDirectory: null, filename: options.filename,
  } }
  const fake = await startFakeLlm(agentScript([
    () => ({ toolCall: { name: 'app_help', arguments: { name: 'work_reports.write' } } }),
    () => ({ toolCall: { name: 'app_manage', arguments: { operation: 'work_reports.profiles', args: {} } } }),
    () => ({ toolCall: { name: 'app_manage', arguments: { operation: 'work_reports.prepare', args: { source: explicit, request } } } }),
    () => ({ toolCall: { name: 'read', arguments: { path: 'content/范围外.md' } } }),
    () => ({ toolCall: { name: 'read', arguments: { path: draft } } }),
    results => ({ toolCall: { name: 'read', arguments: nextRead(results[4]!) } }),
    () => ({ toolCall: { name: 'app_manage', arguments: { operation: 'work_reports.write', args: { source: explicit, request, body: report } } } }),
    results => '已保存 ' + JSON.parse(results[6]!).link + '，只采用指定草稿。',
  ]))
  try {
    const resource = path.resolve(import.meta.dirname, '../../resources/app-extensions/work-diary/ai/work-report')
    const files = ['skills/work-report/SKILL.md', ...['daily', 'weekly', 'monthly', 'okr'].map(kind => 'skills/work-report/references/' + kind + '.md')]
    await call('capabilities:changePlugin', { action: 'save',
      manifest: JSON.parse(fs.readFileSync(path.join(resource, 'plugin.json'), 'utf8')) as PluginDefinition,
      files: files.map(file => ({ path: file, content: fs.readFileSync(path.join(resource, file), 'utf8') })), enabled: true })
    await call('settings:set', { model: { baseUrl: fake.baseUrl, apiKey: 'fake', model: 'w4-64k', contextWindow: 65536 } })
    write(draft, '长文事实'.repeat(1700) + '末尾事实：真实联调未完成。')
    write('content/范围外.md', '不可泄漏的范围外正文')
    await call('vault:refreshIndex', {})
    await page.keyboard.press('Control+l')
    const input = page.getByTestId('agent-input')
    await input.fill('只根据 @' + draft)
    await page.getByTestId('agent-candidates').locator('[data-kind="file"][data-path=' + JSON.stringify(draft) + ']').click()
    await expect(page.getByTestId('agent-unrestrict')).toBeVisible()
    await input.fill('/work-report')
    await page.getByRole('option').filter({ hasText: '工作总结' }).click()
    await expect(input).toHaveValue('/work-report:work-report ')
    await input.fill('/work-report:work-report 按这些路径生成并保存2026-11-19日报：' + JSON.stringify(explicit.paths))
    await page.getByTestId('agent-send').click()
    await expect(page.getByTestId('agent-answer')).toHaveCount(1)
    await expect(page.getByTestId('agent-stop')).toHaveCount(0)
    await expect(page.getByTestId('agent-answer')).toContainText('已保存')
    await expect(page.getByTestId('agent-confirmation')).toHaveCount(0)
    const id = (await call('agent:conversations', {})).items[0]!.conversationId
    const saved = (await call('agent:get', { conversationId: id })).messages.at(-1)!
    expect(saved.error).toBeUndefined()
    expect(saved.context).toMatchObject({ strict: true, skillIds: ['work-report:work-report'], references: [{ kind: 'file', value: draft }] })
    expect(JSON.parse(saved.toolCalls![1]!.output!)).toEqual({ profiles: [], issues: [] })
    expect(saved.toolCalls![3]).toMatchObject({ name: 'read', ok: false, output: expect.stringContaining('限定材料') })
    expect(saved.toolCalls![5]!.output).toContain('末尾事实')
    expect(saved.toolCalls!.at(-1)!.ok).toBe(true)
    expect(fs.existsSync(path.join(vault, '.jot/app-extensions/work-diary'))).toBe(false)
    expect(fs.readFileSync(path.join(vault, target), 'utf8')).toBe(report)
    await call('settings:set', { appearance: { theme: 'dark' } })
    await shot(page, 'w4-independent-report-dark')
  } finally { await fake.close() }
})

test('W4：报告目录被文件占用时真实失败，不显示保存链接或改写占位文件', async ({ jot }) => {
  const { page, call, write, vault } = jot
  const source: WorkReportSource = { kind: 'paths', paths: {
    root: 'content/阻塞', draftDirectory: options.draftDirectory, reportDirectory: options.reportDirectory,
    worklogDirectory: null, filename: options.filename,
  } }
  const fake = await startFakeLlm(agentScript([
    () => ({ toolCall: { name: 'app_manage', arguments: { operation: 'work_reports.write', args: { source, request, body: '不应写入' } } } }),
    results => JSON.parse(results[0]!).failed.length ? '报告保存失败：目标目录被文件占用。' : '不应到达',
  ]))
  try {
    await call('settings:set', { model: { baseUrl: fake.baseUrl, apiKey: 'fake', model: 'w4-failure' } })
    write('content/阻塞', '占位原件')
    await page.keyboard.press('Control+l')
    await page.getByTestId('agent-input').fill('按明确路径生成正式日报：' + JSON.stringify(source.paths))
    await page.getByTestId('agent-send').click()
    await expect(page.getByTestId('agent-answer')).toHaveCount(1)
    await expect(page.getByTestId('agent-stop')).toHaveCount(0)
    await expect(page.getByTestId('agent-answer')).toContainText('报告保存失败')
    await expect(page.getByTestId('agent-answer').getByRole('link')).toHaveCount(0)
    const id = (await call('agent:conversations', {})).items[0]!.conversationId
    const saved = (await call('agent:get', { conversationId: id })).messages.at(-1)!
    expect(saved.toolCalls![0]!.ok).toBe(false)
    const result = JSON.parse(saved.toolCalls![0]!.output!)
    expect(result.updated).toEqual([]); expect(result.failed).toHaveLength(1); expect(result.link).toBeUndefined()
    expect(fs.readFileSync(path.join(vault, 'content/阻塞'), 'utf8')).toBe('占位原件')
  } finally { await fake.close() }
})
