import fs from 'node:fs'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { selectOption, cleanup, launch, shot, showSide, windowByUrl, type Launched } from './helpers'

// M1 的完成标志：记一条想法，能在列表里看到，能搜到，能编辑。

let launched: Launched
let page: Page
let vaultDir: string

async function onboard(l: Launched): Promise<void> {
  await l.page.getByTestId('vault-path').fill(vaultDir)
  await l.page.getByTestId('vault-use').click()
  await l.page.getByTestId('model-skip').click()
  await l.page.getByTestId('onboarding-start').click()
  await expect(l.page.getByTestId('shell')).toBeVisible()
}

const inboxFiles = () => fs.readdirSync(path.join(vaultDir, 'inbox')).sort()

test.beforeEach(async () => {
  launched = await launch()
  page = launched.page
  vaultDir = path.join(launched.workDir, '库')
  await onboard(launched)
})
test.afterEach(async () => {
  await launched.close()
  cleanup(launched.userData, launched.workDir)
})

test('记一条想法 → 文件列表里看到 → 搜到 → 打开并编辑', async () => {
  // 在主窗口底部记一条；回车保存后输入框清空
  const capture = page.getByTestId('capture-bar').getByTestId('capture-input')
  await capture.fill('过年回老家前要买零食和年货')
  await capture.press('Enter')
  await expect(capture).toHaveValue('')
  await expect.poll(inboxFiles).toHaveLength(1)
  const file = inboxFiles()[0]!
  const onDisk = fs.readFileSync(path.join(vaultDir, 'inbox', file), 'utf8')
  expect(onDisk).toMatch(/^---\nid: [0-9A-Z]{26}\ntype: idea\ncreated: .+\nsource: main-window\nstatus: 待整理\n---\n过年回老家前要买零食和年货\n$/)

  // 空内容回车不保存
  await capture.press('Enter')
  expect(inboxFiles()).toHaveLength(1)

  // 文件列表里看到
  await showSide(page, 'files')
  await expect(page.getByTestId(`tree-inbox/${file}`)).toBeVisible()
  await shot(page, 'm1-files')

  // 搜索：两个字的词和更长的词都能搜到，命中高亮
  await showSide(page, 'search')
  for (const q of ['过年', '零食和年货']) {
    await page.getByTestId('search-input').fill(q)
    await expect(page.getByTestId('search-count')).toHaveText('1 条结果')
    await expect(page.getByTestId('search-hit').locator('mark').first()).toHaveText(q)
  }
  await page.getByTestId('search-input').fill('不存在的内容')
  await expect(page.getByTestId('search-none')).toBeVisible()
  await page.getByTestId('search-input').fill('零食')
  await shot(page, 'm1-search')

  // 点击结果打开，默认是预览
  await page.getByTestId('search-hit').click()
  await expect(page.getByTestId('tab')).toHaveCount(1)
  await expect(page.getByTestId('doc-preview')).toContainText('过年回老家前要买零食和年货')

  // 进入编辑，补一句；自动保存后圆点消失，磁盘上的文件头没变
  await page.getByTestId('doc-toggle').click()
  await page.getByTestId('editor').locator('.cm-content').click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type('还要给爸妈带坚果')
  await expect(page.getByTestId('doc-unsaved')).toBeVisible()
  await expect(page.getByTestId('doc-unsaved')).toBeHidden({ timeout: 5000 })
  const saved = fs.readFileSync(path.join(vaultDir, 'inbox', file), 'utf8')
  expect(saved).toContain('还要给爸妈带坚果')
  expect(saved.split('---')[1]).toBe(onDisk.split('---')[1])
  await shot(page, 'm1-editor')

  // 新写的内容也能搜到
  await page.getByTestId('search-input').fill('坚果')
  await expect(page.getByTestId('search-count')).toHaveText('1 条结果')
})

test('快捷记录小窗：回车保存并隐藏，Esc 取消，Shift+Enter 换行', async () => {
  const capturePage = await windowByUrl(launched.app, 'capture.html')
  const visible = () => launched.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('capture.html'))!.isVisible())
  const show = () => launched.app.evaluate(() => (globalThis as unknown as { __jotTest: { showCapture(): void } }).__jotTest.showCapture())

  // 全局快捷键已注册
  const registered = () => launched.app.evaluate(() => (globalThis as unknown as { __jotTest: { hotkey(): string | null } }).__jotTest.hotkey())
  if (await registered() === null) {
    // 用户正在运行的正式程序可能已经占用默认键，只修改这个隔离实例的设置。
    await page.evaluate(() => window.jot.invoke('settings:set', { capture: { hotkey: 'Ctrl+Alt+Shift+F11' } }))
    expect(await registered()).toBe('Ctrl+Alt+Shift+F11')
  } else expect(await registered()).toBe('Ctrl+Alt+N')
  expect(await visible()).toBe(false)

  await show()
  expect(await visible()).toBe(true)
  const size = await launched.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('capture.html'))!.getBounds())
  expect(size.width).toBe(600)

  const input = capturePage.getByTestId('capture-input')
  await input.fill('第一行')
  await input.press('Shift+Enter')
  await capturePage.keyboard.type('第二行')
  await shot(capturePage, 'm1-capture')
  await input.press('Enter')
  await expect.poll(visible).toBe(false)
  await expect.poll(inboxFiles).toHaveLength(1)
  const text = fs.readFileSync(path.join(vaultDir, 'inbox', inboxFiles()[0]!), 'utf8')
  expect(text).toContain('source: quick-capture')
  expect(text).toContain('第一行\n第二行\n')

  // 主窗口里马上能搜到
  await showSide(page, 'search')
  await page.getByTestId('search-input').fill('第二行')
  await expect(page.getByTestId('search-count')).toHaveText('1 条结果')

  // Esc 取消：不保存
  await show()
  await input.fill('不要这条')
  await input.press('Escape')
  await expect.poll(visible).toBe(false)
  expect(inboxFiles()).toHaveLength(1)
})

