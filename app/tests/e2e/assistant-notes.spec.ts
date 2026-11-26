import fs from 'node:fs'
import path from 'node:path'
import type { ChatMessage } from '../../shared/types'
import { agentScript, chunkIds, isAgentRequest, startFakeLlm, type FakeLlm } from '../helpers/fake-llm'
import { callOnPage, expect, test } from './file-fixture'
import { launch, shot } from './helpers'

const first = 'content/工作/项目甲/进展.md', second = 'content/工作/项目乙/进展.md'
const reportDir = 'content/工作/工作报告/周报'
const title = '工作周报（2026-11-16—2026-11-19）'
const report = (results: string[]) => '# ' + title + '\n\n## 本周完成\n\n项目甲：完成接口联调[^' + chunkIds(results[2]!)[0] + ']。\n\n## 进行中\n\n项目乙：正在验证性能[^' + chunkIds(results[3]!)[0] + ']。\n\n## 下周计划\n\n项目乙：下周安排压测[^' + chunkIds(results[3]!)[0] + ']。'
const weeklyScript = () => agentScript([
  () => ({ toolCall: { name: 'use_skill', arguments: { name: 'work-review:weekly-report' } } }),
  () => ({ toolCall: { name: 'use_skill', arguments: { name: 'work-review:weekly-report', path: 'references/outline.md' } } }),
  () => ({ toolCall: { name: 'read', arguments: { path: first } } }),
  () => ({ toolCall: { name: 'read', arguments: { path: second } } }),
  report,
])
let fake: FakeLlm
test.beforeEach(async () => { fake = await startFakeLlm(weeklyScript()) })
test.afterEach(async () => { await fake.close() })

