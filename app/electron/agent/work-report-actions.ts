import { EXTENSION_IDENTIFIER } from '@shared/commands'
import { z } from 'zod'
import { workReportPaths, workReportRequest, appExtensionId } from '../extensions/schema'
import { operation } from './operation-base'
import type { WorkReportSource } from '@shared/work-reports'

const source: z.ZodType<WorkReportSource> = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('profile'), extensionId: appExtensionId, profileId: z.string().min(1).max(80).regex(EXTENSION_IDENTIFIER) }).strict(),
  z.object({ kind: z.literal('paths'), paths: workReportPaths }).strict(),
])
const input = { source, request: workReportRequest }
const example = { source: { kind: 'profile' as const, extensionId: 'work-diary', profileId: 'default' }, request: { kind: 'daily' as const, date: '2026-11-24' } }

export const workReportActions = [
  operation('work_reports.profiles', '只读工作日记入口名称、启停和路径；多入口需选择。停用不阻止读取已配置路径；不含模板正文或密钥。', z.object({}).strict(), {}, false,
    (_input, context) => context.app.workReports.profiles()),
  operation('work_reports.prepare', '计算正式目标、范围、逐日草稿／日报、逐月OKR与相关周月报候选、工程日志目录；不读正文、不创建。source选已查询profile或用户明确paths。返回request供写入沿用；候选仍受本轮材料范围约束。', z.object(input).strict(), example, false,
    (input, context) => context.app.workReports.prepare(input.source, input.request)),
  operation('work_reports.write', '按所选配置及类型／日期直接创建或覆盖单个正式报告，保留属性；用户要求生成报告时使用。不改草稿，不接受任意path或免确认参数。body只传报告正文，不带frontmatter；来源用相对链接。写后回读核对正文一致，返回真实updated／failed，成功才有库内link。', z.object({ ...input, body: z.string().min(1).max(500000) }).strict(), { ...example, body: '# 工作日报\n\n已完成有材料依据的工作。' }, true,
    (input, context) => context.app.workReports.write(input.source, input.request, input.body, context.signal)),
]
