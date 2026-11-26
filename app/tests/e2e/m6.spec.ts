import fs from 'node:fs'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { startFakeLlm, type FakeLlm } from '../helpers/fake-llm'
import { selectOption, cleanup, launch, shot, showSide, windowByUrl, type Launched } from './helpers'

// M6：项目视图、项目和标签的管理、文件夹操作、设置收尾。

let fake: FakeLlm
let launched: Launched
let page: Page
let vaultDir: string

const inVault = (rel: string) => path.join(vaultDir, rel)
const read = (rel: string) => fs.readFileSync(inVault(rel), 'utf8')
let seq = 0
function idea(text: string, cls: Record<string, unknown>): string {
  const rel = `inbox/2026-11-1${seq % 4} 10000${seq++}.md`
  const head = Object.entries({ type: 'idea', created: `${rel.slice(6, 16)}T10:00:0${seq}+08:00`, ...cls, status: '已归类' }).map(([k, v]) => `${k}: ${Array.isArray(v) ? `[${v.join(', ')}]` : v}`)
  fs.writeFileSync(inVault(rel), `---\n${head.join('\n')}\n---\n${text}\n`)
  return rel
}
/** 等索引里的文件数达到预期（文件是在软件外面写进去的） */
async function indexed(total: number): Promise<void> {
  await expect
    .poll(() => page.evaluate(async () => { const r = await window.jot.invoke('search:query', {}); return r.ok ? r.data.total : -1 }), { timeout: 15000 })
    .toBe(total)
}

async function start(tryCapture?: string): Promise<void> {
  launched = await launch({ llmBaseUrl: fake.baseUrl })
  page = launched.page
  vaultDir = path.join(launched.workDir, '库')
  await page.getByTestId('vault-path').fill(vaultDir)
  await page.getByTestId('vault-use').click()
  await page.getByTestId('model-next').click()
  if (tryCapture) {
    await page.getByTestId('onboarding-try').getByTestId('capture-input').fill(tryCapture)
    await page.getByTestId('onboarding-try').getByTestId('capture-input').press('Enter')
    await expect(page.getByTestId('onboarding-try')).toHaveCount(0)
  }
  await page.getByTestId('onboarding-start').click()
  await expect(page.getByTestId('shell')).toBeVisible()
}

test.beforeAll(async () => (fake = await startFakeLlm()))
test.afterAll(() => fake.close())
test.beforeEach(() => {
  seq = 0
  // 归类一律给很低的把握，这样测试里写好的归类不会被改动
  fake.setResponder((req) => (String(req.messages[0]?.content).includes('归类助手') ? JSON.stringify({ domain: '生活', tags: [], confidence: 0.1, reason: '' }) : '好'))
})
test.afterEach(async () => {
  await launched.close()
  cleanup(launched.userData, launched.workDir)
})

test('首次启动的最后一步可以试记一条，进入后出现在“今天”', async () => {
  await start('第一次试着记一条')
  await expect(page.getByTestId('today-entry')).toContainText('第一次试着记一条')
})

