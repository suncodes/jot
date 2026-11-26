import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Core } from '../../electron/core'
import { loadDevModelDefaults } from '../../electron/env'
import { makeTmpDir, noon } from '../helpers/tmp'

const config = loadDevModelDefaults(path.resolve(import.meta.dirname, '../../..'))
describe.skipIf(!config)('真实模型：当前通用助手与四类技能', () => {
  let core: Core, tmp: ReturnType<typeof makeTmpDir>
  beforeEach(async () => {
    tmp = makeTmpDir('universal-llm')
    core = new Core({ now: noon, userDataDir: path.join(tmp.dir, 'data'), devModel: config, secrets: { encrypt: text => text, decrypt: text => text }, emit: () => {} })
    await core.init(); await core.openVault(path.join(tmp.dir, '虚构库'), true)
    await core.settings.set({ classify: { enabled: false }, daily: { enabled: false } }); await core.jobs.stop()
  })
  afterEach(async () => { await core.dispose(); tmp.cleanup() })

  it('当前Pi诊断可连接，默认通用助手与全部预装任务依赖有效', async () => {
    expect(await core.model.test(core.pi, core.vault.path)).toMatchObject({ ok: true })
    const catalog = await core.capabilities.catalog()
    expect(catalog.agents.map(agent => agent.id)).toEqual(['default'])
    expect(catalog.taskBindings.every(binding => !binding.issues.length)).toBe(true)
  })

  it('四类后台通过正式技能执行，原件不改，整理和同义只保存待确认建议', async () => {
    const source = 'inbox/2026/11/接口评审.txt', raw = '项目甲确认采用接口甲，预算0.3万元，林晓负责接口文档。'
    fs.mkdirSync(path.dirname(core.vault.abs(source)), { recursive: true }); fs.writeFileSync(core.vault.abs(source), raw)
    await core.syncIndex()
    await core.files.summarize(source); await core.idle()
    const summary = await core.vault.read({ path: core.files.summaries(source)[0]! })
    expect(summary.body).toContain('接口甲')
    expect(summary.properties?.skill).toBe('jot-core:source-summary')
    await core.classify.run(source)
    const directory = core.state.getSuggestion(source, 'directory')
    if (directory?.kind === 'directory') expect(core.content.directories(undefined, true).some(item => item.path === directory.directoryPath)).toBe(true)
    expect((await core.vault.read({ path: source })).classification.tags).toEqual([])
    core.state.confirmTerms('tag', ['Jot', 'Jot笔记'], 'preset')
    await core.taxonomy.findSynonyms('tag')
    for (const group of core.taxonomy.synonyms()) expect(group.names.every(name => ['Jot', 'Jot笔记'].includes(name))).toBe(true)
    await core.vault.createIdea({ text: '今天明确完成接口评审，确认采用方案甲。', source: 'main-window' }); await core.idle()
    const date = noon().getFullYear() + '-' + String(noon().getMonth() + 1).padStart(2, '0') + '-' + String(noon().getDate()).padStart(2, '0')
    await core.daily.run(date)
    const daily = await core.vault.read({ path: 'journal/' + date.slice(0, 4) + '/' + date + '.md' })
    expect(daily.body).toContain('评审')
    expect(daily.properties?.skill).toBe('jot-core:daily-review')
    expect(fs.readFileSync(core.vault.abs(source), 'utf8')).toBe(raw)
  })

  it('通用助手按明确材料做简报、精确计算、引用并保存独立笔记', async () => {
    for (const [name, body] of [['甲', '方案甲预算0.1万元，已验证。'], ['乙', '方案乙预算0.2万元，还在讨论。']])
      await core.vault.createNote({ dir: 'content/工作', title: name!, body })
    await core.idle()
    const id = core.agent.create().conversationId, output = 'content/工作/预算简报.md'
    const { runId } = core.agent.send(id, '使用材料简报技能，读取甲.md与乙.md。用calculator核算两项预算总额，区分已验证和讨论方案。引用原文，并将简报保存到' + output + '，文件内使用普通相对来源链接。', {
      agentId: 'default', references: [{ kind: 'folder', value: 'content/工作', title: '工作' }], strict: true, skillIds: ['jot-productivity:research-brief'],
    })
    await core.agent.wait(runId)
    const answer = core.agent.get(id).messages.at(-1)!
    expect(answer.error).toBeUndefined()
    expect(answer.toolCalls?.some(call => call.name === 'calculator' && call.ok)).toBe(true)
    expect(answer.citations?.length).toBeGreaterThanOrEqual(2)
    expect(answer.citations?.every(cite => cite.valid)).toBe(true)
    const body = (await core.vault.read({ path: output })).body
    expect(body).toMatch(/0\.3|三千|3000/)
    expect(body).toMatch(/\]\([^\n)]+\.md\)/)
    expect(body).not.toMatch(/\[\^[a-f0-9]{6}\]/)
  })
})
