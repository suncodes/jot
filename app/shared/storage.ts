/** 集合由实际物理路径决定；索引和应用状态不承担文件归属。 */
export type ContentCollection = 'all' | 'ideas' | 'pending'
export type ContentRole = 'record' | 'note' | 'source' | 'derived'
export interface ContentScope {
  selection: { kind: 'collection'; name: ContentCollection } | { kind: 'directory'; path: string; recursive: boolean }
  roles?: ContentRole[]
  time?: { basis: 'occurred' | 'recorded' | 'edited' | 'imported'; from: string; to: string }
}

/** 大小写与分隔符不影响根目录职责；不访问数据库或要求 frontmatter。 */
export function contentArea(rel: string): 'ideas' | 'inbox' | 'content' | null {
  const root = rel.replace(/\\/g, '/').split('/')[0]?.toLowerCase()
  return root === 'ideas' || root === 'inbox' || root === 'content' ? root : null
}

export interface StorageChange {
  paths: string[]
  moves?: import('./files').PathChange[]
  kind: 'metadata' | 'generation' | 'path'
}
