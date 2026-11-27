import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'

const appRoot = path.resolve(import.meta.dirname, '..')
const workspace = path.dirname(appRoot)
if (/^c:/i.test(workspace)) throw new Error('Chrome 测试需在非 C 盘工作区运行')
const temporaryRoot = path.join(workspace, 'tmp/tests')
fs.mkdirSync(temporaryRoot, { recursive: true })
const runRoot = fs.mkdtempSync(path.join(temporaryRoot, 'chrome-run-'))
const require = createRequire(import.meta.url)
let child
const stop = () => { child?.kill('SIGTERM') }
process.once('SIGINT', stop)
process.once('SIGTERM', stop)
try {
  child = spawn(process.execPath, [require.resolve('@playwright/test/cli'), 'test', '--config', 'playwright.chrome.config.ts', ...process.argv.slice(2)], {
    cwd: appRoot, stdio: 'inherit',
    env: { ...process.env, TEMP: runRoot, TMP: runRoot, TMPDIR: runRoot, JOT_CHROME_TEST_ROOT: runRoot },
  })
  process.exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', code => resolve(code ?? 1))
  })
} finally {
  process.removeListener('SIGINT', stop)
  process.removeListener('SIGTERM', stop)
  if (!path.resolve(runRoot).startsWith(temporaryRoot + path.sep)) throw new Error('测试临时目录越界')
  fs.rmSync(runRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
  if (fs.existsSync(runRoot)) throw new Error('Chrome 测试临时目录未清理：' + runRoot)
}
