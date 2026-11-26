import { REASONING_EFFORTS } from '@shared/reasoning'
import { z, type ZodType } from 'zod'
import { MODEL_BUDGET_BOUNDS } from '@shared/model-budget'
import { COMMAND_IDENTIFIER, EXTENSION_IDENTIFIER } from '@shared/commands'
import { appExtensionId, appExtensionImportRequest, appExtensionProfileInput, profileShortcutInput, noteTemplate, shortcutConfiguration, templatePath, workReportOptions } from '../extensions/schema'
import { isCalendarDay } from '../util/time'
import type { Channel } from '@shared/ipc'
import { capabilityOwner, pluginChange, resourcePatch, taskBindings, agentChange, skillChange, skillName, skillId } from '../agent/capability-schema'

const none = z.undefined().or(z.null()).transform(() => undefined)
const reasoningEffort = z.enum(REASONING_EFFORTS)
const compactionThreshold = z.union([z.literal(0.6), z.literal(0.7), z.literal(0.8)])
const ref = z.object({ path: z.string().min(1).max(1000) }).strict()
const docType = z.enum(['idea', 'log', 'note', 'file', 'source-summary', 'daily'])
const jobState = z.enum(['queued', 'running', 'waiting-model', 'failed', 'done', 'cancelled'])
const termKind = z.enum(['tag', 'place', 'person'])
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(isCalendarDay, '日期无效')
const eventTime = z.object({
  basis: z.enum(['occurred', 'recorded', 'edited', 'imported']),
  from: day, to: day,
}).strict().refine(t => t.from <= t.to, '起始日期不能晚于结束日期')
const contentScope = z.object({
  selection: z.union([
    z.object({ kind: z.literal('collection'), name: z.enum(['all', 'ideas', 'pending']) }).strict(),
    z.object({ kind: z.literal('directory'), path: z.string().min(1).max(1000), recursive: z.boolean().default(false) }).strict(),
  ]),
  roles: z.array(z.enum(['record', 'note', 'source', 'derived'])).optional(),
  time: eventTime.optional(),
}).strict()
const propertyFilter = z.object({
  types: z.array(docType),
  tags: z.array(z.string()),
  place: z.string(),
  people: z.array(z.string()),
  from: day,
  to: day,
}).partial().strict()
export const searchFilter = propertyFilter.extend({ scope: contentScope.optional() }).refine(f => !f.from || !f.to || f.from <= f.to, '起始日期不能晚于结束日期')
const libraryFilter = propertyFilter.refine(f => !f.from || !f.to || f.from <= f.to, '起始日期不能晚于结束日期')
const page = { limit: z.number().int().min(1).max(200).optional(), offset: z.number().int().min(0).optional() }

const classificationPatch = z.object({
  tags: z.array(z.string().min(1).max(40)).max(20).optional(),
  place: z.string().max(40).nullable().optional(),
  people: z.array(z.string().min(1).max(40)).max(20).optional(),
}).strict()

