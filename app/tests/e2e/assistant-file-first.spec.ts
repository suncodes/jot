import { absoluteFileHref } from '../../shared/file-links'
import fs from 'node:fs'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import type { Args, Channel, Ret } from '../../shared/ipc'
import type { Result } from '../../shared/result'
import { agentScript, chunkIds, isAgentRequest, startFakeLlm, type FakeLlm } from '../helpers/fake-llm'
import { cleanup, launch, shot, type Launched } from './helpers'

let launched: Launched, page: Page, vault: string, fake: FakeLlm
const file = 'content/工作/采购.md', second = 'content/工作/安排.md'
const agent = () => page.getByTestId('agent')
const input = () => agent().getByTestId('agent-input')
const doc = () => page.locator('[data-testid="doc-view"]:visible')
const readScript = () => agentScript([
  () => ({ toolCall: { name: 'read', arguments: { path: file } } }),
  results => '当前采购内容[^' + chunkIds(results[0]!)[0] + ']。',
])
async function call<K extends Channel>(channel: K, args: Args<K>): Promise<Ret<K>> {
  const result = await page.evaluate(async payload => (window.jot.invoke as (name: string, data: unknown) => Promise<unknown>)(payload.channel, payload.args), { channel, args }) as Result<Ret<K>>
  if (!result.ok) throw new Error(result.error.code + ': ' + result.error.message)
  return result.data
}
function write(rel: string, text: string) {
  const absolute = path.join(vault, rel)
  fs.mkdirSync(path.dirname(absolute), { recursive: true }); fs.writeFileSync(absolute, text)
}
const read = (rel: string) => fs.readFileSync(path.join(vault, rel), 'utf8')
async function ask(text: string) { await input().fill(text); await agent().getByTestId('agent-send').click() }
async function done(n: number) {
  await expect(agent().getByTestId('agent-answer')).toHaveCount(n)
  await expect(agent().getByTestId('agent-stop')).toHaveCount(0)
}
async function open(rel: string) {
  await page.getByTestId('ribbon-library').click(); await page.getByTestId('library-all').click()
  await page.locator('[data-testid="library-item"][data-path=' + JSON.stringify(rel) + ']').getByTestId('library-item-open').click()
}
async function latest() {
  const id = (await call('agent:conversations', {})).items[0]!.conversationId
  return call('agent:get', { conversationId: id })
}

test.beforeEach(async () => {
  fake = await startFakeLlm(agentScript([() => '完成']))
  launched = await launch({ isolateHotkey: true, llmBaseUrl: fake.baseUrl, now: new Date('2026-11-19T12:00:00+08:00') })
  page = launched.page; vault = path.join(launched.workDir, 'R3虚构库')
  await page.setViewportSize({ width: 1440, height: 940 })
  await page.getByTestId('vault-path').fill(vault); await page.getByTestId('vault-use').click()
  await page.getByTestId('model-next').click(); await page.getByTestId('onboarding-start').click()
  await expect(page.getByTestId('shell')).toBeVisible()
  await call('settings:set', { classify: { enabled: false }, daily: { enabled: false } })
  write(file, '---\ntags: [采购]\ncustom: 保留\n---\n原始采购清单。\n')
  write(second, '安排原文。\n')
  await call('vault:refreshIndex', {})
})
test.afterEach(async () => { await launched.close(); await fake.close(); cleanup(launched.userData, launched.workDir) })

