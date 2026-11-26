import fs from 'node:fs'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { cleanup, fillDateTime, fillTime, launch, openArchive, selectOption, shot, showSide, type Launched } from './helpers'

let launched: Launched
let page: Page
let vault: string
test.beforeEach(async () => {
  launched = await launch()
  page = launched.page
  vault = path.join(launched.workDir, '体验优化虚构库')
  await page.getByTestId('vault-path').fill(vault)
  await page.getByTestId('vault-use').click()
  await page.getByTestId('model-skip').click()
  await page.getByTestId('onboarding-start').click()
  await expect(page.getByTestId('shell')).toBeVisible()
})
test.afterEach(async () => { await launched.close(); cleanup(launched.userData, launched.workDir) })

test('任务入口空闲常驻，等待任务可取消，文件处理与分类整理能直接到达', async () => {
  await page.getByTestId('jobs-open').click()
  await expect(page.getByTestId('jobs-popover')).toContainText('没有进行中的任务')
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('jobs-open')).toBeFocused()
  await page.getByTestId('capture-input').fill('需要稍后确认分类的演示记录')
  await page.getByTestId('capture-save').click()
  await expect(page.getByTestId('jobs-waiting')).toBeVisible()
  await page.getByTestId('jobs-open').click()
  await page.locator('[data-testid="jobs-filter"][data-filter="waiting-model"]').click()
  await expect(page.getByTestId('job')).toHaveAttribute('data-state', 'waiting-model')
  await page.getByTestId('job-cancel').click()
  await expect(page.getByTestId('job')).toHaveCount(0)
  await page.getByTestId('jobs-files').click()
  await expect(page.getByTestId('archive-view')).toBeVisible()
  await expect(page.getByTestId('archive-view').getByRole('heading', { name: '文件处理', exact: true })).toBeVisible()
  await page.getByTestId('jobs-open').click()
  await page.getByTestId('jobs-review').click()
  await expect(page.getByTestId('inbox-panel')).toBeVisible()
  await expect(page.getByTestId('side-panel').getByTestId('library-sidebar')).toBeVisible()
  await expect(page.getByTestId('side-panel').getByTestId('inbox-panel')).toHaveCount(0)
  await expect(page.locator('[data-testid="tab"].active')).toHaveAttribute('data-path', 'jot://review')
  await page.getByTestId('jobs-open').click()
  await page.getByTestId('jobs-close').click()
  await expect(page.getByTestId('jobs-open')).toBeVisible()
})

