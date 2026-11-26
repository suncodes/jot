import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PluginDefinition } from '@shared/capabilities'
import { appExtensionManifest } from '../../electron/extensions/schema'
import { argSchemas } from '../../electron/ipc/schemas'
import { agentScript } from '../helpers/fake-llm'
import { appExtensionSource } from '../helpers/app-extension'
import { testApp } from '../helpers/test-app'

let app: Awaited<ReturnType<typeof testApp>>
let usesModel = false
const aiPath = 'ai/report'
const skillId = 'reports:summarize'
const pluginManifest = (id = 'reports'): PluginDefinition => ({ schemaVersion: 1, id, name: '虚构报告技能包', description: '整理工作材料', agents: [], skills: ['summarize'], requiredTools: ['read'] })
function source(version = '1.0.0', aiId = 'reports') {
  const pkg = appExtensionSource(path.join(app.tmp.dir, 'sources', version), 'work-diary', { version, aiPlugin: { path: aiPath } })
  pkg.write(aiPath + '/plugin.json', JSON.stringify(pluginManifest(aiId)))
  pkg.write(aiPath + '/skills/summarize/SKILL.md', '---\nname: summarize\ndescription: 整理工作材料\n---\n# 整理工作\n读取 references/format.md。')
  pkg.write(aiPath + '/skills/summarize/references/format.md', '按事实、来源、后续安排整理。')
  return pkg
}
async function preview(root: string, updating?: string) {
  app.core.extensions.setPlatform({ pickDirectory: async () => root })
  const result = await app.call('extensions:previewImport', { source: { kind: 'local' }, updating })
  if (!result) throw new Error('没有返回预览')
  return result
}
async function install(installAiPlugin = false) {
  const pkg = source()
  const pending = await preview(pkg.root)
  await app.call('extensions:confirmImport', { token: pending.token, installAiPlugin })
  return pkg
}
async function details() {
  return (await app.call('extensions:catalog', undefined)).installed.find(pkg => pkg.id === 'work-diary')!
}
const aiFile = (relative = 'plugin.json') => app.file('.jot/plugins/reports/' + relative)
function actualCandidate() {
  fs.cpSync(path.resolve(import.meta.dirname, '../../resources/app-extensions/work-diary'), path.join(app.appExtensionCandidates, 'work-diary'), { recursive: true })
}

beforeEach(async () => { usesModel = false; app = await testApp() })
afterEach(async () => {
  vi.restoreAllMocks()
  try { if (!usesModel) expect(app.fake.requests).toHaveLength(0) }
  finally { await app.close() }
})

