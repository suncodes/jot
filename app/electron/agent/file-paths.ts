import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { JotError } from '@shared/result'
import type { VaultService } from '../vault/vault'
import { isSidecar } from '../vault/metadata'

export interface FileLocation {
  absolute: string
  /** 库内使用相对路径；库外使用绝对路径。 */
  path: string
  relative?: string
}
export const samePath = (a: string, b: string) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
export function insidePath(file: string, directory: string): boolean {
  const relative = path.relative(directory, file)
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)
}

/** 解析已存在的祖先，统一符号链接／junction 与真实路径的身份；也适用于新建目标。 */
function physicalPath(absolute: string): string {
  let ancestor = absolute
  const tail: string[] = []
  while (!fs.existsSync(ancestor)) {
    const parent = path.dirname(ancestor)
    if (parent === ancestor) return absolute
    tail.unshift(path.basename(ancestor)); ancestor = parent
  }
  return path.join(fs.realpathSync(ancestor), ...tail)
}

/** 文件工具共用解析器；不改变库服务自身的相对路径边界。 */
export function resolveFile(vault: VaultService, raw: string, sidecar = false): FileLocation {
  if (typeof raw !== 'string' || raw.includes('\0')) throw new JotError('INVALID_INPUT', '文件路径无效')
  const value = (/^file:/i.test(raw) ? fileURLToPath(raw) : raw).replace(/\\/g, '/')
  if (/^[a-z]:[^/]/i.test(value) || /^[a-z]:$/i.test(value)) throw new JotError('INVALID_INPUT', '请使用完整绝对路径')
  const root = physicalPath(path.resolve(vault.path))
  const resolved = path.resolve(root, value || '.')
  if (!path.isAbsolute(value) && !insidePath(resolved, root)) throw new JotError('INVALID_INPUT', '访问库外文件请使用绝对路径')
  const absolute = physicalPath(resolved)
  const relative = insidePath(absolute, root) ? path.relative(root, absolute).split(path.sep).join('/') : undefined
  if (relative !== undefined && (/^\.jot(?:\/|$)/i.test(relative) || !sidecar && isSidecar(relative))) {
    throw new JotError('WRITE_DENIED', '软件数据和附属属性请通过专用管理操作访问')
  }
  return { absolute, path: relative ?? absolute.split(path.sep).join('/'), relative }
}

export function indexedPath(location: FileLocation): string | undefined {
  const rel = location.relative
  return rel && /^(ideas|content|inbox|wiki|journal)(\/|$)/.test(rel) && !rel.split('/').some(part => part.startsWith('.')) && !isSidecar(rel) ? rel : undefined
}

/** 固定内容根及包含当前笔记库的目录不能被通用移动／删除。 */
export function assertMovable(vault: VaultService, location: FileLocation): void {
  const root = physicalPath(path.resolve(vault.path))
  if (samePath(path.dirname(location.absolute), location.absolute) || insidePath(root, location.absolute)
    || location.relative !== undefined && /^(ideas|content|inbox|wiki|journal|templates)$/.test(location.relative)) {
    throw new JotError('WRITE_DENIED', '不能移动或回收磁盘根、当前笔记库或固定根目录')
  }
}
