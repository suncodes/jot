import fs from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { test, expect, callOnPage } from './file-fixture'
import { launch, shot } from './helpers'
import { agentScript, chunkIds, startFakeLlm } from '../helpers/fake-llm'

const first = 'content/工作/甲/预算.md', second = 'content/工作/乙/预算.md'
async function ask(page: Page, text: string, count: number) {
  await page.getByTestId('agent-input').fill(text); await page.getByTestId('agent-send').click()
  await expect(page.getByTestId('agent-answer')).toHaveCount(count); await expect(page.getByTestId('agent-stop')).toHaveCount(0)
}
const script = () => agentScript([
  () => ({ toolCall: { name: 'use_skill', arguments: { name: 'jot-productivity:research-brief' } } }),
  () => ({ toolCall: { name: 'use_skill', arguments: { name: 'jot-productivity:research-brief', path: 'references/evidence.md' } } }),
  () => ({ toolCall: { name: 'read', arguments: { path: first } } }),
  () => ({ toolCall: { name: 'read', arguments: { path: second } } }),
  () => ({ toolCall: { name: 'calculator', arguments: { expression: '0.1+0.2' } } }),
  results => '甲预算0.1万元[^' + chunkIds(results[2]!)[0] + ']，乙预算0.2万元[^'
    + chunkIds(results[3]!)[0] + ']，合计' + JSON.parse(results[4]!).result + '万元。乙仍是讨论方案。',
])

test('实用技能可通过$引用，跨笔记简报、计算和来源走真实工具；普通问答不保存，重启保留', async ({ jot }) => {
  const { page, call, write, launched, vault } = jot
  const fake = await startFakeLlm(script())
  let resumed: Awaited<ReturnType<typeof launch>> | undefined
  try {
    await call('settings:set', { model: { baseUrl: fake.baseUrl, model: 'u6-model', apiKey: 'fake' } })
    write(first, '甲预算0.1万元，已完成接口验证。'); write(second, '乙预算0.2万元，目前还是讨论方案。')
    await call('vault:refreshIndex', {})
    await page.keyboard.press('Control+l')
    const input = page.getByTestId('agent-input')
    for (const folder of ['content/工作/甲', 'content/工作/乙']) {
      await input.fill('@' + folder)
      await page.getByTestId('agent-candidates').locator('[data-kind="folder"][data-path=' + JSON.stringify(folder) + ']').click()
    }
    await input.fill('$research-brief')
    const choice = page.getByRole('option').filter({ hasText: '材料简报' })
    await expect(choice).toBeVisible(); await choice.click()
    await expect(input).toHaveValue('$jot-productivity:research-brief ')
    await ask(page, '$jot-productivity:research-brief 比较两份预算，算出合计，只回答。', 1)
    const answer = page.getByTestId('agent-answer').last()
    await expect(answer).toContainText('合计0.3万元')
    await expect(answer.locator('a.cite.valid')).toHaveCount(2)
    const id = (await call('agent:conversations', {})).items[0]!.conversationId
    const saved = (await call('agent:get', { conversationId: id })).messages.at(-1)!
    expect(saved.context?.skillIds).toEqual(['jot-productivity:research-brief'])
    expect(saved.toolCalls!.map(tool => tool.name)).toEqual(['use_skill', 'use_skill', 'read', 'read', 'calculator'])
    expect(saved.toolCalls!.every(tool => tool.ok)).toBe(true)
    expect(saved.toolCalls!.at(-1)?.output).toContain('"result":"0.3"')
    await shot(page, 'u6-brief-calculation-light')
    expect(fs.readdirSync(path.join(vault, 'content/工作')).sort()).toEqual(['乙', '甲'].sort())
    expect((await call('library:query', {})).total).toBe(2)
    await launched.close(); resumed = await launch({ reuse: launched, isolateHotkey: true })
    await expect(resumed.page.getByTestId('shell')).toBeVisible()
    expect((await callOnPage(resumed.page, 'agent:get', { conversationId: id })).messages.at(-1)?.toolCalls).toEqual(saved.toolCalls)
  } finally { await resumed?.close(); await fake.close() }
})

