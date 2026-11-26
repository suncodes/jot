import fs from 'node:fs'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import type { Args, Channel, Ret } from '../../shared/ipc'
import type { Result } from '../../shared/result'
import { agentScript, chunkIds, startFakeLlm } from '../helpers/fake-llm'
import { cleanup, launch, shot } from './helpers'

test('文件、标签、摘要、日总结和助手组合操作跨重启与索引重建', async () => {
  const fallback = (req: { messages: { content: unknown }[] }) => JSON.stringify(String(req.messages[0]?.content).includes('日记助手')
    ? { oneLine: '今天明确完成评审', done: ['完成评审'], highlights: [], followUps: [] }
    : { oneLine: '会议明确记录方案甲', points: ['采用方案甲'], entities: null })
  const fake = await startFakeLlm(req => fallback(req))
  let launched = await launch({ llmBaseUrl: fake.baseUrl })
  let page: Page = launched.page
  const vault = path.join(launched.workDir, 'R5虚构库')
  const source = 'content/工作/会议.txt', moved = 'content/工作/归档/会议新版.txt', note = 'content/工作/规则.md'
  const raw = '会议资料：采用方案甲。\n'
  async function call<K extends Channel>(channel: K, args: Args<K>): Promise<Ret<K>> {
    const result = await page.evaluate(async data => (window.jot.invoke as (name: string, args: unknown) => Promise<unknown>)(data.channel, data.args), { channel, args }) as Result<Ret<K>>
    if (!result.ok) throw new Error(result.error.code + ': ' + result.error.message)
    return result.data
  }
  async function ask(text: string, answers: number) {
    await page.getByTestId('agent-input').fill(text)
    await page.getByTestId('agent-send').click()
    await expect(page.getByTestId('agent-answer')).toHaveCount(answers)
    await expect(page.getByTestId('agent-stop')).toHaveCount(0)
  }
  try {
    await page.setViewportSize({ width: 1440, height: 940 })
    await page.getByTestId('vault-path').fill(vault); await page.getByTestId('vault-use').click()
    await page.getByTestId('model-next').click(); await page.getByTestId('onboarding-start').click()
    await expect(page.getByTestId('shell')).toBeVisible()
    await call('settings:set', { classify: { enabled: false }, daily: { enabled: false } })
    await call('vault:createFolder', { parent: 'content/工作', name: '归档' })
    const outside = path.join(launched.workDir, '会议.txt')
    fs.writeFileSync(outside, raw)
    await call('files:import', { paths: [outside], toDir: 'content/工作' })
    await call('doc:create', { dir: 'content/工作', title: '规则', body: '当前规则：待确认。\n\n[会议资料](会议.txt)\n\n保留这一段业务说明。' })
    await call('doc:patchProperties', { path: source, patch: { tags: ['评审'] } })
    await call('doc:setClassification', { ref: { path: note }, patch: { tags: ['评审'] } })
    await expect.poll(async () => (await call('library:resolve', { path: source }))?.summaryPath).toBeTruthy()
    const summary = (await call('library:resolve', { path: source }))!.summaryPath!
    const captured = await call('capture:save', { text: '今天明确完成评审', source: 'main-window' })
    await call('doc:patchProperties', { path: captured.path, patch: { related: ['content/工作'] } })
    await call('taxonomy:rename', { kind: 'tag', from: '评审', to: '业务' })
    await page.getByTestId('ribbon-library').click(); await page.getByTestId('library-all').click()
    await page.locator('[data-testid="library-item"][data-path=' + JSON.stringify(note) + ']').getByTestId('library-item-open').click()
    await page.keyboard.press('Control+l')
    fake.setResponder(agentScript([
      () => ({ toolCall: { name: 'edit_file', arguments: { path: note, before: '待确认', after: '已确认' } } }),
      () => ({ toolCall: { name: 'move', arguments: { path: source, targetPath: moved } } }),
      () => ({ toolCall: { name: 'read', arguments: { path: note } } }),
      results => '已修改规则并归档会议[^' + chunkIds(results[2]!)[0] + ']。',
    ], req => fallback(req)))
    await ask('确认规则，并将会议资料改名移动到归档目录', 1)
    expect(fs.readFileSync(path.join(vault, moved), 'utf8')).toBe(raw)
    expect(fs.existsSync(path.join(vault, moved + '.meta.yaml'))).toBe(true)
    expect((await call('doc:get', { ref: { path: summary } })).sourcePath).toBe(moved)
    await expect(page.locator('[data-testid="doc-view"]:visible').getByTestId('doc-preview')).toContainText('已确认')
    expect(decodeURI(fs.readFileSync(path.join(vault, note), 'utf8'))).toContain('归档/会议新版.txt')
    await page.getByTestId('ribbon-today').click()
    await page.getByTestId('daily-generate').click()
    await expect(page.getByTestId('daily-body')).toContainText('完成评审')
    await shot(page, 'r5-lifecycle-timeline')
    const conversation = (await call('agent:conversations', {})).items[0]!.conversationId
    await launched.close()
    launched = await launch({ llmBaseUrl: fake.baseUrl, reuse: launched }); page = launched.page
    await expect(page.getByTestId('shell')).toBeVisible()
    await call('vault:rebuildIndex', undefined)
    expect((await call('library:query', {})).total).toBe(3)
    expect((await call('taxonomy:terms', { kind: 'tag' })).find(tag => tag.name === '业务')?.count).toBe(2)
    await page.getByTestId('ribbon-library').click(); await page.getByTestId('library-all').click()
    await page.locator('[data-testid="library-item"][data-path=' + JSON.stringify(moved) + ']').getByTestId('library-item-open').click()
    await expect(page.locator('[data-testid="file-view"]:visible').getByTestId('props-summary')).toHaveAttribute('title', /#业务/)
    if (!(await page.getByTestId('agent').isVisible())) await page.keyboard.press('Control+l')
    await page.getByTestId('agent-history').click()
    await page.getByTestId('agent-conversation').first().locator('.history-main').click()
    fake.setResponder(agentScript([
      () => ({ toolCall: { name: 'read', arguments: { path: moved } } }),
      results => '当前归档资料[^' + chunkIds(results[0]!)[0] + ']。',
    ], req => fallback(req)))
    await ask('接着读取归档后的会议资料', 2)
    const last = (await call('agent:get', { conversationId: conversation })).messages.at(-1)!
    expect(last.error).toBeUndefined()
    expect(last.citations?.[0]).toMatchObject({ valid: true, chunk: { path: moved } })
    await shot(page, 'r5-lifecycle-assistant')
    const trash = await call('library:delete', { path: moved, scope: 'entry' })
    await expect.poll(() => fs.existsSync(path.join(vault, summary))).toBe(false)
    await call('doc:restore', trash)
    expect(fs.readFileSync(path.join(vault, moved), 'utf8')).toBe(raw)
    expect((await call('library:resolve', { path: summary }))?.path).toBe(moved)
  } finally {
    await launched.close(); await fake.close(); cleanup(launched.userData, launched.workDir)
  }
})
