import fs from 'node:fs'
import path from 'node:path'
import { test, expect } from './file-fixture'
import { shot } from './helpers'

const visibleDoc = (page: import('@playwright/test').Page) => page.locator('[data-testid="doc-view"]:visible')

test('手动刷新与重建更新打开的正文、附属属性；外部移走显示缺失，恢复后可继续', async ({ jot }) => {
  const { page, write, call, open, vault } = jot
  const file = 'content/工作/规则.md'
  write(file, '---\ntags: [原标签]\n---\n原正文')
  await call('vault:refreshIndex', {})
  await open(file)
  const doc = visibleDoc(page)
  await expect(doc.getByTestId('doc-preview')).toContainText('原正文')
  write(file, '---\ntags: [新标签]\n---\n外部当前正文')
  await call('vault:refreshIndex', {})
  await expect(doc.getByTestId('doc-preview')).toContainText('外部当前正文')
  await expect(doc.getByTestId('props-summary')).toHaveAttribute('title', /#新标签/)
  write(file, '重建后当前正文')
  await call('vault:rebuildIndex', undefined)
  await expect(doc.getByTestId('doc-preview')).toContainText('重建后当前正文')

  fs.renameSync(path.join(vault, file), path.join(vault, 'content/工作/外部移走.md'))
  await call('vault:refreshIndex', {})
  await expect(doc.getByTestId('doc-error')).toBeVisible()
  await expect(doc.getByTestId('doc-preview')).toHaveCount(0)
  await shot(page, 'r4-note-missing')
  fs.renameSync(path.join(vault, 'content/工作/外部移走.md'), path.join(vault, file))
  await call('vault:refreshIndex', {})
  await expect(doc.getByTestId('doc-preview')).toContainText('重建后当前正文')

  write('content/工作/资料.txt', '附件原文')
  write('content/工作/资料.txt.meta.yaml', 'kind: attachment\ntags: [旧属性]\n')
  await call('vault:refreshIndex', {})
  await open('content/工作/资料.txt')
  await expect(page.locator('[data-testid="file-view"]:visible').getByTestId('props-summary')).toHaveAttribute('title', /#旧属性/)
  write('content/工作/资料.txt.meta.yaml', 'kind: attachment\ntags: [当前属性]\n')
  await call('vault:refreshIndex', {})
  await expect(page.locator('[data-testid="file-view"]:visible').getByTestId('props-summary')).toHaveAttribute('title', /#当前属性/)
})

test('已知目录移动保留编辑器草稿与自动材料引用，逻辑标签标题保留', async ({ jot }) => {
  const { page, write, call, open, launched, vault } = jot
  const file = 'content/工作/业务/规则.md', moved = 'content/工作/业务新版/规则.md'
  write(file, '初稿')
  await call('vault:refreshIndex', {})
  await open(file)
  await page.keyboard.press('Control+l')
  await expect(page.getByTestId('agent-references')).toContainText('规则')
  await visibleDoc(page).getByTestId('doc-toggle').click()
  await visibleDoc(page).locator('.cm-content').fill('移动时仍在输入的草稿')
  // 延迟保存失败，确保移动发生时确有未落盘的草稿。
  await launched.app.evaluate(({ ipcMain }) => {
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (event: unknown, args: unknown) => Promise<unknown>> })._invokeHandlers
    const original = handlers.get('doc:saveBody')!
    ;(globalThis as unknown as { restoreR4Save: () => void }).restoreR4Save = () => { ipcMain.removeHandler('doc:saveBody'); ipcMain.handle('doc:saveBody', original) }
    ipcMain.removeHandler('doc:saveBody')
    ipcMain.handle('doc:saveBody', () => ({ ok: false, error: { code: 'IO_ERROR', message: '测试保存暂不可用' } }))
  })
  await call('folder:move', { path: 'content/工作/业务', toDir: 'content/工作', name: '业务新版' })
  await expect(visibleDoc(page)).toHaveAttribute('data-path', moved)
  await expect(visibleDoc(page).locator('.cm-content')).toHaveText('移动时仍在输入的草稿')
  const refs = page.getByTestId('agent-references')
  await expect(refs.locator('.reference-chip')).toHaveAttribute('title', moved)
  await expect(refs.locator('.reference-chip small').first()).toHaveText('自动')
  await expect(page.getByTestId('tabbar').getByRole('button', { name: '时间线', exact: true })).toBeVisible()
  await expect(page.getByTestId('tabbar').getByRole('button', { name: '内容库', exact: true })).toBeVisible()
  await launched.app.evaluate(() => (globalThis as unknown as { restoreR4Save: () => void }).restoreR4Save())
  await page.keyboard.press('Control+e')
  await expect.poll(() => fs.readFileSync(path.join(vault, moved), 'utf8')).toContain('移动时仍在输入的草稿')
  expect(fs.existsSync(path.join(vault, file))).toBe(false)
})

test('文件外部删除时保留冲突草稿，恢复后可选择保留本地修改', async ({ jot }) => {
  const { page, write, call, open, vault } = jot
  const file = 'content/生活/想法.md'
  write(file, '最初正文')
  await call('vault:refreshIndex', {})
  await open(file)
  const doc = visibleDoc(page)
  await doc.getByTestId('doc-toggle').click()
  await doc.locator('.cm-content').fill('不能丢失的草稿')
  write(file, '外部同时改过')
  await call('vault:refreshIndex', {})
  await expect(doc.getByTestId('doc-conflict')).toBeVisible()
  fs.unlinkSync(path.join(vault, file))
  await call('vault:refreshIndex', {})
  await expect(doc.getByTestId('doc-draft-unavailable')).toContainText('草稿已保留')
  await expect(doc.locator('.cm-content')).toHaveText('不能丢失的草稿')
  await shot(page, 'r4-draft-missing')
  write(file, '外部恢复正文')
  await call('vault:refreshIndex', {})
  await expect(doc.getByTestId('doc-draft-unavailable')).toHaveCount(0)
  await doc.getByTestId('conflict-mine').click()
  await expect.poll(() => fs.readFileSync(path.join(vault, file), 'utf8')).toContain('不能丢失的草稿')
})

test('选中摘要外部移走时保留草稿，不切换到另一份摘要；孤立摘要属性只读', async ({ jot }) => {
  const { page, write, call, open, vault } = jot
  const file = 'content/工作/资料.txt', a = 'wiki/sources/甲摘要.md', b = 'wiki/sources/乙摘要.md'
  write(file, '原文')
  write(a, '---\ntype: source-summary\nsource: ' + file + '\n---\n甲摘要正文')
  write(b, '---\ntype: source-summary\nsource: ' + file + '\n---\n乙摘要正文')
  await call('vault:refreshIndex', {})
  await open(file)
  const view = page.locator('[data-testid="file-view"]:visible')
  await view.getByTestId('file-summary-select').click()
  await page.getByTestId('select-options').locator('[data-value=' + JSON.stringify(a) + ']').click()
  await view.getByTestId('doc-toggle').click()
  await view.locator('.cm-content').fill('甲摘要用户草稿')
  write(a, '---\ntype: source-summary\nsource: ' + file + '\n---\n甲摘要外部变动')
  await call('vault:refreshIndex', {})
  await expect(view.getByTestId('doc-conflict')).toBeVisible()
  fs.renameSync(path.join(vault, a), path.join(vault, 'wiki/sources/甲摘要外部移走.md'))
  await call('vault:refreshIndex', {})
  await expect(view.getByTestId('doc-draft-unavailable')).toBeVisible()
  await expect(view.locator('.cm-content')).toHaveText('甲摘要用户草稿')
  await expect(view.getByTestId('file-summary-select')).toContainText('已缺失')
  await view.getByTestId('doc-discard-draft').click()
  await page.getByTestId('app-dialog').getByRole('button', { name: '取消' }).click()
  await expect(view.locator('.cm-content')).toHaveText('甲摘要用户草稿')
  await view.getByTestId('doc-discard-draft').click()
  await page.getByTestId('doc-discard-confirm').click()
  await view.getByTestId('file-summary-select').click()
  await page.getByTestId('select-options').locator('[data-value=' + JSON.stringify(b) + ']').click()
  await expect(view.locator('.cm-content')).toHaveText('乙摘要正文')

  write('wiki/sources/独立摘要.md', '---\ntype: source-summary\nsource: content/不存在.txt\ntags: [摘要属性]\n---\n原件已缺失，摘要仍可阅读')
  await call('vault:refreshIndex', {})
  await open('wiki/sources/独立摘要.md')
  const orphan = page.locator('[data-testid="file-view"]:visible')
  await expect(orphan.getByTestId('doc-source-missing')).toBeVisible()
  await orphan.getByTestId('props-summary').focus()
  await page.keyboard.press('Enter')
  await expect(orphan.getByTestId('props-form')).toBeVisible()
  await expect(orphan.getByTestId('props-tags-input')).toBeDisabled()
  await expect(orphan.getByTestId('doc-preview')).toContainText('摘要仍可阅读')
  await shot(page, 'r4-orphan-summary-properties')
})

test('时间线加载失败可重试；重做日总结先处理隐藏的草稿', async ({ jot }) => {
  const { page, write, call, launched, vault } = jot
  const date = await page.getByTestId('today-view').getAttribute('data-date')
  const daily = 'journal/' + date!.slice(0, 4) + '/' + date + '.md'
  write('content/工作/规则.md', '当天可读材料')
  write(daily, '---\ntype: daily\ndate: ' + date + '\n---\n原日总结')
  await call('vault:refreshIndex', {})
  await expect(page.getByTestId('daily-open')).toBeVisible()
  await page.getByTestId('daily-open').click()
  await visibleDoc(page).getByTestId('doc-toggle').click()
  await visibleDoc(page).locator('.cm-content').fill('尚未保存的日总结草稿')
  await page.getByTestId('ribbon-today').click()
  await expect(page.getByTestId('daily-body')).toContainText('原日总结')
  await page.getByTestId('daily-regenerate').click()
  await expect.poll(() => fs.readFileSync(path.join(vault, daily), 'utf8')).toContain('尚未保存的日总结草稿')
  await expect(page.getByTestId('toast')).toContainText('覆盖')

  await launched.app.evaluate(({ ipcMain }) => {
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (event: unknown, args: unknown) => Promise<unknown>> })._invokeHandlers
    const original = handlers.get('timeline:day')!
    ;(globalThis as unknown as { restoreR4Timeline: () => void }).restoreR4Timeline = () => { ipcMain.removeHandler('timeline:day'); ipcMain.handle('timeline:day', original) }
    ipcMain.removeHandler('timeline:day')
    ipcMain.handle('timeline:day', () => ({ ok: false, error: { code: 'IO_ERROR', message: '测试读取失败' } }))
  })
  await page.getByTestId('today-prev').click()
  await expect(page.getByTestId('timeline-error')).toContainText('测试读取失败')
  await launched.app.evaluate(() => (globalThis as unknown as { restoreR4Timeline: () => void }).restoreR4Timeline())
  await page.getByTestId('timeline-error').getByRole('button', { name: '重试' }).click()
  await expect(page.getByTestId('timeline-error')).toHaveCount(0)
  await expect(page.getByTestId('today-overview')).toBeVisible()
})