test('统一内容库：领域和项目浏览、混合记录、类型筛选与新建项目', async () => {
  await start()
  idea('门锁二期只做指纹解锁', { domain: '工作', project: '智能门锁' })
  idea('临时密码有效期 24 小时', { domain: '工作', project: '智能门锁' })
  idea('周末去跑步', { domain: '健康', project: '健身计划' })
  fs.writeFileSync(inVault('notes/门锁电池方案.md'), '---\ntype: note\ncreated: 2026-11-09T10:00:00+08:00\ndomain: 工作\nproject: 智能门锁\nstatus: 已归类\n---\n暂定方案乙\n')
  await indexed(4)
  await page.getByTestId('ribbon-library').click()
  await page.locator('[data-testid="library-domain"][data-domain="工作"]').click()
  await expect(page.getByTestId('library-project')).toHaveText(['智能门锁'])
  await expect(page.getByTestId('library-item')).toHaveCount(0)
  await page.getByTestId('library-project').click()
  await expect(page.getByTestId('library-item')).toHaveCount(3)
  await expect(page.getByTestId('library-item').first()).toContainText('随手记')
  await shot(page, 'm6-project-page')
  await page.locator('[data-testid="library-kind"][data-kind="note"]').click()
  await expect(page.getByTestId('library-item')).toHaveText([/门锁电池方案/])
  await page.getByTestId('library-item').getByTestId('library-item-open').click()
  await expect(page.locator('[data-testid="tab"].active')).toHaveAttribute('data-path', 'notes/门锁电池方案.md')
  await page.getByTestId('projects-new').click()
  await page.getByTestId('project-name').fill('读书计划')
  await selectOption(page, 'project-domain', '成长')
  await page.getByTestId('project-create').click()
  await expect(page.getByTestId('library-title')).toHaveText('读书计划')
  expect(read('projects/读书计划.md')).toMatch(/type: project[\s\S]*domain: 成长/)
  await expect(page.getByTestId('project-row').filter({ hasText: '读书计划' })).toHaveText('读书计划')
})
test('项目和标签的管理：重命名、手动合并、检查同义后合并', async () => {
  await start()
  const a = idea('买坚果', { tags: ['零食', '过年'] })
  const b = idea('买薯片', { tags: ['小吃'] })
  const c = idea('回老家', { tags: ['春节', '零食'] })
  const d = idea('门锁的事', { domain: '工作', project: '门锁' })
  await indexed(4)

  await page.getByTestId('ribbon-library').click()
  await page.getByTestId('projects-manage').click()
  await expect(page.getByTestId('taxonomy-view')).toBeVisible()
  const row = (name: string) => page.locator(`[data-testid="taxonomy-row"][data-name="${name}"]`)
  await expect(page.getByTestId('taxonomy-row')).toHaveCount(4)
  await expect(row('零食').getByTestId('taxonomy-count')).toHaveText('2 条')
  // 没确认过、用得少的标签是候选
  await expect(row('小吃').getByTestId('taxonomy-candidate')).toBeVisible()

  // 重命名
  await row('小吃').getByTestId('taxonomy-more').click()
  await page.getByTestId('taxonomy-rename').click()
  await page.getByTestId('taxonomy-rename-input').fill('小零嘴')
  await page.getByTestId('taxonomy-rename-input').press('Enter')
  await expect(row('小零嘴')).toBeVisible()
  await expect.poll(() => read(b)).toContain('tags: [小零嘴]')
  await expect(row('小零嘴').getByTestId('taxonomy-candidate')).toHaveCount(0)

  // 手动合并：勾两个，选保留哪一个
  await row('小零嘴').getByTestId('taxonomy-check').check()
  await row('零食').getByTestId('taxonomy-check').check()
  await selectOption(page, 'taxonomy-keep', '零食')
  await expect(page.getByTestId('taxonomy-mergebar')).toContainText('把 小零嘴 并入「零食」，涉及约 1 条记录')
  await shot(page, 'm6-taxonomy')
  await page.getByTestId('taxonomy-merge').click()
  await expect(row('小零嘴')).toHaveCount(0)
  await expect(row('零食').getByTestId('taxonomy-count')).toHaveText('3 条')
  expect(read(b)).toContain('tags: [零食]')

  // 检查同义：模型提出建议，可以改保留哪一个再合并
  fake.setResponder(() => JSON.stringify({ groups: [{ names: ['过年', '春节'], suggested: '过年', reason: '同一个节日' }] }))
  await page.getByTestId('taxonomy-find').click()
  const suggestion = page.getByTestId('taxonomy-suggestion')
  await expect(suggestion).toContainText('同一个节日', { timeout: 15000 })
  await suggestion.getByLabel('春节').check()
  await suggestion.getByTestId('suggestion-merge').click()
  await expect(page.getByTestId('taxonomy-suggestion')).toHaveCount(0)
  await expect(row('过年')).toHaveCount(0)
  await expect(row('春节').getByTestId('taxonomy-count')).toHaveText('2 条')
  expect(read(a)).toContain('tags: [零食, 春节]')
  expect(read(c)).toContain('tags: [春节, 零食]')

  // 再检查一次：没有可合并的
  fake.setResponder(() => JSON.stringify({ groups: [] }))
  await page.getByTestId('taxonomy-find').click()
  await expect(page.getByTestId('taxonomy-no-suggestions')).toBeVisible({ timeout: 15000 })

  // 项目改名：记录和项目列表都跟着变
  await page.getByTestId('taxonomy-kind-project').click()
  await row('门锁').getByTestId('taxonomy-more').click()
  await page.getByTestId('taxonomy-rename').click()
  await page.getByTestId('taxonomy-rename-input').fill('智能门锁')
  await page.getByTestId('taxonomy-rename-input').press('Enter')
  await expect(row('智能门锁')).toBeVisible()
  await expect.poll(() => read(d)).toContain('project: 智能门锁')
  await page.locator('[data-testid="library-domain"][data-domain="工作"]').click()
  await expect(page.getByTestId('project-row')).toHaveText(['智能门锁'])
})

