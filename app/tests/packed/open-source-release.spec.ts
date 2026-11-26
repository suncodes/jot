import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { _electron as electron, expect, test } from '@playwright/test'
import { agentScript, chunkIds, startFakeLlm } from '../helpers/fake-llm'
import { callOnPage } from '../e2e/file-fixture'
import { windowByUrl } from '../e2e/helpers'

test('公开发行包：许可与能力资源完整，隔离建库、捕获、助手读写和加密配置可重启', async () => {
  const exe = path.resolve(process.env.JOT_PACKED_EXE ?? path.join(import.meta.dirname, '../../dist/win-unpacked/Jot.exe'))
  const packed = path.dirname(exe), repo = path.resolve(import.meta.dirname, '../../..')
  for (const file of ['LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md', 'PRIVACY.md', 'licenses/THIRD_PARTY_LICENSES.txt']) {
    const digest = (target: string) => createHash('sha256').update(fs.readFileSync(target)).digest('hex')
    expect(digest(path.join(packed, file))).toBe(digest(path.join(repo, file)))
  }
  for (const file of ['LICENSE.electron.txt', 'LICENSES.chromium.html', 'resources/app.asar', 'resources/app-extensions/work-diary/extension.json'])
    expect(fs.statSync(path.join(packed, file)).size).toBeGreaterThan(0)
  expect(fs.existsSync(path.join(packed, '.env'))).toBe(false)
  expect(fs.existsSync(path.join(packed, 'resources/.env'))).toBe(false)
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jot-public-release-'))
  const data = path.join(root, 'user-data'), vault = path.join(root, '虚构笔记库'), note = 'content/工作/发行验证.md'
  const key = 'public-release-fixture-key', body = '这是隔离发行测试创建的虚构笔记。'
  const fake = await startFakeLlm(agentScript([
    () => ({ toolCall: { name: 'write_files', arguments: { files: [{ path: note, body }] } } }),
    () => ({ toolCall: { name: 'read', arguments: { path: note } } }),
    results => '已保存并读取[^' + chunkIds(results[1]!)[0] + ']。',
  ]))
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && !entry[0].startsWith('JOT_')))
  const noon = new Date(); noon.setHours(12, 0, 0, 0)
  Object.assign(env, { JOT_USER_DATA: data, JOT_NO_DOTENV: '1', JOT_TEST_NOW: noon.toISOString() })
  let app = await electron.launch({ executablePath: exe, env })
  try {
    await app.evaluate(({ globalShortcut }) => { globalShortcut.unregisterAll(); globalShortcut.register = () => true })
    let page = await windowByUrl(app, 'index.html')
    expect(await app.evaluate(({ app }) => app.isPackaged)).toBe(true)
    await page.getByTestId('vault-path').fill(vault); await page.getByTestId('vault-use').click()
    await expect(page.getByTestId('dev-model')).toHaveCount(0)
    await page.getByTestId('model-skip').click(); await page.getByTestId('onboarding-start').click()
    await expect(page.getByTestId('shell')).toBeVisible()
    await callOnPage(page, 'settings:set', { model: { baseUrl: fake.baseUrl, model: 'public-release', apiKey: key }, classify: { enabled: false }, daily: { enabled: false } })
    const catalog = await callOnPage(page, 'capabilities:catalog', undefined)
    expect(catalog.agents.map(agent => agent.id)).toEqual(['default'])
    expect(catalog.plugins.map(plugin => plugin.id).sort()).toEqual(['jot-core', 'jot-productivity', 'work-review'])
    expect(catalog.plugins.every(plugin => !plugin.issues.length)).toBe(true)
    expect(catalog.tools).toHaveLength(18)
    for (const skill of catalog.skills) {
      expect((await callOnPage(page, 'capabilities:readResource', { owner: 'skill', id: skill.id, path: 'SKILL.md' })).length).toBeGreaterThan(50)
    }
    const capture = page.getByTestId('capture-bar')
    await capture.getByTestId('capture-input').fill('隔离测试的灵感 #验证')
    await capture.getByTestId('capture-input').press('Enter')
    await expect(page.getByTestId('toast').filter({ hasText: '已保存到灵感' })).toBeVisible()
    expect(fake.requests).toHaveLength(0)
    await page.keyboard.press('Control+l')
    await page.getByTestId('agent-input').fill('创建发行验证笔记并回读。')
    await page.getByTestId('agent-send').click()
    await expect(page.getByTestId('agent-stop')).toHaveCount(0)
    await expect(page.getByTestId('agent-answer').locator('a.cite.valid')).toHaveCount(1)
    expect(fs.readFileSync(path.join(vault, note), 'utf8')).toContain(body)
    const settings = fs.readFileSync(path.join(data, 'settings.json'), 'utf8')
    expect(settings).not.toContain(key)
    expect(JSON.parse(settings).model.apiKeyEnc).toMatch(/^enc:/)
    const sdkAuth = path.join(data, 'pi/auth.json')
    if (fs.existsSync(sdkAuth)) expect(fs.readFileSync(sdkAuth, 'utf8')).not.toContain(key)
    const conversationId = (await callOnPage(page, 'agent:conversations', {})).items[0]!.conversationId
    await app.evaluate(({ app }) => app.exit(0)); await app.close()
    const requests = fake.requests.length
    app = await electron.launch({ executablePath: exe, env })
    page = await windowByUrl(app, 'index.html'); await expect(page.getByTestId('shell')).toBeVisible()
    expect((await callOnPage(page, 'settings:get', undefined)).model.hasApiKey).toBe(true)
    expect((await callOnPage(page, 'agent:get', { conversationId })).messages.at(-1)?.text).toContain('已保存并读取')
    expect(fake.requests).toHaveLength(requests)
  } finally {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); await app.close().catch(() => {})
    await fake.close(); await fs.promises.rm(root, { recursive: true, force: true })
  }
})
