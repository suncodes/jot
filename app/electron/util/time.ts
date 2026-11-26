import { JotError } from '@shared/result'
const pad = (n: number, len = 2) => String(n).padStart(len, '0')

/** 带本机时区的 ISO 时间，例如 2026-11-13T21:40:05+08:00 */
export function localIso(d: Date = new Date()): string {
  const off = -d.getTimezoneOffset()
  const sign = off >= 0 ? '+' : '-'
  const abs = Math.abs(off)
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  )
}

/** 本机时区的日期，YYYY-MM-DD。传入无法解析的值时返回空串。 */
export function localDay(d: Date | string): string {
  const date = typeof d === 'string' ? new Date(d) : d
  if (Number.isNaN(date.getTime())) return ''
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** 用作文件名的时间，例如 2026-11-13 214005 */
export function fileStamp(d: Date = new Date()): string {
  return `${localDay(d)} ${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

/** 日期精度保持为日期；拒绝 Date 自动纠正的 2 月 30 日等输入。 */
export function isCalendarDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [year, month, day] = value.split('-').map(Number) as [number, number, number]
  const d = new Date(value + 'T12:00:00Z')
  return d.getUTCFullYear() === year && d.getUTCMonth() + 1 === month && d.getUTCDate() === day
}

export function activityTime(value: string): string {
  if (isCalendarDay(value)) return value
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})?$/.exec(value)
  if (!match || !isCalendarDay(match[1]!) || +match[2]! > 23 || +match[3]! > 59 || +(match[4] ?? '0') > 59
    || match[5] && match[5] !== 'Z' && (+match[5].slice(1, 3) > 23 || +match[5].slice(4) > 59))
    throw new JotError('INVALID_INPUT', '时间格式不对，请使用有效日期或时刻')
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) throw new JotError('INVALID_INPUT', '时间格式不对')
  return localIso(date)
}

/** 外部属性无效时不猜发生时间，事件按记录时间回退。 */
export function optionalActivityTime(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  try { return activityTime(value) } catch { return undefined }
}

export function activityDay(value: string): string {
  return isCalendarDay(value) ? value : localDay(value)
}

export function activityRange(startRaw: string, endRaw: string): { start: string; end: string } {
  const start = activityTime(startRaw)
  const end = activityTime(endRaw)
  if (isCalendarDay(start) !== isCalendarDay(end)) throw new JotError('INVALID_INPUT', '起止时间须使用相同精度')
  if (isCalendarDay(start) ? end < start : Date.parse(end) < Date.parse(start)) throw new JotError('INVALID_INPUT', '结束时间不能早于开始时间')
  return { start, end }
}
