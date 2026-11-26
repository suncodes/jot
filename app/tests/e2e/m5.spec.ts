import fs from 'node:fs'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { agentScript, startFakeLlm, type FakeLlm } from '../helpers/fake-llm'
import { cleanup, fillTime, launch, shot, type Launched } from './helpers'

// M5 的完成标志：晚上能看到当天记录和日总结。

let fake: FakeLlm
let launched: Launched
let page: Page
let vaultDir: string

const pad = (n: number) => String(n).padStart(2, '0')
const dayOf = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const today = dayOf(new Date())
const daysAgo = (n: number) => { const d = new Date(); d.setDate(d.getDate() - n); return dayOf(d) }
const at = (h: number, m: number) => { const d = new Date(); d.setHours(h, m, 0, 0); return d }
const journal = (day: string) => path.join(vaultDir, 'journal', day.slice(0, 4), `${day}.md`)
/** 这个测试开始以后发出的日总结请求（假模型是整个文件共用的） */
let baseline = 0
const dailyRequests = () => fake.requests.slice(baseline).filter((r) => String(r.messages[0]?.content).includes('日记助手'))

function respond(): void {
  fake.setResponder(agentScript([() => '今天你记了两件事。'], (req) => {
    const system = String(req.messages[0]?.content)
    if (system.includes('日记助手')) {
      return JSON.stringify({ oneLine: '你今天主要在准备过年和开会', done: ['列了过年要买的东西', '开了需求评审会'], highlights: ['年货要提前买'], followUps: ['订车票'] })
    }
    if (system.includes('归类助手')) return JSON.stringify({ directoryIds: [], tags: ['过年'], place: null, people: [], confidence: 0.95, reason: '' })
    return '好'
  }))
}
async function capture(text: string): Promise<void> {
  const input = page.getByTestId('capture-bar').getByTestId('capture-input')
  await input.fill(text)
  await input.press('Enter')
  await expect(input).toHaveValue('')
}
async function start(now?: Date): Promise<void> {
  launched = await launch({ llmBaseUrl: fake.baseUrl, now })
  page = launched.page
  vaultDir = path.join(launched.workDir, '库')
  await page.getByTestId('vault-path').fill(vaultDir)
  await page.getByTestId('vault-use').click()
  await page.getByTestId('model-next').click()
  await page.getByTestId('onboarding-start').click()
  await expect(page.getByTestId('shell')).toBeVisible()
}
async function restart(now: Date): Promise<void> {
  await launched.close()
  launched = await launch({ llmBaseUrl: fake.baseUrl, reuse: launched, now })
  page = launched.page
  await expect(page.getByTestId('shell')).toBeVisible()
}

test.beforeAll(async () => (fake = await startFakeLlm()))
test.afterAll(() => fake.close())
test.beforeEach(() => {
  baseline = fake.requests.length
  respond()
})
test.afterEach(async () => {
  await launched.close()
  cleanup(launched.userData, launched.workDir)
})

