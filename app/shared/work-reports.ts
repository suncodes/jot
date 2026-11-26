import type { NoteTemplate } from './app-extensions'
import { calendarDate, expandDatePath, pathDay, previewDateNote, validateContentDirectory, type DateNotePreview } from './date-paths'
import { JotError } from './result'

export const WORK_REPORT_KINDS = ['okr', 'daily', 'weekly', 'monthly'] as const
export type WorkReportKind = typeof WORK_REPORT_KINDS[number]
export const WORK_REPORT_FOLDERS: Record<WorkReportKind, string> = { okr: '1、OKR', daily: '2、日报', weekly: '3、周报', monthly: '4、月报' }

/** 月目录相对于工作根，工程日志来源使用独立的 content 库内路径。 */
export interface WorkReportPaths {
  root: string | null
  draftDirectory: string
  reportDirectory: string
  worklogDirectory: string | null
  filename: string
}

export interface WorkReportOptions extends WorkReportPaths {
  template: NoteTemplate
  /** null 不初始化 OKR 文件；none 表示初始化一份空白 OKR。 */
  okrTemplate: NoteTemplate | null
}

export const createWorkReportOptions = (): WorkReportOptions => ({
  root: null,
  draftDirectory: '草稿/{{yyyy}}年{{MM}}月',
  reportDirectory: 'AI总结/{{yyyy}}年{{MM}}月',
  worklogDirectory: null,
  filename: '{{yyyy}}-{{MM}}-{{dd}}.md',
  template: { kind: 'none' },
  okrTemplate: null,
})

export interface WorkReportMonthPreview {
  date: string
  month: string
  /** W2 仅检查这个目录是否存在，存在即跳过月份初始化。 */
  draftDirectory: string
  reportDirectory: string
  /** 仅在草稿月目录不存在时使用；预览不查询任何目录或文件。 */
  directories: string[]
  dailyDraft: DateNotePreview
  draftOkrPath: string
}

export interface WorkReportRequest {
  kind: WorkReportKind
  /** 锚点日期；周报、月报和 OKR 分别选择其所属周／月，省略时用本地今天。 */
  date?: string
}

export interface WorkReportPeriod {
  kind: WorkReportKind
  date: string
  from: string
  to: string
}

export interface WorkReportPreview extends WorkReportPeriod {
  path: string
}

function monthDirectory(root: string, pattern: string, date: string): string {
  if (!pattern.includes('{{yyyy}}') || !pattern.includes('{{MM}}') || pattern.includes('{{dd}}')) {
    throw new JotError('INVALID_INPUT', '月份目录必须包含 {{yyyy}}、{{MM}}，不能包含 {{dd}}')
  }
  const directory = root + '/' + expandDatePath(pattern, date)
  validateContentDirectory(directory)
  return directory
}

function monthDirectories(options: WorkReportPaths, root: string, date: string) {
  validateContentDirectory(root)
  const draftDirectory = monthDirectory(root, options.draftDirectory, date)
  const reportDirectory = monthDirectory(root, options.reportDirectory, date)
  const draft = draftDirectory.toLowerCase(), report = reportDirectory.toLowerCase()
  if (draft === report || draft.startsWith(report + '/') || report.startsWith(draft + '/')) {
    throw new JotError('INVALID_INPUT', '草稿与正式报告月目录必须分开，不能相同或互相包含')
  }
  return { draftDirectory, reportDirectory }
}

/** 配置可暂未选择根目录；只校验路径规则，不采用备用根目录写入。 */
export function validateWorkReportPaths(options: WorkReportPaths): void {
  const date = '2026-11-24'
  const { draftDirectory, reportDirectory } = monthDirectories(options, options.root ?? 'content', date)
  if (options.worklogDirectory !== null) validateContentDirectory(options.worklogDirectory)
  previewDateNote({ directory: (options.root ?? 'content') + '/' + options.draftDirectory + '/' + WORK_REPORT_FOLDERS.daily, filename: options.filename }, new Date(2026, 10, 24))
  // 年、月位于月份目录，文件名还需要按日区分。
  if (!options.filename.includes('{{dd}}')) throw new JotError('INVALID_INPUT', '日报草稿文件名必须包含 {{dd}}')
  for (const directory of [draftDirectory, reportDirectory]) {
    for (const kind of WORK_REPORT_KINDS) validateContentDirectory(directory + '/' + WORK_REPORT_FOLDERS[kind])
    if ((directory + '/1、OKR/2026年11月OKR.md').length > 1000) throw new JotError('INVALID_INPUT', '生成路径过长')
  }
}

/** 只计算当月目录、当天草稿和可选 OKR 的目标，不创建或探测文件。 */
export function previewWorkReportMonth(options: WorkReportPaths, now: Date): WorkReportMonthPreview {
  validateWorkReportPaths(options)
  if (options.root === null) throw new JotError('INVALID_INPUT', '请选择工作根目录')
  const date = pathDay(now)
  const { draftDirectory, reportDirectory } = monthDirectories(options, options.root, date)
  const directoryPattern = options.root + '/' + options.draftDirectory + '/' + WORK_REPORT_FOLDERS.daily
  return {
    date, month: date.slice(0, 7), draftDirectory, reportDirectory,
    directories: [draftDirectory, reportDirectory].flatMap(directory => WORK_REPORT_KINDS.map(kind => directory + '/' + WORK_REPORT_FOLDERS[kind])),
    dailyDraft: previewDateNote({ directory: directoryPattern, filename: options.filename }, now),
    draftOkrPath: draftDirectory + '/' + WORK_REPORT_FOLDERS.okr + '/' + expandDatePath('{{yyyy}}年{{MM}}月OKR.md', date),
  }
}

