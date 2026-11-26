import fs from 'node:fs'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { startFakeLlm, type FakeChatRequest, type FakeLlm } from '../helpers/fake-llm'
import { cleanup, launch, openArchive, shot, showSide, type Launched } from './helpers'

// M3 的完成标志：拖入一个文本文件，生成摘要页并能搜到。

let fake: FakeLlm
let launched: Launched
let page: Page
let vaultDir: string
let summaryFails = false

const isClassify = (req: FakeChatRequest) => String(req.messages[0]?.content).includes('归类助手')
const outside = (name: string, content: string | Buffer) => {
  const p = path.join(launched.workDir, 'outside', name)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, content)
  return p
}
const filesIn = (dir: string) => (fs.existsSync(path.join(vaultDir, dir)) ? fs.readdirSync(path.join(vaultDir, dir), { recursive: true }).map(String).filter((f) => /\.\w+$/.test(f)) : [])
const row = (name: string) => page.locator(`[data-testid="archive-row"][data-path$="/${name}"]`)

test.beforeAll(async () => (fake = await startFakeLlm()))
test.afterAll(() => fake.close())
test.beforeEach(async () => {
  summaryFails = false
  fake.setResponder((req) => {
    if (isClassify(req)) return JSON.stringify({ domain: '工作', tags: ['需求'], confidence: 0.9, reason: '' })
    if (summaryFails) return { status: 500, body: 'boom' }
    return JSON.stringify({ oneLine: '一份关于搜索功能的需求说明', points: ['搜索要支持两个字的词', '结果要高亮'], entities: { projects: ['人生笔记'], people: [], dates: ['11 月 20 日'], numbers: [] } })
  })
  launched = await launch({ llmBaseUrl: fake.baseUrl })
  page = launched.page
  vaultDir = path.join(launched.workDir, '库')
  await page.getByTestId('vault-path').fill(vaultDir)
  await page.getByTestId('vault-use').click()
  await page.getByTestId('model-next').click()
  await page.getByTestId('onboarding-start').click()
  await expect(page.getByTestId('shell')).toBeVisible()
})
test.afterEach(async () => {
  await launched.close()
  cleanup(launched.userData, launched.workDir)
})