test('两目录周报先预览，编辑后选择目录保存，出处可跳原文，同名另存且删除会话后仍有效', async ({ jot }) => {
  const { page, call, write, vault } = jot
  await call('settings:set', { model: { baseUrl: fake.baseUrl, model: 'fake', apiKey: 'fake' } })
  write(first, '---\ncreated: 2026-11-18\n---\n2026-11-18：项目甲完成接口联调。\n')
  write(second, '---\ncreated: 2026-11-19\n---\n2026-11-19：项目乙正在验证性能；下周安排压测。\n')
  fs.mkdirSync(path.join(vault, reportDir), { recursive: true })
  await call('vault:refreshIndex', {})
  await page.keyboard.press('Control+l')
  const agent = page.getByTestId('agent'), input = agent.getByTestId('agent-input')
  await expect(agent.getByTestId('agent-select')).toHaveText('通用助手')
  for (const folder of ['content/工作/项目甲', 'content/工作/项目乙']) {
    await input.fill('@' + folder)
    await page.getByTestId('agent-candidates').locator('[data-kind="folder"][data-path=' + JSON.stringify(folder) + ']').click()
  }
  await expect(agent.getByTestId('agent-references')).toContainText('项目甲')
  await expect(agent.getByTestId('agent-references')).toContainText('项目乙')
  await input.fill('整理 2026-11-16 至 2026-11-19 的工作周报，按项目写，先给我草稿。')
  await agent.getByTestId('agent-send').click()
  await expect(agent.getByTestId('agent-stop')).toHaveCount(0)
  const answer = agent.getByTestId('agent-answer')
  await expect(answer).toContainText('项目甲：完成接口联调')
  await expect(answer.locator('a.cite.valid')).toHaveCount(3)
  expect(fs.readdirSync(path.join(vault, reportDir))).toEqual([])
  const conversation = (await call('agent:conversations', {})).items[0]!.conversationId
  const message: ChatMessage = (await call('agent:get', { conversationId: conversation })).messages.at(-1)!
  expect(message.toolCalls!.map(tool => tool.name)).toEqual(['use_skill', 'use_skill', 'read', 'read'])
  expect(message.toolCalls!.every(tool => tool.ok)).toBe(true)
  expect(message.context?.agent.id).toBe('default')
  expect(message.citations!.map(cite => cite.chunk?.path).sort()).toEqual([first, second].sort())
  const request = fake.requests.find(isAgentRequest)!
  expect(JSON.stringify(request.messages)).toContain('普通问答、建议或草稿回答不写文件')

  await answer.getByTestId('agent-save-note').click()
  const dialog = page.getByRole('dialog', { name: '保存为笔记', exact: true })
  await expect(dialog.getByTestId('agent-note-preview')).toContainText('下周安排压测')
  await expect(dialog.getByTestId('agent-note-title')).toHaveValue(title)
  await expect(dialog.getByTestId('agent-note-save')).toBeDisabled()
  await dialog.getByRole('combobox').click()
  await page.getByTestId('select-options').getByRole('option', { name: '工作/工作报告/周报', exact: true }).click()
  await dialog.getByTestId('agent-note-title').fill('本周汇报')
  expect(await dialog.evaluate(el => Math.round(el.getBoundingClientRect().width))).toBe(760)
  await expect(dialog.getByTestId('agent-note-preview').locator('h2').first()).toHaveCSS('font-size', '15px')
  await shot(page, 'weekly-note-preview-light')
  await dialog.getByTestId('agent-note-toggle').click()
  await dialog.locator('.cm-content').fill(message.text + '\n\n补充：周一和业务方同步压测安排。')
  await dialog.getByTestId('agent-note-toggle').click()
  await expect(dialog.getByTestId('agent-note-preview')).toContainText('周一和业务方同步')
  await dialog.getByTestId('agent-note-save').click()
  await expect(dialog).toHaveCount(0)
  const savedPath = reportDir + '/本周汇报.md'
  await expect(page.locator('[data-testid="doc-view"]:visible')).toHaveAttribute('data-path', savedPath)
  const saved = fs.readFileSync(path.join(vault, savedPath), 'utf8')
  expect(saved).toContain('补充：周一和业务方同步')
  expect(saved).not.toContain('[^')
  expect(saved).toContain('../../')
  expect((await call('links:list', { path: savedPath, direction: 'outgoing' })).map(link => link.path).sort()).toEqual([first, second].sort())
  await page.locator('[data-testid="doc-view"]:visible').getByTestId('doc-preview').getByRole('link').first().click()
  await expect(page.locator('[data-testid="doc-view"]:visible')).toHaveAttribute('data-path', first)
  await expect(answer).not.toContainText('补充：周一和业务方同步')

  await answer.getByTestId('agent-save-note').click()
  await dialog.getByTestId('agent-note-title').fill('本周汇报')
  await dialog.getByRole('combobox').click()
  await page.getByTestId('select-options').getByRole('option', { name: '工作/工作报告/周报', exact: true }).click()
  await dialog.getByTestId('agent-note-save').click()
  await expect(dialog).toHaveCount(0)
  expect(fs.readdirSync(path.join(vault, reportDir)).filter(name => name.endsWith('.md'))).toHaveLength(2)
  expect(fs.readFileSync(path.join(vault, savedPath), 'utf8')).toBe(saved)
  await call('agent:delete', { conversationId: conversation })
  expect((await call('doc:get', { ref: { path: savedPath } })).body).toContain('周一和业务方同步')
  expect((await call('links:list', { path: savedPath, direction: 'outgoing' })).every(link => !link.missing)).toBe(true)
})

