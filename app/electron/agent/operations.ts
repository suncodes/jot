import { workReportActions } from './work-report-actions'
import { z } from 'zod'
import { capabilityActions } from './capability-actions'
import { JotError } from '@shared/result'
import { isCalendarDay } from '../util/time'
import { ToolInputError } from './tool-errors'

const page = { limit: z.number().int().min(1).max(100).default(20), offset: z.number().int().min(0).default(0) }
const path = z.string().min(1).max(1000)
const kind = z.enum(['tag', 'person', 'place'])
const suggestion = z.enum(['directory', 'properties'])
const id = z.string().min(1).max(160)
export type { OperationContext } from './operation-base'
import { operation, noGlobalScope, approve, type OperationContext, type Operation } from './operation-base'
const check = (context: OperationContext) => { if (context.signal?.aborted) throw new JotError('CANCELLED', '操作已停止') }
async function readable(context: OperationContext, raw: string) { return context.files.metadata(raw, context.scope) }
const paged = <T>(items: T[], input: { limit: number; offset: number }) => ({ total: items.length,
  items: items.slice(input.offset, input.offset + input.limit),
  nextOffset: input.offset + input.limit < items.length ? input.offset + input.limit : null })
const batch = z.array(id).min(1).max(50).refine(values => new Set(values).size === values.length, '目标不能重复')
const queued = (context: OperationContext, result: { jobId: string }) => ({ ...context.app.job(result.jobId), status: 'scheduled', note: '已安排；请用 jobs.get 查询真实状态。' })