test('插件与计算器沿现有管理界面展示，可启停并恢复依赖，深色窄窗可用', async ({ jot }) => {
  const { page, call } = jot
  await page.getByTestId('ribbon-capabilities').click(); await page.getByTestId('cap-tab-skills').click()
  for (const skill of ['skill-manager', 'research-brief', 'knowledge-organize'])
    await expect(page.getByTestId('cap-row-jot-productivity:' + skill)).toBeVisible()
  await page.getByTestId('cap-row-jot-productivity:knowledge-organize').click()
  await expect(page.getByTestId('cap-detail')).toContainText('知识梳理')
  await page.getByTestId('cap-tab-tools').click(); await page.getByTestId('cap-row-calculator').click()
  await expect(page.getByTestId('cap-detail')).toContainText('40位有效数字')
  await expect(page.getByTestId('cap-detail')).toContainText('不读取文件、不写数据')
  await expect(page.getByTestId('cap-detail')).toContainText('仅计算输入的数值表达式')
  await page.getByTestId('cap-tool-parameters').locator('summary').click()
  await expect(page.getByTestId('cap-tool-parameters')).toContainText('expression')
  await shot(page, 'u6-calculator-detail-light')
  await page.getByTestId('cap-more-calculator').click(); await page.getByRole('menuitem', { name: '停用', exact: true }).click()
  await expect.poll(async () => (await call('capabilities:catalog', undefined)).tools.find(tool => tool.id === 'calculator')?.enabled).toBe(false)
  await page.getByTestId('cap-more-calculator').click(); await page.getByRole('menuitem', { name: '启用', exact: true }).click()
  await expect.poll(async () => (await call('capabilities:catalog', undefined)).tools.find(tool => tool.id === 'calculator')?.enabled).toBe(true)
  await page.getByTestId('cap-tab-plugins').click(); await page.getByTestId('cap-row-jot-productivity').click()
  await expect(page.getByTestId('cap-plugin-detail')).toContainText('助手实用')
  await call('settings:set', { appearance: { theme: 'dark' } })
  await page.setViewportSize({ width: 740, height: 820 })
  await shot(page, 'u6-productivity-plugin-dark-narrow')
})

test('助手按技能管理指引创建能力，下一轮通过/引用加载；知识梳理明确保存为普通相对链接文件', async ({ jot }) => {
  const { page, call, write, vault } = jot
  const fake = await startFakeLlm(agentScript([
    () => ({ toolCall: { name: 'use_skill', arguments: { name: 'jot-productivity:skill-manager' } } }),
    () => ({ toolCall: { name: 'use_skill', arguments: { name: 'jot-productivity:skill-manager', path: 'references/actions.md' } } }),
    () => ({ toolCall: { name: 'app_help', arguments: { operation: 'capabilities.skill' } } }),
    () => ({ toolCall: { name: 'app_manage', arguments: { operation: 'capabilities.skill', args: { action: 'save',
      content: { name: 'u6-outline', title: '我的提纲', description: '整理当前笔记要点', body: '按事实、依据和待补问题整理。', requiredTools: ['read'] }, enabled: true } } } }),
    () => '已创建我的提纲，下轮可使用。',
  ]))
  try {
    await call('settings:set', { model: { baseUrl: fake.baseUrl, model: 'u6-model', apiKey: 'fake' } })
    await page.getByTestId('ribbon-capabilities').click(); await page.getByTestId('cap-tab-skills').click()
    await page.keyboard.press('Control+l')
    await ask(page, '创建一个提纲技能，按事实、依据和待补问题整理。', 1)
    await expect(page.getByTestId('cap-row-u6-outline')).toBeVisible()
    fake.setResponder(agentScript([
      () => ({ toolCall: { name: 'use_skill', arguments: { name: 'u6-outline' } } }),
      results => results[0]!,
    ]))
    await page.getByTestId('agent-input').fill('/u6-outline')
    await page.getByRole('option').filter({ hasText: '我的提纲' }).click()
    await ask(page, '/u6-outline 核对做法', 2)
    await expect(page.getByTestId('agent-answer').last()).toContainText('事实、依据和待补问题')
    write('content/成长/学习.md', '排查性能前先确认瓶颈，区分测量和猜测。'); await call('vault:refreshIndex', {})
    const target = 'content/成长/知识提纲.md'
    fake.setResponder(agentScript([
      () => ({ toolCall: { name: 'use_skill', arguments: { name: 'jot-productivity:knowledge-organize' } } }),
      () => ({ toolCall: { name: 'use_skill', arguments: { name: 'jot-productivity:knowledge-organize', path: 'references/outline.md' } } }),
      () => ({ toolCall: { name: 'read', arguments: { path: 'content/成长/学习.md' } } }),
      () => ({ toolCall: { name: 'write_files', arguments: { files: [{ path: target, body: '# 性能排查\n\n先测量瓶颈，再分析原因。\n\n来源：[学习记录](学习.md)' }] } } }),
      () => '已保存知识提纲：' + target,
    ]))
    await ask(page, '使用知识梳理技能整理学习.md并保存到' + target, 3)
    const saved = fs.readFileSync(path.join(vault, target), 'utf8')
    expect(saved).toContain('[学习记录](学习.md)')
    expect((await call('doc:resolveLink', { from: target, target: '学习.md', kind: 'markdown' })).path).toBe('content/成长/学习.md')
    expect(fs.readFileSync(path.join(vault, 'content/成长/学习.md'), 'utf8')).toContain('区分测量和猜测')
  } finally { await fake.close() }
})
