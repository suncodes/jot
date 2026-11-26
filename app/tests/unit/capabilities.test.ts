import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { inspectSkills } from '../../electron/agent/skills'
import { PackageFiles } from '../../electron/vault/package-files'
import { capabilityCatalog } from '../../electron/agent/catalog'
import { Core } from '../../electron/core'
import { createAssistantConfiguration } from '../../shared/capabilities'
import { createHandlers, type Platform } from '../../electron/ipc/handlers'
import { dispatch } from '../../electron/ipc/register'
import { dependencyProblems, type PreviewAgent, type PreviewSkill } from '../../src/capabilities/model'
import { makeTmpDir } from '../helpers/tmp'
import { deferred } from '../helpers/test-app'

const dirs: ReturnType<typeof makeTmpDir>[] = []
let core: Core | undefined
const temp = () => { const dir = makeTmpDir('capabilities'); dirs.push(dir); return dir.dir }
afterEach(async () => { await core?.dispose(); core = undefined; dirs.splice(0).forEach((dir) => dir.cleanup()) })
const write = (root: string, folder: string, body: string) => {
  const target = path.join(root, folder, 'SKILL.md')
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, body)
}

describe('能力目录只读查看', () => {
  it('缺少独立技能目录时返回空集合，不创建文件', async () => {
    const dir = path.join(temp(), 'missing')
    const result = await inspectSkills(new PackageFiles(() => dir))
    expect(result.issues).toEqual([])
    expect(result.skills).toEqual([])
    expect(fs.existsSync(dir)).toBe(false)
  })
  it('读取本库改动、外部技能和诊断；不改写文件或伪造已知依赖', async () => {
    const dir = temp()
    const original = fs.readFileSync(path.resolve(import.meta.dirname, '../../resources/plugins/work-review/skills/weekly-report/SKILL.md'), 'utf8')
    write(dir, 'weekly-report', original.replace('# 写周报', '# 自定义周报'))
    write(dir, 'custom', '---\nname: custom\ndescription: 自定义用途\nrequired_tools: [search]\n---\n# 阅读回顾\n按原文整理。')
    write(dir, 'broken', '---\nname: [\n---\n正文')
    write(dir, 'empty', '---\ndescription: 只有用途\n---\n')
    write(dir, 'duplicate', '---\nname: custom\ndescription: 重复名\n---\n正文')
    fs.mkdirSync(path.join(dir, 'missing'), { recursive: true })
    const before = fs.readFileSync(path.join(dir, 'weekly-report/SKILL.md'), 'utf8')
    const result = await inspectSkills(new PackageFiles(() => dir))
    expect(result.skills.find((skill) => skill.id === 'weekly-report')).toMatchObject({ title: '自定义周报', requiredTools: ['timeline', 'stats', 'read', 'search'] })
    expect(result.skills.find((skill) => skill.id === 'custom')?.requiredTools).toEqual(['search'])
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.stringContaining('文件头格式错误'), expect.stringContaining('缺少标识、用途或正文'),
      expect.stringContaining('missing/SKILL.md'), expect.stringContaining('目录名须与 SKILL.md 的 name 一致'),
    ]))
    expect(result.skills.map(skill => skill.id)).toEqual(['custom', 'weekly-report'])
    expect(fs.readFileSync(path.join(dir, 'weekly-report/SKILL.md'), 'utf8')).toBe(before)
  })
  it('目录无法作为文件夹读取时返回错误，不能悄悄当成空目录', async () => {
    const file = path.join(temp(), 'not-dir')
    fs.writeFileSync(file, 'x')
    await expect(inspectSkills(new PackageFiles(() => file))).rejects.toThrow()
  })
  it('无模型也可通过 IPC 查看当前工具参数，不新增对话、技能或文档', async () => {
    const dir = temp()
    core = new Core({
      userDataDir: path.join(dir, 'data'),
      secrets: { encrypt: (text) => text, decrypt: (text) => text },
      emit: () => {}, devModel: null,
    })
    await core.init()
    await core.openVault(path.join(dir, 'vault'), true)
    const platform: Platform = { appInfo: () => ({ version: 't', dev: true, platform: 't' }), trashItem: async () => { throw new Error('未配置系统回收站测试') }, pickFiles: async () => null, pickDirectory: async () => null, saveFile: async () => null, hideCapture: () => {}, resizeCapture: () => {}, openExternal: async () => {} }
    const handlers = createHandlers(core, platform)
    const before = await core.vault.listFiles()
    const result = await dispatch(handlers, 'capabilities:catalog', undefined)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.tools.map((tool) => tool.id)).toEqual(['calculator', 'find_files', 'grep_files', 'app_help', 'app_manage', 'list_directory', 'search', 'read', 'timeline', 'stats', 'list_tags', 'write_files', 'edit_file', 'set_properties', 'create_folder', 'move', 'trash', 'use_skill'])
    const search = JSON.parse(result.data.tools.find(t => t.id === 'search')!.parameters)
    expect(search.properties.query.type).toBe('string')
    expect(result.data.prompt).toContain('个人笔记助手')
    expect(await core.vault.listFiles()).toEqual(before)
    expect(core.agent.conversations({}).total).toBe(0)
    expect((await capabilityCatalog(core.vault, core.index)).skills.every((skill) => ['work-review', 'jot-core', 'jot-productivity'].includes(skill.pluginId ?? ''))).toBe(true)
    const file = path.join(core.vault.path, '.jot/assistant.json')
    for (const broken of ['{}', '{invalid']) {
      fs.writeFileSync(file, broken)
      await expect(capabilityCatalog(core.vault, core.index)).rejects.toThrow('智能体配置无法读取')
      expect(fs.readFileSync(file, 'utf8')).toBe(broken)
    }
  })
})