test('发送先保存草稿，多轮与重新回答读当前文件，新问题草稿和历史出处保留，重启可续聊', async () => {
  await open(file); await page.keyboard.press('Control+l')
  await expect(agent().getByTestId('agent-references')).toContainText('采购')
  await doc().getByTestId('doc-toggle').click()
  await doc().locator('.cm-content').fill('当前编辑器刚写入的采购清单')
  fake.setResponder(readScript())
  await ask('核对采购内容'); await done(1)
  expect(read(file)).toContain('当前编辑器刚写入')
  expect((await latest()).messages[1]!.toolCalls![0]!.output).toContain('当前编辑器刚写入')
  await agent().getByTestId('agent-user').getByTestId('agent-turn-context').click()
  await expect(page.getByTestId('agent-material-reference')).toContainText('只保留路径选择')
  await expect(page.getByTestId('app-dialog')).not.toContainText('正文快照')
  await page.getByRole('button', { name: '返回对话', exact: true }).click()
  write(file, '外部更新：改买咖啡')
  await call('vault:refreshIndex', {})
  await ask('接着核对'); await done(2)
  expect((await latest()).messages[3]!.toolCalls![0]!.output).toContain('改买咖啡')
  await input().fill('稍后再问的草稿')
  write(file, '最新正文：改买水果')
  await call('vault:refreshIndex', {})
  await agent().getByTestId('agent-answer').last().getByTestId('agent-retry').click()
  await done(3)
  await expect(input()).toHaveValue('稍后再问的草稿')
  expect((await latest()).messages[5]!.toolCalls![0]!.output).toContain('改买水果')
  expect((await latest()).messages[3]!.toolCalls![0]!.output).toContain('改买咖啡')
  await shot(page, 'r3-assistant-current-light')
  await page.getByTestId('theme-toggle').click(); await shot(page, 'r3-assistant-current-dark')
  const id = (await latest()).info.conversationId
  await launched.close()
  launched = await launch({ isolateHotkey: true, llmBaseUrl: fake.baseUrl, reuse: launched }); page = launched.page
  await expect(page.getByTestId('shell')).toBeVisible()
  if (!(await agent().isVisible())) await page.keyboard.press('Control+l')
  await agent().getByTestId('agent-history').click()
  await page.getByTestId('agent-conversation').first().locator('.history-main').click()
  await expect(agent().getByTestId('agent-references')).toContainText('采购')
  await ask('重启后继续'); await done(4)
  const data = await call('agent:get', { conversationId: id })
  expect(data.messages[7]!.toolCalls![0]!.output).toContain('改买水果')
})

test('保存失败时保留编辑器和问题草稿，不请求模型；修复后可继续发送', async () => {
  await open(file); await page.keyboard.press('Control+l')
  await launched.app.evaluate(({ ipcMain }) => {
    const original = (ipcMain as unknown as { _invokeHandlers: Map<string, (event: unknown, args: unknown) => Promise<unknown>> })._invokeHandlers.get('doc:saveBody')!
    ;(globalThis as unknown as { restoreSave: () => void }).restoreSave = () => { ipcMain.removeHandler('doc:saveBody'); ipcMain.handle('doc:saveBody', original) }
    ipcMain.removeHandler('doc:saveBody'); ipcMain.handle('doc:saveBody', () => ({ ok: false, error: { code: 'IO_ERROR', message: '虚构保存失败' } }))
  })
  await doc().getByTestId('doc-toggle').click(); await doc().locator('.cm-content').fill('必须保留的编辑草稿')
  const count = fake.requests.filter(isAgentRequest).length
  await ask('必须保留的问题')
  await expect(agent().getByTestId('agent-error')).toContainText('请先完成保存')
  await expect(input()).toHaveValue('必须保留的问题')
  await expect(doc().locator('.cm-content')).toHaveText('必须保留的编辑草稿')
  expect(fake.requests.filter(isAgentRequest)).toHaveLength(count)
  expect((await call('agent:conversations', {})).total).toBe(0)
  expect(read(file)).toContain('原始采购')
  await launched.app.evaluate(() => (globalThis as unknown as { restoreSave: () => void }).restoreSave())
  fake.setResponder(readScript())
  await page.getByTestId('toast').filter({ hasText: '虚构保存失败' }).getByRole('button', { name: '关闭', exact: true }).click()
  await agent().getByTestId('agent-send').click(); await done(1)
  expect((await latest()).messages[1]!.toolCalls![0]!.output).toContain('必须保留的编辑草稿')
})