function shiftDay(value: string, days: number): string {
  const date = calendarDate(value)
  date.setUTCDate(date.getUTCDate() + days)
  const shifted = date.toISOString().slice(0, 10)
  calendarDate(shifted)
  return shifted
}

/** 周报按周一至周五；当前周期截至今天，历史周期取完整范围。 */
export function workReportPeriod(request: WorkReportRequest, now: Date): WorkReportPeriod {
  if (!WORK_REPORT_KINDS.includes(request.kind)) throw new JotError('INVALID_INPUT', '工作报告类型无效')
  const today = pathDay(now), date = request.date ?? today
  const anchor = calendarDate(date)
  let from = date, to = date
  if (request.kind === 'weekly') {
    from = shiftDay(date, -((anchor.getUTCDay() + 6) % 7))
    to = shiftDay(from, 4)
  } else if (request.kind === 'monthly' || request.kind === 'okr') {
    from = date.slice(0, 7) + '-01'
    const end = calendarDate(from)
    end.setUTCMonth(end.getUTCMonth() + 1, 0)
    to = end.toISOString().slice(0, 10)
  }
  if (to > today) to = today
  if (to < from) throw new JotError('INVALID_INPUT', '所选周期尚未开始，暂无可汇总的日期')
  return { kind: request.kind, date, from, to }
}

/** 报告预览与后续实际写入共用；周报归实际结束日所在月，避免同一范围落到两个月。 */
export function previewWorkReport(options: WorkReportPaths, request: WorkReportRequest, now: Date): WorkReportPreview {
  validateWorkReportPaths(options)
  if (options.root === null) throw new JotError('INVALID_INPUT', '请选择工作根目录')
  const period = workReportPeriod(request, now)
  const targetDate = request.kind === 'weekly' ? period.to : period.date
  const { reportDirectory } = monthDirectories(options, options.root, targetDate)
  const filename = request.kind === 'daily' ? period.date + '.md'
    : request.kind === 'weekly' ? period.from + '~' + period.to + '.md'
      : request.kind === 'monthly' ? targetDate.slice(0, 7) + '月报.md'
        : expandDatePath('{{yyyy}}年{{MM}}月OKR.md', targetDate)
  const path = reportDirectory + '/' + WORK_REPORT_FOLDERS[request.kind] + '/' + filename
  if (path.length > 1000) throw new JotError('INVALID_INPUT', '生成路径过长')
  return { ...period, path }
}

export interface WorkReportProfile {
  extensionId: string
  profileId: string
  name: string
  enabled: boolean
  paths: WorkReportPaths
}

export interface WorkReportProfiles {
  profiles: WorkReportProfile[]
  issues: { extensionId: string; message: string }[]
}

export type WorkReportSource =
  | { kind: 'profile'; extensionId: string; profileId: string }
  | { kind: 'paths'; paths: WorkReportPaths }

export interface WorkReportPlan extends WorkReportPreview {
  request: Required<WorkReportRequest>
  days: { date: string; draftPath: string; reportPath: string }[]
  months: { month: string; draftDirectory: string; reportDirectory: string; draftOkrPath: string; reportOkrPath: string; monthlyPath: string }[]
  weekly: WorkReportPreview[]
  worklogDirectory: string | null
}

export function planWorkReport(options: WorkReportPaths, request: WorkReportRequest, now: Date): WorkReportPlan {
  const target = previewWorkReport(options, request, now)
  const days: WorkReportPlan['days'] = [], months = new Map<string, WorkReportPlan['months'][number]>()
  const weekly = new Map<string, WorkReportPreview>()
  for (let day = target.from; day <= target.to; day = shiftDay(day, 1)) {
    const calendar = calendarDate(day)
    const month = previewWorkReportMonth(options, new Date(calendar.getUTCFullYear(), calendar.getUTCMonth(), calendar.getUTCDate(), 12))
    days.push({ date: day, draftPath: month.dailyDraft.path, reportPath: previewWorkReport(options, { kind: 'daily', date: day }, now).path })
    if (!months.has(month.month)) {
      months.set(month.month, { month: month.month, draftDirectory: month.draftDirectory, reportDirectory: month.reportDirectory,
        draftOkrPath: month.draftOkrPath, reportOkrPath: previewWorkReport(options, { kind: 'okr', date: day }, now).path,
        monthlyPath: previewWorkReport(options, { kind: 'monthly', date: day }, now).path })
    }
    const week = previewWorkReport(options, { kind: 'weekly', date: day }, now)
    if (week.to >= target.from && week.from <= target.to) weekly.set(week.path, week)
  }
  return { ...target, request: { kind: target.kind, date: target.date }, days, months: [...months.values()],
    weekly: [...weekly.values()], worklogDirectory: options.worklogDirectory }
}
