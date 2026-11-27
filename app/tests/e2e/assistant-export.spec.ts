import { modelSettings } from '../helpers/models'
import fs from 'node:fs'
import path from 'node:path'
import type { ChatMessage } from '../../shared/types'
import { test, expect, callOnPage } from './file-fixture'
import { launch, shot } from './helpers'
import { agentScript, chunkIds, isAgentRequest, isCompactionRequest, startFakeLlm } from '../helpers/fake-llm'
import type { Page, ElectronApplication } from '@playwright/test'

async function setTarget(app: ElectronApplication, target: string | null): Promise<void> {
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: filePath === null, filePath: filePath ?? '' })
  }, target)
}
async function history(page: Page): Promise<void> {
  if (!(await page.getByTestId('agent').isVisible())) await page.keyboard.press('Control+l')
  await page.getByTestId('agent-history').click()
}
async function exportCurrent(page: Page, format: 'markdown' | 'jsonl'): Promise<void> {
  await page.getByTestId('agent-conversation').first().getByTestId('conversation-more').click()
  await page.getByTestId('conversation-export-' + format).click()
}
const jsonlMessages = (file: string): ChatMessage[] => fs.readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(row => row.type === 'message').map(row => row.message)

test('历史菜单导出 Markdown／JSONL，取消不写，失败可重试；来源链接与原消息保留，深浅窄窗可用', async ({ jot }) => {
  const { page, call, launched, write } = jot
  const source = 'content/工作/材料.md', markdown = path.join(launched.workDir, '导出讨论.md'), jsonl = path.join(launched.workDir, '讨论.jsonl')
  write(source, '项目甲：完成接口联调，下一步准备压测。')
  const fake = await startFakeLlm(agentScript([
    () => ({ toolCall: { name: 'read', arguments: { path: source } } }),
    results => '项目甲完成接口联调[^' + chunkIds(results[0]!)[0] + ']。',
  ]))
  try {
    await call('settings:set', { ...modelSettings({ baseUrl: fake.baseUrl, model: 'fake', apiKey: 'fake' }, await call('settings:get', undefined)) })
    await page.keyboard.press('Control+l')
    await page.getByTestId('agent-input').fill('核对项目甲的进展')
    await page.getByTestId('agent-send').click()
    await expect(page.getByTestId('agent-stop')).toHaveCount(0)
    const id = (await call('agent:conversations', {})).items[0]!.conversationId
    const before = (await call('agent:get', { conversationId: id })).messages
    const requests = fake.requests.length
    await history(page)
    await page.getByTestId('agent-conversation').first().click({ button: 'right' })
    await expect(page.getByTestId('conversation-export-markdown')).toBeVisible()
    await expect(page.getByTestId('conversation-export-jsonl')).toBeVisible()
    await shot(page, 'assistant-export-menu-light')
    await setTarget(launched.app, null)
    await page.getByTestId('conversation-export-markdown').click()
    await expect(page.getByTestId('conversation-menu')).toHaveCount(0)
    expect(fs.existsSync(markdown)).toBe(false)
    await setTarget(launched.app, path.join(launched.workDir, '错误扩展名.txt'))
    await exportCurrent(page, 'markdown')
    await expect(page.getByTestId('conversation-export-error')).toContainText('请选择 .md')
    await page.getByRole('dialog', { name: '导出失败', exact: true }).getByRole('button', { name: '关闭', exact: true }).last().click()
    await setTarget(launched.app, markdown)
    await exportCurrent(page, 'markdown')
    await expect.poll(() => fs.existsSync(markdown)).toBe(true)
    const body = fs.readFileSync(markdown, 'utf8')
    expect(body).toContain('项目甲完成接口联调')
    expect(body).toContain('read · 成功')
    expect(body).toContain(encodeURI('R2虚构库/content/工作/材料.md'))
    expect(body).not.toMatch(/\[\^[0-9a-f]{6}\]/)
    await setTarget(launched.app, jsonl)
    await exportCurrent(page, 'jsonl')
    await expect.poll(() => fs.existsSync(jsonl)).toBe(true)
    expect(jsonlMessages(jsonl)).toEqual(before)
    expect((await call('agent:get', { conversationId: id })).messages).toEqual(before)
    expect(fake.requests).toHaveLength(requests)
    await page.keyboard.press('Escape')
    await page.getByTestId('theme-toggle').click()
    await page.setViewportSize({ width: 640, height: 800 })
    await history(page)
    await page.getByTestId('agent-conversation').first().getByTestId('conversation-more').click()
    await expect(page.getByTestId('conversation-export-jsonl')).toBeVisible()
    await shot(page, 'assistant-export-menu-dark-narrow')
  } finally { await fake.close() }
})