test('批量覆盖展示全部目标，确认前不落盘；窄窗口可操作，历史及运行记录保留确认结果', async () => {
  await page.keyboard.press('Control+l')
  fake.setResponder(agentScript([
    () => ({ toolCall: { name: 'write_files', arguments: { files: [{ path: file, body: '---\ncustom: 保留\n---\n确认后的新采购' }, { path: second, body: '确认后的新安排' }] } } }),
    () => '两个文件已保存。',
  ]))
  await ask('将采购和安排按下面内容整篇替换')
  const confirmation = agent().getByTestId('agent-confirmation')
  await expect(confirmation).toContainText(file)
  await expect(confirmation).toContainText(second)
  expect(read(file)).toContain('原始采购')
  expect(read(second)).toContain('安排原文')
  await shot(page, 'r3-confirm-overwrite-light')
  await page.setViewportSize({ width: 1080, height: 800 })
  await page.getByTestId('theme-toggle').click()
  await shot(page, 'r3-confirm-overwrite-dark-narrow')
  await confirmation.getByTestId('agent-confirm-approve').click(); await done(1)
  expect(read(file)).toContain('确认后的新采购')
  expect(read(file)).toContain('custom: 保留')
  expect(read(second)).toContain('确认后的新安排')
  const data = await latest()
  expect(data.messages[1]!.toolCalls![0]!.confirmation!.state).toBe('approved')
  await expect(agent().getByTestId('agent-confirm-approve')).toHaveCount(0)
  await page.setViewportSize({ width: 1440, height: 940 })
  await page.getByTestId('ribbon-capabilities').click(); await page.getByTestId('cap-tab-runs').click()
  await page.getByTestId('cap-list').locator('.row-main').first().click()
  const step = page.getByTestId('cap-run-detail').getByTestId('agent-tool')
  await step.locator('summary').click()
  await expect(step.getByTestId('agent-confirmation')).toContainText('已确认')
  await expect(step.getByTestId('agent-confirm-approve')).toHaveCount(0)
  await shot(page, 'r3-run-file-operation')
})

for (const action of ['取消', '停止'] as const) test('回收等待中' + action + '，文件保持不变，可继续提问', async () => {
  await page.keyboard.press('Control+l')
  fake.setResponder(agentScript([
    () => ({ toolCall: { name: 'trash', arguments: { paths: [file, second] } } }),
    () => '本次未回收。',
  ]))
  await ask('把采购和安排移入回收站')
  await expect(agent().getByTestId('agent-confirmation')).toContainText(file)
  if (action === '取消') await agent().getByTestId('agent-confirm-reject').click()
  else await agent().getByTestId('agent-stop').click()
  await done(1)
  expect(read(file)).toContain('原始采购')
  expect(read(second)).toContain('安排原文')
  if (action === '停止') await expect(agent().getByTestId('agent-message-error')).toContainText('已停止')
  fake.setResponder(agentScript([() => '可以继续。']))
  await ask('接着聊'); await done(2)
  await expect(agent().getByTestId('agent-answer').last()).toContainText('可以继续')
})

test('明确新建、局部修改、属性和移动可连贯执行；工具中心准确区分读写', async () => {
  const created = 'content/工作/新目录/说明.md', moved = 'content/工作/新目录/说明新版.md'
  await page.keyboard.press('Control+l')
  fake.setResponder(agentScript([
    () => ({ toolCall: { name: 'create_folder', arguments: { parent: 'content/工作', name: '新目录' } } }),
    () => ({ toolCall: { name: 'write_files', arguments: { files: [{ path: created, body: '# 说明\n\n第一项：原文\n第二项：保留原文。' }] } } }),
    () => ({ toolCall: { name: 'edit_file', arguments: { path: created, before: '第一项：原文', after: '第一项：已修改' } } }),
    () => ({ toolCall: { name: 'set_properties', arguments: { path: created, patch: { tags: ['测试标签'] } } } }),
    () => ({ toolCall: { name: 'move', arguments: { path: created, targetPath: moved } } }),
    () => '已保存并改名。',
  ]))
  await ask('在工作下新建新目录和说明，修改第一项、加标签后改名说明新版')
  await done(1)
  expect(read(moved)).toContain('第一项：已修改')
  expect(read(moved)).toContain('测试标签')
  expect(fs.existsSync(path.join(vault, created))).toBe(false)
  await expect(agent().getByTestId('agent-confirmation')).toHaveCount(0)
  expect((await latest()).messages[1]!.toolCalls!.every(c => c.ok)).toBe(true)
  await page.getByTestId('ribbon-capabilities').click(); await page.getByTestId('cap-tab-tools').click()
  await page.getByTestId('cap-filter-write').click()
  await expect(page.getByTestId('cap-list').locator('.row-main')).toHaveCount((await call('capabilities:catalog', undefined)).tools.filter(tool => tool.access === 'write').length)
  await expect(page.getByTestId('cap-list')).toContainText('可写')
  await page.getByTestId('cap-list').locator('.row-main').filter({ hasText: '写文件' }).click()
  await expect(page.getByTestId('cap-detail')).toContainText('覆盖文件及回收需确认')
  await shot(page, 'r3-tools-write')
  await page.getByTestId('cap-filter-read').click()
  await expect(page.getByTestId('cap-list').locator('.row-main')).toHaveCount((await call('capabilities:catalog', undefined)).tools.filter(tool => tool.access === 'read').length)
  await expect(page.getByTestId('cap-list')).not.toContainText('写文件')
})