test('内容库与智能体侧栏同宽，工具读写提示与深浅窄窗口保持一致', async ({ jot }) => {
  const { page, write, call } = jot
  write('content/工作/规则.md', '规则正文')
  await call('vault:createFolder', { parent: 'content/工作', name: '资料' })
  await call('vault:refreshIndex', {})
  await page.setViewportSize({ width: 1440, height: 940 })
  await page.getByTestId('ribbon-library').click()
  const width = await page.getByTestId('side-panel').evaluate(el => el.getBoundingClientRect().width)
  expect(width).toBe(224)
  await page.getByTestId('ribbon-capabilities').click()
  expect(await page.getByTestId('side-panel').evaluate(el => el.getBoundingClientRect().width)).toBe(width)
  await page.getByTestId('cap-tab-tools').click()
  await expect(page.getByTestId('cap-list').locator('.cap-row')).toHaveCount((await call('capabilities:catalog', undefined)).tools.length)
  await shot(page, 'r4-agents-tools-light')
  await page.getByTestId('theme-toggle').click()
  await shot(page, 'r4-agents-tools-dark')
  await page.setViewportSize({ width: 980, height: 800 })
  await shot(page, 'r4-agents-narrow')
  await page.getByTestId('ribbon-library').click()
  await expect(page.getByTestId('library-view')).toBeVisible()
  await expect(page.getByTestId('library-sidebar').locator('[data-path="content/工作"]')).toBeVisible()
  await shot(page, 'r4-library-narrow')
})