test('放入一个文本文件 → 生成摘要页 → 能搜到 → 从摘要页打开原件', async () => {
  await openArchive(page)
  await expect(page.getByTestId('archive-empty')).toContainText('把文件拖到这里')

  const src = outside('搜索需求.txt', '搜索功能的需求：\n要支持两个字的词，比如“过年”。\n命中的词要高亮显示。')
  await page.getByTestId('archive-picker').setInputFiles(src)
  await expect(row('搜索需求.txt')).toHaveAttribute('data-state', 'done', { timeout: 15000 })
  await expect(row('搜索需求.txt')).toContainText('工作')

  // 原件复制进了库，内容不变；库外的文件还在
  const copied = filesIn('files')
  expect(copied).toHaveLength(1)
  expect(fs.readFileSync(path.join(vaultDir, 'files', copied[0]!), 'utf8')).toBe(fs.readFileSync(src, 'utf8'))
  const summary = fs.readFileSync(path.join(vaultDir, 'wiki/sources/搜索需求.md'), 'utf8')
  for (const line of [/^type: source-summary$/m, /^generated_by: ai$/m, /^source: "\[\[files\/\d{4}-\d{2}\/搜索需求\.txt\]\]"$/m, /^status: 已归类$/m]) expect(summary).toMatch(line)
  expect(summary).toContain('- 搜索要支持两个字的词')
  await shot(page, 'm3-archive')

  // 点击一行打开摘要页：有 AI 标记和“打开原件”
  await row('搜索需求.txt').click()
  await expect(page.locator('[data-testid="tab"].active')).toHaveAttribute('data-path', `files/${copied[0]!.replaceAll('\\', '/')}`)
  const view = page.locator('[data-testid="file-view"]:visible')
  await expect(view.getByTestId('file-summary')).toHaveAttribute('aria-pressed', 'true')
  await expect(view.getByTestId('doc-preview')).toContainText('一份关于搜索功能的需求说明')
  await expect(view.getByTestId('props-domain')).toContainText('工作')
  await shot(page, 'm3-summary')
  await view.getByTestId('file-source').click()
  await expect(page.locator('[data-testid="tab"].active')).toHaveAttribute('data-path', /^files\/.*搜索需求\.txt$/)
  await expect(page.locator('[data-testid="doc-view"]:visible [data-testid="editor"]')).toContainText('命中的词要高亮显示')

  // 搜索：原文里的词搜到原件，摘要里的词搜到摘要页（带 AI 标记）
  await showSide(page, 'search')
  await page.getByTestId('search-input').fill('过年')
  await expect(page.getByTestId('search-hit')).toHaveAttribute('data-path', /^files\//)
  await page.getByTestId('search-input').fill('需求说明')
  await expect(page.getByTestId('search-hit')).toHaveAttribute('data-path', 'wiki/sources/搜索需求.md')
  await expect(page.getByTestId('search-hit').locator('.ai-badge')).toBeVisible()
})

test('内容重复、格式不支持的文件：照常保存，状态说明原因', async () => {
  await openArchive(page)
  await page.getByTestId('archive-picker').setInputFiles([outside('甲.txt', '相同的内容'), outside('扫描件.pdf', Buffer.from('%PDF-1.4'))])
  await expect(row('甲.txt')).toHaveAttribute('data-state', 'done', { timeout: 15000 })
  await expect(row('扫描件.pdf')).toHaveAttribute('data-state', 'unsupported')
  await expect(page.getByTestId('toast').filter({ hasText: '已放入 2 个文件' })).toBeVisible()

  await page.getByTestId('archive-picker').setInputFiles(outside('乙.txt', '相同的内容'))
  await expect(row('乙.txt')).toHaveAttribute('data-state', 'duplicate', { timeout: 15000 })
  await row('乙.txt').click()
  await expect(page.getByTestId('archive-detail').last()).toContainText('内容相同')
  await row('扫描件.pdf').click()
  await expect(page.getByTestId('archive-detail').filter({ hasText: '暂时不能解析' })).toBeVisible()
  expect(filesIn('files').sort().map((f) => path.basename(f))).toEqual(['乙.txt', '扫描件.pdf', '甲.txt'])
  expect(filesIn('wiki/sources')).toEqual(['甲.md'])
  await shot(page, 'm3-states')
})

test('直接放进库的 files 文件夹、之后在外部修改和删除，软件都跟上', async () => {
  await openArchive(page)
  fs.mkdirSync(path.join(vaultDir, 'files/资料'), { recursive: true })
  const file = path.join(vaultDir, 'files/资料/计划.txt')
  fs.writeFileSync(file, '第一版计划')
  await expect(row('计划.txt')).toHaveAttribute('data-state', 'done', { timeout: 15000 })
  const summaryFile = path.join(vaultDir, 'wiki/sources/计划.md')
  const firstHash = /source_hash: (\S+)/.exec(fs.readFileSync(summaryFile, 'utf8'))![1]

  // 外部修改原件：摘要重新生成
  fs.writeFileSync(file, '第二版计划，改了很多内容')
  await expect.poll(() => /source_hash: (\S+)/.exec(fs.readFileSync(summaryFile, 'utf8'))![1], { timeout: 15000 }).not.toBe(firstHash)

  // 在软件里改摘要页，再改原件：不覆盖，给出提示；点重新处理时先确认
  fs.writeFileSync(summaryFile, fs.readFileSync(summaryFile, 'utf8').replace('一份关于搜索功能的需求说明', '我自己改写的概括'))
  await page.waitForTimeout(1500)
  fs.writeFileSync(file, '第三版计划')
  await expect(page.getByTestId('archive-detail')).toContainText('没有自动覆盖', { timeout: 15000 })
  expect(fs.readFileSync(summaryFile, 'utf8')).toContain('我自己改写的概括')
  await row('计划.txt').getByTestId('archive-reprocess').click()
  await expect(page.getByTestId('toast').filter({ hasText: '会覆盖你的修改' })).toBeVisible()
  expect(fs.readFileSync(summaryFile, 'utf8')).toContain('我自己改写的概括')
  await page.getByTestId('toast-action').click()
  await expect.poll(() => fs.readFileSync(summaryFile, 'utf8'), { timeout: 15000 }).not.toContain('我自己改写的概括')

  // 删除原件：列表里消失，摘要页保留并标记
  fs.unlinkSync(file)
  await expect(row('计划.txt')).toHaveCount(0, { timeout: 15000 })
  expect(fs.existsSync(summaryFile)).toBe(true)
  await showSide(page, 'search')
  await page.getByTestId('search-input').fill('需求说明')
  await expect(page.getByTestId('hit-source-missing')).toHaveText('原件已删除')
  await page.getByTestId('search-hit').click()
  await expect(page.locator('[data-testid="file-view"]:visible').getByTestId('doc-source-missing')).toBeVisible()
})

test('模型不可用时：文件照常保存并能搜到，状态是等待模型；恢复后重新处理成功', async () => {
  summaryFails = true
  await openArchive(page)
  await page.getByTestId('archive-picker').setInputFiles(outside('离线.txt', '模型不可用时放进来的内容'))
  await expect(row('离线.txt')).toHaveAttribute('data-state', 'waiting-model', { timeout: 15000 })
  await expect(page.getByTestId('jobs-waiting')).toContainText('1 项等待模型')
  await showSide(page, 'search')
  await page.getByTestId('search-input').fill('模型不可用')
  await expect(page.getByTestId('search-count')).toHaveText('1 条结果')

  summaryFails = false
  await page.locator('[data-testid="tab"][data-path="jot://archive"]').click()
  await row('离线.txt').getByTestId('archive-reprocess').click()
  await expect(row('离线.txt')).toHaveAttribute('data-state', 'done', { timeout: 15000 })
  expect(filesIn('wiki/sources')).toEqual(['离线.md'])
})

test('把文件拖到窗口上方时出现提示层', async () => {
  const drag = (type: string) =>
    page.evaluate((t) => {
      const dt = new DataTransfer()
      dt.items.add(new File(['x'], 'a.txt', { type: 'text/plain' }))
      document.querySelector('[data-testid="shell"]')!.dispatchEvent(new DragEvent(t, { dataTransfer: dt, bubbles: true, cancelable: true }))
    }, type)
  await drag('dragenter')
  await expect(page.getByTestId('drop-overlay')).toHaveText('松开以放入文件')
  await shot(page, 'm3-drop')
  await drag('dragleave')
  await expect(page.getByTestId('drop-overlay')).toHaveCount(0)

  // 松开：打开文件归档。这里的文件是脚本造出来的，没有磁盘位置，所以会提示放不进来
  await drag('dragenter')
  await drag('drop')
  await expect(page.getByTestId('drop-overlay')).toHaveCount(0)
  await expect(page.getByTestId('today-view')).toBeVisible()
  await expect(page.getByTestId('toast').filter({ hasText: '拿不到这个文件的位置' })).toBeVisible()
})