test('“今天”是默认页面：记录、补记、分类建议和日总结', async () => {
  await start()
  // 启动后就是“今天”，没有记录时有说明
  await expect(page.getByTestId('today-view')).toHaveAttribute('data-date', today)
  await expect(page.locator('[data-testid="ribbon-today"][aria-current="page"]')).toBeVisible()
  await expect(page.getByTestId('today-empty')).toContainText('还没有记录')
  await expect(page.getByTestId('daily-generate')).toHaveCount(0)

  // 记一条：出现在时间线末尾并短暂高亮；无匹配目录时保留待整理建议
  await capture('过年回老家前要买零食和年货')
  const entry = page.getByTestId('today-entry')
  await expect(entry).toHaveCount(1)
  await expect(entry).toHaveClass(/fresh/)
  await expect(entry).toContainText('过年回老家前要买零食和年货')
  await expect(entry.locator('[data-testid=entry-pending]')).toBeVisible({ timeout: 10000 })
  await expect(page.getByTestId('today-overview')).toContainText('1 条随手记')

  // 补记一件事
  await page.getByTestId('today-add-log').click()
  await expect(page.getByTestId('log-dialog')).toBeVisible()
  await fillTime(page, 'log-start', '09:00')
  await fillTime(page, 'log-end', '08:00')
  await page.getByTestId('log-text').fill('需求评审会')
  await page.getByTestId('log-save').click()
  await expect(page.getByTestId('log-error')).toContainText('结束时间不能早于开始时间')
  await fillTime(page, 'log-end', '10:30')
  await page.getByTestId('log-save').click()
  await expect(page.getByTestId('log-dialog')).toHaveCount(0)
  // 记事按开始时间排在前面，显示时间段
  await expect(page.getByTestId('today-entry')).toHaveCount(2)
  const log = page.getByTestId('today-entry').first()
  await expect(log).toHaveAttribute('data-kind', 'log')
  await expect(log.locator('.time')).toHaveText('09:0010:30')
  await expect(page.getByTestId('today-overview')).toContainText('2 条随手记')
  const logFile = fs.readdirSync(path.join(vaultDir, 'inbox'), { recursive: true }).find((f) => String(f).includes('090000'))!
  const logPath = 'inbox/' + String(logFile).replaceAll('\\', '/')
  expect(fs.readFileSync(path.join(vaultDir, 'inbox', String(logFile)), 'utf8')).toMatch(/type: log[\s\S]*source: manual[\s\S]*需求评审会/)

  // 点击一条记录：在新标签页打开，“今天”页还在
  await log.click()
  await expect(page.getByTestId('tab')).toHaveCount(2)
  await expect(page.locator('[data-testid="tab"].active')).toHaveAttribute('data-path', logPath)
  await page.getByTestId('ribbon-today').click()
  await expect(page.getByTestId('today-view')).toBeVisible()

  // 时间轴按已确认原型显示时刻、节点和正文；日期块在标题左边。
  const hero = page.getByTestId('timeline-hero')
  const dateBox = (await hero.locator('.hero-date').boundingBox())!
  const titleBox = (await hero.locator('.hero-copy').boundingBox())!
  expect(dateBox.x + dateBox.width).toBeLessThanOrEqual(titleBox.x)
  await expect(page.getByTestId('timeline-stream')).toBeVisible()
  await expect(entry.first().locator('.entry-body')).toBeVisible()
  expect(await entry.first().evaluate((el) => getComputedStyle(el, '::before').borderRadius)).toBe('50%')
  await shot(page, 'timeline-prototype-light')
  await page.getByTestId('theme-toggle').click()
  await shot(page, 'timeline-prototype-dark')
  await page.setViewportSize({ width: 960, height: 600 })
  await expect(page.getByTestId('timeline-kind').last()).toBeInViewport()
  await shot(page, 'timeline-prototype-dark-narrow')
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.getByTestId('theme-toggle').click()

  // 生成日总结
  await page.getByTestId('daily-generate').click()
  const body = page.getByTestId('daily-body')
  await expect(body).toContainText('你今天主要在准备过年和开会', { timeout: 15000 })
  await expect(body).not.toContainText('今天的数字')
  await expect(body.locator('h2, ul')).toHaveCount(0)
  await expect(page.getByTestId('daily-open')).toBeVisible()
  await expect(page.getByTestId('today-daily').locator('.ai-badge')).toBeVisible()
  await expect(page.getByTestId('daily-generated-at')).toContainText('材料截至')
  await expect(page.getByTestId('daily-evidence')).toContainText('查看生成依据（2 条材料）')
  await page.getByTestId('daily-evidence').locator('summary').click()
  await expect(page.getByTestId('daily-evidence')).toContainText('当前版本一致')
  await expect(page.getByTestId('daily-evidence').locator('.evidence-material')).toHaveCount(2)
  await page.getByTestId('daily-evidence').scrollIntoViewIfNeeded()
  await shot(page, 'p5-daily-evidence-light')
  await page.getByTestId('daily-evidence').locator('summary').click()
  expect(fs.readFileSync(journal(today), 'utf8')).toMatch(/type: daily[\s\S]*generated_by: ai[\s\S]*## 待跟进\n\n- 订车票/)
  await shot(page, 'm5-today')
  await shot(page, 'timeline-summary-light')

  // 摘要入口可打开完整内容，窄窗口中操作仍可见。
  await page.getByTestId('daily-open').click()
  await expect(page.locator('[data-testid="doc-view"]:visible').getByTestId('doc-preview')).toContainText('订车票')
  await page.getByTestId('ribbon-today').click()
  await page.getByTestId('theme-toggle').click()
  await page.setViewportSize({ width: 960, height: 600 })
  await page.getByTestId('today-daily').scrollIntoViewIfNeeded()
  await expect(page.getByTestId('daily-open')).toBeInViewport()
  await expect(page.getByTestId('daily-regenerate')).toBeInViewport()
  expect((await page.getByTestId('today-daily').boundingBox())!.height).toBeLessThan(220)
  await shot(page, 'timeline-summary-dark-narrow')
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.getByTestId('theme-toggle').click()

  // 生成之后又记了一条：提示总结可能过时（时间精确到秒，所以隔一秒再记）
  await page.waitForTimeout(1100)
  await capture('再记一条晚上的想法')
  await expect(page.getByTestId('daily-stale')).toHaveText('生成之后又多了 1 条记录', { timeout: 10000 })

  // 在别处修改总结后：标出“你修改过”，重新生成要先确认
  fs.writeFileSync(journal(today), fs.readFileSync(journal(today), 'utf8').replace('你今天主要在准备过年和开会', '我自己改写的一句话'))
  await expect(page.getByTestId('daily-edited')).toBeVisible({ timeout: 10000 })
  await expect(body).toContainText('我自己改写的一句话')
  await page.getByTestId('daily-regenerate').click()
  await expect(page.getByTestId('toast').filter({ hasText: '会覆盖你的修改' })).toBeVisible()
  expect(fs.readFileSync(journal(today), 'utf8')).toContain('我自己改写的一句话')
  await page.getByTestId('toast-action').click()
  await expect(body).toContainText('你今天主要在准备过年和开会', { timeout: 15000 })
  expect(fs.readFileSync(journal(today), 'utf8')).toContain('随手记 2 条，补记 1 条')
  await expect(page.getByTestId('daily-edited')).toHaveCount(0)
  await expect(page.getByTestId('daily-stale')).toHaveCount(0)

  // “编辑”在标签页里打开日总结文件
  await page.getByTestId('daily-edit').click()
  await expect(page.locator('[data-testid="tab"].active')).toHaveAttribute('data-path', `journal/${today.slice(0, 4)}/${today}.md`)
  await expect(page.locator('[data-testid="doc-view"]:visible').getByTestId('doc-ai-banner')).toBeVisible()
})

test('切换日期和日历：有记录的日子带标记；过去的日子也能生成总结', async () => {
  await start()
  const yesterday = daysAgo(1)
  await page.evaluate(async (day) => {
    const created = await window.jot.invoke('capture:save', { text: '昨天记下的想法', source: 'main-window' })
    if (!created.ok) throw new Error(created.error.message)
    const dated = await window.jot.invoke('doc:setOccurredAt', { ref: { path: created.data.path }, occurredAt: day })
    if (!dated.ok) throw new Error(dated.error.message)
  }, yesterday)
  await capture('今天的想法')
  await expect(page.getByTestId('today-entry')).toHaveCount(1)

  // 时间线只显示日期导航；侧栏、正文和切换页面共享所选日期。
  const day = (value: string) => page.locator('[data-testid="timeline-day"][data-day="' + value + '"]')
  await expect(page.getByTestId('timeline-sidebar')).toBeVisible()
  await expect(page.getByTestId('library-sidebar')).toHaveCount(0)
  await expect(page.getByTestId('timeline-date')).toHaveValue(today)
  await day(yesterday).click()
  await expect(page.getByTestId('today-view')).toHaveAttribute('data-date', yesterday)
  await expect(page.getByTestId('timeline-date')).toHaveValue(yesterday)
  await expect(day(yesterday)).toHaveAttribute('aria-current', 'date')
  await page.getByTestId('ribbon-library').click()
  await expect(page.getByTestId('library-sidebar')).toBeVisible()
  await expect(page.getByTestId('timeline-sidebar')).toHaveCount(0)
  await page.locator('[data-testid="tab"][data-path="jot://today"]').click()
  await expect(page.getByTestId('timeline-sidebar')).toBeVisible()
  await expect(page.getByTestId('library-sidebar')).toHaveCount(0)
  await expect(page.getByTestId('timeline-date')).toHaveValue(yesterday)
  await page.getByTestId('today-next').click()
  await expect(day(today)).toHaveAttribute('aria-current', 'date')
  await page.getByTestId('today-prev').click()
  await expect(page.getByTestId('today-view')).toHaveAttribute('data-date', yesterday)
  await expect(page.getByTestId('today-entry')).toContainText('昨天记下的想法', { timeout: 10000 })
  await expect(page.getByTestId('today-back')).toBeVisible()
  await expect(page.getByTestId('daily-generate')).toHaveText('生成这一天的总结')
  await page.getByTestId('daily-generate').click()
  await expect(page.getByTestId('daily-body')).toContainText('你今天主要在准备过年和开会', { timeout: 15000 })
  expect(fs.existsSync(journal(yesterday))).toBe(true)

  // 上一条只有发生日期时，补记默认时刻仍然有效。
  await page.getByTestId('today-add-log').click()
  await expect(page.getByTestId('log-start')).toHaveAttribute('data-value', /^\d{2}:\d{2}$/)
  await expect(page.getByTestId('log-end')).toHaveAttribute('data-value', /^\d{2}:\d{2}$/)
  await page.getByTestId('log-dialog').press('Escape')
  await expect(page.getByTestId('log-dialog')).toHaveCount(0)

  // 日历：昨天和今天有标记，别的日子没有
  await page.getByTestId('today-date').click()
  await expect(page.getByTestId('calendar')).toBeVisible()
  await expect(page.locator(`[data-testid="calendar-day"][data-day="${today}"]`)).toHaveAttribute('data-marked', 'true')
  await shot(page, 'm5-calendar')
  if (yesterday.slice(0, 7) === today.slice(0, 7)) {
    await expect(page.locator(`[data-testid="calendar-day"][data-day="${yesterday}"]`)).toHaveAttribute('data-marked', 'true')
  }
  await expect(page.locator('[data-testid="calendar-day"][data-marked="true"]')).toHaveCount(yesterday.slice(0, 7) === today.slice(0, 7) ? 2 : 1)
  // 翻到上个月再选一天：那天没有记录
  await page.getByTestId('calendar-prev').click()
  await page.getByTestId('calendar-day').nth(2).click()
  await expect(page.getByTestId('calendar')).toHaveCount(0)
  await expect(page.getByTestId('today-empty')).toBeVisible()
  await expect(page.getByTestId('daily-generate')).toHaveCount(0)
  await page.getByTestId('today-back').click()
  await expect(page.getByTestId('today-view')).toHaveAttribute('data-date', today)
  await page.getByTestId('today-next').click()
  await expect(page.getByTestId('today-empty')).toBeVisible()

  // 选择最近七天之外的日期，日历月份随之更新；清空日期不能破坏时间线。
  const historical = daysAgo(40)
  await page.getByTestId('timeline-date').fill(historical)
  await expect(page.getByTestId('today-view')).toHaveAttribute('data-date', historical)
  await expect(day(historical)).toHaveAttribute('aria-current', 'date')
  await page.getByTestId('today-date').click()
  await expect(page.getByTestId('calendar-month')).toHaveAttribute('data-month', historical.slice(0, 7))
  await page.getByTestId('today-date').click()
  await page.getByTestId('timeline-date').fill('')
  await expect(page.getByTestId('timeline-date')).toHaveValue(historical)
  await expect(page.getByTestId('today-view')).toHaveAttribute('data-date', historical)
  await page.getByTestId('today-back').click()
  await expect(day(today)).toHaveAttribute('aria-current', 'date')
  await shot(page, 'timeline-date-sidebar')
})

test('到了设定的时间自动生成今天的总结；软件没开而错过的日子，启动时补上', async () => {
  await start(at(12, 0))
  await capture('中午记的一条')
  await expect(page.getByTestId('today-entry')).toHaveCount(1)
  // 中午：还不到时间
  expect(await launched.app.evaluate(() => (globalThis as unknown as { __jotTest: { tick(): Promise<string[]> } }).__jotTest.tick())).toEqual([])
  expect(fs.existsSync(journal(today))).toBe(false)

  // 关掉软件前创建一条有真实事件身份的前天记录，重启后应补生成总结。
  const dayBefore = daysAgo(2)
  await page.evaluate(async (day) => {
    const created = await window.jot.invoke('capture:save', { text: '前天的想法', source: 'main-window' })
    if (!created.ok) throw new Error(created.error.message)
    const dated = await window.jot.invoke('doc:setOccurredAt', { ref: { path: created.data.path }, occurredAt: day })
    if (!dated.ok) throw new Error(dated.error.message)
  }, dayBefore)
  await launched.close()

  // 晚上九点半以后再打开：今天的和前天的都自动生成
  launched = await launch({ llmBaseUrl: fake.baseUrl, reuse: launched, now: at(21, 31) })
  page = launched.page
  await expect(page.getByTestId('daily-body')).toContainText('你今天主要在准备过年和开会', { timeout: 20000 })
  await expect.poll(() => fs.existsSync(journal(dayBefore)), { timeout: 20000 }).toBe(true)
  expect(dailyRequests().length).toBe(2)
  await shot(page, 'm5-auto')

  // 已经有了就不再重复生成
  await restart(at(22, 0))
  await expect(page.getByTestId('daily-body')).toBeVisible()
  await page.waitForTimeout(1500)
  expect(dailyRequests().length).toBe(2)

  // 在设置里关掉自动生成
  await page.getByTestId('ribbon-settings').click()
  await expect(page.getByTestId('settings-daily-time')).toHaveAttribute('data-value', '21:30')
  await page.getByTestId('settings-daily-enabled').uncheck()
  fs.unlinkSync(journal(today))
  expect(await launched.app.evaluate(() => (globalThis as unknown as { __jotTest: { tick(): Promise<string[]> } }).__jotTest.tick())).toEqual([])
})

test('时间线上的 AI 对话：点击后在助手面板里打开', async () => {
  await start()
  await capture('一条想法')
  await page.keyboard.press('Control+l')
  await page.getByTestId('agent-input').fill('今天记了什么')
  await page.getByTestId('agent-input').press('Enter')
  await expect(page.getByTestId('agent-answer')).toContainText('今天你记了两件事', { timeout: 15000 })
  const conv = page.locator('[data-testid="today-entry"][data-kind="conversation"]')
  await expect(conv).toContainText('今天记了什么', { timeout: 10000 })
  await expect(page.getByTestId('today-overview')).toContainText('1 次对话')

  await page.getByTestId('agent-new').click()
  await expect(page.getByTestId('agent-empty')).toBeVisible()
  await page.getByTestId('agent-close').click()
  await conv.click()
  await expect(page.getByTestId('agent-panel')).toBeVisible()
  await expect(page.getByTestId('agent-title')).toHaveText('今天记了什么')
  await expect(page.getByTestId('agent-answer')).toContainText('今天你记了两件事')
})
