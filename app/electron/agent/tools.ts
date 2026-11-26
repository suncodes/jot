import type { ReadRange } from './read-page'
import type { ToolCall } from '@shared/assistant'
import type { AppOperations } from '../operations/service'
import { APP_ACTIONS, operationHelp, runOperation } from './operations'
import { ToolInputError, toolFailure } from './tool-errors'
import type { CapabilitySkill, CapabilityTool } from '@shared/capabilities'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import { Type, type TSchema } from 'typebox'
import type { Chunk, DocMeta, DocType, SearchFilter } from '@shared/types'
import type { IndexService } from '../index/index'
import type { AgentFiles, ConfirmFiles } from './files'
import { dateCandidates, overlaps } from '../content/time'
import { isCalendarDay } from '../util/time'
import { calculate } from './calculator'

interface ToolFactory { defineTool<P extends TSchema>(definition: ToolDefinition<P>): ToolDefinition<P> }
const LABEL: Record<DocType, string> = { idea: '随手记', log: '补记', note: '笔记', file: '文件', 'source-summary': '摘要', daily: '日总结' }
export interface ToolHooks {
  scope: () => SearchFilter
  cite: (chunk: Chunk) => void
  confirm: (call: ToolCall, title: string, targets: Parameters<ConfirmFiles>[1]) => Promise<boolean>
  onStart: (name: string, summary: string, call: ToolCall) => void
  onEnd: (name: string, summary: string, ok: boolean, call: ToolCall) => void
}
const cleanEnum = (v: string) => v.trim().replace(/^["'“”’\s]+|["'“”’\s]+$/g, '')
/** 只清理枚举；正文、原文匹配和属性值必须逐字保留。 */
function clean(args: unknown): unknown {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return args
  return Object.fromEntries(Object.entries(args).map(([key, value]) => [key,
    ['groupBy', 'kind'].includes(key) && typeof value === 'string' ? cleanEnum(value)
      : key === 'types' && Array.isArray(value) ? value.map(v => typeof v === 'string' ? cleanEnum(v) : v) : value]))
}
const filters = {
  types: Type.Optional(Type.Array(Type.String({ description: 'idea、log、note、file、source-summary、daily' }))),
  tags: Type.Optional(Type.Array(Type.String())),
  directory: Type.Optional(Type.String({ description: '只查询这个库内目录及其子目录（可传绝对路径）；库外使用 find_files／grep_files' })),
  from: Type.Optional(Type.String({ description: '当前可用日期候选的起日 YYYY-MM-DD' })),
  to: Type.Optional(Type.String({ description: '当前可用日期候选的止日 YYYY-MM-DD' })),
}
interface FilterArgs { types?: string[]; tags?: string[]; directory?: string; from?: string; to?: string }
const header = (doc: DocMeta, chunk: Chunk) => '[' + chunk.chunkId + '] ' + chunk.path + ':' + chunk.lineStart + ' · ' + LABEL[doc.type] + ' · ' + doc.created.slice(0, 10) + (doc.generatedByAi ? ' · AI 生成' : '')
interface Output { output: string; summary: string; ok?: boolean }

type ToolSkill = Pick<CapabilitySkill, 'id' | 'name' | 'body'>
interface SkillAccess { skills: ToolSkill[]; read: (skill: ToolSkill, relative: string) => Promise<string> }

export function createTools(pi: ToolFactory, index: IndexService, hooks: ToolHooks, files?: AgentFiles, skillAccess?: SkillAccess, operations?: { app: AppOperations; conversationId: string }): ToolDefinition[] {
  const disk = () => { if (!files) throw new Error('文件服务未连接'); return files }
  const merge = (args: FilterArgs): SearchFilter => {
    if (args.from && !isCalendarDay(args.from) || args.to && !isCalendarDay(args.to) || args.from && args.to && args.from > args.to) throw new Error('日期需为有效的 YYYY-MM-DD，止日不能早于起日')
    const scope = hooks.scope()
    const types = args.types?.filter((type): type is DocType => Object.hasOwn(LABEL, type))
    const result: SearchFilter = { ...scope, ...(types?.length ? { types } : {}), ...(args.tags?.length ? { tags: [...new Set([...(scope.tags ?? []), ...args.tags])] } : {}) }
    if (args.directory) {
      const directory = disk().path(args.directory)
      const prefix = directory.toLocaleLowerCase()
      result.objectPaths = index.allPaths().filter(rel => (!scope.objectPaths || scope.objectPaths.includes(rel)) && (rel.toLocaleLowerCase() === prefix || rel.toLocaleLowerCase().startsWith(prefix + '/')))
    }
    if (args.from) result.from = args.from
    if (args.to) result.to = args.to
    return result
  }
  const tool = <P extends TSchema>(def: {
    name: string; label: string; description: string; parameters: P
    title: (args: never) => string
    run: (args: never, confirm: ConfirmFiles, signal?: AbortSignal) => Output | Promise<Output>
  }): ToolDefinition => pi.defineTool({
    name: def.name, label: def.label, description: def.description, parameters: def.parameters,
    prepareArguments: args => clean(args) as never,
    async execute(id, params, signal) {
      const title = def.title(params as never), started = Date.now()
      const call: ToolCall = { id, name: def.name, summary: title, input: params }
      hooks.onStart(def.name, title, call)
      try {
        if (signal?.aborted) throw new Error('操作已停止')
        const result = await def.run(params as never, (title, targets) => hooks.confirm(call, title, targets), signal)
        const ok = result.ok !== false
        call.summary = title + ' · ' + result.summary
        call.ok = ok; if (!ok) call.errorKind = 'execution'; call.output = result.output; call.durationMs = Date.now() - started
        hooks.onEnd(def.name, call.summary, ok, call)
        return { content: [{ type: 'text' as const, text: result.output }], details: undefined }
      } catch (error) {
        const message = (error as Error).message
        Object.assign(call, toolFailure(title, error instanceof ToolInputError ? 'validation' : 'execution', message))
        call.durationMs = Date.now() - started
        hooks.onEnd(def.name, call.summary, false, call)
        return { content: [{ type: 'text' as const, text: '工具未完成：' + call.output }], details: undefined }
      }
    },
  }) as unknown as ToolDefinition
  const tools = [
    tool({
      name: 'calculator', label: '计算器',
      description: '十进制计算，返回expression、字符串result和40位有效数字精度。支持+ - * / ^、括号、科学计数、后缀%（除以100，不是取模）、abs/sqrt/round/sum/mean/min/max。例如(125-100)/100*100、sum(0.1,0.2)、round(10/3,2)。^仅整数指数；无变量、单位换算、数组或脚本。除法／开方可能舍入，数据来源和单位仍需说明。',
      parameters: Type.Object({ expression: Type.String({ minLength: 1, maxLength: 2048 }) }),
      title: (a: { expression: string }) => '计算：' + a.expression.slice(0, 80),
      run: (a: { expression: string }) => {
        const result = calculate(a.expression)
        return { output: JSON.stringify(result), summary: '= ' + result.result }
      },
    }),
    tool({
      name: 'find_files', label: '查找文件', description: '按当前物理文件名匹配，不依赖索引。相对路径默认库根，绝对目录可查库外；省略directory只查本库。pattern 支持 *、?、**；directory 限定子树，结果分页；遵守本轮材料。',
      parameters: Type.Object({ directory: Type.Optional(Type.String()), pattern: Type.Optional(Type.String()), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })), offset: Type.Optional(Type.Integer({ minimum: 0 })) }),
      title: (a: { pattern?: string }) => '查找文件：' + (a.pattern ?? '**/*'),
      run: async (a: { directory?: string; pattern?: string; limit?: number; offset?: number }, _confirm: ConfirmFiles, signal?: AbortSignal) => {
        const result = await disk().find(a, hooks.scope(), signal)
        return { output: JSON.stringify(result), summary: result.items.length + ' 项' }
      },
    }),
    tool({
      name: 'grep_files', label: '搜索原文', description: '直接查当前磁盘完整原文，包含frontmatter，query是字面文本。省略directory只查本库，绝对目录可查库外。返回路径、行号、片段，可按目录／文件名筛选并分页；引用前read。',
      parameters: Type.Object({ query: Type.String({ minLength: 1, maxLength: 500 }), directory: Type.Optional(Type.String()), pattern: Type.Optional(Type.String()), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })), offset: Type.Optional(Type.Integer({ minimum: 0 })) }),
      title: (a: { query: string }) => '原文搜索：' + a.query,
      run: async (a: { query: string; directory?: string; pattern?: string; limit?: number; offset?: number }, _confirm: ConfirmFiles, signal?: AbortSignal) => {
        const result = await disk().find(a, hooks.scope(), signal)
        return { output: JSON.stringify(result), summary: result.items.length + ' 处' }
      },
    }),
    tool({
      name: 'app_help', label: '操作帮助', description: '软件操作帮助：无参数列分组，group 查该组参数与示例，name 查单项。parameters 是 app_manage.args 的结构，example 是可直接传给 app_manage 的完整参数对象。',
      parameters: Type.Object({ group: Type.Optional(Type.String()), name: Type.Optional(Type.String()) }),
      title: (a: { group?: string; name?: string }) => '操作帮助：' + (a.name ?? a.group ?? '分组'),
      run: (a: { group?: string; name?: string }) => ({ output: JSON.stringify(operationHelp(a.group, a.name)), summary: '已读取' }),
    }),
    tool({
      name: 'app_manage', label: '软件操作', description: '执行 app_help 返回的操作；先查具体 name，按其 example 组织完整参数：{operation:返回的name,args:符合parameters的对象}。只传一个JSON对象，正文换行／引号按JSON转义，不在JSON外追加文字。字段错误按返回的帮助纠正，不原样重试。jobId仅表示已安排；普通覆盖／删除仍确认，work_reports.write直接保存正式报告。',
      parameters: Type.Object({ operation: Type.String({ enum: APP_ACTIONS.map(action => action.name), description: 'app_help 返回的完整 name，不能使用 IPC 名称' }),
        args: Type.Object({}, { additionalProperties: true, description: '与该操作 parameters 对应的对象；无参数传 {}，不要在其中再包 operation 或 args' }) }, { additionalProperties: false }),
      title: (a: { operation: string }) => '软件操作：' + a.operation,
      run: async (a: { operation: string; args: Record<string, unknown> }, confirm: ConfirmFiles, signal?: AbortSignal) => {
        if (!operations) throw new Error('软件操作服务未连接')
        const result = await runOperation(a.operation, a.args, { ...operations, files: disk(), scope: hooks.scope(), confirm, signal })
        const cancelled = !!(result && typeof result === 'object' && 'cancelled' in result && result.cancelled)
        const failed = result && typeof result === 'object' && (
          'failed' in result && Array.isArray(result.failed) && result.failed.length > 0
          || 'skipped' in result && Array.isArray(result.skipped) && result.skipped.length > 0)
        return { output: JSON.stringify(result ?? { ok: true }), summary: cancelled ? '已取消' : failed ? '部分未完成，见实际结果' : '已返回实际结果', ok: !failed && !cancelled }
      },
    }),
    tool({
      name: 'list_directory', label: '列目录', description: '直接列出当前磁盘目录中的文件与子目录，包含空目录。库根只列 ideas、content、inbox、journal、wiki；限定材料时只展示相关路径。',
      parameters: Type.Object({ path: Type.Optional(Type.String({ description: '目录路径：相对路径以库根为基准，绝对路径可访问库外；留空列库内容目录' })) }),
      title: (a: { path?: string }) => '目录：' + (a.path || '库根'),
      run: async (a: { path?: string }) => {
        const rows = await disk().list(a.path, hooks.scope())
        return { output: rows.slice(0, 500).map(row => row.kind + ' ' + row.path).join('\n') + (rows.length > 500 ? '\n只显示前 500 项，请指定子目录。' : '') || '目录为空或没有范围内的内容。', summary: rows.length + ' 项' }
      },
    }),
    tool({
      name: 'search', label: '搜索', description: '用索引定位文件候选，再读取当前磁盘片段。关键词用空格分隔；可换词或少写词再试。返回的编号可引用，完整内容用 read。',
      parameters: Type.Object({ query: Type.Optional(Type.String()), ...filters, limit: Type.Optional(Type.Number()) }),
      title: (a: { query?: string }) => '搜索：' + (a.query || '全部'),
      run: async (a: FilterArgs & { query?: string; limit?: number }) => {
        const filter = merge(a), limit = Math.min(Math.max(Math.round(a.limit ?? 8), 1), 20)
        let result = index.search({ text: a.query, filter, limit: 200 }), loose = ''
        if (!result.items.length && a.query?.trim()) { result = index.search({ text: a.query, filter, limit: 200, mode: 'any' }); loose = '以下是相近结果，请核对是否相关。\n\n' }
        const blocks: string[] = []
        for (const hit of result.items) {
          try {
            const doc = await disk().read(hit.chunk.path, hooks.scope())
            const chunks = disk().chunks(doc)
            const tokens = (a.query ?? '').toLocaleLowerCase().split(/\s+/).filter(Boolean)
            const chunk = chunks.find(c => tokens.some(t => c.text.toLocaleLowerCase().includes(t))) ?? chunks[0]
            if (!chunk) blocks.push(doc.path + ' · ' + doc.title + '\n（无可读正文，可用 read 查看属性）')
            else {
              const excerpt = { ...chunk, text: chunk.text.slice(0, 600) }
              hooks.cite(excerpt)
              blocks.push(header(doc, excerpt) + '\n' + excerpt.text + (chunk.text.length > 600 ? '…（用 read 查看全文）' : ''))
            }
            if (blocks.length >= limit) break
          } catch { /* 过期索引指向的缺失文件不作为读取结果。 */ }
        }
        return { output: blocks.length ? loose + blocks.join('\n\n') : '没有找到当前可用的相关内容。可以换词、用 list_directory 或 timeline 再查。', summary: '找到 ' + blocks.length + ' 条' }
      },
    }),
    tool({
      name: 'read', label: '阅读', description: '读取库内或库外当前磁盘完整UTF-8原文（包括frontmatter，从第1行起），按实际文件行号和可选columnStart（1起的UTF-16位置）精确裁剪。每页最多6000字符；有nextRead时原样传入续读，长单行也不会遗漏。lineEnd为闭区间。局部编辑匹配失败时重读。',
      parameters: Type.Object({ path: Type.String(), lineStart: Type.Optional(Type.Integer({ minimum: 1 })), lineEnd: Type.Optional(Type.Integer({ minimum: 1 })), columnStart: Type.Optional(Type.Integer({ minimum: 1 })) }),
      title: (a: { path: string }) => '阅读：' + a.path,
      run: async (a: ReadRange & { path: string }) => {
        const doc = await disk().read(a.path, hooks.scope())
        const page = disk().page(doc, a)
        const blocks: string[] = []
        if (page.chunk) {
          hooks.cite(page.chunk)
          blocks.push(header(doc, page.chunk) + ' · 第' + page.columnStart + '列起\n' + page.text)
        } else blocks.push(doc.editable ? '该范围没有正文。' : '此格式暂不支持正文读取；原件和属性仍可管理。')
        blocks.push('nextRead: ' + JSON.stringify(page.next ? { path: doc.path, ...page.next, ...(a.lineEnd !== undefined ? { lineEnd: a.lineEnd } : {}) } : null))
        return { output: blocks.join('\n\n'), summary: page.chunk ? '已读第' + page.lineStart + '—' + page.lineEnd + '行' : '无正文' }
      },
    }),
    tool({
      name: 'timeline', label: '时间线', description: '按当前发生日期、创建日期与最后修改日期查找材料。普通笔记／附件只能说明有更新，不能推断具体差异或业务成果。明确记录可用 read 读取。',
      parameters: Type.Object({ ...filters, from: Type.String() }),
      title: (a: FilterArgs) => '时间线：' + a.from + (a.to ? '~' + a.to : ''),
      run: async (a: FilterArgs & { from: string }) => {
        const filter = merge(a)
        const docs = index.timeline(a.from, a.to ?? a.from, filter)
        const blocks: string[] = []
        for (const candidate of docs.slice(0, 60)) {
          const doc = await disk().metadata(candidate.path, hooks.scope()).catch(() => null)
          if (!doc) continue
          const date = dateCandidates(doc).find(c => overlaps(c, a.from, a.to ?? a.from))
          if (!date) continue
          const info = date.time + ' · ' + doc.path
          if (doc.type !== 'idea' && doc.type !== 'log') blocks.push(info + '\n文件有更新，具体变化未确认；不能据此推断当天进展。')
          else {
            const chunk = disk().chunks(await disk().read(doc.path, hooks.scope()))[0]
            if (!chunk) { blocks.push(info); continue }
            const excerpt = { ...chunk, text: chunk.text.slice(0, 500) }; hooks.cite(excerpt)
            blocks.push(header(doc, excerpt) + '\n' + info + '\n' + excerpt.text)
          }
        }
        return { output: blocks.join('\n\n') || '这段时间没有当前可用记录。', summary: blocks.length + ' 条' }
      },
    }),
    tool({
      name: 'stats', label: '统计', description: '按实际文件夹、标签、日期或类型统计当前索引条数；数字不代表业务完成事项。',
      parameters: Type.Object({ groupBy: Type.String({ description: 'folder、tag、date、type' }), ...filters }),
      title: (a: { groupBy: string }) => '统计：' + a.groupBy,
      run: (a: FilterArgs & { groupBy: string }) => {
        const groupBy = (['folder', 'tag', 'date', 'type'] as const).find(value => value === a.groupBy)
        if (!groupBy) throw new Error('groupBy 只能是 folder、tag、date、type')
        const filter = merge(a)
        const result = index.statistics(groupBy, filter)
        return { output: result.groups.map(r => (groupBy === 'type' ? LABEL[r.key as DocType] : r.key) + '：' + r.count).join('\n') + '\n合计：' + result.total, summary: result.groups.length + ' 组' }
      },
    }),
    tool({
      name: 'list_tags', label: '词表', description: '列出本轮范围中使用的标签、地点或人物以及使用次数。',
      parameters: Type.Object({ kind: Type.Optional(Type.String({ description: 'tag、place、person' })) }),
      title: () => '词表',
      run: (a: { kind?: string }) => { const rows = index.filterTerms(a.kind === 'place' || a.kind === 'person' ? a.kind : 'tag', hooks.scope()); return { output: rows.slice(0, 200).map(r => r.name + '：' + r.count).join('\n') || '还没有。', summary: rows.length + ' 项' } },
    }),
    tool({
      name: 'write_files', label: '写文件',
      description: '仅在用户明确要求时新建或替换完整UTF-8文本文件。相对路径以库根为基准，绝对路径直接写库外。body是完整文件内容，包含需要保留的frontmatter；工具不自动补写或保留旧属性。新建直接执行，覆盖已有文件由界面集中确认。updated只包含写入后回读一致的文件；回读异常返回failed，不代表已经回滚。小改动优先 edit_file；同一批覆盖一次列全。',
      parameters: Type.Object({ files: Type.Array(Type.Object({ path: Type.String(), body: Type.String() }), { minItems: 1, maxItems: 50 }) }),
      title: (a: { files: unknown[] }) => '写文件：' + a.files.length + ' 项',
      run: async (a: { files: { path: string; body: string }[] }, confirm: ConfirmFiles, signal?: AbortSignal) => { const result = await disk().write(a.files, confirm, signal); return { output: JSON.stringify(result), summary: '写入并回读核对 ' + result.updated.length + '，失败 ' + result.failed.length, ok: !result.failed.length } },
    }),
    tool({
      name: 'edit_file', label: '局部编辑', description: '对库内或库外完整原文进行唯一匹配，将 before 替换成 after，空白和换行逐字匹配；不匹配请重新 read。保存后回读全文核对一致。普通局部修改直接执行，大部分文件内容覆盖需要确认。',
      parameters: Type.Object({ path: Type.String(), before: Type.String({ minLength: 1 }), after: Type.String() }),
      title: (a: { path: string }) => '编辑：' + a.path,
      run: async (a: { path: string; before: string; after: string }, confirm: ConfirmFiles, signal?: AbortSignal) => { await disk().edit(a.path, a.before, a.after, confirm, signal); return { output: '已修改并回读核对一致：' + a.path, summary: '已保存并回读核对' } },
    }),
    tool({
      name: 'set_properties', label: '修改属性', description: '仅管理库内内容属性。只修改明确给出的属性，null 删除对应字段。普通 Markdown 写 frontmatter，附件写同目录 sidecar，不改附件原字节。source 来源使用库根相对路径；目录归属由实际位置决定，不使用 related。',
      parameters: Type.Object({ path: Type.String(), patch: Type.Record(Type.String(), Type.Unknown()) }),
      title: (a: { path: string }) => '属性：' + a.path,
      run: async (a: { path: string; patch: Record<string, unknown> }, _confirm: ConfirmFiles, signal?: AbortSignal) => { const doc = await disk().properties(a.path, a.patch, signal); return { output: JSON.stringify({ path: doc.path, properties: doc.properties }), summary: '已保存' } },
    }),
    tool({
      name: 'create_folder', label: '新建目录', description: '在parent下创建name子目录，必要时补齐父目录。相对路径默认库根，绝对路径可在库外创建；不自动生成业务目录体系。',
      parameters: Type.Object({ parent: Type.String(), name: Type.String() }),
      title: (a: { parent: string; name: string }) => '新建目录：' + a.parent + '/' + a.name,
      run: async (a: { parent: string; name: string }, _confirm: ConfirmFiles, signal?: AbortSignal) => ({ output: JSON.stringify(await disk().mkdir(a.parent, a.name, signal)), summary: '已创建' }),
    }),
    tool({
      name: 'move', label: '移动或改名', description: '把明确文件或目录移动／改名到 targetPath；目标存在则失败。附件与 sidecar 共同移动，库内容移动维护本次可确定的普通链接；支持库外与跨库移动，跨库不自动改写已有链接，返回未更新项。',
      parameters: Type.Object({ path: Type.String(), targetPath: Type.String() }),
      title: (a: { path: string; targetPath: string }) => '移动：' + a.path + ' → ' + a.targetPath,
      run: async (a: { path: string; targetPath: string }, _confirm: ConfirmFiles, signal?: AbortSignal) => { const result = await disk().move(a.path, a.targetPath, signal); return { output: JSON.stringify(result), summary: result.notUpdated.length ? '已移动，部分链接未更新' : '已移动' } },
    }),
    tool({
      name: 'trash', label: '移入回收站', description: '将明确文件或目录移入回收站；库内使用应用回收站，库外使用系统回收站，不能用应用恢复命令恢复库外文件。paths 一次列全本次删除目标，界面展示全部实际影响路径后集中确认；不永久删除，不顺带删除目录外的摘要或引用。',
      parameters: Type.Object({ paths: Type.Array(Type.String(), { minItems: 1, maxItems: 50 }) }),
      title: (a: { paths: string[] }) => '回收：' + a.paths.length + ' 项',
      run: async (a: { paths: string[] }, confirm: ConfirmFiles, signal?: AbortSignal) => { const result = await disk().trash(a.paths, confirm, signal); return { output: JSON.stringify(result), summary: '回收 ' + result.filter(r => r.trashId || r.recycled).length + ' 项', ok: result.every(r => !r.error) } },
    }),
  ]
  tools.push(tool({
    name: 'use_skill', label: '技能',
    description: '加载当前智能体允许使用的技能。SKILL.md 是入口；按任务类型用 path 读取入口指定的参考规则后再生成，不把链接当作已读取的规则。只传 name 读取 SKILL.md 正文；传 path 读取包内 UTF-8 资源（例如 references/format.md）。这些资源提供做法和模板，用户材料仍需通过当前范围内的内容工具读取。',
    parameters: Type.Object({ name: Type.String({ description: '技能完整标识，包内技能使用 插件标识:技能名称' }), path: Type.Optional(Type.String({ description: '包内相对路径，使用 / 分隔' })) }),
    title: (a: { name: string; path?: string }) => '技能：' + a.name + (a.path ? ' / ' + a.path : ''),
    run: async (a: { name: string; path?: string }) => {
      const exact = skillAccess?.skills.find(skill => skill.id === a.name)
      const matches = exact ? [exact] : skillAccess?.skills.filter(skill => skill.name === a.name) ?? []
      if (matches.length > 1) throw new Error('技能名称重复，请指定完整标识：' + matches.map(skill => skill.id).join('、'))
      const skill = matches[0]
      if (!skill || !skillAccess) throw new Error('没有这个可用技能：' + a.name)
      if (a.path === undefined || a.path === 'SKILL.md') return { output: skill.body, summary: '已加载' }
      try {
        return { output: await skillAccess.read(skill, a.path), summary: '已读取资源' }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('技能资源不存在：' + a.path)
        throw error
      }
    },
  }))
  return tools
}
const WRITES = new Set(['write_files', 'edit_file', 'set_properties', 'create_folder', 'move', 'trash', 'app_manage'])
/** 与执行共用定义，只读取工具说明；不执行工具。 */
export function describeTools(index: IndexService): CapabilityTool[] {
  return createTools({ defineTool: definition => definition }, index, {
    scope: () => ({}), cite: () => {}, confirm: async () => false, onStart: () => {}, onEnd: () => {},
  }).map(tool => ({ id: tool.name, enabled: true, source: 'builtin', title: tool.label, description: tool.description, parameters: JSON.stringify(tool.parameters, null, 2), loader: tool.name === 'use_skill', access: tool.name === 'use_skill' ? 'loader' : WRITES.has(tool.name) ? 'write' : 'read' }))
}
