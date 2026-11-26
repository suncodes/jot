import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { _electron as electron, expect, test } from '@playwright/test'
import { startFakeLlm } from '../helpers/fake-llm'
import { shot, windowByUrl } from '../e2e/helpers'
import { installAndReport, resumeAndManage, removeWorkReportIndex, W5_NOW, W5_RESTART } from '../e2e/work-report-flow'

test('W5发布包：完整工作报告资源、四类报告、跨年及重启、两类插件独立管理', async () => {
  test.setTimeout(180000)
  const exe = path.resolve(process.env.JOT_PACKED_EXE ?? path.join(import.meta.dirname, '../../dist/win-unpacked/Jot.exe'))
  expect(fs.statSync(exe).isFile()).toBe(true)
  const packaged = path.join(path.dirname(exe), 'resources/app-extensions/work-diary')
  const source = path.resolve(import.meta.dirname, '../../resources/app-extensions/work-diary')
  const hashes = (root: string): Record<string, string> => {
    const result: Record<string, string> = {}
    const walk = (relative: string) => {
      for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
        const child = relative ? relative + '/' + entry.name : entry.name
        if (entry.isDirectory()) walk(child)
        else result[child] = createHash('sha256').update(fs.readFileSync(path.join(root, child))).digest('hex')
      }
    }
    walk('')
    return result
  }
  expect(hashes(packaged)).toEqual(hashes(source))
  expect(Object.keys(hashes(packaged))).toEqual(expect.arrayContaining([
    'ai/work-report/plugin.json', 'ai/work-report/skills/work-report/SKILL.md',
    ...['daily', 'weekly', 'monthly', 'okr'].map(kind => 'ai/work-report/skills/work-report/references/' + kind + '.md'),
  ]))
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jot-w5-release-'))
  const vault = path.join(root, 'W5虚构发布库')
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && !entry[0].startsWith('JOT_')))
  Object.assign(env, { JOT_USER_DATA: path.join(root, 'data'), JOT_NO_DOTENV: '1', JOT_TEST_NOW: W5_NOW.toISOString() })
  const fake = await startFakeLlm()
  let app = await electron.launch({ executablePath: exe, env })
  const close = async () => {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {})
    await app.close().catch(() => {})
  }
  try {
    await app.evaluate(({ globalShortcut }) => { globalShortcut.unregisterAll(); globalShortcut.register = () => true })
    expect(await app.evaluate(({ app }) => app.isPackaged)).toBe(true)
    let page = await windowByUrl(app, 'index.html')
    const state = await installAndReport(page, vault, fake)
    await shot(page, 'w5-release-light')
    await close()
    removeWorkReportIndex(vault)
    env.JOT_TEST_NOW = W5_RESTART.toISOString()
    app = await electron.launch({ executablePath: exe, env })
    await app.evaluate(({ globalShortcut }) => { globalShortcut.unregisterAll(); globalShortcut.register = () => true })
    page = await windowByUrl(app, 'index.html')
    await resumeAndManage(page, vault, fake, state)
    await shot(page, 'w5-release-restart-dark')
  } finally {
    await close()
    await fake.close()
    await fs.promises.rm(root, { recursive: true, force: true })
  }
})