export const APP_ACTIONS: Operation[] = [
  ...capabilityActions,
  ...workReportActions,
  operation('records.idea', '保存一条灵感；正文 #标签确认入词表，沿用自动分析开关，默认 ideas/年/月。', z.object({ text: z.string().trim().min(1).max(20000) }).strict(), { text: '想到一个改进 #想法' }, true,
    (a, c) => c.app.execute('capture:save', { text: a.text, source: 'main-window' })),
  operation('records.log', '保存有发生时间区间的补记，默认 ideas/年/月。', z.object({ text: z.string().trim().min(1).max(20000), start: path, end: path }).strict(), { text: '参加例会', start: '2026-11-22', end: '2026-11-22' }, true,
    (a, c) => c.app.execute('capture:saveLog', a)),
  operation('records.note', '创建笔记，无目录默认 inbox/年/月；已有目录按明确目标保存。', z.object({ title: z.string().trim().min(1).max(120), body: z.string().optional(), dir: path.optional() }).strict(), { title: '业务规则', body: '规则正文', dir: 'content/工作' }, true,
    (a, c) => { if (a.dir) a.dir = c.files.path(a.dir); return c.app.execute('doc:create', a) }),
  operation('records.time', '设置发生日期（occurredAt=null清除）或补记区间；按类型二选一。', z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('date'), path, occurredAt: z.string().nullable() }).strict(),
    z.object({ mode: z.literal('range'), path, start: path, end: path }).strict(),
  ]), { mode: 'date', path: 'ideas/2026/11/想法.md', occurredAt: '2026-11-22' }, true,
  async (a, c) => { a.path = c.files.path(a.path); await readable(c, a.path); return a.mode === 'date'
    ? c.app.execute('doc:setOccurredAt', { ref: { path: a.path }, occurredAt: a.occurredAt })
    : c.app.execute('doc:setLogTime', { ref: { path: a.path }, start: a.start, end: a.end }) }),
  operation('terms.list', '全局词条含预置零次数项；限定材料时只返回所选材料词条。', z.object({ kind, ...page }).strict(), { kind: 'tag', limit: 20 }, false,
    async (a, c) => {
      const rows = c.scope.materials || c.scope.scope ? c.app.scopedTerms(a.kind, c.scope) : await c.app.execute('taxonomy:terms', { kind: a.kind })
      return paged(rows, a)
    }),
  operation('terms.create', '预置标签、人物或地点词条，不修改文件。', z.object({ kind, name: z.string().trim().min(1).max(40).regex(/^[^\r\n]+$/) }).strict(), { kind: 'tag', name: '产品' }, true,
    (a, c) => c.app.execute('taxonomy:create', a)),
  operation('terms.rename', '全局改名，更新当前实际属性；不移动目录或正文引用。', z.object({ kind, from: path, to: path }).strict(), { kind: 'tag', from: '旧名', to: '新名' }, true,
    (a, c) => { noGlobalScope(c); return c.app.execute('taxonomy:rename', a) }),
  operation('terms.merge', '全局合并词条并去重属性，保留正文和文件。', z.object({ kind, from: z.array(path).min(1).max(30), into: path }).strict(), { kind: 'tag', from: ['产品设计', '设计'], into: '设计' }, true,
    (a, c) => { noGlobalScope(c); return c.app.execute('taxonomy:merge', a) }),
  operation('terms.remove', '删除词条并从文件全局解除；into 可迁移到另一词条。全局解除需集中确认。', z.object({ kind, name: path, into: path.optional() }).strict(), { kind: 'tag', name: '过时' }, true,
    async (a, c) => {
      noGlobalScope(c)
      if (!a.into) {
        const paths = await c.app.termTargets(a.kind, [a.name])
        await approve(c, '删除词条并全局解除属性', [...paths.map(path => ({ path, action: 'unlink' as const })), { path: a.kind + '：' + a.name, action: 'unlink' }])
        if ((await c.app.termTargets(a.kind, [a.name])).some(path => !paths.includes(path))) throw new JotError('CONFLICT', '词条影响范围新增了文件，请重新确认')
      }
      return c.app.execute('taxonomy:remove', a)
    }),
  operation('terms.analyze', '安排同义词分析，返回真实任务编号；不自动合并。', z.object({ kind }).strict(), { kind: 'tag' }, true,
    async (a, c) => { noGlobalScope(c); return queued(c, await c.app.execute('taxonomy:findSynonyms', a)) }),
  operation('terms.suggestions', '读取同义合并建议。', z.object(page).strict(), {}, false,
    async (a, c) => { noGlobalScope(c); return paged(await c.app.execute('taxonomy:synonyms', undefined), a) }),
  operation('terms.dismiss', '忽略指定同义建议，不修改文件。', z.object({ id }).strict(), { id: '建议编号' }, true,
    (a, c) => { noGlobalScope(c); return c.app.execute('taxonomy:dismissSynonym', a) }),
  operation('pending.list', '查看待归档和已发起的属性事项，包含建议、真实任务状态。', z.object(page).strict(), {}, false,
    async (a, c) => {
      if (!c.scope.materials && !c.scope.scope) return c.app.execute('classify:inbox', a)
      const result = await c.app.execute('classify:inbox', { limit: 200, offset: 0 })
      // 限定模式不返回范围外的正文；逐页筛选后再分页。
      const items = [...result.items]
      for (let offset = 200; offset < result.total; offset += 200) items.push(...(await c.app.execute('classify:inbox', { limit: 200, offset })).items)
      return paged(items.filter(item => c.files.allowed(item.doc.path, c.scope)), a)
    }),
  operation('pending.analyze', '安排当前文件目录／属性分析，结果等待用户确认，不直接改文件。', z.object({ path }).strict(), { path: 'inbox/2026/11/资料.md' }, true,
    async (a, c) => { a.path = c.files.path(a.path); await readable(c, a.path); return queued(c, await c.app.execute('classify:rerun', { ref: { path: a.path } })) }),
  operation('pending.accept', '按用户明确要求确认目录或属性建议；目录可手选 content 下已有目录。', z.object({ path, kind: suggestion, toDir: path.optional() }).strict(), { path: 'inbox/2026/11/资料.md', kind: 'directory', toDir: 'content/工作' }, true,
    async (a, c) => { a.path = c.files.path(a.path); await readable(c, a.path); if (a.toDir) a.toDir = c.files.path(a.toDir); return c.app.execute('classify:accept', { ref: { path: a.path }, kind: a.kind, toDir: a.toDir }) }),
  operation('pending.skip', '忽略属性建议或暂缓目录建议；inbox 文件仍待归档。', z.object({ path, kind: suggestion }).strict(), { path: 'inbox/2026/11/资料.md', kind: 'properties' }, true,
    async (a, c) => { a.path = c.files.path(a.path); await readable(c, a.path); return c.app.execute('classify:skip', { ref: { path: a.path }, kind: a.kind }) }),
  operation('trash.list', '分页查看回收项编号及实际路径。', z.object(page).strict(), {}, false,
    (a, c) => { noGlobalScope(c); return c.app.execute('trash:list', a) }),
  operation('trash.restore', '按编号恢复文件或目录，同名自动另存；返回每项实际结果。', z.object({ ids: batch }).strict(), { ids: ['回收编号'] }, true,
    async (a, c) => {
      noGlobalScope(c)
      const items = await c.app.trashItems(a.ids), results = []
      for (const item of items) {
        check(c)
        try {
          const result = item.kind === 'directory' ? await c.app.execute('folder:restore', { trashId: item.trashId }) : await c.app.execute('doc:restore', { trashId: item.trashId })
          results.push({ trashId: item.trashId, ok: true, result })
        } catch (error) { results.push({ trashId: item.trashId, ok: false, error: (error as Error).message }) }
      }
      return { results, failed: results.filter(item => !item.ok) }
    }),
  operation('trash.purge', '永久删除明确编号的回收项；确认列出全部实际路径，不清空后来新增的回收项。', z.object({ ids: batch }).strict(), { ids: ['回收编号'] }, true,
    async (a, c) => {
      noGlobalScope(c)
      const items = await c.app.trashItems(a.ids)
      await approve(c, '永久删除这些回收内容，无法恢复', items.flatMap(item => [...new Set([item.originalPath, ...item.paths])].map(path => ({ path: item.trashId + ' · ' + path, action: 'purge' as const }))))
      const purged: string[] = [], failed: { id: string; message: string }[] = []
      for (const id of a.ids) {
        check(c)
        try { await c.app.execute('trash:purge', { trashIds: [id] }); purged.push(id) }
        catch (error) { failed.push({ id, message: (error as Error).message }) }
      }
      return { purged, failed }
    }),
  operation('files.list', '分页查看附件原件信息、处理状态与摘要路径。', z.object(page).strict(), {}, false,
    async (a, c) => {
      noGlobalScope(c)
      return c.app.execute('files:list', a)
    }),
  operation('files.import', '弹系统窗口选择导入文件，可指定已有目录；取消不写入，不遍历库外文件。', z.object({ toDir: path.optional() }).strict(), { toDir: 'content/工作' }, true,
    (a, c) => { if (a.toDir) a.toDir = c.files.path(a.toDir); return c.app.importSelected(a.toDir, c.signal) }),
  operation('files.summarize', '为已支持附件安排摘要；重生成已有摘要需确认，返回 jobId。', z.object({ path, summaryPath: path.optional() }).strict(), { path: 'content/工作/资料.txt' }, true,
    async (a, c) => {
      a.path = c.files.path(a.path)
      await readable(c, a.path)
      const summaries = c.app.summaries(a.path)
      const target = a.summaryPath ?? (summaries.length === 1 ? summaries[0] : undefined)
      if (summaries.length > 1 && !a.summaryPath) throw new JotError('INVALID_INPUT', '存在多份摘要，请指定 summaryPath')
      if (target) {
        if (!summaries.includes(target)) throw new JotError('INVALID_INPUT', '所选摘要不属于当前原件')
        await approve(c, '重新生成并替换此摘要', [{ path: target, action: 'overwrite' }])
      }
      return queued(c, await c.app.execute('files:reprocess', { path: a.path, force: !!target, summaryPath: target }))
    }),
  operation('daily.view', '按日期查看时间线、统计、日总结路径和生成状态；正文另用read，事件不推断具体修改。', z.object({ date: z.string().refine(isCalendarDay, '日期需为有效的YYYY-MM-DD'), ...page }).strict(), { date: '2026-11-22' }, false,
    async (a, c) => {
      noGlobalScope(c)
      const view = await c.app.execute('timeline:day', { date: a.date })
      return { date: view.date, stats: view.stats, entries: paged(view.entries, a),
        daily: view.daily ? { path: view.daily.path, generatedAt: view.daily.generatedAt } : null, dailyJob: view.dailyJob }
    }),
  operation('daily.generate', '按日期安排日总结；已有成果重生成需确认，返回 jobId。', z.object({ date: z.string().refine(isCalendarDay, '日期需为有效的YYYY-MM-DD') }).strict(), { date: '2026-11-22' }, true,
    async (a, c) => {
      noGlobalScope(c)
      const view = await c.app.execute('timeline:day', { date: a.date })
      if (view.daily) await approve(c, '重新生成并替换日总结', [{ path: view.daily.path, action: 'overwrite' }])
      return queued(c, await c.app.execute('timeline:generateDaily', { date: a.date, force: !!view.daily }))
    }),
  operation('jobs.list', '查看真实任务状态；默认未完成，states 可含 done／cancelled。', z.object({ ...page, states: z.array(z.enum(['queued', 'running', 'waiting-model', 'failed', 'done', 'cancelled'])).min(1).max(6).optional() }).strict(), {}, false,
    (a, c) => { noGlobalScope(c); return c.app.execute('jobs:list', a) }),
  operation('jobs.get', '查看指定任务状态、目标、重试次数、结果说明或失败原因。', z.object({ jobId: id }).strict(), { jobId: '任务编号' }, false,
    (a, c) => { noGlobalScope(c); return c.app.job(a.jobId) }),
  operation('jobs.retry', '重试指定任务，已运行或成功的任务不重复运行。', z.object({ jobId: id }).strict(), { jobId: '任务编号' }, true,
    async (a, c) => { noGlobalScope(c); await c.app.execute('jobs:retry', a); return c.app.job(a.jobId) }),
  operation('jobs.cancel', '取消指定后台任务，保留已生成文件。', z.object({ jobId: id }).strict(), { jobId: '任务编号' }, true,
    async (a, c) => { noGlobalScope(c); await c.app.execute('jobs:cancel', a); return c.app.job(a.jobId) }),
  operation('conversations.list', '按标题或消息查询历史对话，不读取文件正文。', z.object({ ...page, text: z.string().max(200).optional() }).strict(), {}, false,
    (a, c) => { noGlobalScope(c); return c.app.execute('agent:conversations', a) }),
  operation('conversations.get', '分页读取完整历史问答和工具记录；运行中的对话只返回已落盘消息与状态。', z.object({ conversationId: id, ...page }).strict(), { conversationId: '会话编号' }, false,
    async (a, c) => { noGlobalScope(c); const data = await c.app.execute('agent:get', { conversationId: a.conversationId }); return { info: data.info, running: data.running, messages: paged(data.messages, a) } }),
  operation('conversations.rename', '按明确标题改名，不修改消息正文。', z.object({ conversationId: id, title: z.string().trim().min(1).max(80) }).strict(), { conversationId: '会话编号', title: '规则讨论' }, true,
    (a, c) => c.app.execute('agent:rename', a)),
  operation('conversations.export', '弹系统保存窗口导出 Markdown／JSONL；正在回答的会话需先结束，取消不写。', z.object({ conversationId: id, format: z.enum(['markdown', 'jsonl']) }).strict(), { conversationId: '历史会话编号', format: 'markdown' }, true,
    async (a, c) => { noGlobalScope(c); return await c.app.exportConversation(a.conversationId, a.format, c.signal) ?? { cancelled: true } }),
  operation('conversations.delete', '集中确认后删除历史会话；当前对话或仍在运行的对话不允许在工具中删除。', z.object({ ids: batch }).strict(), { ids: ['历史会话编号'] }, true,
    async (a, c) => {
      noGlobalScope(c)
      if (a.ids.includes(c.conversationId)) throw new JotError('CONFLICT', '当前会话请在回答结束后从历史菜单删除')
      const rows = await Promise.all(a.ids.map(conversationId => c.app.execute('agent:get', { conversationId })))
      if (rows.some(row => row.running)) throw new JotError('CONFLICT', '请先停止目标会话的回答')
      await approve(c, '删除这些历史对话及消息', rows.map(row => ({ path: row.info.title + ' · ' + row.info.conversationId, action: 'delete-conversation' })))
      const deleted: string[] = [], failed: { id: string; message: string }[] = []
      for (const conversationId of a.ids) {
        check(c)
        try {
          if ((await c.app.execute('agent:get', { conversationId })).running) throw new JotError('CONFLICT', '会话正在回答，请先停止')
          await c.app.execute('agent:delete', { conversationId })
          deleted.push(conversationId)
        } catch (error) { failed.push({ id: conversationId, message: (error as Error).message }) }
      }
      return { deleted, failed }
    }),
  operation('settings.get', '查看公开设置，不含密钥原文。', z.object({}).strict(), {}, false,
    (_a, c) => c.app.execute('settings:get', undefined)),
  operation('settings.set', '修改主题、日总结、分析或既有回收保留策略；模型密钥及连接配置到设置界面处理。', z.object({
    appearance: z.object({ theme: z.enum(['system', 'dark', 'light']) }).strict().optional(),
    classify: z.object({ enabled: z.boolean() }).strict().optional(),
    daily: z.object({ enabled: z.boolean().optional(), time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional() }).strict().optional(),
    maintenance: z.object({ trashRetentionDays: z.union([z.literal(0), z.literal(30)]) }).strict().optional(),
  }).strict().refine(a => Object.keys(a).length > 0, '至少选择一项设置'), { appearance: { theme: 'dark' } }, true,
  async (a, c) => {
    if (a.maintenance?.trashRetentionDays === 30) await approve(c, '开启回收站30天后自动永久清理', [{ path: '回收站：已超过30天及后续到期的回收内容', action: 'maintenance' }])
    return c.app.execute('settings:set', a)
  }),
  operation('maintenance.usage', '查看内容、会话、配置、回收和临时文件的实际占用。', z.object({}).strict(), {}, false,
    (_a, c) => c.app.execute('maintenance:usage', undefined)),
  operation('maintenance.refresh', '刷新索引，可指定内容路径；无 paths 同步整个库，不发起AI分析。', z.object({ paths: z.array(path).min(1).max(1000).optional() }).strict(), {}, true,
    (a, c) => { noGlobalScope(c); if (a.paths) a.paths = a.paths.map(path => c.files.path(path)); return c.app.execute('vault:refreshIndex', a) }),
  operation('maintenance.rebuild', '重建可重建查询索引，内容和会话保留。', z.object({}).strict(), {}, true,
    (_a, c) => { noGlobalScope(c); return c.app.execute('vault:rebuildIndex', undefined) }),
  operation('maintenance.optimize', '回收数据库空闲页，保留内容和会话；其他任务／助手在运行时推迟。', z.object({}).strict(), {}, true,
    (_a, c) => { noGlobalScope(c); return c.app.optimizeForAssistant(c.conversationId) }),
  operation('maintenance.temporary', '清理服务识别的过期临时残留，不清理笔记或普通附件。', z.object({}).strict(), {}, true,
    async (_a, c) => {
      const usage = await c.app.execute('maintenance:usage', undefined)
      await approve(c, '清理已识别的临时残留', [{ path: '可清理临时文件：' + usage.temporary.files + ' 个，' + usage.temporary.bytes + ' 字节', action: 'maintenance' }])
      return c.app.execute('maintenance:clearTemporary', { vaultPath: usage.vaultPath, confirmed: true })
    }),
]

