import fs from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { test, expect, callOnPage } from './file-fixture'
import { launch, selectOption, shot } from './helpers'
import { agentScript, startFakeLlm } from '../helpers/fake-llm'

async function menu(page: Page, id: string, action: string) {
  await page.getByTestId('cap-more-' + id).click()
  await page.getByRole('menuitem', { name: action, exact: true }).click()
}
async function ask(page: Page, text: string, count: number) {
  await page.getByTestId('agent-input').fill(text)
  await page.getByTestId('agent-send').click()
  await expect(page.getByTestId('agent-answer')).toHaveCount(count)
  await expect(page.getByTestId('agent-stop')).toHaveCount(0)
}
const manifest = (id = 'u3-reading') => ({
  schemaVersion: 1, id, name: 'U3阅读插件', description: '按当前资料整理事实',
  agents: [{ id: 'reader', name: '插件阅读', description: '核对原文', toolIds: ['read'], skillIds: [id + ':reading'] }],
  skills: ['reading'], requiredTools: [],
})

test('助手创建技能即时刷新目录，下一轮加载真实资源；覆盖可取消、确认后留存', async ({ jot }) => {
  const { page, call, vault } = jot
  const id = 'u3-created', relative = 'references/format.md', marker = '事实、出处、后续行动'
  const fake = await startFakeLlm(agentScript([
    () => ({ toolCall: { name: 'app_help', arguments: { group: 'capabilities' } } }),
    () => ({ toolCall: { name: 'app_manage', arguments: { operation: 'capabilities.skill', args: { action: 'save',
      content: { name: id, title: '助手创建的阅读', description: '按模板整理', body: '读取 references/format.md 后回答。', requiredTools: ['read'] }, enabled: true } } } }),
    () => ({ toolCall: { name: 'app_manage', arguments: { operation: 'capabilities.edit-resources', args: { owner: 'skill', id, files: [{ path: relative, content: marker }] } } } }),
    () => '技能与模板已保存，下轮可用。',
  ]))
  try {
    await call('settings:set', { model: { baseUrl: fake.baseUrl, model: 'fake', apiKey: 'fake' }, appearance: { theme: 'light' } })
    await page.getByTestId('ribbon-capabilities').click()
    await page.getByTestId('cap-tab-skills').click()
    await page.keyboard.press('Control+l')
    await ask(page, '创建阅读技能和模板', 1)
    await expect(page.getByTestId('cap-row-' + id)).toBeVisible()
    const absolute = path.join(vault, '.jot/skills', id, relative)
    expect(fs.readFileSync(absolute, 'utf8')).toBe(marker)
    fake.setResponder(agentScript([
      () => ({ toolCall: { name: 'use_skill', arguments: { name: id, path: relative } } }),
      results => results[0]!,
    ]))
    await ask(page, '使用刚才的技能列出字段', 2)
    await expect(page.getByTestId('agent-answer').last()).toContainText(marker)
    fake.setResponder(agentScript([
      () => ({ toolCall: { name: 'app_manage', arguments: { operation: 'capabilities.edit-resources', args: { owner: 'skill', id, files: [{ path: relative, content: '修改后的模板' }] } } } }),
      () => '已按确认结果处理。',
    ]))
    await page.getByTestId('agent-input').fill('覆盖模板')
    await page.getByTestId('agent-send').click()
    await expect(page.getByTestId('agent-confirmation').last()).toContainText(relative)
    await shot(page, 'u3-assistant-resource-confirm-light')
    await page.getByTestId('agent-confirm-reject').click()
    await expect(page.getByTestId('agent-stop')).toHaveCount(0)
    expect(fs.readFileSync(absolute, 'utf8')).toBe(marker)
    await page.getByTestId('agent-input').fill('确认改为新的模板')
    await page.getByTestId('agent-send').click()
    await page.getByTestId('agent-confirm-approve').click()
    await expect(page.getByTestId('agent-stop')).toHaveCount(0)
    expect(fs.readFileSync(absolute, 'utf8')).toBe('修改后的模板')
    const conversation = (await call('agent:conversations', {})).items[0]!.conversationId
    const messages = (await call('agent:get', { conversationId: conversation })).messages
    expect(messages.at(-1)?.toolCalls?.[0]?.confirmation?.state).toBe('approved')
  } finally { await fake.close() }
})