test('分类整理和文件处理可以完整翻页，超过原先的 100 条及 200 项限制', async () => {
  test.setTimeout(120000)
  await page.evaluate(() => window.jot.invoke('settings:set', { classify: { enabled: false } }))
  const inboxDir = path.join(vault, 'inbox')
  const filesDir = path.join(vault, 'files/分页样本')
  fs.mkdirSync(filesDir, { recursive: true })
  for (let n = 0; n < 105; n++) {
    const number = String(n).padStart(3, '0')
    fs.writeFileSync(path.join(inboxDir, '分页记录' + number + '.md'), '---\ntype: idea\nstatus: 待整理\n---\n虚构的分页记录 ' + number)
  }
  for (let n = 0; n < 205; n++) fs.writeFileSync(path.join(filesDir, '分页文件' + String(n).padStart(3, '0') + '.pdf'), '%PDF-虚构分页样本 ' + n)
  await expect.poll(() => page.evaluate(async () => {
    const r = await window.jot.invoke('classify:inbox', { limit: 1 })
    return r.ok ? r.data.total : -1
  }), { timeout: 30000 }).toBe(105)
  await showSide(page, 'inbox')
  const records = new Set<string>()
  for (let n = 0; n < 5; n++) {
    await expect(page.getByRole('region', { name: '待整理内容', exact: true })).toHaveAttribute('aria-busy', 'false')
    await expect(page.getByTestId('inbox-item')).toHaveCount(n === 4 ? 5 : 25)
    for (const p of await page.getByTestId('inbox-item').evaluateAll((rows) => rows.map((r) => (r as HTMLElement).dataset.path!))) records.add(p)
    if (n < 4) {
      const before = await page.getByTestId('inbox-item').first().getAttribute('data-path')
      await page.getByTestId('inbox-next').click()
      await expect(page.getByTestId('inbox-item').first()).not.toHaveAttribute('data-path', before!)
    }
  }
  expect(records.size).toBe(105)
  await expect(page.getByTestId('inbox-next')).toBeDisabled()
  await expect.poll(() => page.evaluate(async () => {
    const r = await window.jot.invoke('files:list', { limit: 1 })
    return r.ok ? r.data.total : -1
  }), { timeout: 30000 }).toBe(205)
  await openArchive(page)
  const files = new Set<string>()
  for (let n = 0; n < 5; n++) {
    await expect(page.getByTestId('archive-view').getByRole('table')).toHaveAttribute('aria-busy', 'false')
    await expect(page.getByTestId('archive-row')).toHaveCount(n === 4 ? 5 : 50)
    for (const p of await page.getByTestId('archive-row').evaluateAll((rows) => rows.map((r) => (r as HTMLElement).dataset.path!))) files.add(p)
    if (n < 4) {
      const before = await page.getByTestId('archive-row').first().getAttribute('data-path')
      await page.getByTestId('archive-next').click()
      await expect(page.getByTestId('archive-row').first()).not.toHaveAttribute('data-path', before!)
    }
  }
  expect(files.size).toBe(205)
  await expect(page.getByTestId('archive-next')).toBeDisabled()
})

test('助手引用支持目录搜索和键盘选择，候选在窄宽面板内；搜索保留日期校验', async () => {
  for (const name of ['阅读计划', '演示项目']) {
    await page.evaluate((project) => window.jot.invoke('vault:createFolder', { parent: 'content/成长', name: project }), name)
  }
  await page.getByTestId('agent-open').click()
  const input = page.getByTestId('agent-input')
  const candidates = page.getByTestId('agent-candidates')
  async function withinPanel(): Promise<void> {
    const panel = (await page.getByTestId('agent-panel').boundingBox())!
    const popup = (await candidates.boundingBox())!
    expect(popup.x).toBeGreaterThanOrEqual(panel.x)
    expect(popup.y).toBeGreaterThanOrEqual(panel.y)
    expect(popup.x + popup.width).toBeLessThanOrEqual(panel.x + panel.width)
    expect(popup.y + popup.height).toBeLessThanOrEqual(panel.y + panel.height)
  }
  await input.fill('@阅读')
  await expect(candidates.getByRole('option')).toHaveCount(2)
  await withinPanel()
  await input.press('ArrowDown')
  await input.press('Enter')
  await expect(page.getByTestId('agent-references')).toContainText('阅读计划')
  await expect(input).toBeFocused()
  await page.getByTestId('agent-reference-manage').click()
  await page.getByTestId('agent-strict').check()
  await page.getByRole('button', { name: '返回对话', exact: true }).click()
  await input.fill('继续总结')
  await expect(page.getByTestId('agent-send')).toBeEnabled()
  await page.getByRole('button', { name: '移除引用 阅读计划', exact: true }).click()
  await expect(page.getByTestId('agent-send')).toBeDisabled()
  await page.getByTestId('agent-unrestrict').click()
  await expect(page.getByTestId('agent-send')).toBeEnabled()
  await input.fill('@演示')
  await expect(candidates.getByRole('option')).toHaveCount(2)
  await withinPanel()
  await shot(page, 'experience-assistant-references')
  await input.press('Escape')
  await expect(candidates).toHaveCount(0)
  await expect(input).toBeFocused()
  const grip = (await page.getByTestId('agent-resizer').boundingBox())!
  await page.mouse.move(grip.x + 2, grip.y + 120)
  await page.mouse.down()
  await page.mouse.move(grip.x - 190, grip.y + 120, { steps: 8 })
  await page.mouse.up()
  await input.fill('@阅读')
  await expect(candidates.getByRole('option')).toHaveCount(2)
  await withinPanel()
  await shot(page, 'experience-assistant-references-wide')
  await input.press('Escape')

  await page.getByTestId('agent-close').click()
  await showSide(page, 'search')
  await page.getByTestId('search-input').fill('验证搜索日期校验')
  await page.getByTestId('search-filters-toggle').click()
  await page.getByTestId('filter-from').fill('2026-02-30')
  await expect(page.getByTestId('search-date-error')).toBeVisible()
  await expect(page.getByTestId('search-count')).toHaveCount(0)
  await page.getByTestId('filter-clear').click()
  await expect(page.getByTestId('filter-from')).toHaveValue('')
  await expect(page.getByTestId('search-date-error')).toHaveCount(0)
  await expect(page.getByTestId('search-count')).toHaveText('0 条结果')
})