const material = z.object({ kind: z.enum(['file', 'folder']), value: z.string().min(1).max(1000), title: z.string().max(200) }).strict()
const assistantContext = z.object({ agentId: z.string().min(1), references: z.array(material).max(30), strict: z.boolean(), skillIds: z.array(z.string()).max(100), reasoningEffort: reasoningEffort.optional(), reasoningModel: z.string().max(1500).optional() }).strict()
/** 每个通道的参数校验。主进程入口统一校验，不通过返回 INVALID_INPUT。 */
export const argSchemas: Record<Channel, ZodType> = {
  'commands:list': z.object({ query: z.string().max(200).optional(), availableOnly: z.boolean().default(true) }).strict(),
  'commands:execute': z.object({ id: z.string().max(260).regex(COMMAND_IDENTIFIER) }).strict(),
  'extensions:configuration': none,
  'extensions:catalog': none,
  'extensions:previewImport': appExtensionImportRequest,
  'extensions:confirmImport': z.object({ token: z.string().uuid(), installAiPlugin: z.boolean().optional() }).strict(),
  'extensions:cancelImport': z.object({ token: z.string().uuid() }).strict(),
  'extensions:previewAiPlugin': z.object({ id: appExtensionId }).strict(),
  'extensions:confirmAiPlugin': z.object({ token: z.string().uuid() }).strict(),
  'extensions:cancelAiPlugin': z.object({ token: z.string().uuid() }).strict(),
  'extensions:setEnabled': z.object({ id: appExtensionId, enabled: z.boolean() }).strict(),
  'extensions:saveProfile': z.object({ id: appExtensionId, profile: appExtensionProfileInput, shortcut: profileShortcutInput.optional() }).strict(),
  'extensions:removeProfile': z.object({ id: appExtensionId, profileId: z.string().min(1).max(80).regex(EXTENSION_IDENTIFIER) }).strict(),
  'extensions:uninstall': z.object({ id: appExtensionId, confirmed: z.literal(true) }).strict(),
  'extensions:readTemplate': z.object({ id: appExtensionId, template: noteTemplate }).strict(),
  'extensions:copyTemplate': z.object({ id: appExtensionId, path: templatePath, targetPath: templatePath }).strict(),
  'extensions:previewDateNote': z.object({ directory: z.string().min(1).max(1000), filename: z.string().min(1).max(255) }).strict(),
  'extensions:previewWorkReport': workReportOptions,
  'shortcuts:get': none,
  'shortcuts:set': shortcutConfiguration,
  'maintenance:usage': none,
  'maintenance:clearTemporary': z.object({ vaultPath: z.string().min(1).max(1000), confirmed: z.literal(true) }).strict(),
  'maintenance:optimizeDatabases': z.object({ vaultPath: z.string().min(1).max(1000) }).strict(),
  'vault:refreshIndex': z.object({ paths: z.array(z.string().min(1).max(1000)).max(10000).optional() }).strict(),
  'doc:properties': z.object({ path: z.string().min(1).max(1000) }).strict(),
  'doc:patchProperties': z.object({ path: z.string().min(1).max(1000), patch: z.record(z.string(), z.unknown()) }).strict(),
  'doc:editText': z.object({ path: z.string().min(1).max(1000), before: z.string().min(1), after: z.string() }).strict(),
  'content:move': z.object({ path: z.string().min(1).max(1000), targetPath: z.string().min(1).max(1000) }).strict(),
  'links:list': z.object({ path: z.string().min(1).max(1000), direction: z.enum(['incoming', 'outgoing']).optional() }).strict(),

  'app:info': none,
  'app:status': none,

  'vault:status': none,
  'vault:pick': none,
  'vault:open': z.object({ path: z.string().min(1), create: z.boolean() }),
  'vault:tree': z.object({ dir: z.string().optional() }),
  'vault:rebuildIndex': none,
  'folder:move': z.object({ path: z.string().min(1), toDir: z.string().min(1), name: z.string().min(1).max(80).optional() }).strict(),
  'folder:delete': z.object({ path: z.string().min(1) }).strict(),
  'folder:restore': z.object({ trashId: z.string().min(1) }),
  'trash:purge': z.object({ trashIds: z.array(z.string().regex(/^[0-9A-Z]{26}$/)).min(1).max(10000) }),
  'vault:createFolder': z.object({ parent: z.string().min(1), name: z.string().min(1).max(80) }).strict(),

  'capture:save': z.object({ text: z.string().min(1).max(100_000), source: z.enum(['quick-capture', 'main-window']) }),
  'capture:saveLog': z.object({ text: z.string().min(1).max(100_000), start: z.string().min(10), end: z.string().min(10) }),
  'capture:hideWindow': none,
  'capture:resize': z.object({ height: z.number().min(40).max(400) }),

  'doc:get': z.object({ ref }),
  'doc:create': z.object({ dir: z.string().optional(), title: z.string().min(1).max(120), body: z.string().optional(), classification: classificationPatch.optional() }).strict(),
  'doc:setClassification': z.object({
    ref,
    patch: classificationPatch,
  }),
  'doc:saveBody': z.object({ ref, body: z.string(), baseHash: z.string() }),
  'doc:rename': z.object({ ref, newName: z.string().min(1).max(120) }),
  'doc:move': z.object({ ref, toDir: z.string().min(1) }).strict(),
  'doc:delete': z.object({ ref }),
  'doc:setOccurredAt': z.object({ ref, occurredAt: day.refine(isCalendarDay, '日期无效').nullable() }),
  'doc:setLogTime': z.object({ ref, start: z.string().min(10).max(40), end: z.string().min(10).max(40) }),
  'trash:list': z.object(page),
  'library:delete': z.object({ path: z.string().min(1), scope: z.enum(['source', 'entry']) }).strict(),
  'doc:restore': z.object({ trashId: z.string().min(1) }),
  'doc:openExternal': z.object({ path: z.string().min(1) }),
  'doc:quickOpen': z.object({ query: z.string(), limit: z.number().int().min(1).max(100).optional() }),
  'doc:resolveLink': z.object({ from: z.string().min(1).max(1000), target: z.string().trim().min(1).max(1000), kind: z.enum(['markdown', 'wiki']).optional() }),

  'content:directories': z.object({ parentPath: z.string().min(1).optional(), recursive: z.boolean().optional() }),
  'content:stats': z.object({ scope: contentScope.optional(), filter: searchFilter.optional(), groupBy: z.enum(['folder', 'tag', 'date', 'type']) }),

  'library:pins': none,
  'library:setPinned': z.object({ path: z.string().min(1).max(1000), kind: z.enum(['file', 'folder']), pinned: z.boolean() }).strict(),
  'library:reorderPin': z.object({ path: z.string().min(1).max(1000), direction: z.enum(['up', 'down']) }).strict(),
  'library:facets': z.object({ scope: contentScope.optional() }).strict(),
  'library:query': z.object({
    scope: contentScope.optional(),
    pending: z.boolean().optional(),
    filter: libraryFilter.optional(),
    kind: z.enum(['record', 'note', 'file']).optional(), text: z.string().max(200).optional(), sort: z.enum(['updated', 'created', 'name']).optional(),
    fileState: z.enum(['unprocessed', 'queued', 'processing', 'done', 'waiting-model', 'failed', 'unsupported']).optional(),
    path: z.string().optional(), ...page,
  }).strict(),
  'library:resolve': z.object({ path: z.string().min(1) }).strict(),
  'search:query': z.object({ text: z.string().max(200).optional(), filter: searchFilter.optional(), sort: z.enum(['relevance', 'time']).optional(), ...page }),

  'classify:inbox': z.object(page),
  'classify:accept': z.object({ ref, kind: z.enum(['directory', 'properties']), toDir: z.string().min(1).max(1000).optional() }).strict().refine(a => a.kind === 'directory' || a.toDir === undefined, '属性确认不能指定目录'),
  'classify:skip': z.object({ ref, kind: z.enum(['directory', 'properties']) }).strict(),
  'classify:rerun': z.object({ ref }),

  'taxonomy:create': z.object({
    kind: termKind,
    name: z.string().trim().min(1, '请输入词条名称').max(40, '词条名称最多 40 个字符').regex(/^[^\r\n]+$/, '词条名称请写在一行'),
  }).strict(),
  'taxonomy:remove': z.object({ kind: termKind, name: z.string().min(1).max(60), into: z.string().min(1).max(60).optional() }),
  'taxonomy:terms': z.object({ kind: termKind }),
  'taxonomy:rename': z.object({ kind: termKind, from: z.string().min(1).max(60), to: z.string().min(1).max(60) }),
  'taxonomy:merge': z.object({ kind: termKind, from: z.array(z.string().min(1).max(60)).min(1).max(30), into: z.string().min(1).max(60) }),
  'taxonomy:findSynonyms': z.object({ kind: termKind }),
  'taxonomy:synonyms': none,
  'taxonomy:dismissSynonym': z.object({ id: z.string().min(1) }),

  'files:import': z.object({ paths: z.array(z.string().min(1)).min(1).max(200), toDir: z.string().optional() }).strict(),
  'files:list': z.object(page),
  'files:reprocess': z.object({ path: z.string().min(1), force: z.boolean().optional(), summaryPath: z.string().min(1).optional() }).strict(),

  'timeline:day': z.object({ date: day }),
  'timeline:daysWithRecords': z.object({ month: z.string().regex(/^\d{4}-\d{2}$/) }),
  'timeline:generateDaily': z.object({ date: day, force: z.boolean().optional() }).strict(),

  'agent:conversations': z.object({ ...page, text: z.string().max(200).optional() }),
  'capabilities:removeRun': z.object({ runId: z.string().min(1) }),
  'capabilities:catalog': none,
  'capabilities:changePlugin': pluginChange,
  'capabilities:resources': z.object({ owner: capabilityOwner, id: skillId }).strict(),
  'capabilities:readResource': z.object({ owner: capabilityOwner, id: skillId, path: z.string().min(1).max(1000) }).strict(),
  'capabilities:patchResources': z.object({ owner: capabilityOwner, id: skillId, files: z.array(resourcePatch).min(1).max(1000) }).strict(),
  'capabilities:setToolEnabled': z.object({ id: z.string().min(1), enabled: z.boolean() }).strict(),
  'capabilities:setAgentEnabled': z.object({ id: z.string().min(1), enabled: z.boolean() }).strict(),
  'capabilities:setTaskSkills': taskBindings.partial().refine(patch => Object.keys(patch).length > 0, '至少修改一个任务'),
  'capabilities:impact': z.object({ owner: z.enum(['agent', 'skill', 'plugin', 'tool']), id: z.string().min(1) }).strict(),
  'capabilities:previewUpdate': z.object({ owner: capabilityOwner, id: skillName }).strict(),
  'capabilities:setPluginEnabled': z.object({ id: skillName, enabled: z.boolean() }).strict(),
  'capabilities:previewPluginImport': none,
  'capabilities:confirmPluginImport': z.object({ token: z.uuid() }).strict(),
  'capabilities:cancelPluginImport': z.object({ token: z.uuid() }).strict(),
  'capabilities:changeAgent': agentChange,
  'capabilities:changeSkill': skillChange,
  'capabilities:previewSkillImport': none,
  'capabilities:confirmSkillImport': z.object({ token: z.uuid(), name: skillName }).strict(),
  'capabilities:cancelSkillImport': z.object({ token: z.uuid() }).strict(),
  'capabilities:runs': z.object({ ...page, text: z.string().max(200).optional(), status: z.enum(['completed', 'failed', 'stopped', 'interrupted']).optional() }),
  'agent:create': none,
  'agent:get': z.object({ conversationId: z.string().min(1) }),
  'agent:send': z.object({ conversationId: z.string().min(1), text: z.string().min(1).max(20_000), context: assistantContext.optional(), retryMessageId: z.string().optional() }).strict(),
  'agent:setReasoning': z.object({ conversationId: z.string().min(1), effort: reasoningEffort.nullable() }).strict(),
  'agent:confirm': z.object({ runId: z.string().min(1), requestId: z.string().min(1), approved: z.boolean() }).strict(),
  'agent:abort': z.object({ runId: z.string().min(1) }),
  'agent:rename': z.object({ conversationId: z.string().min(1), title: z.string().min(1).max(80) }),
  'agent:delete': z.object({ conversationId: z.string().min(1) }),
  'agent:export': z.object({ conversationId: z.string().min(1), format: z.enum(['markdown', 'jsonl']) }).strict(),

  'jobs:list': z.object({ state: jobState.optional(), states: z.array(jobState).min(1).max(6).optional(), ...page }),
  'jobs:retry': z.object({ jobId: z.string().min(1) }),
  'jobs:cancel': z.object({ jobId: z.string().min(1) }),

  'settings:get': none,
  'settings:reasoning': z.object({ baseUrl: z.string(), model: z.string() }).strict(),
  'settings:modelBudget': z.object({ baseUrl: z.string(), model: z.string(),
    contextWindow: z.number().int().min(MODEL_BUDGET_BOUNDS.contextWindow.min).max(MODEL_BUDGET_BOUNDS.contextWindow.max).optional(),
    compactionThreshold: compactionThreshold.optional(), reasoningEffort: reasoningEffort.optional(),
  }).strict(),
  'settings:set': z.object({
    model: z.object({
      baseUrl: z.string(), model: z.string(), apiKey: z.string(),
      contextWindow: z.number().int().min(MODEL_BUDGET_BOUNDS.contextWindow.min).max(MODEL_BUDGET_BOUNDS.contextWindow.max).nullable(),
      compactionThreshold: compactionThreshold.nullable(), reasoningEffort,
    }).partial().strict().optional(),
    classify: z.object({ enabled: z.boolean() }).partial().strict().optional(),
    maintenance: z.object({ trashRetentionDays: z.union([z.literal(0), z.literal(30)]) }).partial().strict().optional(),
    capture: z.object({ hotkey: z.string().min(1), launchAtLogin: z.boolean() }).partial().optional(),
    window: z.object({ closeBehavior: z.enum(['tray', 'quit']) }).partial().strict().optional(),
    daily: z.object({ enabled: z.boolean(), time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/) }).partial().optional(),
    appearance: z.object({ theme: z.enum(['system', 'dark', 'light']) }).partial().optional(),
    layout: z
      .object({
        sideWidth: z.number().min(200).max(480),
        agentWidth: z.number().min(280).max(560),
        sideCollapsed: z.boolean(),
        agentCollapsed: z.boolean(),
      })
      .partial()
      .optional(),
  }).strict(),
  'settings:testModel': z.object({ baseUrl: z.string(), apiKey: z.string(), model: z.string(), reasoningEffort,
    contextWindow: z.number().int().min(MODEL_BUDGET_BOUNDS.contextWindow.min).max(MODEL_BUDGET_BOUNDS.contextWindow.max), compactionThreshold }).partial().strict(),
}