test('库内插件与包内项编辑、资源增删、任务绑定和工具启停，深浅窄窗与重启保留', async ({ jot }) => {
  const { page, call, vault, launched } = jot
  let resumed: Awaited<ReturnType<typeof launch>> | undefined
  try {
    await call('settings:set', { appearance: { theme: 'light' } })
    await page.getByTestId('ribbon-capabilities').click()
    await page.getByTestId('cap-tab-plugins').click()
    await page.getByTestId('cap-create-plugin').click()
    await page.getByTestId('cap-plugin-manifest').fill(JSON.stringify(manifest(), null, 2))
    await shot(page, 'u3-plugin-create-light')
    await page.getByTestId('cap-manager-save').click()
    await expect(page.getByTestId('app-dialog')).toHaveCount(0)
    const root = path.join(vault, '.jot/plugins/u3-reading')
    expect(fs.existsSync(path.join(root, 'skills/reading/SKILL.md'))).toBe(true)
    await menu(page, 'u3-reading', '配套资源')
    await page.getByTestId('cap-resource-path').fill('references/template.md')
    await page.getByTestId('cap-resource-content').fill('阅读格式：依据、观察、行动')
    await page.getByTestId('cap-manager-save').click()
    await expect(page.getByTestId('app-dialog')).toHaveCount(0)
    expect(fs.readFileSync(path.join(root, 'references/template.md'), 'utf8')).toContain('阅读格式')
    await menu(page, 'u3-reading', '配套资源')
    await page.locator('.cap-resource-list button').filter({ hasText: 'references/template.md' }).click()
    await page.getByTestId('cap-resource-content').fill('未保存的文本')
    await page.getByRole('button', { name: '取消', exact: true }).click()
    await expect(page.getByTestId('cap-manager-discard')).toBeVisible()
    await page.getByRole('button', { name: '继续编辑', exact: true }).click()
    await expect(page.getByTestId('cap-resource-content')).toHaveValue('未保存的文本')
    await page.getByTestId('app-dialog').getByRole('button', { name: '关闭', exact: true }).click()
    await page.getByTestId('cap-manager-discard-confirm').click()
    expect(fs.readFileSync(path.join(root, 'references/template.md'), 'utf8')).toContain('阅读格式')
    await menu(page, 'u3-reading', '配套资源')
    await page.locator('.cap-resource-list button').filter({ hasText: 'references/template.md' }).click()
    await page.getByTestId('cap-resource-delete').click()
    await expect(page.getByTestId('cap-resource-confirmation')).toBeVisible()
    await page.getByRole('button', { name: '取消', exact: true }).click()
    expect(fs.existsSync(path.join(root, 'references/template.md'))).toBe(true)
    await page.getByTestId('cap-resource-delete').click()
    await page.getByTestId('cap-resource-delete-confirm').click()
    await expect(page.getByTestId('app-dialog')).toHaveCount(0)
    expect(fs.existsSync(path.join(root, 'references/template.md'))).toBe(false)

    await menu(page, 'u3-reading', '编辑插件清单')
    await page.getByTestId('cap-plugin-manifest').fill(JSON.stringify({ ...manifest(), name: '我的阅读插件' }, null, 2))
    await page.getByTestId('cap-manager-save').click()
    await expect(page.getByTestId('cap-row-u3-reading')).toHaveText('我的阅读插件')
    await page.getByTestId('cap-tab-agents').click()
    await page.getByTestId('cap-row-u3-reading:reader').click()
    await page.getByTestId('cap-edit').click()
    await page.getByTestId('cap-edit-instructions').fill('读取当前原文，保留出处。')
    await page.getByTestId('cap-edit-save').click()
    await expect(page.getByTestId('app-dialog')).toHaveCount(0)
    expect(fs.readFileSync(path.join(root, 'agents/reader/PROMPT.md'), 'utf8')).toContain('保留出处')
    await page.getByTestId('cap-tab-skills').click()
    await page.getByTestId('cap-row-u3-reading:reading').click()
    await page.getByTestId('cap-edit').click()
    await page.getByTestId('cap-edit-instructions').fill('按三条要点整理阅读事实。')
    await page.getByTestId('cap-edit-save').click()
    await expect(page.getByTestId('app-dialog')).toHaveCount(0)
    await expect(page.getByTestId('cap-row-u3-reading:reading')).toHaveAttribute('aria-current', 'true')
    await expect(page.getByTestId('cap-detail')).toContainText('按三条要点整理阅读事实。')
    await page.getByTestId('cap-task-bindings').click()
    await selectOption(page, 'cap-task-daily', 'u3-reading:reading')
    await expect(page.getByTestId('cap-manager').locator('label').filter({ has: page.getByTestId('cap-task-daily') })).not.toContainText('技能不存在')
    await shot(page, 'u3-task-bindings-light')
    await page.getByTestId('cap-manager-save').click()
    await expect(page.getByTestId('app-dialog')).toHaveCount(0)
    expect((await call('capabilities:catalog', undefined)).taskBindings.find(binding => binding.task === 'daily')).toMatchObject({ skillId: 'u3-reading:reading', issues: [] })

    await page.getByTestId('cap-tab-tools').click()
    await menu(page, 'read', '停用')
    await expect(page.locator('.cap-row').filter({ has: page.getByTestId('cap-row-read') })).toContainText('已停用')
    await page.getByTestId('cap-tab-agents').click()
    await expect(page.locator('.cap-row').filter({ has: page.getByTestId('cap-row-u3-reading:reader') })).toContainText('待调整')
    await page.getByTestId('cap-tab-tools').click()
    await menu(page, 'read', '启用')
    await page.getByTestId('cap-tab-plugins').click()
    await menu(page, 'u3-reading', '复制到本库')
    await page.getByTestId('cap-plugin-copy-id').fill('my-reading')
    await page.getByTestId('cap-plugin-copy-name').fill('我的阅读副本')
    await page.getByTestId('cap-plugin-copy-references').check()
    await page.getByTestId('cap-manager-save').click()
    await expect(page.getByTestId('app-dialog')).toHaveCount(0)
    expect((await call('capabilities:catalog', undefined)).taskBindings.find(binding => binding.task === 'daily')?.skillId).toBe('my-reading:reading')

    await call('settings:set', { appearance: { theme: 'dark' } })
    await page.setViewportSize({ width: 740, height: 800 })
    await page.getByTestId('cap-back').click()
    await page.getByTestId('cap-row-my-reading').click()
    await page.getByTestId('cap-detail-more').click()
    await page.getByRole('menuitem', { name: '配套资源', exact: true }).click()
    await page.locator('.cap-resource-list button').filter({ hasText: 'skills/reading/SKILL.md' }).click()
    await expect(page.getByTestId('cap-resource-content')).toHaveValue(/三条要点/)
    await shot(page, 'u3-resources-dark-narrow')
    expect(await page.getByTestId('app-dialog').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
    await page.getByRole('button', { name: '取消', exact: true }).click()
    await launched.close()
    resumed = await launch({ reuse: launched, isolateHotkey: true })
    await expect(resumed.page.getByTestId('shell')).toBeVisible()
    const catalog = await callOnPage(resumed.page, 'capabilities:catalog', undefined)
    expect(catalog.taskBindings.find(binding => binding.task === 'daily')?.skillId).toBe('my-reading:reading')
    expect(catalog.agents.find(agent => agent.id === 'my-reading:reader')?.instructions).toContain('保留出处')
    expect(catalog.plugins.find(plugin => plugin.id === 'u3-reading')?.enabled).toBe(false)
    await resumed.page.getByTestId('ribbon-capabilities').click()
    await resumed.page.getByTestId('cap-tab-plugins').click()
    await menu(resumed.page, 'my-reading', '卸载')
    await expect(resumed.page.getByTestId('app-dialog')).toContainText('后台任务：daily')
    await resumed.page.getByTestId('cap-uninstall-confirm').click()
    await expect(resumed.page.getByTestId('app-dialog')).toHaveCount(0)
    expect((await callOnPage(resumed.page, 'capabilities:catalog', undefined)).taskBindings.find(binding => binding.task === 'daily')?.issues.join('')).toContain('不存在')
  } finally { await resumed?.close() }
})

test('目录更新预览可取消且使用已预览快照，旧资源移除，技能同标识可更新', async ({ jot }) => {
  const { page, call, vault, launched } = jot
  const source = path.join(launched.workDir, 'u3-external')
  fs.mkdirSync(path.join(source, 'agents/reader'), { recursive: true })
  fs.mkdirSync(path.join(source, 'skills/reading'), { recursive: true })
  fs.writeFileSync(path.join(source, 'plugin.json'), JSON.stringify(manifest()))
  fs.writeFileSync(path.join(source, 'agents/reader/PROMPT.md'), '按阅读技能回答')
  fs.writeFileSync(path.join(source, 'skills/reading/SKILL.md'), '---\nname: reading\ndescription: 阅读事实\nrequired_tools: [read]\n---\n按事实回答')
  fs.writeFileSync(path.join(source, 'old.md'), '将被移除')
  await launched.app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }) }, source)
  await page.getByTestId('ribbon-capabilities').click()
  await page.getByTestId('cap-tab-plugins').click()
  await page.getByTestId('cap-import-plugin').click()
  await page.getByTestId('cap-plugin-import-confirm').click()
  await expect(page.getByTestId('app-dialog')).toHaveCount(0)
  await menu(page, 'u3-reading', '启用')
  const updated = path.join(launched.workDir, 'u3-update')
  fs.cpSync(source, updated, { recursive: true })
  fs.unlinkSync(path.join(updated, 'old.md'))
  fs.writeFileSync(path.join(updated, 'agents/reader/PROMPT.md'), '更新后的阅读规则')
  await launched.app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }) }, updated)
  await menu(page, 'u3-reading', '从目录更新')
  await expect(page.getByTestId('app-dialog')).toContainText('old.md')
  await page.getByRole('button', { name: '取消', exact: true }).click()
  const installed = path.join(vault, '.jot/plugins/u3-reading')
  expect(fs.existsSync(path.join(installed, 'old.md'))).toBe(true)
  await menu(page, 'u3-reading', '从目录更新')
  await expect(page.getByTestId('app-dialog')).toContainText('old.md')
  fs.writeFileSync(path.join(updated, 'agents/reader/PROMPT.md'), '预览之后的外部改动')
  await page.getByTestId('cap-plugin-import-confirm').click()
  await expect(page.getByTestId('app-dialog')).toHaveCount(0)
  expect(fs.readFileSync(path.join(installed, 'agents/reader/PROMPT.md'), 'utf8')).toBe('更新后的阅读规则')
  expect(fs.existsSync(path.join(installed, 'old.md'))).toBe(false)
  expect((await call('capabilities:catalog', undefined)).plugins.find(plugin => plugin.id === 'u3-reading')?.enabled).toBe(true)
  const content = { name: 'u3-standalone', title: '待更新技能', description: '读取原文', body: '原来方法', requiredTools: ['read'] }
  await call('capabilities:changeSkill', { action: 'save', content, enabled: true })
  const skillSource = path.join(launched.workDir, 'skill-update')
  fs.mkdirSync(skillSource)
  fs.writeFileSync(path.join(skillSource, 'SKILL.md'), '---\nname: u3-standalone\ndescription: 读取原文\nrequired_tools: [read]\n---\n更新后的技能方法')
  await launched.app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }) }, skillSource)
  await page.getByTestId('cap-tab-skills').click()
  await menu(page, 'u3-standalone', '从目录更新')
  await expect(page.getByTestId('cap-import-name')).toHaveValue('u3-standalone')
  await expect(page.getByTestId('cap-import-confirm')).toBeEnabled()
  await page.getByTestId('cap-import-confirm').click()
  await expect(page.getByTestId('app-dialog')).toHaveCount(0)
  expect(fs.readFileSync(path.join(vault, '.jot/skills/u3-standalone/SKILL.md'), 'utf8')).toContain('更新后的技能方法')
})