test('补记日期输入无效或时段不完整时保留正文，修正后保存完整发生时间', async () => {
  await page.getByTestId('capture-input').fill('验证无效日期不会静默保存旧时段')
  await page.getByTestId('capture-time').click()
  await fillDateTime(page, 'capture-start', '2026-10-01T09:00')
  await fillDateTime(page, 'capture-end', '2026-10-01T10:00')
  await page.getByTestId('capture-start-date').fill('2026-02-30')
  await page.getByTestId('capture-save').click()
  await expect(page.getByTestId('capture-error')).toContainText('有效日期')
  await expect(page.getByTestId('capture-input')).toHaveValue('验证无效日期不会静默保存旧时段')
  const count = () => page.evaluate(async () => {
    const r = await window.jot.invoke('search:query', { text: '静默保存' })
    return r.ok ? r.data.total : -1
  })
  expect(await count()).toBe(0)
  await page.getByTestId('capture-start-date').fill('2026-10-01')
  await fillTime(page, 'capture-end-time', '')
  await page.getByTestId('capture-save').click()
  await expect(page.getByTestId('capture-error')).toBeVisible()
  expect(await count()).toBe(0)
  await fillTime(page, 'capture-end-time', '08:00')
  await page.getByTestId('capture-save').click()
  await expect(page.getByTestId('capture-error')).toBeVisible()
  expect(await count()).toBe(0)
  await fillTime(page, 'capture-end-time', '10:00')
  await page.getByTestId('capture-save').click()
  await expect(page.getByTestId('capture-input')).toHaveValue('')
  await expect.poll(count).toBe(1)
  const record = await page.evaluate(async () => {
    const r = await window.jot.invoke('search:query', { text: '静默保存' })
    if (!r.ok || !r.data.items[0]) return null
    const doc = await window.jot.invoke('doc:get', { ref: { path: r.data.items[0].doc.path } })
    return doc.ok ? { type: doc.data.type, start: new Date(doc.data.start!).toISOString(), end: new Date(doc.data.end!).toISOString() } : null
  })
  expect(record).toEqual({ type: 'log', start: new Date('2026-10-01T09:00').toISOString(), end: new Date('2026-10-01T10:00').toISOString() })
})