test('插件技能、多轮后台摘要、重启恢复和完整会话导出组合；删对话后导出文件与保存笔记保留', async ({ jot }) => {
  const { page, call, launched, write } = jot
  const source = 'content/工作/项目甲/进展.md', output = path.join(launched.workDir, '长会话.jsonl')
  const summary = '用户正在整理项目甲进展，要求按模板提供事实与待办。后续继续核对实际记录，写出笔记前选择明确目录。'
  write(source, '项目甲：完成接口联调。')
  const fake = await startFakeLlm(agentScript([
    () => ({ toolCall: { name: 'use_skill', arguments: { name: 'work-review:weekly-report', path: 'references/outline.md' } } }),
    () => ({ toolCall: { name: 'read', arguments: { path: source } } }),
    results => '项目甲完成接口联调[^' + chunkIds(results[1]!)[0] + ']。',
  ], req => isCompactionRequest(req) ? summary : '好'))
  let resumed: Awaited<ReturnType<typeof launch>> | undefined
  try {
    await call('settings:set', { ...modelSettings({ baseUrl: fake.baseUrl, model: 'fake', apiKey: 'fake', contextWindow: 32768 }, await call('settings:get', undefined)) })
    await page.keyboard.press('Control+l')
    await expect(page.getByTestId('agent-select')).toHaveText('通用助手')
    for (let i = 0; i < 7; i++) {
      await page.getByTestId('agent-input').fill((i === 0 ? '$work-review:weekly-report ' : '') + '第' + i + '轮要求，' + '方案细节'.repeat(360))
      await page.getByTestId('agent-send').click()
      await expect(page.getByTestId('agent-answer')).toHaveCount(i + 1)
      await expect(page.getByTestId('agent-stop')).toHaveCount(0)
    }
    await expect.poll(() => fake.requests.filter(isCompactionRequest).length).toBeGreaterThan(0)
    const id = (await call('agent:conversations', {})).items[0]!.conversationId
    const saved = await call('doc:create', { dir: 'content/工作', title: '已审阅的项目进展', body: '用户单独保存的笔记，删除对话后保留。' })
    const before = (await call('agent:get', { conversationId: id })).messages
    await launched.close()
    resumed = await launch({ reuse: launched, isolateHotkey: true })
    const next = resumed.page
    await expect(next.getByTestId('shell')).toBeVisible()
    await history(next)
    await next.getByTestId('agent-conversation').first().locator('.history-main').click()
    await expect(next.getByTestId('agent-answer')).toHaveCount(7)
    await expect(next.getByTestId('agent-select')).toHaveAttribute('title', '通用助手')
    await next.getByTestId('agent-input').fill('按既有要求继续，读取当前材料核对')
    await next.getByTestId('agent-send').click()
    await expect(next.getByTestId('agent-answer')).toHaveCount(8)
    await expect(next.getByTestId('agent-stop')).toHaveCount(0)
    await expect(next.getByTestId('agent-context-budget')).toHaveAttribute('title', /摘要承接较早/)
    const after = (await callOnPage(next, 'agent:get', { conversationId: id })).messages
    expect(after.slice(0, before.length)).toEqual(before)
    expect(after.at(-1)?.context?.agentId).toBe('default')
    expect(JSON.stringify(fake.requests.filter(isAgentRequest).at(-1)!.messages)).toContain(summary)
    await history(next)
    await setTarget(resumed.app, output)
    await exportCurrent(next, 'jsonl')
    await expect.poll(() => fs.existsSync(output)).toBe(true)
    expect(jsonlMessages(output)).toEqual(after)
    const records = fs.readFileSync(output, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    expect(records.some(row => row.type === 'summary' && row.summary === summary)).toBe(true)
    expect(records.filter(row => row.type === 'message' && row.message.role === 'assistant').every(row => row.message.toolCalls.length === 2)).toBe(true)
    await callOnPage(next, 'agent:delete', { conversationId: id })
    expect((await callOnPage(next, 'agent:conversations', {})).total).toBe(0)
    expect(jsonlMessages(output)).toEqual(after)
    expect((await callOnPage(next, 'doc:get', { ref: { path: saved.path } })).body).toContain('用户单独保存')
  } finally { await resumed?.close(); await fake.close() }
})

test('正在回答的会话不能导出，停止后可导出未完成状态及问题', async ({ jot }) => {
  const { page, call, launched } = jot
  let release!: () => void
  const waiting = new Promise<void>(resolve => { release = resolve })
  const fake = await startFakeLlm(agentScript([async () => { await waiting; return '迟到结果' }]))
  const target = path.join(launched.workDir, '停止的会话.jsonl')
  try {
    await call('settings:set', { ...modelSettings({ baseUrl: fake.baseUrl, model: 'fake', apiKey: 'fake' }, await call('settings:get', undefined)) })
    await page.keyboard.press('Control+l')
    await page.getByTestId('agent-input').fill('保留未结束的这个问题')
    await page.getByTestId('agent-send').click()
    await expect(page.getByTestId('agent-stop')).toBeVisible()
    await history(page)
    await setTarget(launched.app, target)
    await exportCurrent(page, 'jsonl')
    await expect(page.getByTestId('conversation-export-error')).toContainText('请先停止回答')
    expect(fs.existsSync(target)).toBe(false)
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
    await page.getByTestId('agent-stop').click()
    await expect(page.getByTestId('agent-stop')).toHaveCount(0)
    await history(page)
    await exportCurrent(page, 'jsonl')
    await expect.poll(() => fs.existsSync(target)).toBe(true)
    expect(jsonlMessages(target).at(-1)?.error).toBe('已停止')
    expect(jsonlMessages(target)[0]?.text).toBe('保留未结束的这个问题')
  } finally { release(); await fake.close() }
})
