import { modelSettings } from '../helpers/models'
import fs from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { test, expect, callOnPage } from './file-fixture'
import { launch, shot } from './helpers'
import { agentScript, startFakeLlm } from '../helpers/fake-llm'

async function ask(page: Page, text: string) {
  await page.getByTestId('agent-input').fill(text)
  await page.getByTestId('agent-send').click()
}
async function done(page: Page, count: number) {
  await expect(page.getByTestId('agent-answer')).toHaveCount(count)
  await expect(page.getByTestId('agent-stop')).toHaveCount(0)
}
async function latest(page: Page) {
  const id = (await callOnPage(page, 'agent:conversations', {})).items[0]!.conversationId
  return callOnPage(page, 'agent:get', { conversationId: id })
}

test('同一对话建目录笔记、属性归档、回收恢复，界面即时刷新且重启保留', async ({ jot }) => {
  const { page, call, vault, launched } = jot
  const base = 'content/U2工作', file = base + '/业务规则.md'
  const fake = await startFakeLlm(agentScript([
    () => ({ toolCall: { name: 'app_help', arguments: { group: 'records' } } }),
    () => ({ toolCall: { name: 'create_folder', arguments: { parent: 'content', name: 'U2工作' } } }),
    () => ({ toolCall: { name: 'app_manage', arguments: { operation: 'records.note', args: { title: '业务规则', body: '这是需要核对的业务规则。' } } } }),
    results => ({ toolCall: { name: 'set_properties', arguments: { path: JSON.parse(results[2]!).path, patch: { tags: ['业务'], people: ['张工'] } } } }),
    results => ({ toolCall: { name: 'app_manage', arguments: { operation: 'pending.accept', args: { path: JSON.parse(results[2]!).path, kind: 'directory', toDir: base } } } }),
    () => ({ toolCall: { name: 'trash', arguments: { paths: [file] } } }),
    results => ({ toolCall: { name: 'app_manage', arguments: { operation: 'trash.restore', args: { ids: [JSON.parse(results[5]!)[0].trashId] } } } }),
    () => '业务规则已归档、回收并恢复。',
  ]))
  let resumed: Awaited<ReturnType<typeof launch>> | undefined
  try {
    await call('settings:set', { ...modelSettings({ baseUrl: fake.baseUrl, model: 'fake', apiKey: 'fake' }, await call('settings:get', undefined)) })
    await page.getByTestId('ribbon-library').click(); await page.getByTestId('library-all').click()
    await page.keyboard.press('Control+l')
    await ask(page, '新建U2工作目录及业务规则，打标签、归档，再回收并恢复')
    const confirmation = page.getByTestId('agent-confirmation')
    await expect(confirmation).toContainText(file)
    expect(fs.existsSync(path.join(vault, file))).toBe(true)
    await shot(page, 'u2-file-confirm-light')
    await page.getByTestId('agent-confirm-approve').click()
    await done(page, 1)
    const data = await latest(page), id = data.info.conversationId
    expect(data.messages.at(-1)?.toolCalls?.every(tool => tool.ok)).toBe(true)
    await expect(page.getByTestId('library-sidebar').locator('[data-path="content/U2工作"]')).toBeVisible()
    await expect(page.locator('[data-testid="library-item"][data-path="content/U2工作/业务规则.md"]')).toBeVisible()
    expect(fs.readFileSync(path.join(vault, file), 'utf8')).toContain('tags:')
    expect((await call('classify:inbox', {})).total).toBe(0)
    expect((await call('trash:list', {})).total).toBe(0)
    await launched.close()
    resumed = await launch({ reuse: launched, llmBaseUrl: fake.baseUrl, isolateHotkey: true })
    await expect(resumed.page.getByTestId('shell')).toBeVisible()
    expect((await callOnPage(resumed.page, 'agent:get', { conversationId: id })).messages.at(-1)?.toolCalls).toHaveLength(7)
    expect((await callOnPage(resumed.page, 'doc:get', { ref: { path: file } })).classification.tags).toEqual(['业务'])
  } finally { await resumed?.close(); await fake.close() }
})