async function openCore(vaultPath: string): Promise<Core> {
  core = new Core({
    userDataDir: path.join(path.dirname(vaultPath), 'data'),
    secrets: { encrypt: text => text, decrypt: text => text },
    emit: () => {}, devModel: null,
  })
  await core.init()
  await core.settings.set({ classify: { enabled: false }, daily: { enabled: false } })
  if (!core.vault.isOpen) await core.openVault(vaultPath, true)
  return core
}
function picker(current: Core, pickDirectory: Platform['pickDirectory']) {
  return createHandlers(current, {
    appInfo: () => ({ version: 'test', dev: true, platform: 'test' }), trashItem: async () => { throw new Error('未配置系统回收站测试') }, pickFiles: async () => null, pickDirectory,
    saveFile: async () => null, hideCapture: () => {}, resizeCapture: () => {}, openExternal: async () => {},
  })
}

describe('技能目录导入和写回', () => {
  const skillText = (id: string) => [
    '---', 'name: ' + id, 'description: 准备模板', 'allowed-tools: Bash Edit',
    'required_tools: [read]', 'metadata: { owner: test }', '---',
    '# 汇总模板', '按 references/format.md 完成。', '',
  ].join('\n')

  it('预览只读，同名可改标识，安装使用预览内容；修改、复制、启停及删除真实文件', async () => {
    const root = temp()
    const vaultPath = path.join(root, 'vault')
    const source = path.join(root, 'source')
    const id = 'weekly-report'
    const original = skillText(id)
    write(root, 'source', original)
    fs.mkdirSync(path.join(source, 'references'), { recursive: true })
    const resource = path.join(source, 'references/format.md')
    fs.writeFileSync(resource, '预览读取的版本')
    fs.mkdirSync(path.join(source, 'assets'), { recursive: true })
    const asset = Buffer.from([0, 255, 48])
    fs.writeFileSync(path.join(source, 'assets/image.bin'), asset)
    fs.mkdirSync(path.join(source, 'assets/empty'))
    fs.mkdirSync(path.join(source, 'agents'))
    const codex = 'policy:\n  allow_implicit_invocation: false\ndependencies:\n  tools:\n    - type: mcp\n      value: reading-service\n'
    fs.writeFileSync(path.join(source, 'agents/openai.yaml'), codex)
    const current = await openCore(vaultPath)
    write(path.join(vaultPath, '.jot/skills'), id, original)
    const handlers = picker(current, async purpose => { expect(purpose).toBe('skill'); return source })
    const preview = await handlers['capabilities:previewSkillImport']()
    expect(preview).toMatchObject({
      name: id, conflict: true, files: ['SKILL.md', 'agents/openai.yaml', 'assets/image.bin', 'references/format.md'], requiredTools: ['read'],
      warnings: expect.arrayContaining([expect.stringContaining('Bash、Edit'), expect.stringContaining('reading-service'), expect.stringContaining('选择此技能')]),
    })
    expect(fs.readdirSync(path.join(vaultPath, '.jot/skills'))).toEqual([id])
    expect(fs.existsSync(path.join(vaultPath, '.jot/assistant.json'))).toBe(false)
    fs.writeFileSync(resource, '预览后改动的版本')
    const token = preview!.token
    const conflict = await dispatch(handlers, 'capabilities:confirmSkillImport', { token, name: id })
    expect(conflict).toMatchObject({ ok: false, error: { code: 'CONFLICT' } })
    const name = 'review-template'
    const result = await handlers['capabilities:confirmSkillImport']({ token, name })
    expect(result.skills.find(skill => skill.id === name)).toMatchObject({ enabled: true, title: '汇总模板', manualOnly: true })
    expect(await current.vault.skillFiles.read(name, 'references/format.md')).toBe('预览读取的版本')
    expect(fs.readFileSync(resource, 'utf8')).toBe('预览后改动的版本')
    expect(fs.readFileSync(path.join(source, 'SKILL.md'), 'utf8')).toBe(original)
    await expect(handlers['capabilities:confirmSkillImport']({ token, name: 'again' })).rejects.toThrow('预览已失效')

    const content = { name, title: '复盘', description: '准备模板', body: '新说明\n\n    保留缩进  ', requiredTools: ['read'] }
    await handlers['capabilities:changeSkill']({ action: 'save', id: name, content, enabled: false })
    expect(await current.vault.skillFiles.read(name)).toContain(content.body)
    expect(await current.vault.skillFiles.read(name)).toContain('metadata: {owner: test}')
    const copy = 'review-copy'
    await handlers['capabilities:changeSkill']({ action: 'save', copyFrom: name, content: { ...content, name: copy }, enabled: true })
    expect(fs.readFileSync(path.join(vaultPath, '.jot/skills', copy, 'assets/image.bin'))).toEqual(asset)
    expect(fs.statSync(path.join(vaultPath, '.jot/skills', copy, 'assets/empty')).isDirectory()).toBe(true)
    expect(await current.vault.skillFiles.read(copy, 'references/format.md')).toBe('预览读取的版本')
    expect(await current.vault.getAssistantConfiguration()).toEqual({ ...createAssistantConfiguration(), disabledSkillIds: [name] })
    await current.dispose()
    const reopened = await openCore(vaultPath)
    const reopenedHandlers = picker(reopened, async () => null)
    const catalog = await reopenedHandlers['capabilities:catalog']()
    expect(catalog.skills.find(skill => skill.id === name)).toMatchObject({ body: content.body + '\n', enabled: false })
    await reopenedHandlers['capabilities:changeSkill']({ action: 'remove', id: name })
    expect(await reopened.vault.getAssistantConfiguration()).toEqual(createAssistantConfiguration())
    expect(fs.existsSync(path.join(vaultPath, '.jot/skills', name))).toBe(false)
    expect(fs.existsSync(path.join(source, 'references/format.md'))).toBe(true)
  })

  it('启停配置或技能文件写入失败后可以用相同标识重试', async () => {
    const current = await openCore(path.join(temp(), 'vault'))
    const handlers = picker(current, async () => null)
    const content = { name: 'retry-reading', title: '阅读', description: '核对参考资料', body: '按原文整理', requiredTools: null }
    const change = { action: 'save', content, enabled: false } as const
    const save = vi.spyOn(current.vault, 'saveAssistantConfiguration')
    const install = vi.spyOn(current.vault.skillFiles, 'install')
    try {
      save.mockRejectedValueOnce(new Error('配置写入失败'))
      await expect(handlers['capabilities:changeSkill'](change)).rejects.toThrow('配置写入失败')
      expect(install).not.toHaveBeenCalled()
      install.mockRejectedValueOnce(new Error('文件写入失败'))
      await expect(handlers['capabilities:changeSkill'](change)).rejects.toThrow('文件写入失败')
      expect((await current.vault.getAssistantConfiguration()).disabledSkillIds).toEqual([])
      const result = await handlers['capabilities:changeSkill'](change)
      expect(result.skills.find(skill => skill.id === content.name)).toMatchObject({ enabled: false })
    } finally {
      save.mockRestore()
      install.mockRestore()
    }
  })

  it('取消、切换库和选择器等待期间切库都会使导入失效', async () => {
    const root = temp()
    const vaultPath = path.join(root, 'vault')
    const source = path.join(root, 'source')
    write(root, 'source', skillText('reading-notes'))
    const current = await openCore(vaultPath)
    const gate = deferred()
    let delay = false
    const handlers = picker(current, async () => {
      if (delay) await gate.promise
      return source
    })
    const preview = (await handlers['capabilities:previewSkillImport']())!
    await handlers['capabilities:cancelSkillImport']({ token: preview.token })
    await expect(handlers['capabilities:confirmSkillImport']({ token: preview.token, name: 'cancelled' })).rejects.toThrow('预览已失效')
    const next = (await handlers['capabilities:previewSkillImport']())!
    await handlers['vault:open']({ path: path.join(root, 'other'), create: true })
    await expect(handlers['capabilities:confirmSkillImport']({ token: next.token, name: 'wrong-vault' })).rejects.toThrow('预览已失效')
    delay = true
    const reading = handlers['capabilities:previewSkillImport']() as Promise<unknown>
    const rejected = expect(reading).rejects.toThrow('库已切换')
    try { await handlers['vault:open']({ path: vaultPath, create: false }) }
    finally { gate.release() }
    await rejected
    expect(fs.readdirSync(path.join(vaultPath, '.jot/skills'))).toEqual([])
    expect(fs.readdirSync(path.join(root, 'other/.jot/skills'))).toEqual([])
  })

  it('目录中的链接被拒绝，旧配置结构不会被覆盖', async () => {
    const root = temp()
    const source = path.join(root, 'source')
    const current = await openCore(path.join(root, 'vault'))
    write(root, 'source', skillText('reading-notes'))
    fs.mkdirSync(path.join(root, 'outside'))
    fs.writeFileSync(path.join(root, 'outside/example.md'), '库外虚构文件')
    fs.symlinkSync(path.join(root, 'outside'), path.join(source, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    const handlers = picker(current, async () => source)
    const linked = await dispatch(handlers, 'capabilities:previewSkillImport', undefined)
    expect(linked).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', message: expect.stringContaining('linked') } })
    const config = path.join(current.vault.path, '.jot/assistant.json')
    const old = JSON.stringify({ agents: [], skills: [{ name: 'old', body: '旧测试数据' }] })
    fs.writeFileSync(config, old)
    await expect(handlers['capabilities:catalog']()).rejects.toThrow('智能体配置无法读取')
    expect(fs.readFileSync(config, 'utf8')).toBe(old)
  })
})

describe('智能体组合依赖', () => {
  const skill = { id: 'weekly', title: '周报', enabled: true, requiredTools: ['timeline', 'stats'] } as PreviewSkill
  const agent = { enabled: true, skillIds: ['weekly'], toolIds: ['timeline', 'stats'] } as PreviewAgent
  it('缺少工具、技能停用和被删除时均可明确诊断', () => {
    expect(dependencyProblems(agent, [skill])).toEqual([])
    expect(dependencyProblems({ ...agent, toolIds: ['timeline'] }, [skill])).toEqual([{ kind: 'tools', skill: '周报', tools: ['stats'] }])
    expect(dependencyProblems(agent, [{ ...skill, enabled: false }])).toEqual([{ kind: 'skill', skill: '周报' }])
    expect(dependencyProblems(agent, [])).toEqual([{ kind: 'skill', skill: 'weekly' }])
    expect(dependencyProblems({ ...agent, enabled: false }, [skill])).toEqual([{ kind: 'agent' }])
  })
  it('显式技能也检查依赖，未声明的不假定安全或补造要求', () => {
    expect(dependencyProblems({ ...agent, skillIds: [], toolIds: ['search'] }, [skill], 'weekly')).toHaveLength(1)
    expect(dependencyProblems({ ...agent, toolIds: [] }, [{ ...skill, requiredTools: null }])).toEqual([])
  })
})