export function operationHelp(group?: string, name?: string) {
  const actions = APP_ACTIONS.filter(action => (!group || action.name.startsWith(group + '.')) && (!name || action.name === name))
  if ((group || name) && !actions.length) throw new JotError('INVALID_INPUT', '没有这个操作分组或名称')
  if (!group && !name) return [...new Set(APP_ACTIONS.map(action => action.name.split('.')[0]))].map(group => ({
    group, actions: APP_ACTIONS.filter(action => action.name.startsWith(group + '.')).map(action => ({ name: action.name, description: action.description, write: action.write })),
  }))
  return actions.map(action => ({ name: action.name, description: action.description, write: action.write,
    parameters: z.toJSONSchema(action.schema, { io: 'input' }), example: { operation: action.name, args: action.example } }))
}

export async function runOperation(name: string, input: unknown, context: OperationContext) {
  const action = APP_ACTIONS.find(action => action.name === name)
  if (!action) throw new ToolInputError('未知操作，请先用 app_help 查询，operation 必须使用返回的 name')
  const parsed = action.schema.safeParse(input)
  if (!parsed.success) throw new ToolInputError(parsed.error.issues.map(issue => issue.path.join('.') + ': ' + issue.message).join('; ')
    + '\n请用 app_help 查询 name=' + action.name + '，parameters 是 args 的结构。'
    + '\napp_manage 完整调用示例：' + JSON.stringify({ operation: action.name, args: action.example }))
  check(context)
  return await action.run(parsed.data as never, context)
}