test('新建笔记、重命名、双链跳转、删除后撤销', async () => {
  await showSide(page, 'files')
  await page.getByTestId('tree-new-note').click()
  // 新建后直接进入重命名
  const rename = page.getByTestId('tree-rename-input')
  await expect(rename).toBeVisible()
  await rename.fill('读书笔记')
  await rename.press('Enter')
  await expect(page.getByTestId('tree-notes/读书笔记.md')).toBeVisible()
  expect(fs.existsSync(path.join(vaultDir, 'notes/读书笔记.md'))).toBe(true)
  await expect(page.locator('[data-testid="tab"].active')).toHaveAttribute('data-path', 'notes/读书笔记.md')

  // 写一个指向另一篇笔记的双链
  fs.writeFileSync(path.join(vaultDir, 'notes/目标.md'), '# 目标页\n这里是目标内容')
  await expect(page.getByTestId('tree-notes/目标.md')).toBeVisible()
  await page.getByTestId('doc-toggle').click()
  await page.getByTestId('editor').locator('.cm-content').click()
  await page.keyboard.type('参见 [[目标]] 这一页')
  await expect(page.getByTestId('doc-unsaved')).toBeHidden({ timeout: 5000 })
  await page.getByTestId('doc-toggle').click()
  await page.getByTestId('doc-preview').locator('a.wikilink').click()
  await expect(page.locator('[data-testid="tab"].active')).toHaveAttribute('data-path', 'notes/目标.md')
  await expect(page.locator('[data-testid="doc-view"]:visible [data-testid="doc-preview"]')).toContainText('这里是目标内容')

  // 删除：不确认，提示里带撤销
  await page.getByTestId('tree-notes/目标.md').click({ button: 'right' })
  await page.getByTestId('menu-delete').click()
  await expect(page.getByTestId('tree-notes/目标.md')).toHaveCount(0)
  expect(fs.existsSync(path.join(vaultDir, 'notes/目标.md'))).toBe(false)
  await page.getByTestId('toast-action').filter({ hasText: '撤销' }).click()
  await expect(page.getByTestId('tree-notes/目标.md')).toBeVisible()
  expect(fs.readFileSync(path.join(vaultDir, 'notes/目标.md'), 'utf8')).toContain('这里是目标内容')
})

test('在外部（如 Obsidian）新增、修改、删除文件，软件里跟着变', async () => {
  await showSide(page, 'files')
  const file = path.join(vaultDir, 'notes/外部笔记.md')

  fs.writeFileSync(file, '在 Obsidian 里写的第一版')
  await expect(page.getByTestId('tree-notes/外部笔记.md')).toBeVisible({ timeout: 10000 })
  await page.getByTestId('tree-notes/外部笔记.md').click()
  await expect(page.getByTestId('doc-preview')).toContainText('第一版')

  // 没有未保存的改动时，外部修改直接刷新
  fs.writeFileSync(file, '在 Obsidian 里改成了第二版')
  await expect(page.getByTestId('doc-preview')).toContainText('第二版', { timeout: 10000 })

  // 有未保存的改动时，提示选择保留哪一份
  await page.getByTestId('doc-toggle').click()
  await page.getByTestId('editor').locator('.cm-content').click()
  await page.keyboard.type('我在软件里加的内容')
  fs.writeFileSync(file, '外部又改成了第三版')
  await expect(page.getByTestId('doc-conflict')).toBeVisible({ timeout: 10000 })
  await shot(page, 'm1-conflict')
  await page.getByTestId('conflict-theirs').click()
  await expect(page.getByTestId('doc-conflict')).toBeHidden()
  await expect(page.getByTestId('editor').locator('.cm-content')).toContainText('第三版')
  expect(fs.readFileSync(file, 'utf8')).toBe('外部又改成了第三版')

  // 外部删除：列表里消失，标签页关闭，搜不到
  fs.unlinkSync(file)
  await expect(page.getByTestId('tree-notes/外部笔记.md')).toHaveCount(0, { timeout: 10000 })
  await expect(page.getByTestId('tab')).toHaveCount(0)
  await showSide(page, 'search')
  await page.getByTestId('search-input').fill('第三版')
  await expect(page.getByTestId('search-none')).toBeVisible()
})

