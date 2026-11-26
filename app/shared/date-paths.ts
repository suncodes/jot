import { JotError } from './result'

export interface DateNotePath {
  directory: string
  filename: string
}

export interface DateNotePreview extends DateNotePath {
  date: string
  path: string
}

const DATE_TOKENS = ['yyyy', 'MM', 'dd'] as const
const illegalSegment = /[\u0000-\u001f\u007f\\:*?"<>|]/
const reservedName = /^(con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i

export function validateResourcePath(value: string): void {
  validateRelativePath(value)
  if (!value.startsWith('templates/') || !/\.(md|markdown)$/i.test(value)) throw new JotError('INVALID_INPUT', '模板必须是 templates/ 下的 Markdown 文件')
}

function validateRelativePath(value: string): void {
  if (!value || value.length > 1000) throw new JotError('INVALID_INPUT', '路径为空或过长')
  for (const segment of value.split('/')) {
    if (!segment || segment.startsWith('.') || /[. ]$/.test(segment) || illegalSegment.test(segment) || reservedName.test(segment) || segment.length > 255) {
      throw new JotError('INVALID_INPUT', '路径含有非法名称：' + value)
    }
  }
}

export function validateContentDirectory(value: string): void {
  validateRelativePath(value)
  if (/[{}]/.test(value)) throw new JotError('INVALID_INPUT', '目录中含有未展开的日期占位符')
  if (value !== 'content' && !value.startsWith('content/')) throw new JotError('INVALID_INPUT', '日记目录必须位于 content/ 下')
}

/** 只接受真实的日历日期，不让 Date 自动把 2 月 30 日移到 3 月。 */
export function calendarDate(value: string): Date {
  const date = new Date(value + 'T12:00:00Z')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000-') || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new JotError('INVALID_INPUT', '日期无效，请使用 YYYY-MM-DD')
  }
  return date
}

/** 操作开始时的本地日期；后续所有路径都使用这个日期，不再取时。 */
export function pathDay(now: Date): string {
  if (!Number.isFinite(now.getTime()) || now.getFullYear() < 1 || now.getFullYear() > 9999) throw new JotError('INVALID_INPUT', '当前日期无效')
  return `${String(now.getFullYear()).padStart(4, '0')}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

export function expandDatePath(value: string, date: string): string {
  calendarDate(date)
  const values = { yyyy: date.slice(0, 4), MM: date.slice(5, 7), dd: date.slice(8, 10) }
  const expanded = value.replace(/\{\{(yyyy|MM|dd)\}\}/g, (_, token: typeof DATE_TOKENS[number]) => values[token])
  if (/[{}]/.test(expanded)) throw new JotError('INVALID_INPUT', '仅支持 {{yyyy}}、{{MM}}、{{dd}} 日期占位符')
  validateRelativePath(expanded)
  return expanded
}

export function previewDateNote(input: DateNotePath, now: Date): DateNotePreview {
  const date = pathDay(now)
  const directory = expandDatePath(input.directory, date)
  let filename = expandDatePath(input.filename, date)
  validateContentDirectory(directory)
  if (filename.includes('/')) throw new JotError('INVALID_INPUT', '文件名不能包含目录')
  if (!/\.(md|markdown)$/i.test(filename)) filename += '.md'
  validateRelativePath(filename)
  const combined = input.directory + '/' + input.filename
  if (DATE_TOKENS.some(token => !combined.includes('{{' + token + '}}'))) throw new JotError('INVALID_INPUT', '目录与文件名合计必须包含年、月、日占位符')
  const path = directory + '/' + filename
  if (path.length > 1000) throw new JotError('INVALID_INPUT', '生成路径过长')
  return { date, directory, filename, path }
}
