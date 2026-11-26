import { z } from 'zod'
import { APP_EXTENSION_API_VERSION, APP_EXTENSION_SCHEMA_VERSION, APP_EXTENSION_ICONS, type AppExtensionConfiguration, type AppExtensionManifest, type ShortcutConfiguration } from '@shared/app-extensions'
import { COMMAND_IDENTIFIER, EXTENSION_IDENTIFIER, isAppExtensionId } from '@shared/commands'
import { calendarDate, previewDateNote, validateResourcePath } from '@shared/date-paths'
import { isReservedShortcut, normalizeShortcut } from '@shared/shortcut-keys'
import { WORK_REPORT_KINDS, validateWorkReportPaths, type WorkReportPaths, type WorkReportOptions, type WorkReportRequest } from '@shared/work-reports'
import { packageSegments } from '../vault/package-files'

const identifier = z.string().min(1).max(80).regex(EXTENSION_IDENTIFIER)
export const appExtensionId = identifier.refine(isAppExtensionId, '应用插件标识无效或为保留名称')
const name = z.string().trim().min(1).max(120)
const version = z.string().max(80).regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/)
const unique = (values: string[]) => new Set(values).size === values.length
export const templatePath = z.string().max(1000).superRefine((value, ctx) => {
  try { validateResourcePath(value) }
  catch (error) { ctx.addIssue({ code: 'custom', message: (error as Error).message }) }
})
export const noteTemplate = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }).strict(),
  z.object({ kind: z.literal('package'), path: templatePath }).strict(),
  z.object({ kind: z.literal('user'), path: templatePath }).strict(),
])
export const dailyNoteOptions = z.object({
  directory: z.string().min(1).max(1000).nullable(), filename: z.string().min(1).max(255), template: noteTemplate,
}).strict().superRefine((value, ctx) => {
  try { previewDateNote({ directory: value.directory ?? 'content/{{yyyy}}/{{MM}}/{{dd}}', filename: value.filename }, new Date(2026, 10, 23)) }
  catch (error) { ctx.addIssue({ code: 'custom', message: (error as Error).message }) }
})

/** 工作日记清单、入口配置及路径预览共用同一契约。 */
const workReportPathFields = {
  root: z.string().min(1).max(1000).nullable(),
  draftDirectory: z.string().min(1).max(1000),
  reportDirectory: z.string().min(1).max(1000),
  worklogDirectory: z.string().min(1).max(1000).nullable(),
  filename: z.string().min(1).max(255),
}
const checkReportPaths = (value: WorkReportPaths, ctx: z.RefinementCtx) => {
  try { validateWorkReportPaths(value) }
  catch (error) { ctx.addIssue({ code: 'custom', message: (error as Error).message }) }
}
export const workReportPaths: z.ZodType<WorkReportPaths> = z.object(workReportPathFields).strict().superRefine(checkReportPaths)
export const workReportOptions: z.ZodType<WorkReportOptions> = z.object({
  ...workReportPathFields, template: noteTemplate, okrTemplate: noteTemplate.nullable(),
}).strict().superRefine(checkReportPaths)

export const workReportRequest: z.ZodType<WorkReportRequest> = z.object({
  kind: z.enum(WORK_REPORT_KINDS),
  date: z.string().superRefine((value, ctx) => {
    try { calendarDate(value) }
    catch (error) { ctx.addIssue({ code: 'custom', message: (error as Error).message }) }
  }).optional(),
}).strict()

export const appExtensionManifest: z.ZodType<AppExtensionManifest> = z.object({
  schemaVersion: z.literal(APP_EXTENSION_SCHEMA_VERSION), apiVersion: z.literal(APP_EXTENSION_API_VERSION),
  id: appExtensionId,
  name, version, description: z.string().trim().min(1).max(1000), minAppVersion: version,
  aiPlugin: z.object({ path: z.string().min(1).max(1000).superRefine((value, ctx) => {
    try { packageSegments(value) }
    catch (error) { ctx.addIssue({ code: 'custom', message: (error as Error).message }) }
  }) }).strict().optional(),
  commands: z.array(z.discriminatedUnion('action', [
    z.object({ id: identifier, name, icon: z.enum(APP_EXTENSION_ICONS), action: z.literal('daily-note'), defaults: dailyNoteOptions }).strict(),
    z.object({ id: identifier, name, icon: z.enum(APP_EXTENSION_ICONS), action: z.literal('work-diary'), defaults: workReportOptions }).strict(),
  ])).min(1).max(30)
    .refine(commands => unique(commands.map(command => command.id)), '命令标识不能重复'),
}).strict()

export const appExtensionConfiguration: z.ZodType<AppExtensionConfiguration> = z.object({
  schemaVersion: z.literal(1),
  extensions: z.record(appExtensionId, z.object({
    enabled: z.boolean(),
    profiles: z.array(z.object({ id: identifier, commandId: identifier, name, options: z.union([dailyNoteOptions, workReportOptions]) }).strict()).max(100)
      .refine(profiles => unique(profiles.map(profile => profile.id)), '配置标识不能重复'),
  }).strict()).refine(extensions => Object.keys(extensions).length <= 100, '应用插件配置过多'),
}).strict()

export const appExtensionProfileInput = z.object({ id: identifier.optional(), commandId: identifier, name, options: z.union([dailyNoteOptions, workReportOptions]) }).strict()
export const appExtensionImportRequest = z.object({
  source: z.discriminatedUnion('kind', [z.object({ kind: z.literal('local') }).strict(), z.object({ kind: z.literal('bundled'), id: appExtensionId }).strict()]),
  updating: appExtensionId.optional(),
}).strict()

const commandId = z.string().max(260).regex(COMMAND_IDENTIFIER)
const hotkey = z.string().min(1).max(100).transform((value, ctx) => {
  try {
    const normalized = normalizeShortcut(value)
    if (isReservedShortcut(normalized)) { ctx.addIssue({ code: 'custom', message: '此快捷键由应用或编辑器保留' }); return z.NEVER }
    return normalized
  } catch (error) { ctx.addIssue({ code: 'custom', message: (error as Error).message }); return z.NEVER }
})
export const shortcutConfiguration: z.ZodType<ShortcutConfiguration> = z.object({
  schemaVersion: z.literal(1),
  pinned: z.array(commandId).max(200).refine(unique, '固定命令不能重复'),
  bindings: z.array(z.object({ commandId, hotkey }).strict()).max(200)
    .refine(bindings => unique(bindings.map(binding => binding.commandId)), '每条命令只能绑定一个快捷键')
    .refine(bindings => unique(bindings.map(binding => binding.hotkey.replace('Meta+', 'Ctrl+'))), '快捷键不能重复'),
}).strict()

export const profileShortcutInput = z.object({ pinned: z.boolean(), hotkey: hotkey.nullable() }).strict()
