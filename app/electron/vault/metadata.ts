import fs from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'
import { JotError } from '@shared/result'
import { writeFileAtomic } from '../util/fs'
import { activityRange, isCalendarDay, optionalActivityTime } from '../util/time'
import { isMarkdown } from './doc'
import { parseDoc, stringifyDoc } from './frontmatter'

export const SIDECAR_SUFFIX = '.meta.yaml'
export const isSidecar = (rel: string): boolean => rel.toLowerCase().endsWith(SIDECAR_SUFFIX)
export const sidecarPath = (rel: string): string => rel + SIDECAR_SUFFIX
export const ownerPath = (rel: string): string => isSidecar(rel) ? rel.slice(0, -SIDECAR_SUFFIX.length) : rel

export interface FileProperties {
  data: Record<string, unknown>
  attachment: boolean
  invalid: boolean
  sidecar: { mtimeMs: number; size: number } | null
}

function mapping(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('属性必须是 YAML 对象')
  return value as Record<string, unknown>
}

/** 文件属性只保存在 frontmatter 或同目录附属文件中，不登记身份或版本。 */
export class MetadataService {
  constructor(private readonly abs: (rel: string) => string) {}

  /** 用途判断只读取附属文件；无 ID 的普通 Markdown 始终可以直接使用。 */
  isAttachment(rel: string): boolean {
    if (!isMarkdown(rel)) return true
    try {
      return mapping(yaml.load(fs.readFileSync(this.abs(sidecarPath(rel)), 'utf8'), { schema: yaml.JSON_SCHEMA })).kind === 'attachment'
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      // 无效附属文件仍按资料打开，防止原件头部伪装成日总结；修改属性时明确报错。
      return true
    }
  }

  async read(rel: string, text?: string): Promise<FileProperties> {
    const attached = sidecarPath(rel)
    const stat = await fs.promises.stat(this.abs(attached)).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    })
    let sideData: Record<string, unknown> = {}
    let invalid = false
    if (stat) {
      try {
        if (!stat.isFile()) throw new Error('附属属性不是文件')
        sideData = mapping(yaml.load(await fs.promises.readFile(this.abs(attached), 'utf8'), { schema: yaml.JSON_SCHEMA }))
      } catch { invalid = true }
    }
    const attachment = !isMarkdown(rel) || !!stat && (invalid || sideData.kind === 'attachment')
    if (attachment) return { data: sideData, attachment: true, invalid, sidecar: stat ? { mtimeMs: stat.mtimeMs, size: stat.size } : null }
    const parsed = parseDoc(text ?? await fs.promises.readFile(this.abs(rel), 'utf8'))
    return { data: parsed.data, attachment: false, invalid: parsed.invalid, sidecar: stat ? { mtimeMs: stat.mtimeMs, size: stat.size } : null }
  }

  async patch(rel: string, patch: Record<string, unknown>): Promise<void> {
    const properties = await this.read(rel)
    if (properties.invalid) throw new JotError('INVALID_INPUT', '属性不是合法的 YAML 对象，请先手动修正：' + rel)
    const data = { ...properties.data }
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue
      if (value === null) delete data[key]
      else data[key] = value
    }
    validateProperties(data)
    if (properties.attachment) {
      data.kind = 'attachment'
      await writeFileAtomic(this.abs(sidecarPath(rel)), yaml.dump(data, { schema: yaml.JSON_SCHEMA, lineWidth: -1, flowLevel: 1, noRefs: true }))
    } else {
      const raw = await fs.promises.readFile(this.abs(rel), 'utf8')
      const current = parseDoc(raw)
      if (current.invalid) throw new JotError('INVALID_INPUT', '请先修正文件头：' + rel)
      await writeFileAtomic(this.abs(rel), stringifyDoc(data, current.body))
    }
  }

  /** 显式导入时才写入用途和入库时间；原件字节不改动。 */
  async markImported(rel: string, created: string): Promise<void> {
    await writeFileAtomic(this.abs(sidecarPath(rel)), yaml.dump({ kind: 'attachment', created }, { schema: yaml.JSON_SCHEMA }))
  }
}

export function validateProperties(data: Record<string, unknown>): void {
  for (const key of ['tags', 'people'] as const) {
    if (data[key] !== undefined && (!Array.isArray(data[key]) || (data[key] as unknown[]).some(value => typeof value !== 'string'))) {
      throw new JotError('INVALID_INPUT', key + ' 必须是字符串数组')
    }
  }
  if (typeof data.source === 'string' && !data.source.startsWith('[[') && data.type === 'source-summary') {
    const value = data.source
    if (!value || path.posix.isAbsolute(value) || /^[a-z]:/i.test(value) || value.includes('\\') || value.split('/').includes('..') || value === '.jot' || value.startsWith('.jot/')) {
      throw new JotError('INVALID_INPUT', '来源必须是库根相对路径')
    }
  }
  if (data.occurred_at !== undefined && !optionalActivityTime(data.occurred_at)) throw new JotError('INVALID_INPUT', '发生日期无效')
  if (typeof data.occurred_at === 'string' && data.occurred_at.length === 10 && !isCalendarDay(data.occurred_at)) throw new JotError('INVALID_INPUT', '发生日期无效')
  if (data.start !== undefined || data.end !== undefined) activityRange(String(data.start ?? ''), String(data.end ?? ''))
}
