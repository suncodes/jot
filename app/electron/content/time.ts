import type { ContentScope } from '@shared/storage'
import type { DocMeta, TimelineEntry } from '@shared/types'
import { activityDay, optionalActivityTime } from '../util/time'

export interface DateCandidate { basis: TimelineEntry['basis']; time: string; end?: string }
/** 当前文件只能提供发生时间、创建时间和最后修改时间，不还原过去的修改记录。 */
export function dateCandidates(doc: DocMeta): DateCandidate[] {
  if (doc.type === 'daily' || doc.type === 'source-summary') return []
  const created = optionalActivityTime(doc.created)
  const occurred = optionalActivityTime(doc.occurredAt)
  const start = optionalActivityTime(doc.start)
  const end = optionalActivityTime(doc.end)
  if (doc.type === 'log') return start
    ? [{ basis: 'occurred', time: start, ...(end && activityDay(end) >= activityDay(start) ? { end } : {}) }]
    : created ? [{ basis: 'recorded', time: created }] : []
  if (doc.type === 'idea') return occurred ? [{ basis: 'occurred', time: occurred }] : created ? [{ basis: 'recorded', time: created }] : []
  const modified = optionalActivityTime(doc.modified)
  return [
    ...(occurred ? [{ basis: 'occurred' as const, time: occurred }] : []),
    ...(created ? [{ basis: 'created' as const, time: created }] : []),
    ...(modified && (!created || activityDay(modified) !== activityDay(created)) ? [{ basis: 'updated' as const, time: modified }] : []),
  ]
}
export function overlaps(candidate: DateCandidate, from: string, to: string): boolean {
  return activityDay(candidate.time) <= to && activityDay(candidate.end ?? candidate.time) >= from
}
/** 普通日期条件匹配当前发生／创建／最后修改候选，在合并、分页之前应用。 */
export function matchesDateRange(doc: DocMeta, from?: string, to?: string): boolean {
  if (!from && !to) return true
  const candidates = doc.type === 'daily' || doc.type === 'source-summary'
    ? [{ time: doc.created, basis: 'created' as const }] : dateCandidates(doc)
  return candidates.some(candidate => overlaps(candidate, from ?? '0001-01-01', to ?? '9999-12-31'))
}
export function matchesTime(doc: DocMeta, time: NonNullable<ContentScope['time']>): boolean {
  if (time.basis === 'occurred') return dateCandidates(doc).some(c => c.basis === 'occurred' && overlaps(c, time.from, time.to))
  const value = time.basis === 'edited' ? doc.modified : time.basis === 'imported' && doc.type !== 'file' ? '' : doc.created
  return !!value && overlaps({ time: value, basis: 'recorded' }, time.from, time.to)
}
