import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { JotError } from '@shared/result'
import { agentChange, skillChange, pluginChange, skillId, capabilityOwner, resourcePatch, taskBindings } from './capability-schema'
import { operation, approve, noGlobalScope, type OperationContext } from './operation-base'
import type { CapabilityFileInput, CapabilityOwner } from '@shared/capabilities'

const id = z.string().min(1).max(160)
const page = { limit: z.number().int().min(1).max(100).default(20), offset: z.number().int().min(0).default(0) }
const owner = z.enum(['agent', 'skill', 'plugin', 'tool'])
async function removeConfirmation(c: OperationContext, kind: 'agent' | 'skill' | 'plugin', id: string) {
  const impact = await c.app.capabilities.impact(kind, id)
  await approve(c, '删除能力及配套文件，保留引用供后续调整', [{ path: kind + '：' + id, action: 'capability-delete' },
    ...impact.map(path => ({ path, action: 'capability-delete' as const }))])
}
async function resourceConfirmation(c: OperationContext, owner: CapabilityOwner, id: string, files: CapabilityFileInput[]) {
  const existing = await c.app.capabilities.resources(owner, id)
  const targets = files.filter(file => existing.some(entry => entry.path.toLowerCase() === file.path.toLowerCase())).map(file => ({
    path: id + '/' + file.path, action: file.content === null ? 'capability-delete' as const : 'capability-overwrite' as const,
  }))
  if (targets.length) await approve(c, '替换或删除这些能力资源', targets)
}
const brief = async (c: OperationContext) => {
  const catalog = await c.app.capabilities.catalog()
  return { issues: catalog.issues, taskBindings: catalog.taskBindings, note: '已保存，从下一轮运行生效；本轮可用技能和工具保持启动时配置。' }
}

