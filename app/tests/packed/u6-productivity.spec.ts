import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'
import { agentScript, chunkIds, startFakeLlm } from '../helpers/fake-llm'
import { callOnPage } from '../e2e/file-fixture'
import { windowByUrl } from '../e2e/helpers'

test('U6候选包：实用插件和参考资源可用，精确计算依赖随包运行，引用／保存／重启真实保留', async () => {
  const exe = path.resolve(process.env.JOT_PACKED_EXE ?? '')
  expect(fs.existsSync(exe)).toBe(true)
  const root = path.join(path.dirname(exe), 'resources/plugins/jot-productivity')
  for (const [skill, ref] of [['skill-manager', 'actions'], ['research-brief', 'evidence'], ['knowledge-organize', 'outline']]) {
    expect(fs.readFileSync(path.join(root, 'skills', skill!, 'SKILL.md'), 'utf8')).toContain('name: ' + skill)
    expect(fs.readFileSync(path.join(root, 'skills', skill!, 'references', ref + '.md'), 'utf8').length).toBeGreaterThan(100)
  }
  const first = 'content/工作/预算甲.md', second = 'content/工作/预算乙.md', target = 'content/工作/材料简报.md'
  const body = '# 预算简报\n\n甲0.1万元、乙0.2万元，合计0.3万元。\n\n[预算甲](预算甲.md) · [预算乙](预算乙.md)'
  const fake = await startFakeLlm(agentScript([
    () => ({ toolCall: { name: 'use_skill', arguments: { name: 'jot-productivity:research-brief' } } }),
    () => ({ toolCall: { name: 'use_skill', arguments: { name: 'jot-productivity:research-brief', path: 'references/evidence.md' } } }),
    () => ({ toolCall: { name: 'read', arguments: { path: first } } }),
    () => ({ toolCall: { name: 'read', arguments: { path: second } } }),
    () => ({ toolCall: { name: 'calculator', arguments: { expression: '0.1+0.2' } } }),
    () => ({ toolCall: { name: 'write_files', arguments: { files: [{ path: target, body }] } } }),
    results => '预算合计' + JSON.parse(results[4]!).result + '万元，依据甲[^' + chunkIds(results[2]!)[0] + ']与乙[^' + chunkIds(results[3]!)[0] + ']，已保存到' + target,
  ]))
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'jot-u6-packed-data-')), work = fs.mkdtempSync(path.join(os.tmpdir(), 'jot-u6-packed-work-'))
  const vault = path.join(work, '库'), now = new Date(); now.setHours(12, 0, 0, 0)
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && !entry[0].startsWith('JOT_')))
  Object.assign(env, { JOT_USER_DATA: data, JOT_NO_DOTENV: '1', JOT_TEST_NOW: now.toISOString() })
  let app = await electron.launch({ executablePath: exe, env })
  try {
    let page = await windowByUrl(app, 'index.html')
    await page.getByTestId('vault-path').fill(vault); await page.getByTestId('vault-use').click()
    await page.getByTestId('model-skip').click(); await page.getByTestId('onboarding-start').click()
    await expect(page.getByTestId('shell')).toBeVisible()
    await callOnPage(page, 'settings:set', { model: { baseUrl: fake.baseUrl, model: 'packed-u6', apiKey: 'fake' }, daily: { enabled: false }, classify: { enabled: false } })
    const catalog = await callOnPage(page, 'capabilities:catalog', undefined)
    expect(catalog.plugins.find(pkg => pkg.id === 'jot-productivity')).toMatchObject({ enabled: true, agentIds: [], issues: [] })
    expect(catalog.tools.find(tool => tool.id === 'calculator')).toMatchObject({ enabled: true, access: 'read' })
    fs.writeFileSync(path.join(vault, first), '预算甲0.1万元'); fs.writeFileSync(path.join(vault, second), '预算乙0.2万元')
    await callOnPage(page, 'vault:refreshIndex', {})
    await page.keyboard.press('Control+l')
    await page.getByTestId('agent-input').fill('比较预算并保存到' + target)
    await page.getByTestId('agent-send').click()
    await expect(page.getByTestId('agent-stop')).toHaveCount(0)
    await expect(page.getByTestId('agent-answer')).toContainText('合计0.3万元')
    const id = (await callOnPage(page, 'agent:conversations', {})).items[0]!.conversationId
    const answer = (await callOnPage(page, 'agent:get', { conversationId: id })).messages.at(-1)!
    expect(answer.toolCalls).toHaveLength(6)
    expect(answer.toolCalls!.every(tool => tool.ok)).toBe(true)
    expect(answer.citations!.every(cite => cite.valid)).toBe(true)
    expect(fs.readFileSync(path.join(vault, target), 'utf8')).toContain('[预算甲](预算甲.md)')
    expect((await callOnPage(page, 'doc:resolveLink', { from: target, target: '预算甲.md', kind: 'markdown' })).path).toBe(first)
    await app.evaluate(({ app }) => app.exit(0)); await app.close()
    app = await electron.launch({ executablePath: exe, env })
    page = await windowByUrl(app, 'index.html'); await expect(page.getByTestId('shell')).toBeVisible()
    expect((await callOnPage(page, 'agent:get', { conversationId: id })).messages.at(-1)?.toolCalls).toEqual(answer.toolCalls)
    expect(fs.readFileSync(path.join(vault, target), 'utf8')).toContain('合计0.3万元')
  } finally {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); await app.close().catch(() => {})
    await fake.close()
    await fs.promises.rm(data, { recursive: true, force: true }); await fs.promises.rm(work, { recursive: true, force: true })
  }
})