test('保存期间返回的旧正文不会覆盖已保存的新内容', async ({ jot }) => {
  const { page, write, call, open, launched, vault } = jot
  const file = 'content/工作/异步.md'
  write(file, '读取时的旧正文')
  await call('vault:refreshIndex', {})
  await open(file)
  const doc = visibleDoc(page)
  await expect(doc.getByTestId('doc-preview')).toContainText('旧正文')
  await doc.getByTestId('doc-toggle').click()
  await launched.app.evaluate(({ ipcMain }) => {
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (event: unknown, args: unknown) => Promise<unknown>> })._invokeHandlers
    const original = handlers.get('doc:get')!
    const state = globalThis as unknown as { r4ReadHeld: boolean; releaseR4Read: () => void }
    state.r4ReadHeld = false
    let once = true
    ipcMain.removeHandler('doc:get')
    ipcMain.handle('doc:get', async (event, args) => {
      const result = await original(event, args)
      if (once && args.ref.path === 'content/工作/异步.md') {
        once = false; state.r4ReadHeld = true
        await new Promise<void>(resolve => { state.releaseR4Read = resolve })
      }
      return result
    })
  })
  await call('vault:refreshIndex', {})
  await expect.poll(() => launched.app.evaluate(() => (globalThis as unknown as { r4ReadHeld: boolean }).r4ReadHeld)).toBe(true)
  await doc.locator('.cm-content').fill('随后保存的新正文')
  await doc.getByTestId('doc-toggle').click()
  await expect.poll(() => fs.readFileSync(path.join(vault, file), 'utf8')).toContain('随后保存的新正文')
  await launched.app.evaluate(() => (globalThis as unknown as { releaseR4Read: () => void }).releaseR4Read())
  // 给已释放的 IPC 回包一次渲染机会，再检查编辑器显示的是保存结果。
  await page.waitForTimeout(100)
  await expect(doc.getByTestId('doc-preview')).toContainText('随后保存的新正文')
  await expect(doc.getByTestId('doc-conflict')).toHaveCount(0)
})
