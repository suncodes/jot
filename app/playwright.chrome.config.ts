import fs from 'node:fs'
import path from 'node:path'
import { defineConfig } from '@playwright/test'

const chrome = [process.env.JOT_CHROME_EXE,
  path.join(process.env.LOCALAPPDATA ?? '', 'Google/Chrome/Application/chrome.exe'),
  'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
].find(candidate => candidate && fs.existsSync(candidate))
if (!chrome) throw new Error('Chrome 未安装，请通过 JOT_CHROME_EXE 指定 chrome.exe')

export default defineConfig({
  testDir: 'tests/e2e', testMatch: 'model-protocols.chrome.spec.ts', timeout: 60000, workers: 1,
  use: { browserName: 'chromium', launchOptions: { executablePath: chrome }, headless: true, viewport: { width: 960, height: 900 } },
  reporter: [['list']], outputDir: path.join(process.env.JOT_CHROME_TEST_ROOT ?? '../tmp/chrome', 'results'),
})