test('自定义时分选择支持键盘、保存与重启；描边按钮在深浅和窄窗口下可用', async () => {
  await page.evaluate(() => window.jot.invoke('settings:set', { capture: { hotkey: 'Ctrl+Alt+Shift+F12' } }))
  while (await page.getByTestId('toast').count()) await page.getByTestId('toast').first().getByRole('button', { name: '关闭', exact: true }).click()
  await page.getByTestId('ribbon-settings').click()
  await selectOption(page, 'settings-theme', 'light')
  const time = page.getByTestId('settings-daily-time')
  const hour = page.getByTestId('settings-daily-time-hour')
  const minute = page.getByTestId('settings-daily-time-minute')
  await expect(time).toHaveAttribute('data-value', '21:30')
  const savedTime = () => page.evaluate(async () => {
    const r = await window.jot.invoke('settings:get')
    return r.ok ? r.data.daily.time : ''
  })
  await hour.focus()
  await hour.press('ArrowDown')
  await page.keyboard.press('Home')
  await page.keyboard.press('Enter')
  await expect.poll(savedTime).toBe('00:30')
  await hour.press('ArrowDown')
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  await expect(hour).toBeFocused()
  await expect.poll(savedTime).toBe('23:30')
  await selectOption(page, 'settings-daily-time-minute', '07')
  await expect.poll(savedTime).toBe('23:07')
  expect(await time.locator('.select-control > span').evaluateAll((labels) => labels.every((label) => label.scrollWidth <= label.clientWidth))).toBe(true)
  await page.getByRole('heading', { name: '日总结', exact: true }).evaluate((heading) => heading.scrollIntoView({ block: 'start' }))
  await shot(page, 'controls-settings-light')
  await minute.focus()
  await minute.press('ArrowDown')
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  await expect.poll(savedTime).toBe('23:59')

  await page.setViewportSize({ width: 960, height: 600 })
  await page.getByTestId('theme-toggle').click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await minute.click()
  const options = page.getByTestId('select-options')
  const bounds = (await options.boundingBox())!
  expect(bounds.x).toBeGreaterThanOrEqual(0)
  expect(bounds.y).toBeGreaterThanOrEqual(0)
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(960)
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(600)
  await shot(page, 'controls-settings-dark-narrow')
  await page.keyboard.press('Escape')
  await expect(minute).toBeFocused()

  const reuse = { userData: launched.userData, workDir: launched.workDir }
  await launched.close()
  launched = await launch({ reuse })
  page = launched.page
  await expect(page.getByTestId('shell')).toBeVisible()
  await page.getByTestId('ribbon-settings').click()
  await expect(page.getByTestId('settings-daily-time')).toHaveAttribute('data-value', '23:59')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await page.setViewportSize({ width: 960, height: 600 })
  await page.getByTestId('ribbon-today').click()
  await page.getByTestId('capture-time').click()
  const date = (await page.getByTestId('today-view').getAttribute('data-date'))!
  await fillDateTime(page, 'capture-start', date + 'T09:07')
  await fillDateTime(page, 'capture-end', date + 'T10:19')
  const save = page.getByTestId('capture-save')
  await expect(save).toBeDisabled()
  const disabledColor = await save.evaluate((button) => getComputedStyle(button).color)
  await page.getByTestId('capture-input').fill('自定义时间选择与描边按钮的虚构记录')
  await expect(save).toBeEnabled()
  await expect.poll(() => save.evaluate((button) => {
    const css = getComputedStyle(button)
    return css.color === css.borderTopColor
  })).toBe(true)
  const style = await save.evaluate((button) => {
    const css = getComputedStyle(button)
    return { color: css.color, border: css.borderTopColor, background: css.backgroundColor }
  })
  expect(style.color).toBe(style.border)
  expect(style.color).not.toBe(disabledColor)
  expect(style.background).not.toBe(style.color)
  const saveBounds = (await save.boundingBox())!
  expect(saveBounds.x + saveBounds.width).toBeLessThanOrEqual(960)
  expect(saveBounds.y + saveBounds.height).toBeLessThanOrEqual(600)
  await shot(page, 'controls-capture-dark-narrow')
  await page.getByTestId('theme-toggle').click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await shot(page, 'controls-capture-light-narrow')
  await save.click()
  await expect(page.getByTestId('capture-input')).toHaveValue('')
  const entries = page.getByTestId('today-entry')
  await expect(entries).toHaveCount(1)
  await expect(entries.first().locator('.time')).toHaveText('09:0710:19')
})
