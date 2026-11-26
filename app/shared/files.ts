/** 文件与目录的当前路径契约；不保存永久身份和历史路径。 */
export interface PathChange { from: string; to: string }
export interface MoveResult {
  path: string
  paths: PathChange[]
  notUpdated: { path: string; message: string }[]
}
export interface DirectoryItem { path: string; name: string; hasChildren: boolean }
export interface LibraryPin { path: string; kind: 'file' | 'folder'; missing: boolean }
export interface PropertyDocument {
  path: string
  data: Record<string, unknown>
  attachment: boolean
  invalid: boolean
}
export interface FileLink {
  from: string
  target: string
  path?: string
  kind: 'markdown' | 'wiki' | 'source'
  missing: boolean
  ambiguous?: string[]
}

export interface BatchResult { affected: number; updated: string[]; failed: { path: string; message: string }[] }

/** 仅使用本次操作返回的路径映射。 */
export function mappedPath(rel: string, changes: PathChange[]): string {
  const lower = (value: string) => value.toLocaleLowerCase()
  const found = changes.find(change => lower(rel) === lower(change.from))
    ?? changes.filter(change => lower(rel).startsWith(lower(change.from) + '/')).sort((a, b) => b.from.length - a.from.length)[0]
  return found ? found.to + rel.slice(found.from.length) : rel
}