test('标签页、按名称打开、快捷键、调整面板宽度', async () => {
  for (const name of ['甲', '乙', '丙']) fs.writeFileSync(path.join(vaultDir, `notes/${name}.md`), `${name}的内容`)
  await showSide(page, 'files')
  await expect(page.getByTestId('tree-notes/丙.md')).toBeVisible({ timeout: 10000 })

  // 单击在当前标签页打开（替换），Ctrl+单击在新标签页打开，同一个文件不重复打开
  await page.getByTestId('tree-notes/甲.md').click()
  await page.getByTestId('tree-notes/乙.md').click()
  await expect(page.getByTestId('tab')).toHaveCount(1)
  await page.getByTestId('tree-notes/丙.md').click({ modifiers: ['Control'] })
  await page.getByTestId('tree-notes/乙.md').click({ modifiers: ['Control'] })
  await expect(page.getByTestId('tab')).toHaveCount(2)
  await expect(page.locator('[data-testid="tab"].active')).toHaveAttribute('data-path', 'notes/乙.md')

  // Ctrl+O 按名称打开
  await page.keyboard.press('Control+o')
  await page.getByTestId('quick-open-input').fill('甲')
  await expect(page.getByTestId('quick-open-item').first()).toContainText('甲')
  await page.keyboard.press('Control+Enter')
  await expect(page.getByTestId('quick-open')).toHaveCount(0)
  await expect(page.getByTestId('tab')).toHaveCount(3)

  // Ctrl+Tab 切换，Ctrl+W 关闭
  await page.keyboard.press('Control+Tab')
  await page.keyboard.press('Control+w')
  await expect(page.getByTestId('tab')).toHaveCount(2)

  // Ctrl+Shift+F 打开搜索并聚焦，Ctrl+J 聚焦到“记一条”，Ctrl+, 打开设置
  await page.keyboard.press('Control+Shift+f')
  await expect(page.getByTestId('search-input')).toBeFocused()
  await page.keyboard.press('Control+j')
  await expect(page.getByTestId('capture-bar').getByTestId('capture-input')).toBeFocused()
  await page.keyboard.press('Control+,')
  await expect(page.getByTestId('settings')).toBeVisible()
  await expect(page.getByTestId('settings-hotkey')).toHaveValue('Ctrl+Alt+N')

  // 拖动调整侧边面板宽度，并且重启后记住
  const before = (await page.getByTestId('side-panel').boundingBox())!.width
  const handle = (await page.getByTestId('side-resizer').boundingBox())!
  await page.mouse.move(handle.x + 2, handle.y + 100)
  await page.mouse.down()
  await page.mouse.move(handle.x + 82, handle.y + 100, { steps: 4 })
  await page.mouse.up()
  const after = (await page.getByTestId('side-panel').boundingBox())!.width
  expect(Math.round(after - before)).toBe(80)

  await launched.close()
  launched = await launch({ reuse: launched })
  page = launched.page
  await expect(page.getByTestId('shell')).toBeVisible()
  expect((await page.getByTestId('side-panel').boundingBox())!.width).toBe(after)
})

test('搜索筛选：按类型和时间', async () => {
  const capture = page.getByTestId('capture-bar').getByTestId('capture-input')
  await capture.fill('关于接口设计的想法')
  await capture.press('Enter')
  fs.writeFileSync(path.join(vaultDir, 'notes/接口设计笔记.md'), '---\ncreated: 2026-01-05T10:00:00+08:00\n---\n接口设计的详细笔记')
  await showSide(page, 'search')
  await page.getByTestId('search-input').fill('接口设计')
  await expect(page.getByTestId('search-count')).toHaveText('2 条结果', { timeout: 10000 })

  await page.getByTestId('search-filters-toggle').click()
  await selectOption(page, 'filter-type', 'note')
  await expect(page.getByTestId('search-count')).toHaveText('1 条结果')
  await expect(page.getByTestId('search-hit')).toHaveAttribute('data-path', 'notes/接口设计笔记.md')
  await page.getByTestId('filter-clear').click()
  await expect(page.getByTestId('search-count')).toHaveText('2 条结果')

  await page.getByTestId('filter-to').fill('2026-01-31')
  await expect(page.getByTestId('search-count')).toHaveText('1 条结果')
  await expect(page.getByTestId('search-hit')).toHaveAttribute('data-path', 'notes/接口设计笔记.md')

  // 不输关键词只筛选也可以
  await page.getByTestId('search-input').fill('')
  await expect(page.getByTestId('search-count')).toHaveText('1 条结果')
})