test('文件列表：新建文件夹、把文件移进去；设置里重建索引、查看任务', async () => {
  await start()
  fs.writeFileSync(inVault('notes/要移动的笔记.md'), '---\nid: MOVE1\n---\n这篇笔记会被移动')
  await indexed(1)
  await showSide(page, 'files')

  // 新建文件夹
  await page.getByTestId('tree-notes').click({ button: 'right' })
  await page.getByTestId('menu-folder').click()
  await page.getByTestId('folder-name').fill('读书')
  await page.getByTestId('folder-name').press('Enter')
  await expect(page.getByTestId('tree-notes/读书')).toBeVisible()
  expect(fs.statSync(inVault('notes/读书')).isDirectory()).toBe(true)

  // 打开文件，再把它移进新文件夹：标签页跟着换路径，内容还在，仍然能搜到
  await page.getByTestId('tree-notes/要移动的笔记.md').click()
  await page.getByTestId('tree-notes/要移动的笔记.md').click({ button: 'right' })
  await page.getByTestId('menu-move').click()
  await expect(page.getByTestId('move-target')).toContainText(['notes/读书'])
  // AI 自己维护的目录不能作为目标
  await expect(page.locator('[data-testid="move-target"][data-dir^="wiki"]')).toHaveCount(0)
  await page.locator('[data-testid="move-target"][data-dir="notes/读书"]').click()
  await expect(page.getByTestId('tree-notes/读书/要移动的笔记.md')).toBeVisible()
  expect(fs.existsSync(inVault('notes/要移动的笔记.md'))).toBe(false)
  await expect(page.locator('[data-testid="tab"].active')).toHaveAttribute('data-path', 'notes/读书/要移动的笔记.md')
  await expect(page.locator('[data-testid="doc-view"]:visible').getByTestId('doc-preview')).toContainText('这篇笔记会被移动')
  await showSide(page, 'search')
  await page.getByTestId('search-input').fill('会被移动')
  await expect(page.getByTestId('search-hit')).toHaveAttribute('data-path', 'notes/读书/要移动的笔记.md')

  // 设置：重建索引
  await page.getByTestId('ribbon-settings').click()
  await page.getByTestId('settings-rebuild').click()
  await expect(page.getByTestId('toast').filter({ hasText: '索引已重建，共 1 个文件' })).toBeVisible()
  await expect(page.getByTestId('search-hit')).toHaveCount(1)
  // 设置：查看后台任务；开机启动的开关会保存
  await page.getByTestId('settings-jobs').click()
  await expect(page.getByTestId('jobs-popover')).toContainText('没有进行中的任务')
  await page.mouse.click(600, 200)
  await expect(page.getByTestId('jobs-popover')).toHaveCount(0)
  await page.getByTestId('settings-launch').check()
  await expect.poll(() => JSON.parse(fs.readFileSync(path.join(launched.userData, 'settings.json'), 'utf8')).capture.launchAtLogin).toBe(true)
})

test('快捷记录小窗弹出到可以输入的时间', async () => {
  await start()
  const capturePage = await windowByUrl(launched.app, 'capture.html')
  const input = capturePage.getByTestId('capture-input')
  const times: number[] = []
  for (let i = 0; i < 5; i++) {
    const t0 = Date.now()
    await launched.app.evaluate(() => (globalThis as unknown as { __jotTest: { showCapture(): void } }).__jotTest.showCapture())
    await expect(input).toBeFocused()
    times.push(Date.now() - t0)
    await input.press('Escape')
    await expect.poll(() => launched.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('capture.html'))!.isVisible())).toBe(false)
  }
  console.log(`快捷记录小窗：从触发到输入框获得焦点 ${times.join('、')} 毫秒（包含测试工具自身的往返开销）`)
  // 需求里的目标是 0.3 秒以内。这里量到的时间含测试工具的开销，所以放宽一些，只防止明显变慢
  expect(Math.min(...times)).toBeLessThan(300)
  expect(times.sort((a, b) => a - b)[2]!).toBeLessThan(600)
})
