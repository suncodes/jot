import { call } from '@/api'

interface PendingEditor { path: () => string; flush: () => Promise<void> }
const editors = new Set<PendingEditor>()

/** 即使编辑页藏在其他标签页中，文件操作前也先保存并检查冲突。 */
export function registerPendingEditor(path: () => string, flush: () => Promise<void>): () => void {
  const editor = { path, flush }
  editors.add(editor)
  return () => { editors.delete(editor) }
}

export async function prepareContentAction(path?: string): Promise<void> {
  let paths: Set<string> | undefined
  let sourcePath: string | undefined
  if (path) {
    const item = await call('library:resolve', { path })
    paths = new Set([path, item?.path ?? '', item?.summaryPath ?? ''])
    if (item?.kind === 'file') sourcePath = item.path
  }
  for (const editor of editors) {
    if (!paths || paths.has(editor.path())) await editor.flush()
    else if (sourcePath && (await call('library:resolve', { path: editor.path() }))?.path === sourcePath) await editor.flush()
  }
}