describe('W3 应用插件与配套 AI 能力包', () => {
  it('预览不落盘；默认跳过配套包，仅安装停用的应用插件', async () => {
    const pkg = source()
    const pending = await preview(pkg.root)
    expect(pending.aiPlugin).toMatchObject({ id: 'reports', installation: { kind: 'missing' }, issues: [] })
    expect(pending.aiPlugin!.files).toContain('skills/summarize/references/format.md')
    expect(fs.existsSync(aiFile())).toBe(false)
    await app.call('extensions:confirmImport', { token: pending.token })
    expect(await details()).toMatchObject({ enabled: false, aiPlugin: { installation: { kind: 'missing' } } })
    expect(fs.existsSync(aiFile())).toBe(false)
    expect(await app.core.vault.listFiles()).toEqual([])
  })

  it('勾选联装复制预览快照，两类包默认停用，不修改助手配置或业务文件', async () => {
    const before = await app.core.vault.getAssistantConfiguration()
    const pkg = source(), pending = await preview(pkg.root)
    pkg.write(aiPath + '/skills/summarize/references/format.md', '预览后修改的源资源')
    await app.call('extensions:confirmImport', { token: pending.token, installAiPlugin: true })
    expect(await details()).toMatchObject({ enabled: false, issues: [], aiPlugin: { installation: { kind: 'installed', source: 'vault', enabled: false, issues: [] } } })
    expect(fs.readFileSync(aiFile('skills/summarize/references/format.md'), 'utf8')).toBe('按事实、来源、后续安排整理。')
    expect(await app.core.vault.getAssistantConfiguration()).toEqual(before)
    expect((await app.call('capabilities:catalog', undefined)).skills.find(skill => skill.id === skillId)?.enabled).toBe(false)
    expect(await app.core.vault.listFiles()).toEqual([])
    expect((await app.call('shortcuts:get', undefined)).pinned).toEqual([])
  })

  it('后补安装可以取消；新预览替换旧预览，确认也使用快照', async () => {
    await install()
    const cancelled = await app.call('extensions:previewAiPlugin', { id: 'work-diary' })
    await app.call('extensions:cancelAiPlugin', { token: cancelled.token })
    await expect(app.call('extensions:confirmAiPlugin', { token: cancelled.token })).rejects.toThrow('预览已失效')
    const previous = await app.call('extensions:previewAiPlugin', { id: 'work-diary' })
    const pending = await app.call('extensions:previewAiPlugin', { id: 'work-diary' })
    await expect(app.call('extensions:confirmAiPlugin', { token: previous.token })).rejects.toThrow('预览已失效')
    app.write('.jot/app-extensions/work-diary/' + aiPath + '/skills/summarize/references/format.md', '后补预览之后的源修改')
    const before = await app.call('extensions:configuration', undefined)
    await app.call('extensions:confirmAiPlugin', { token: pending.token })
    expect(fs.readFileSync(aiFile('skills/summarize/references/format.md'), 'utf8')).toBe('按事实、来源、后续安排整理。')
    expect(await app.call('extensions:configuration', undefined)).toEqual(before)
    expect(await details()).toMatchObject({ aiPlugin: { installation: { kind: 'installed', enabled: false } } })
  })

  it.each(['bundled', 'vault', 'disabled'] as const)('已有 %s 同标识包显示实际状态，联装和后补不覆盖、不重新启用', async kind => {
    const id = kind === 'bundled' ? 'work-review' : 'reports'
    if (kind !== 'bundled') await app.call('capabilities:changePlugin', { action: 'save', manifest: pluginManifest(), files: [
      { path: 'skills/summarize/SKILL.md', content: '---\nname: summarize\ndescription: 已有技能\n---\n# 用户自己的规则' },
    ], enabled: kind === 'vault' })
    const before = await app.call('capabilities:readResource', { owner: 'plugin', id, path: 'plugin.json' })
    const pkg = source('1.0.0', id), pending = await preview(pkg.root)
    expect(pending.aiPlugin).toMatchObject({ id, installation: { kind: 'installed', source: kind === 'bundled' ? 'bundled' : 'vault', enabled: kind !== 'disabled' } })
    await expect(app.call('extensions:confirmImport', { token: pending.token, installAiPlugin: true })).rejects.toThrow('CONFLICT')
    expect(fs.existsSync(app.file('.jot/app-extensions/work-diary'))).toBe(false)
    await app.call('extensions:confirmImport', { token: pending.token })
    await expect(app.call('extensions:previewAiPlugin', { id: 'work-diary' })).rejects.toThrow('CONFLICT')
    expect(await app.call('capabilities:readResource', { owner: 'plugin', id, path: 'plugin.json' })).toBe(before)
    expect((await app.call('capabilities:catalog', undefined)).plugins.find(plugin => plugin.id === id)?.enabled).toBe(kind !== 'disabled')
  })

  it.each(['file', 'broken-directory', 'case-directory'] as const)('已有 %s 占用时明确诊断，普通应用插件仍可安装', async kind => {
    const occupied = kind === 'case-directory' ? '.jot/plugins/Reports/manual.md' : kind === 'file' ? '.jot/plugins/reports' : '.jot/plugins/reports/plugin.json'
    app.write(occupied, '用户自己的内容')
    const pkg = source(), pending = await preview(pkg.root)
    expect(pending.aiPlugin?.installation.kind).toBe('occupied')
    expect(pending.issues).toEqual([])
    await expect(app.call('extensions:confirmImport', { token: pending.token, installAiPlugin: true })).rejects.toThrow('CONFLICT')
    await app.call('extensions:confirmImport', { token: pending.token })
    expect(fs.readFileSync(app.file(occupied), 'utf8')).toBe('用户自己的内容')
  })

  it('预览后出现同标识包时拒绝联装；可跳过配套包继续安装应用插件', async () => {
    const pending = await preview(source().root)
    app.write('.jot/plugins/reports/manual.md', '晚于预览出现的用户资料')
    await expect(app.call('extensions:confirmImport', { token: pending.token, installAiPlugin: true })).rejects.toThrow('CONFLICT')
    expect(fs.existsSync(app.file('.jot/app-extensions/work-diary'))).toBe(false)
    await app.call('extensions:confirmImport', { token: pending.token })
    expect(fs.readFileSync(app.file('.jot/plugins/reports/manual.md'), 'utf8')).toContain('用户资料')
  })

  it('后补确认前出现同标识文件不被覆盖', async () => {
    await install()
    const pending = await app.call('extensions:previewAiPlugin', { id: 'work-diary' })
    app.write('.jot/plugins/reports', '后出现的普通文件')
    await expect(app.call('extensions:confirmAiPlugin', { token: pending.token })).rejects.toThrow('CONFLICT')
    expect(fs.readFileSync(app.file('.jot/plugins/reports'), 'utf8')).toBe('后出现的普通文件')
    expect((await details()).enabled).toBe(false)
  })

  it.each(['missing', 'manifest', 'skill'] as const)('附带 %s 损坏只禁用配套安装，不阻断日记功能', async damage => {
    const pkg = source()
    if (damage === 'missing') fs.unlinkSync(path.join(pkg.root, aiPath, 'plugin.json'))
    else pkg.write(aiPath + (damage === 'manifest' ? '/plugin.json' : '/skills/summarize/SKILL.md'), '{broken')
    const pending = await preview(pkg.root)
    expect(pending.issues).toEqual([])
    expect(pending.aiPlugin?.issues.length).toBeGreaterThan(0)
    await expect(app.call('extensions:confirmImport', { token: pending.token, installAiPlugin: true })).rejects.toThrow('INVALID_INPUT')
    await app.call('extensions:confirmImport', { token: pending.token })
    const options = { directory: 'content/虚构日记', filename: '{{yyyy}}-{{MM}}-{{dd}}.md', template: { kind: 'none' as const } }
    await app.call('extensions:saveProfile', { id: 'work-diary', profile: { id: 'today', commandId: 'today', name: '写日记', options } })
    await app.call('extensions:setEnabled', { id: 'work-diary', enabled: true })
    expect(await app.call('commands:execute', { id: 'extension:work-diary:today:today' })).toMatchObject({ kind: 'open-note', created: true })
    expect(fs.existsSync(aiFile())).toBe(false)
  })

  it.each(['app', 'ai', 'configuration'] as const)('联合安装 %s 发布失败时回滚两个包与配置，可原预览重试', async failingPart => {
    const pending = await preview(source().root)
    const target = app.file(failingPart === 'app' ? '.jot/app-extensions/work-diary' : failingPart === 'ai' ? '.jot/plugins/reports' : '.jot/app-extensions.json')
    const rename = fs.promises.rename.bind(fs.promises)
    const failure = vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      if (path.resolve(String(to)) === path.resolve(target)) throw new Error('虚构联合安装失败')
      return rename(from, to)
    })
    await expect(app.call('extensions:confirmImport', { token: pending.token, installAiPlugin: true })).rejects.toThrow('虚构联合安装失败')
    failure.mockRestore()
    expect(fs.readdirSync(app.file('.jot/app-extensions'))).toEqual([])
    expect(fs.readdirSync(app.file('.jot/plugins'))).toEqual([])
    expect(fs.existsSync(app.file('.jot/app-extensions.json'))).toBe(false)
    expect((await app.call('extensions:confirmImport', { token: pending.token, installAiPlugin: true })).installed[0]?.aiPlugin?.installation.kind).toBe('installed')
  })

  it('应用更新联装失败恢复原包和自定义配置；后补装失败也保留应用包', async () => {
    await install()
    const before = fs.readFileSync(app.file('.jot/app-extensions.json'), 'utf8')
    const pending = await preview(source('2.0.0').root, 'work-diary')
    const rename = fs.promises.rename.bind(fs.promises)
    const failure = vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      if (path.resolve(String(to)) === path.resolve(app.file('.jot/plugins/reports'))) throw new Error('虚构 AI 发布失败')
      return rename(from, to)
    })
    await expect(app.call('extensions:confirmImport', { token: pending.token, installAiPlugin: true })).rejects.toThrow('虚构 AI 发布失败')
    expect((await details()).manifest?.version).toBe('1.0.0')
    expect(fs.readFileSync(app.file('.jot/app-extensions.json'), 'utf8')).toBe(before)
    const ai = await app.call('extensions:previewAiPlugin', { id: 'work-diary' })
    await expect(app.call('extensions:confirmAiPlugin', { token: ai.token })).rejects.toThrow('虚构 AI 发布失败')
    failure.mockRestore()
    await app.call('extensions:confirmAiPlugin', { token: ai.token })
    expect((await details()).manifest?.version).toBe('1.0.0')
  })

  it('独立启停、资源更新与卸载互不级联；重启及删除索引仍恢复真实安装状态', async () => {
    await install(true)
    app.write('content/工作/草稿.md', '# 用户草稿')
    app.write('templates/自定义.md', '# 用户模板')
    await app.call('extensions:setEnabled', { id: 'work-diary', enabled: true })
    expect((await details()).aiPlugin?.installation).toMatchObject({ enabled: false })
    await app.call('capabilities:setPluginEnabled', { id: 'reports', enabled: true })
    await app.call('extensions:setEnabled', { id: 'work-diary', enabled: false })
    expect((await details()).aiPlugin?.installation).toMatchObject({ enabled: true })
    await app.call('capabilities:patchResources', { owner: 'skill', id: skillId, files: [{ path: 'references/format.md', content: '用户独立更新的 AI 规则' }] })
    const updated = await preview(source('2.0.0').root, 'work-diary')
    await app.call('extensions:confirmImport', { token: updated.token })
    expect(fs.readFileSync(aiFile('skills/summarize/references/format.md'), 'utf8')).toBe('用户独立更新的 AI 规则')
    await app.reopen({ removeIndex: true })
    expect(await details()).toMatchObject({ enabled: false, manifest: { version: '2.0.0' }, aiPlugin: { installation: { kind: 'installed', enabled: true } } })
    await app.call('capabilities:changePlugin', { action: 'remove', id: 'reports' })
    expect((await details()).aiPlugin?.installation.kind).toBe('missing')
    await app.call('extensions:confirmAiPlugin', { token: (await app.call('extensions:previewAiPlugin', { id: 'work-diary' })).token })
    await app.call('extensions:uninstall', { id: 'work-diary', confirmed: true })
    expect(fs.existsSync(aiFile())).toBe(true)
    expect(fs.readFileSync(app.file('content/工作/草稿.md'), 'utf8')).toBe('# 用户草稿')
    expect(fs.readFileSync(app.file('templates/自定义.md'), 'utf8')).toBe('# 用户模板')
  })

  it('切库与重启使后补预览失效，不写入另一库', async () => {
    await install()
    const pending = await app.call('extensions:previewAiPlugin', { id: 'work-diary' })
    await app.call('vault:open', { path: path.join(app.tmp.dir, 'other-vault'), create: true })
    await app.core.jobs.stop()
    await expect(app.call('extensions:confirmAiPlugin', { token: pending.token })).rejects.toThrow('预览已失效')
    expect(fs.readdirSync(app.core.vault.abs('.jot/plugins'))).toEqual([])
    await app.call('vault:open', { path: app.root, create: false })
    await app.core.jobs.stop()
    const next = await app.call('extensions:previewAiPlugin', { id: 'work-diary' })
    await app.reopen()
    await expect(app.call('extensions:confirmAiPlugin', { token: next.token })).rejects.toThrow('预览已失效')
    expect(fs.existsSync(aiFile())).toBe(false)
  })

  it('真实工作日记携带标准工作总结技能；启用后通用助手可加载四类参考', async () => {
    actualCandidate()
    const pending = await app.call('extensions:previewImport', { source: { kind: 'bundled', id: 'work-diary' } })
    expect(pending?.aiPlugin).toMatchObject({ id: 'work-report', issues: [], installation: { kind: 'missing' } })
    expect(pending?.aiPlugin?.files).toEqual(expect.arrayContaining(['plugin.json', 'skills/work-report/SKILL.md', ...['daily', 'weekly', 'monthly', 'okr'].map(kind => 'skills/work-report/references/' + kind + '.md')]))
    await app.call('extensions:confirmImport', { token: pending!.token, installAiPlugin: true })
    await app.call('capabilities:setPluginEnabled', { id: 'work-report', enabled: true })
    usesModel = true
    app.fake.setResponder(agentScript([
      ...['daily', 'weekly', 'monthly', 'okr'].map(kind => () => ({ toolCall: { name: 'use_skill', arguments: { name: 'work-report:work-report', path: 'references/' + kind + '.md' } } })),
      () => '四类工作报告规则已加载。',
    ]))
    const id = app.core.agent.create().conversationId
    const run = app.core.agent.send(id, '读取工作总结的四类参考规则', { agentId: 'default', skillIds: ['work-report:work-report'], strict: false, references: [] })
    await app.core.agent.wait(run.runId)
    const reply = app.core.agent.get(id).messages.at(-1)!
    expect(reply.error).toBeUndefined()
    expect(reply.toolCalls).toHaveLength(4)
    expect(reply.toolCalls?.every(call => call.ok && !!call.output)).toBe(true)
    expect(reply.text).toContain('四类工作报告规则已加载')
    expect(await app.core.vault.listFiles()).toEqual([])
    expect((await details()).enabled).toBe(false)
  })

  it('清单只允许安全相对目录，新增 IPC 严格验证字段', () => {
    const manifest = source().manifest
    expect(appExtensionManifest.safeParse(manifest).success).toBe(true)
    for (const value of ['', '../outside', '/root', 'C:/absolute', 'ai\\report', 'ai/./report', 'ai/../report']) {
      expect(appExtensionManifest.safeParse({ ...manifest, aiPlugin: { path: value } }).success).toBe(false)
    }
    expect(appExtensionManifest.safeParse({ ...manifest, aiPlugin: { path: aiPath, autoEnable: true } }).success).toBe(false)
    const token = 'd77e4681-11eb-4bd8-8d60-5e58618d496e'
    expect(argSchemas['extensions:confirmImport'].safeParse({ token, installAiPlugin: true }).success).toBe(true)
    expect(argSchemas['extensions:confirmImport'].safeParse({ token, installAiPlugin: 'true' }).success).toBe(false)
    expect(argSchemas['extensions:previewAiPlugin'].safeParse({ id: '../outside' }).success).toBe(false)
    expect(argSchemas['extensions:confirmAiPlugin'].safeParse({ token, enabled: true }).success).toBe(false)
    expect(argSchemas['extensions:cancelAiPlugin'].safeParse({ token: 'invalid' }).success).toBe(false)
  })
})


