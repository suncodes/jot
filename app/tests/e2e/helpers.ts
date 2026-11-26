import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'

export const appDir = path.resolve(import.meta.dirname, '../..')
/** 截图和测试产物放在工作区的 tmp/ 下（已被 git 忽略） */
export const shotsDir = path.resolve(appDir, '../tmp/shots')

export interface Launched {
  app: ElectronApplication
  page: Page
  /** 这次启动使用的独立数据目录 */
  userData: string
  /** 给测试用的空目录，用来建库 */
  workDir: string
  close(): Promise<void>
}

export interface LaunchOptions {
  /** 仅普通 UI 场景使用，避免宿主程序占用快捷键；快捷键专项不启用。 */
  isolateHotkey?: boolean
  /** 假模型的地址；不传表示没有配置模型 */
  llmBaseUrl?: string
  /** 复用上一次的数据目录，用来测试“重启后” */
  reuse?: { userData: string; workDir: string }
  /** 软件认为的当前时间。默认是今天中午，这样不管测试在几点跑，都不会碰上晚上的自动日总结 */
  now?: Date
}

/** 启动构建好的软件。每次用独立的数据目录，不读工作区的 .env，不碰真实的库。 */
export async function launch(opts: LaunchOptions = {}): Promise<Launched> {
  const userData = opts.reuse?.userData ?? fs.mkdtempSync(path.join(os.tmpdir(), 'jot-e2e-data-'))
  const workDir = opts.reuse?.workDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'jot-e2e-work-'))
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.startsWith('JOT_')) env[k] = v
  }
  env.JOT_USER_DATA = userData
  env.JOT_NO_DOTENV = '1'
  const noon = new Date()
  noon.setHours(12, 0, 0, 0)
  env.JOT_TEST_NOW = (opts.now ?? noon).toISOString()
  if (opts.llmBaseUrl) {
    env.JOT_LLM_BASE_URL = opts.llmBaseUrl
    env.JOT_LLM_API_KEY = 'fake-key'
    env.JOT_LLM_MODEL = 'fake-model'
  }
  const app = await electron.launch({ args: ['.'], cwd: appDir, env })
  if (opts.isolateHotkey) {
    await app.evaluate(({ globalShortcut }) => { globalShortcut.unregisterAll(); globalShortcut.register = () => true })
  }
  // 软件有两个窗口（主窗口和隐藏的快捷记录小窗），按地址找主窗口
  const page = await windowByUrl(app, 'index.html')
  await page.waitForLoadState('domcontentloaded')
  if (opts.isolateHotkey) {
    const conflict = page.getByTestId('toast').filter({ hasText: /全局快捷键.*被其他软件占用了/ })
    if (await conflict.count()) await conflict.getByRole('button', { name: '关闭', exact: true }).click()
  }
  return {
    app,
    page,
    userData,
    workDir,
    async close() {
      // 关闭主窗口只会收进托盘，这里要真正退出
      await app.evaluate(({ app: a }) => a.exit(0)).catch(() => {})
      await app.close().catch(() => {})
    },
  }
}

/** 等到地址里包含指定文件名的窗口出现 */
export async function windowByUrl(app: ElectronApplication, file: string): Promise<Page> {
  for (let i = 0; i < 100; i++) {
    const found = app.windows().find((w) => w.url().includes(file))
    if (found) return found
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`没有找到窗口：${file}`)
}

export function cleanup(...dirs: string[]): void {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true })
}

export async function shot(page: Page, name: string): Promise<void> {
  fs.mkdirSync(shotsDir, { recursive: true })
  await page.screenshot({ animations: 'disabled', path: path.join(shotsDir, `${name}.png`) })
}

/** 打开搜索、存储工具或主内容区的分类整理。 */
export async function showSide(page: Page, view: 'files' | 'search' | 'inbox'): Promise<void> {
  const panel = page.getByTestId(`${view}-panel`)
  if (!(await panel.isVisible())) {
    if (view !== 'search' && !(await page.getByTestId(`ribbon-${view}`).isVisible())) await page.getByTestId('tools-open').click()
    await page.getByTestId(`ribbon-${view}`).click()
  }
  await panel.waitFor({ state: 'visible' })
}

/** 文件处理是次级工具入口，主导航仍为时间线／内容库。 */
export async function openArchive(page: Page): Promise<void> {
  if (!(await page.getByTestId('ribbon-archive').isVisible())) await page.getByTestId('tools-open').click()
  await page.getByTestId('ribbon-archive').click()
}
export async function inboxCount(page: Page): Promise<number> {
  return page.evaluate(async () => { const r = await window.jot.invoke('app:status'); return r.ok ? r.data.inboxCount : -1 })
}

/** 通过真实的定制下拉交互选择，不绕过组件状态。 */
export async function selectOption(page: Page, testid: string, value: string): Promise<void> {
  await page.getByTestId(testid).click()
  await page.getByTestId('select-options').locator('[data-value=' + JSON.stringify(value) + ']').click()
}

export async function fillDateTime(page: Page, testid: string, value: string): Promise<void> {
  const [date = '', time = ''] = value.split('T')
  await page.getByTestId(testid + '-date').fill(date)
  await fillTime(page, testid + '-time', time)
}

/** 使用统一小时／分钟选择，不绕过保存与校验。 */
export async function fillTime(page: Page, testid: string, value: string): Promise<void> {
  const [hour = '', minute = ''] = value.split(':')
  await selectOption(page, testid + '-hour', hour)
  if (value) await selectOption(page, testid + '-minute', minute)
}