test('草稿取消不落盘，保存失败保留修改可重试，深色窄窗和重新选择目录正常', async ({ jot }) => {
  const { page, call, launched, vault } = jot
  await call('settings:set', { model: { baseUrl: fake.baseUrl, model: 'fake', apiKey: 'fake' } })
  fake.setResponder(agentScript([() => '# 可编辑草稿\n\n这是需要人工确认的正文。']))
  await page.keyboard.press('Control+l')
  const agent = page.getByTestId('agent')
  await agent.getByTestId('agent-input').fill('先给我一个草稿')
  await agent.getByTestId('agent-send').click()
  await expect(agent.getByTestId('agent-stop')).toHaveCount(0)
  await agent.getByTestId('agent-save-note').click()
  const dialog = page.getByRole('dialog', { name: '保存为笔记', exact: true })
  await dialog.getByTestId('agent-note-title').fill('已取消的草稿')
  await dialog.getByRole('button', { name: '取消', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  expect((await call('search:query', { text: '已取消的草稿' })).total).toBe(0)
  await page.getByTestId('theme-toggle').click()
  await page.setViewportSize({ width: 640, height: 720 })
  await agent.getByTestId('agent-save-note').click()
  await dialog.getByTestId('agent-note-title').fill('人工确认的草稿')
  await dialog.getByRole('combobox').click()
  await page.getByTestId('select-options').getByRole('option', { name: '工作', exact: true }).click()
  await dialog.getByTestId('agent-note-toggle').click()
  await dialog.locator('.cm-content').fill('# 人工确认\n\n保留我刚补充的内容。')
  await dialog.getByTestId('agent-note-toggle').click()
  await shot(page, 'weekly-note-dark-narrow')
  expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
  await launched.app.evaluate(({ ipcMain }) => {
    const original = (ipcMain as unknown as { _invokeHandlers: Map<string, (event: unknown, args: unknown) => Promise<unknown>> })._invokeHandlers.get('doc:create')!
    ;(globalThis as unknown as { restoreCreate: () => void }).restoreCreate = () => { ipcMain.removeHandler('doc:create'); ipcMain.handle('doc:create', original) }
    ipcMain.removeHandler('doc:create')
    ipcMain.handle('doc:create', () => ({ ok: false, error: { code: 'IO_ERROR', message: '虚构写盘失败' } }))
  })
  await dialog.getByTestId('agent-note-save').click()
  await expect(dialog.getByTestId('agent-note-error')).toContainText('虚构写盘失败')
  await expect(dialog.getByTestId('agent-note-title')).toHaveValue('人工确认的草稿')
  await expect(dialog.getByTestId('agent-note-preview')).toContainText('保留我刚补充')
  expect(fs.existsSync(path.join(vault, 'content/工作/人工确认的草稿.md'))).toBe(false)
  await launched.app.evaluate(() => (globalThis as unknown as { restoreCreate: () => void }).restoreCreate())
  await dialog.getByRole('combobox').click()
  await page.getByTestId('select-options').getByRole('option', { name: '生活', exact: true }).click()
  await dialog.getByTestId('agent-note-save').click()
  await expect(dialog).toHaveCount(0)
  expect(fs.readFileSync(path.join(vault, 'content/生活/人工确认的草稿.md'), 'utf8')).toContain('保留我刚补充的内容')
  expect(fs.existsSync(path.join(vault, 'content/工作/人工确认的草稿.md'))).toBe(false)
})

test('重启后历史回答仍可预览并另存为笔记', async ({ jot }) => {
  const { page, call, write, vault, launched } = jot
  await call('settings:set', { model: { baseUrl: fake.baseUrl, model: 'fake', apiKey: 'fake' } })
  write(first, '项目甲完成接口联调。')
  write(second, '项目乙进行性能验证。')
  await call('vault:refreshIndex', {})
  await page.keyboard.press('Control+l')
  await page.getByTestId('agent-input').fill('给我周报草稿')
  await page.getByTestId('agent-send').click()
  await expect(page.getByTestId('agent-stop')).toHaveCount(0)
  await expect(page.getByTestId('agent-answer')).toContainText('项目甲')
  const id = (await call('agent:conversations', {})).items[0]!.conversationId
  await launched.close()
  const resumed = await launch({ reuse: launched, isolateHotkey: true })
  try {
    const nextPage = resumed.page
    await expect(nextPage.getByTestId('shell')).toBeVisible()
    if (!(await nextPage.getByTestId('agent').isVisible())) await nextPage.keyboard.press('Control+l')
    await nextPage.getByTestId('agent-history').click()
    await nextPage.getByTestId('agent-conversation').first().locator('.history-main').click()
    await nextPage.getByTestId('agent-save-note').click()
    const dialog = nextPage.getByRole('dialog', { name: '保存为笔记', exact: true })
    await dialog.getByTestId('agent-note-title').fill('重启后周报')
    await dialog.getByRole('combobox').click()
    await nextPage.getByTestId('select-options').getByRole('option', { name: '工作', exact: true }).click()
    await dialog.getByTestId('agent-note-save').click()
    await expect(dialog).toHaveCount(0)
    const saved = 'content/工作/重启后周报.md'
    expect((await callOnPage(nextPage, 'links:list', { path: saved, direction: 'outgoing' })).every(link => !link.missing)).toBe(true)
    expect((await callOnPage(nextPage, 'agent:get', { conversationId: id })).messages).toHaveLength(2)
    expect(fs.readFileSync(path.join(vault, saved), 'utf8')).not.toContain('[^')
  } finally { await resumed.close() }
})