test('全局解除及永久清理确认可取消，深色窄窗可操作，助手设置立即同步界面', async ({ jot }) => {
  const { page, call, write, vault } = jot
  const file = 'content/工作/U2标签.md'
  write(file, '---\ntags: [待解除]\n---\n人工正文')
  await call('vault:refreshIndex', {})
  const fake = await startFakeLlm(agentScript([
    () => ({ toolCall: { name: 'app_manage', arguments: { operation: 'terms.remove', args: { kind: 'tag', name: '待解除' } } } }),
    () => '按用户选择结束操作。',
  ]))
  try {
    await call('settings:set', { ...modelSettings({ baseUrl: fake.baseUrl, model: 'fake', apiKey: 'fake' }, await call('settings:get', undefined)) })
    await page.keyboard.press('Control+l')
    await ask(page, '全局解除待解除标签')
    await expect(page.getByTestId('agent-confirmation')).toContainText(file)
    await page.getByTestId('agent-confirm-reject').click()
    await done(page, 1)
    expect((await call('doc:get', { ref: { path: file } })).classification.tags).toEqual(['待解除'])
    fake.setResponder(agentScript([
      () => ({ toolCall: { name: 'app_manage', arguments: { operation: 'settings.set', args: { appearance: { theme: 'dark' } } } } }),
      () => '主题已切换。',
    ]))
    await ask(page, '切换深色主题')
    await done(page, 2)
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await page.setViewportSize({ width: 740, height: 800 })
    fake.setResponder(agentScript([
      () => ({ toolCall: { name: 'app_manage', arguments: { operation: 'terms.remove', args: { kind: 'tag', name: '待解除' } } } }),
      () => '已解除标签。',
    ]))
    await ask(page, '确认解除标签')
    await expect(page.getByTestId('agent-confirmation').last()).toContainText(file)
    await shot(page, 'u2-term-confirm-dark-narrow')
    await page.getByTestId('agent-confirm-approve').click()
    await done(page, 3)
    expect((await call('doc:get', { ref: { path: file } })).classification.tags).toEqual([])
    const item = await call('doc:delete', { ref: { path: file } })
    fake.setResponder(agentScript([
      () => ({ toolCall: { name: 'app_manage', arguments: { operation: 'trash.purge', args: { ids: [item.trashId] } } } }),
      () => '按确认结果处理。',
    ]))
    await ask(page, '永久清理刚才的回收项')
    await expect(page.getByTestId('agent-confirmation').last()).toContainText('无法恢复')
    await page.getByTestId('agent-confirm-reject').click()
    await done(page, 4)
    expect((await call('trash:list', {})).total).toBe(1)
    await ask(page, '继续清理这个回收项')
    await page.getByTestId('agent-confirm-approve').click()
    await done(page, 5)
    expect((await call('trash:list', {})).total).toBe(0)
    expect(fs.existsSync(path.join(vault, file))).toBe(false)
    const current = (await latest(page)).info.conversationId
    fake.setResponder(agentScript([
      () => ({ toolCall: { name: 'app_manage', arguments: { operation: 'conversations.delete', args: { ids: [current] } } } }),
      () => '请在对话结束后使用历史菜单删除。',
    ]))
    await ask(page, '删除当前对话')
    await done(page, 6)
    expect((await latest(page)).messages.at(-1)?.toolCalls?.[0]).toMatchObject({ ok: false, output: expect.stringContaining('当前会话') })
  } finally { await fake.close() }
})

