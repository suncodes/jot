import path from 'node:path'
import fs from 'node:fs'
import { JotError } from '@shared/result'

/** 系统内容按给定本地日期分月；只决定新文件落点，不搬动已有文件。 */
export function monthlyPath(root: string, date: string): string {
  return `${root}/${date.slice(0, 4)}/${date.slice(5, 7)}`
}

/** 新库的固定目录；正式笔记和原件统一位于 content/。 */
export const DIRS = {
  ideas: 'ideas',
  content: 'content',
  inbox: 'inbox',
  journal: 'journal',
  wiki: 'wiki',
  wikiSources: 'wiki/sources',
  templates: 'templates',
  meta: '.jot',
  skills: '.jot/skills',
  plugins: '.jot/plugins',
  appExtensions: '.jot/app-extensions',
  trash: '.jot/trash',
} as const

/** 只创建新结构；旧目录不会因打开库而被补回。 */
export const FIXED_DIRS: readonly string[] = [
  DIRS.ideas,
  DIRS.content,
  DIRS.inbox,
  DIRS.journal,
  DIRS.wikiSources,
  DIRS.templates,
  DIRS.meta,
  DIRS.skills,
  DIRS.plugins,
  DIRS.appExtensions,
  DIRS.trash,
]

/** 把任意写法的相对路径规范成用正斜杠分隔的库内相对路径 */
export function normalizeRel(rel: string): string {
  const cleaned = path.posix.normalize(rel.replace(/\\/g, '/')).replace(/^\/+/, '').replace(/\/+$/, '')
  return cleaned === '.' ? '' : cleaned
}

/** 把库内相对路径解析成绝对路径；越出库的范围时抛出 PATH_OUTSIDE_VAULT */
export function resolveInVault(root: string, rel: string): string {
  const normalized = normalizeRel(rel)
  if ((normalized === '..' || normalized.startsWith('../')) || path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel)) {
    throw new JotError('PATH_OUTSIDE_VAULT', `路径不在库内：${rel}`)
  }
  const abs = path.resolve(root, normalized)
  const relBack = path.relative(root, abs)
  if (relBack.startsWith('..') || path.isAbsolute(relBack)) {
    throw new JotError('PATH_OUTSIDE_VAULT', `路径不在库内：${rel}`)
  }
  let ancestor = abs
  while (!fs.existsSync(ancestor) && path.dirname(ancestor) !== ancestor) ancestor = path.dirname(ancestor)
  if (fs.existsSync(root) && fs.existsSync(ancestor)) {
    const actualRoot = fs.realpathSync(root)
    const actualAncestor = fs.realpathSync(ancestor)
    const actualRelative = path.relative(actualRoot, actualAncestor)
    if (actualRelative === '..' || actualRelative.startsWith('..' + path.sep) || path.isAbsolute(actualRelative)) {
      throw new JotError('PATH_OUTSIDE_VAULT', '符号链接指向库外：' + rel)
    }
  }
  return abs
}

/** 绝对路径转成库内相对路径（正斜杠） */
export function toRel(root: string, abs: string): string {
  return path.relative(root, abs).split(path.sep).join('/')
}

export function isInContent(rel: string): boolean {
  const n = normalizeRel(rel)
  return n === DIRS.content || n.startsWith(DIRS.content + '/')
}

export function isInInbox(rel: string): boolean {
  const n = normalizeRel(rel)
  return n === DIRS.inbox || n.startsWith(DIRS.inbox + '/')
}

export function isInUserContent(rel: string): boolean {
  return isInContent(rel) || isInInbox(rel) || normalizeRel(rel) === DIRS.ideas || normalizeRel(rel).startsWith(DIRS.ideas + '/')
}

export function isInMeta(rel: string): boolean {
  const n = normalizeRel(rel).toLowerCase()
  return n === DIRS.meta || n.startsWith(DIRS.meta + '/')
}

export function isInTemplates(rel: string): boolean {
  const normalized = normalizeRel(rel).toLowerCase()
  return normalized === DIRS.templates || normalized.startsWith(DIRS.templates + '/')
}
