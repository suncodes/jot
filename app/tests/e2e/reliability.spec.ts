import fs from 'node:fs'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import type { Args, Channel, Ret } from '../../shared/ipc'
import type { DocMeta } from '../../shared/types'
import type { Result } from '../../shared/result'
import { agentScript, isAgentRequest, startFakeLlm, type FakeLlm } from '../helpers/fake-llm'
import { cleanup, launch, shot, type Launched } from './helpers'

// 隔离虚构库与本地假模型，按上一轮发现的故障操作回归。
let launched: Launched
let page: Page
let vault: string
let fake: FakeLlm
const doc = () => page.locator('[data-testid="doc-view"]:visible')
const assistant = () => page.getByTestId('agent')
const input = () => assistant().getByTestId('agent-input')
async function call<K extends Channel>(channel: K, args: Args<K>): Promise<Ret<K>> {
  const result = await page.evaluate(async (payload: { channel: Channel; args: unknown }) => (window.jot.invoke as (channel: Channel, args: unknown) => Promise<Result<unknown>>)(payload.channel, payload.args), { channel, args }) as Result<Ret<K>>
  if (!result.ok) throw new Error(channel + ': ' + result.error.message)
  return result.data as Ret<K>
}
async function create(title: string, body = '初始正文'): Promise<DocMeta> {
  const item = await call('doc:create', { dir: 'notes', title, body })
  await expect.poll(async () => (await call('doc:quickOpen', { query: title })).some(d => d.path === item.path)).toBe(true)
  return item
}
async function openDoc(title: string): Promise<void> {
  await page.keyboard.press('Control+o')
  await page.getByTestId('quick-open-input').fill(title)
  await expect(page.getByTestId('quick-open-item').first()).toContainText(title)
  await page.getByTestId('quick-open-input').press('Enter')
  await expect(page.getByTestId('quick-open')).toHaveCount(0)
}
async function edit(body: string): Promise<void> {
  if (!await doc().locator('.cm-content').isVisible()) await doc().getByTestId('doc-toggle').click()
  await doc().locator('.cm-content').fill(body)
}
async function ask(text: string): Promise<void> { await input().fill(text); await input().press('Enter') }
async function done(text: string): Promise<void> {
  await expect(assistant().getByTestId('agent-answer').last()).toContainText(text, { timeout: 20000 })
  await expect(assistant().getByTestId('agent-stop')).toHaveCount(0)
}
test.beforeAll(async () => { fake = await startFakeLlm() })
test.afterAll(() => fake.close())
test.beforeEach(async () => {
  fake.setResponder(() => '虚构回答完成。')
  launched = await launch({ llmBaseUrl: fake.baseUrl })
  page = launched.page
  await page.setViewportSize({ width: 1440, height: 940 })
  vault = path.join(launched.workDir, '可靠性回归库')
  await page.getByTestId('vault-path').fill(vault)
  await page.getByTestId('vault-use').click()
  await page.getByTestId('model-next').click()
  await page.getByTestId('onboarding-start').click()
  await expect(page.getByTestId('shell')).toBeVisible()
  await call('settings:set', { classify: { enabled: false }, daily: { enabled: false }, appearance: { theme: 'light' } })
  for (const close of await page.getByTestId('toast').locator('button.close').all()) await close.click()
})
test.afterEach(async () => { await launched?.close(); if (launched) cleanup(launched.userData, launched.workDir) })

test('冲突时关闭、快捷关闭、替换标签和直接改标题均保留草稿，解决后正常改名关闭', async () => {
  const item = await create('冲突保护')
  await create('替换目标')
  await openDoc('冲突保护')
  await expect(doc()).toHaveAttribute('data-path', item.path)
  await edit('仅在本地的冲突草稿')
  const disk = path.join(vault, item.path)
  fs.writeFileSync(disk, fs.readFileSync(disk, 'utf8').replace('初始正文', '外部版本'), 'utf8')
  await expect(doc().getByTestId('doc-conflict')).toBeVisible()
  const tab = page.getByTestId('tab').filter({ has: page.locator('[data-testid="tab-close"]') }).and(page.locator('[data-path="' + item.path + '"]'))
  await tab.getByTestId('tab-close').click()
  await expect(tab).toBeVisible()
  await page.keyboard.press('Control+w')
  await expect(tab).toBeVisible()
  await openDoc('替换目标')
  await expect(doc()).toHaveAttribute('data-path', item.path)
  await doc().getByTestId('doc-title').fill('冲突保护已改名')
  await doc().getByTestId('doc-title').press('Enter')
  await expect(doc().getByTestId('doc-title')).toHaveValue('冲突保护')
  await expect(doc().locator('.cm-content')).toHaveText('仅在本地的冲突草稿')
  expect(fs.existsSync(path.join(vault, 'notes/冲突保护已改名.md'))).toBe(false)
  expect(fs.readFileSync(disk, 'utf8')).toContain('外部版本')
  await shot(page, 'reliability-conflict-preserved')
  await doc().getByTestId('conflict-mine').click()
  await expect(doc().getByTestId('doc-conflict')).toHaveCount(0)
  await doc().getByTestId('doc-title').fill('冲突保护已改名')
  await doc().getByTestId('doc-title').press('Enter')
  await expect(doc()).toHaveAttribute('data-path', 'notes/冲突保护已改名.md')
  expect(fs.readFileSync(path.join(vault, 'notes/冲突保护已改名.md'), 'utf8')).toContain('仅在本地的冲突草稿')
  await page.keyboard.press('Control+w')
  await expect(page.getByTestId('tab').and(page.locator('[data-path="notes/冲突保护已改名.md"]'))).toHaveCount(0)
})