test('后台任务返回排队状态、真实编号及取消结果，不把已安排显示成已完成', async ({ jot }) => {
  const { page, call } = jot
  const note = await call('doc:create', { title: 'U2待分析', body: '待归档资料' })
  const fake = await startFakeLlm(agentScript([
    () => ({ toolCall: { name: 'app_manage', arguments: { operation: 'pending.analyze', args: { path: note.path } } } }),
    results => ({ toolCall: { name: 'app_manage', arguments: { operation: 'jobs.get', args: { jobId: JSON.parse(results[0]!).jobId } } } }),
    results => ({ toolCall: { name: 'app_manage', arguments: { operation: 'jobs.cancel', args: { jobId: JSON.parse(results[0]!).jobId } } } }),
    () => '已安排的分析任务已取消。',
  ]))
  try {
    await call('settings:set', { ...modelSettings({ baseUrl: fake.baseUrl, model: 'fake', apiKey: 'fake' }, await call('settings:get', undefined)) })
    await page.keyboard.press('Control+l')
    await ask(page, '安排资料分析，查看状态，然后取消')
    await done(page, 1)
    const data = await latest(page), tools = data.messages.at(-1)!.toolCalls!
    expect(JSON.parse(tools[0]!.output!)).toMatchObject({ status: 'scheduled', jobId: expect.any(String) })
    expect(JSON.parse(tools[2]!.output!)).toMatchObject({ state: 'cancelled' })
    const id = JSON.parse(tools[0]!.output!).jobId
    expect((await call('jobs:list', { states: ['cancelled'] })).items.some(item => item.jobId === id)).toBe(true)
  } finally { await fake.close() }
})

test('畸形工具参数显示完整原文和明确原因，字段纠正后可继续保存与回读', async ({ jot }) => {
  const { page, call, vault } = jot
  const name = '纠正后保存'
  const malformed = JSON.stringify({ operation: 'records.note', args: { title: name, dir: 'content/工作', body: '这是完整保留的失败参数。'.repeat(150) } }) + 'JSON之外的错误尾部'
  const fake = await startFakeLlm(agentScript([
    () => ({ toolCall: { name: 'app_manage', arguments: malformed } }),
    () => ({ toolCall: { name: 'app_manage', arguments: { operation: 'records.note', args: { body: '缺少标题' } } } }),
    () => ({ toolCall: { name: 'app_manage', arguments: { operation: 'records.note', args: { title: name, dir: 'content/工作', body: '只有这次成功写入。' } } } }),
    results => ({ toolCall: { name: 'read', arguments: { path: JSON.parse(results[2]!).path } } }),
    () => '已纠正参数，保存并核对当前文件。',
  ]))
  try {
    await call('settings:set', { ...modelSettings({ baseUrl: fake.baseUrl, model: 'fake', apiKey: 'fake' }, await call('settings:get', undefined)) })
    await page.keyboard.press('Control+l')
    await ask(page, '创建笔记并检查实际结果')
    await done(page, 1)
    const answer = page.getByTestId('agent-answer')
    await expect(answer).toContainText('保存并核对')
    const malformedStep = answer.getByTestId('agent-tool').filter({ hasText: '参数 JSON 格式错误' })
    await expect(malformedStep).toHaveCount(1)
    await expect(malformedStep).toContainText('JSON之外的错误尾部')
    await expect(malformedStep).toContainText('本次未执行')
    const validationStep = answer.getByTestId('agent-tool').filter({ hasText: '参数校验失败' })
    await expect(validationStep).toHaveCount(1)
    await expect(validationStep).toContainText('app_manage 完整调用示例')
    const message = (await latest(page)).messages.at(-1)!
    expect(message.toolCalls?.map(tool => tool.ok)).toEqual([false, false, true, true])
    expect(message.toolCalls?.[0]?.input).toBe(malformed)
    expect(message.parts?.filter(part => part.type === 'tool')).toHaveLength(4)
    expect(fs.readFileSync(path.join(vault, 'content/工作/纠正后保存.md'), 'utf8')).toContain('只有这次成功写入')
  } finally { await fake.close() }
})