export const capabilityActions = [
  operation('capabilities.list', '分页查询智能体、技能、工具或插件，不预加载正文；name/id详情用get。', z.object({ kind: owner, ...page }).strict(), { kind: 'skill' }, false,
    async (a, c) => {
      const catalog = await c.app.capabilities.catalog()
      const items = a.kind === 'agent' ? catalog.agents.map(({ instructions: _instructions, ...agent }) => agent)
        : a.kind === 'skill' ? catalog.skills.map(({ body: _body, ...skill }) => skill)
          : a.kind === 'plugin' ? catalog.plugins : catalog.tools.map(({ parameters: _parameters, ...tool }) => tool)
      return { total: items.length, items: items.slice(a.offset, a.offset + a.limit) }
    }),
  operation('capabilities.get', '查看能力当前说明、依赖和真实状态；工具实现由应用提供，不能仅写清单新增代码。', z.object({ kind: owner, id }).strict(), { kind: 'agent', id: 'default' }, false,
    async (a, c) => {
      const catalog = await c.app.capabilities.catalog()
      const entries = a.kind === 'agent' ? catalog.agents : a.kind === 'skill' ? catalog.skills : a.kind === 'plugin' ? catalog.plugins : catalog.tools
      const item = entries.find(item => item.id === a.id)
      if (!item) throw new JotError('NOT_FOUND', '能力不存在')
      return item
    }),
  operation('capabilities.agent', '创建／编辑／删除智能体；default用configure-default仅改说明，插件智能体编辑限库内包。', agentChange, { action: 'configure-default', instructions: '先核对资料再回答。' }, true,
    async (a, c) => { if (a.action === 'remove') await removeConfirmation(c, 'agent', a.id); await c.app.capabilities.agent(a); return brief(c) }),
  operation('capabilities.agent-copy', '复制智能体为自建配置，保留技能／工具绑定；下一轮可选择。', z.object({ id, name: z.string().trim().min(1).max(60) }).strict(), { id: 'default', name: '资料助手' }, true,
    async (a, c) => {
      const original = (await c.app.capabilities.catalog()).agents.find(agent => agent.id === a.id)
      if (!original) throw new JotError('NOT_FOUND', '智能体不存在')
      const { pluginId: _pluginId, ...agent } = original
      const target = 'custom-' + randomUUID()
      await c.app.capabilities.agent({ action: 'save', agent: { ...agent, id: target, name: a.name } })
      return { id: target, ...await brief(c) }
    }),
  operation('capabilities.agent-enable', '单独启停智能体；通用助手不能停用，包自身状态仍决定可用性。', z.object({ id, enabled: z.boolean() }).strict(), { id: 'custom-reader', enabled: false }, true,
    async (a, c) => { await c.app.capabilities.enableAgent(a.id, a.enabled); return brief(c) }),
  operation('capabilities.skill', '创建／编辑／复制／启停／删除技能，配套资源保留。copyFrom+replaceReferences可替换引用并停用原技能；预装不能直接修改。', skillChange,
    { action: 'save', content: { name: 'reading-notes', title: '阅读记录', description: '整理阅读事实', body: '先读取原文，区分事实和建议。', requiredTools: ['read'] }, enabled: true }, true,
    async (a, c) => { if (a.action === 'remove') await removeConfirmation(c, 'skill', a.id); await c.app.capabilities.skill(a); return brief(c) }),
  operation('capabilities.plugin', '创建／编辑库内插件、复制预装或卸载。save的files是文件补丁，null删资源；清单及声明资源必须有效。copy可替换引用并停用原包。', pluginChange,
    { action: 'copy', id: 'work-review', targetId: 'my-work-review', name: '我的工作回顾', replaceReferences: true }, true,
    async (a, c) => {
      if (a.action === 'remove') await removeConfirmation(c, 'plugin', a.id)
      else if (a.action === 'save' && a.id && a.files.length) await resourceConfirmation(c, 'plugin', a.id, a.files)
      await c.app.capabilities.plugin(a); return brief(c)
    }),
  operation('capabilities.plugin-enable', '启停插件及其能力；依赖诊断可查询，改动下次运行生效。', z.object({ id, enabled: z.boolean() }).strict(), { id: 'work-review', enabled: false }, true,
    async (a, c) => { await c.app.capabilities.togglePlugin(a.id, a.enabled); return brief(c) }),
  operation('capabilities.resources', '列出技能或插件真实配套文件，标注大小及是否可编辑文本。', z.object({ owner: capabilityOwner, id: skillId, ...page }).strict(), { owner: 'skill', id: 'work-review:weekly-report' }, false,
    async (a, c) => {
      const files = await c.app.capabilities.resources(a.owner, a.id)
      return { total: files.length, items: files.slice(a.offset, a.offset + a.limit) }
    }),
  operation('capabilities.read-resource', '读取能力包内UTF-8文本，含SKILL.md、PROMPT.md和模板；不执行脚本。', z.object({ owner: capabilityOwner, id: skillId, path: z.string().min(1).max(1000) }).strict(),
    { owner: 'skill', id: 'work-review:weekly-report', path: 'references/outline.md' }, false,
    (a, c) => c.app.capabilities.readResource(a.owner, a.id, a.path)),
  operation('capabilities.edit-resources', '修改库内技能／插件资源并校验完整包；整篇替换或删除已有资源集中确认。预装先复制。', z.object({ owner: capabilityOwner, id: skillId, files: z.array(resourcePatch).min(1).max(1000) }).strict(),
    { owner: 'skill', id: 'reading-notes', files: [{ path: 'references/format.md', content: '事实、出处、后续行动。' }] }, true,
    async (a, c) => {
      await resourceConfirmation(c, a.owner, a.id, a.files)
      await c.app.capabilities.patchResources(a.owner, a.id, a.files)
      return brief(c)
    }),
  operation('capabilities.tool-enable', '配置应用工具启停；自建智能体绑定通过agent操作修改，不新增可执行实现。', z.object({ id, enabled: z.boolean() }).strict(), { id: 'grep_files', enabled: false }, true,
    async (a, c) => { await c.app.capabilities.tool(a.id, a.enabled); return brief(c) }),
  operation('capabilities.tasks', '查看四类后台任务实际技能绑定及诊断；任务继承全局模型与推理强度。', z.object({}).strict(), {}, false,
    async (_a, c) => (await c.app.capabilities.catalog()).taskBindings),
  operation('capabilities.bind-tasks', '为指定后台任务绑定处理程序材料的技能，其他任务保留；绑定从下次运行生效。', taskBindings.partial().refine(patch => Object.keys(patch).length > 0, '至少指定一个任务'),
    { daily: 'jot-core:daily-review' }, true,
    async (a, c) => { await c.app.capabilities.tasks(a); return brief(c) }),
  operation('capabilities.import-preview', '预览用户明确提供的本地来源目录（source）；未提供时打开系统选择。Codex／Claude技能或插件，updating指定同标识库内更新，列出被替换／移除资源。', z.object({ owner: capabilityOwner, updating: id.optional(), source: z.string().min(1).max(1000).optional() }).strict(),
    { owner: 'skill' }, false, async (a, c) => await c.app.capabilities.importPreview(a.owner, a.updating, c.signal, a.source) ?? { cancelled: true }),
  operation('capabilities.import-confirm', '确认刚才预览安装／更新，可按明确意图同时启用。内容使用已预览文件，不重新读取外部目录。', z.object({ owner: capabilityOwner, token: z.uuid(), name: skillId.optional(), enabled: z.boolean().optional() }).strict(),
    { owner: 'plugin', token: '2b65a76e-e846-48ee-a4cc-40dc2bf706f5', enabled: true }, true,
    async (a, c) => { await c.app.capabilities.importConfirm(a.owner, a.token, a.name, a.enabled); return brief(c) }),
  operation('capabilities.import-cancel', '取消未安装的导入／更新预览。', z.object({ owner: capabilityOwner, token: z.uuid() }).strict(),
    { owner: 'skill', token: '2b65a76e-e846-48ee-a4cc-40dc2bf706f5' }, false, (a, c) => { c.app.capabilities.importCancel(a.owner, a.token); return { cancelled: true } }),
  operation('capabilities.impact', '查看能力被哪些智能体／任务引用；删除后引用保留并明确诊断，支持修复。', z.object({ owner, id }).strict(), { owner: 'plugin', id: 'work-review' }, false,
    (a, c) => c.app.capabilities.impact(a.owner, a.id)),
].map(action => ({ ...action, run: (input: never, context: OperationContext) => { noGlobalScope(context); return action.run(input, context) } }))