test('自动保存尚在进行时关闭和改标题，等待并保存最新输入', async () => {
  for (const action of ['关闭', '改名']) {
    const item = await create('在途保存' + action)
    await openDoc('在途保存' + action)
    // 只在本次隔离 Electron 中延迟一次真实 IPC，不增加产品测试开关。
    await launched.app.evaluate(({ ipcMain }) => {
      const original = (ipcMain as unknown as { _invokeHandlers: Map<string, (event: unknown, args: unknown) => Promise<unknown>> })._invokeHandlers.get('doc:saveBody')!
      const state = { entered: false, release: () => {} }
      ;(globalThis as unknown as { saveGate: typeof state }).saveGate = state
      let delayed = false
      ipcMain.removeHandler('doc:saveBody')
      ipcMain.handle('doc:saveBody', async (event, args) => {
        if (!delayed) {
          delayed = true
          state.entered = true
          await new Promise<void>(resolve => { state.release = () => { ipcMain.removeHandler('doc:saveBody'); ipcMain.handle('doc:saveBody', original); resolve() } })
        }
        return original(event, args)
      })
    })
    await edit('第一版等待保存')
    await expect.poll(() => launched.app.evaluate(() => (globalThis as unknown as { saveGate: { entered: boolean } }).saveGate.entered)).toBe(true)
    await doc().locator('.cm-content').fill('保存进行中又输入的最新版')
    if (action === '关闭') await page.keyboard.press('Control+w')
    else {
      await doc().getByTestId('doc-title').fill('在途改名已完成')
      await doc().getByTestId('doc-title').press('Enter')
    }
    await expect(doc()).toHaveAttribute('data-path', item.path)
    await launched.app.evaluate(() => (globalThis as unknown as { saveGate: { release: () => void } }).saveGate.release())
    if (action === '关闭') await expect(page.getByTestId('tab').and(page.locator('[data-path="' + item.path + '"]'))).toHaveCount(0)
    else await expect(doc()).toHaveAttribute('data-path', 'notes/在途改名已完成.md')
    const currentPath = action === '关闭' ? item.path : 'notes/在途改名已完成.md'
    expect(fs.readFileSync(path.join(vault, currentPath), 'utf8')).toContain('保存进行中又输入的最新版')
  }
})

test('保存 IO 失败时关闭和改标题保留草稿，重试成功后可以正常关闭', async () => {
  const item = await create('保存失败保护')
  await openDoc('保存失败保护')
  await launched.app.evaluate(({ ipcMain }) => {
    const original = (ipcMain as unknown as { _invokeHandlers: Map<string, (event: unknown, args: unknown) => Promise<unknown>> })._invokeHandlers.get('doc:saveBody')!
    ;(globalThis as unknown as { restoreSave: () => void }).restoreSave = () => { ipcMain.removeHandler('doc:saveBody'); ipcMain.handle('doc:saveBody', original) }
    ipcMain.removeHandler('doc:saveBody')
    ipcMain.handle('doc:saveBody', () => ({ ok: false, error: { code: 'IO_ERROR', message: '虚构写入失败' } }))
  })
  await edit('不能丢失的失败草稿')
  await page.keyboard.press('Control+w')
  await expect(page.getByTestId('toast').filter({ hasText: '请先完成保存或处理冲突' })).toBeVisible()
  await doc().getByTestId('doc-title').fill('失败时不应改名')
  await doc().getByTestId('doc-title').press('Enter')
  await expect(doc().getByTestId('doc-title')).toHaveValue('保存失败保护')
  await expect(doc().locator('.cm-content')).toHaveText('不能丢失的失败草稿')
  await expect(doc()).toHaveAttribute('data-path', item.path)
  expect(fs.readFileSync(path.join(vault, item.path), 'utf8')).toContain('初始正文')
  await launched.app.evaluate(() => (globalThis as unknown as { restoreSave: () => void }).restoreSave())
  await page.keyboard.press('Control+w')
  await expect(page.getByTestId('tab').and(page.locator('[data-path="' + item.path + '"]'))).toHaveCount(0)
  expect(fs.readFileSync(path.join(vault, item.path), 'utf8')).toContain('不能丢失的失败草稿')
})