test('绝对路径直接操作库外文件，出处原件与文件链接可打开，保存笔记保留磁盘来源', async () => {
  const external = path.join(launched.workDir, '库外资料'), created = path.join(external, '草稿', '原稿.md')
  const renamed = path.join(external, '定稿 [A] #50%.md'), canonical = renamed.replace(/\\/g, '/')
  const href = absoluteFileHref(canonical)
  await launched.app.evaluate(({ shell }) => {
    const state = globalThis as unknown as { externalOpened: string[] }
    state.externalOpened = []
    shell.openPath = async absolute => { state.externalOpened.push(absolute); return '' }
  })
  await page.keyboard.press('Control+l')
  fake.setResponder(agentScript([
    () => ({ toolCall: { name: 'create_folder', arguments: { parent: external, name: '草稿' } } }),
    () => ({ toolCall: { name: 'write_files', arguments: { files: [{ path: created, body: '---\ncustom: 库外属性\n---\n第一项：准备开始。\n第二项：保留原文。' }] } } }),
    () => ({ toolCall: { name: 'read', arguments: { path: created } } }),
    () => ({ toolCall: { name: 'edit_file', arguments: { path: created, before: '第一项：准备开始。', after: '第一项：已经完成。' } } }),
    () => ({ toolCall: { name: 'move', arguments: { path: created, targetPath: renamed } } }),
    () => ({ toolCall: { name: 'read', arguments: { path: renamed } } }),
    results => '库外材料已修改[^' + chunkIds(results[5]!)[0] + ']。[打开文件](' + href + ')',
  ]))
  await ask('在 ' + external + ' 新建草稿并修改、改名，直接保留在磁盘目录')
  await done(1)
  const message = (await latest()).messages[1]!
  expect(message.toolCalls!.every(tool => tool.ok)).toBe(true)
  expect(message.toolCalls![2]!.output).toContain('custom: 库外属性')
  expect(message.citations![0]!.chunk?.path).toBe(canonical)
  expect(fs.existsSync(created)).toBe(false)
  expect(fs.readFileSync(renamed, 'utf8')).toContain('第一项：已经完成。')
  await expect(agent().getByTestId('agent-confirmation')).toHaveCount(0)
  await agent().locator('a[data-cite]').first().click()
  await page.getByTestId('agent-source-open').click()
  await expect.poll(() => launched.app.evaluate(() => (globalThis as unknown as { externalOpened: string[] }).externalOpened)).toEqual([renamed])
  await agent().locator('.answer a[data-file]').click()
  await expect.poll(() => launched.app.evaluate(() => (globalThis as unknown as { externalOpened: string[] }).externalOpened.length)).toBe(2)

  await agent().getByTestId('agent-save-note').click()
  const dialog = page.getByRole('dialog', { name: '保存为笔记', exact: true })
  await dialog.getByTestId('agent-note-title').fill('外部材料整理')
  await dialog.getByRole('combobox').click()
  await page.getByTestId('select-options').getByRole('option', { name: '工作', exact: true }).click()
  await dialog.getByTestId('agent-note-save').click()
  await expect(doc()).toHaveAttribute('data-path', 'content/工作/外部材料整理.md')
  expect(read('content/工作/外部材料整理.md')).toContain(href)
  await doc().getByTestId('doc-preview').locator('a[data-file]').first().click()
  await expect.poll(() => launched.app.evaluate(() => (globalThis as unknown as { externalOpened: string[] }).externalOpened.length)).toBe(3)
})
