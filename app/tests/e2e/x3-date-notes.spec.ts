import fs from 'node:fs'
import path from 'node:path'
import { test, expect, callOnPage } from './file-fixture'
import { launch } from './helpers'
import { workDiaryOptions } from '../helpers/app-extension'

test('X3：两个候选包无模型生成普通日记，重复打开保留正在编辑的草稿，重启后仍打开原篇', async ({ jot }) => {
  const { call, page, vault } = jot
  const catalog = await call('extensions:catalog', undefined)
  expect(catalog.candidates.map(pkg => pkg.id).sort()).toEqual(['personal-diary', 'work-diary'])
  expect(catalog.installed).toEqual([])
  for (const id of ['personal-diary', 'work-diary']) {
    const preview = await call('extensions:previewImport', { source: { kind: 'bundled', id } })
    expect(preview?.issues).toEqual([])
    await call('extensions:confirmImport', { token: preview!.token })
    await call('extensions:saveProfile', { id, profile: { id: 'today', commandId: 'today', name: id,
      options: id === 'work-diary' ? workDiaryOptions('content/工作/X3虚构日记/' + id)
        : { directory: 'content/工作/X3虚构日记/' + id + '/{{yyyy}}年-{{MM}}月', filename: '{{yyyy}}-{{MM}}-{{dd}}.md', template: { kind: 'package', path: 'templates/default.md' } } } })
    await call('extensions:setEnabled', { id, enabled: true })
  }
  expect((await call('settings:get', undefined)).model.hasApiKey).toBe(false)
  expect((await call('app:status', undefined)).modelState).toBe('not-configured')
  const id = 'extension:work-diary:today:today'
  const created = await call('commands:execute', { id })
  expect(created).toMatchObject({ kind: 'open-note', created: true })
  if (created.kind !== 'open-note') throw new Error('结果不符')
  const filename = path.join(vault, created.path)
  expect(fs.readFileSync(filename, 'utf8')).toContain('今日记录')
  const original = fs.readFileSync(filename, 'utf8')
  await jot.open(created.path)
  const view = page.locator('[data-testid="doc-view"]:visible')
  await view.getByTestId('doc-toggle').click()
  await jot.launched.app.evaluate(({ ipcMain }) => {
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (event: unknown, args: unknown) => Promise<unknown>> })._invokeHandlers
    const original = handlers.get('doc:saveBody')!
    ;(globalThis as unknown as { restoreX3Save: () => void }).restoreX3Save = () => { ipcMain.removeHandler('doc:saveBody'); ipcMain.handle('doc:saveBody', original) }
    ipcMain.removeHandler('doc:saveBody')
    ipcMain.handle('doc:saveBody', () => ({ ok: false, error: { code: 'IO_ERROR', message: '虚构草稿保存暂不可用' } }))
  })
  const editor = view.locator('.cm-content')
  await editor.click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type('\nX3尚未保存的日记草稿')
  await expect(editor).toContainText('X3尚未保存的日记草稿')
  const existing = await call('commands:execute', { id })
  expect(existing).toEqual({ ...created, created: false })
  await page.keyboard.press('Control+o')
  await page.getByTestId('quick-open-input').fill(path.basename(created.path, '.md'))
  await page.getByTestId('quick-open-item').first().click()
  expect(fs.readFileSync(filename, 'utf8')).toBe(original)
  await expect(editor).toContainText('X3尚未保存的日记草稿')
  await jot.launched.app.evaluate(() => (globalThis as unknown as { restoreX3Save: () => void }).restoreX3Save())
  await page.keyboard.press('Control+e')
  await expect.poll(() => fs.readFileSync(filename, 'utf8')).toContain('X3尚未保存的日记草稿')
  const personal = await call('commands:execute', { id: 'extension:personal-diary:today:today' })
  expect(personal).toMatchObject({ created: true })
  if (personal.kind !== 'open-note') throw new Error('结果不符')
  expect(fs.readFileSync(path.join(vault, personal.path), 'utf8')).toContain('一个小收获')
  const copyPath = 'templates/X3虚构模板/工作日记.md'
  await call('extensions:copyTemplate', { id: 'work-diary', path: 'templates/default.md', targetPath: copyPath })
  expect(fs.readFileSync(path.join(vault, copyPath), 'utf8')).toContain('{{title}}')
  await call('extensions:uninstall', { id: 'personal-diary', confirmed: true })
  expect(fs.existsSync(path.join(vault, personal.path))).toBe(true)
  expect(await call('commands:execute', { id })).toEqual({ ...created, created: false })
  await jot.launched.close()
  const restarted = await launch({ isolateHotkey: true, reuse: { userData: jot.launched.userData, workDir: jot.launched.workDir } })
  try {
    await expect(restarted.page.getByTestId('shell')).toBeVisible()
    expect(await callOnPage(restarted.page, 'commands:execute', { id })).toEqual({ ...created, created: false })
    expect(fs.readFileSync(filename, 'utf8')).toContain('X3尚未保存的日记草稿')
    expect(fs.readFileSync(path.join(vault, copyPath), 'utf8')).toContain('{{title}}')
  } finally { await restarted.close() }
})