test('普通设置不中止回答；真正主进程强退后恢复已中断进度，运行详情及主动重试可用', async () => {
  let release!: (value: string) => void
  const pending = new Promise<string>(resolve => { release = resolve })
  fake.setResponder(agentScript([
    () => ({ content: '虚构检索已经开始。', toolCall: { name: 'stats', arguments: { groupBy: 'type' } } }),
    () => pending,
  ]))
  await page.keyboard.press('Control+l')
  const baseline = fake.requests.length
  await ask('进程中断回归问题')
  try {
    await expect.poll(() => fake.requests.slice(baseline).filter(isAgentRequest).length).toBe(2)
    const conv = (await call('agent:conversations', {})).items[0]!
    const live = (await call('agent:get', { conversationId: conv.conversationId })).live!
    expect(live.text).toContain('虚构检索已经开始')
    expect(live.toolCalls![0]!.ok).toBe(true)
    await page.getByTestId('theme-toggle').click()
    await page.keyboard.press('Control+l')
    await page.keyboard.press('Control+l')
    await call('settings:set', { layout: { sideWidth: 270, agentWidth: 500 } })
    expect((await call('agent:get', { conversationId: conv.conversationId })).running).toBe(live.runId)
    const main = await launched.app.evaluate(({ app }) => ({ pid: process.pid, userData: app.getPath('userData') }))
    expect(path.resolve(main.userData)).toBe(path.resolve(launched.userData))
    process.kill(main.pid, 'SIGKILL')
    await expect.poll(() => { try { process.kill(main.pid, 0); return true } catch { return false } }).toBe(false)
    release('强退后的虚构响应')
    await launched.app.close().catch(() => {})
    launched = await launch({ llmBaseUrl: fake.baseUrl, reuse: launched }); page = launched.page
    await expect(page.getByTestId('shell')).toBeVisible()
    const requestCount = fake.requests.length
    const recovered = await call('agent:get', { conversationId: conv.conversationId })
    expect(recovered.messages).toHaveLength(2)
    expect(recovered.messages[1]).toMatchObject({ runState: 'interrupted', runId: live.runId, text: expect.stringContaining('虚构检索已经开始'), toolCalls: [expect.objectContaining({ ok: true })] })
    expect(recovered.running).toBeUndefined()
    await page.getByTestId('ribbon-capabilities').click()
    await page.getByTestId('cap-tab-runs').click()
    await page.getByTestId('cap-list').locator('.row-main').first().click()
    await expect(page.getByTestId('cap-run-detail')).toContainText('已中断')
    await expect(page.getByTestId('cap-run-error')).toContainText('应用意外退出')
    await expect(page.getByTestId('cap-run-detail').getByTestId('agent-tool')).toHaveCount(1)
    await shot(page, 'reliability-interrupted-run-dark')
    await page.getByTestId('theme-toggle').click()
    await shot(page, 'reliability-interrupted-run-light')
    expect(fake.requests.length).toBe(requestCount)
    await page.keyboard.press('Control+l')
    if (!await assistant().isVisible()) await page.keyboard.press('Control+l')
    await assistant().getByTestId('agent-history').click()
    await page.locator('.assistant-history-dialog .history-row').getByRole('button', { name: '进程中断回归问题', exact: true }).click()
    await expect(assistant().getByTestId('agent-message-error')).toContainText('应用意外退出')
    fake.setResponder(agentScript([() => '手动重试成功。']))
    await assistant().getByTestId('agent-retry').click()
    await done('手动重试成功')
    const retried = await call('agent:get', { conversationId: conv.conversationId })
    expect(retried.messages).toHaveLength(4)
    expect(retried.messages.filter(m => m.runState === 'interrupted')).toHaveLength(1)
    await page.getByTestId('ribbon-settings').click()
    await page.getByTestId('settings-backup').locator('summary').click()
    await expect(page.getByTestId('settings-backup')).toContainText('.jot/')
    await expect(page.getByTestId('settings-backup')).toContainText('重建索引')
    await shot(page, 'reliability-backup-hint')
  } finally { release('清理等待') }
})
