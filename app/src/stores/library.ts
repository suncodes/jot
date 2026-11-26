import { defineStore } from 'pinia'
import { computed, reactive, ref, watch } from 'vue'
import type { FileState, LibraryKind, LibraryQuery } from '@shared/types'
import type { ContentCollection } from '@shared/storage'
import { mappedPath, type DirectoryItem, type PathChange } from '@shared/files'
import { call } from '@/api'
import { LIBRARY_TAB, useTabsStore } from './tabs'
import { useAppStore } from './app'
import { useToastsStore } from './toasts'
import { t } from '@/strings'

export type LibraryScope = { collection: ContentCollection; directoryPath?: never } | { directoryPath: string; collection?: never }
const scopeKey = (scope: LibraryScope) => scope.directoryPath ? 'directory:' + scope.directoryPath : 'collection:' + scope.collection
const initialView = (scope: LibraryScope) => ({
  filters: { kind: '' as LibraryKind | '', text: '', sort: (scope.collection === 'ideas' ? 'created' : 'updated') as NonNullable<LibraryQuery['sort']>, fileState: '' as FileState | '', month: '', tag: '', page: 1 },
  scrollTop: 0,
})
/** content 是隐藏根；各逻辑入口与实际目录只在本次打开的库内记住列表状态。 */
export const useLibraryStore = defineStore('library', () => {
  const scope = ref<LibraryScope>({ collection: 'all' })
  const view = ref(initialView(scope.value))
  const remembered = new Map<string, ReturnType<typeof initialView>>()
  let restoring = false
  const filters = computed(() => view.value.filters)
  const scrollTop = computed({ get: () => view.value.scrollTop, set: (value: number) => { view.value.scrollTop = value } })
  const directories = reactive<Record<string, DirectoryItem[]>>({})
  const expanded = reactive(new Set<string>())
  const all = ref<DirectoryItem[]>([])
  const current = computed(() => all.value.find(d => d.path === scope.value.directoryPath) ?? null)
  const ancestors = computed(() => current.value ? all.value.filter(d => current.value!.path.startsWith(d.path + '/')).sort((a, b) => a.path.length - b.path.length) : [])
  const roots = computed(() => directories.root ?? [])
  const children = computed(() => scope.value.directoryPath ? directories[scope.value.directoryPath] ?? [] : [])
  const title = computed(() => scope.value.directoryPath ? current.value?.name ?? t.directory.unavailable : t.library[scope.value.collection!])
  const unavailable = computed(() => !!scope.value.directoryPath && !current.value)
  watch(() => [filters.value.kind, filters.value.text, filters.value.sort, filters.value.fileState, filters.value.month, filters.value.tag], () => {
    if (!restoring) { filters.value.page = 1; scrollTop.value = 0 }
  }, { flush: 'sync' })
  watch(() => useAppStore().vault.path, () => {
    restoring = true
    remembered.clear()
    scope.value = { collection: 'all' }
    view.value = initialView(scope.value)
    all.value = []
    for (const key of Object.keys(directories)) delete directories[key]
    expanded.clear()
    sequence++
    restoring = false
  })
  let sequence = 0
  async function refresh(): Promise<void> {
    const request = ++sequence
    const result = await call('content:directories', { recursive: true })
    if (request !== sequence) return
    all.value = result
    for (const key of Object.keys(directories)) delete directories[key]
    for (const dir of result) {
      const parent = dir.path.split('/').slice(0, -1).join('/')
      const key = parent === 'content' ? 'root' : parent
      ;(directories[key] ??= []).push(dir)
    }
    for (const path of [...expanded]) if (!result.some(dir => dir.path === path)) expanded.delete(path)
  }
  async function loadChildren(): Promise<void> { await refresh() }
  function toggle(path: string): void {
    if (expanded.has(path)) expanded.delete(path)
    else expanded.add(path)
  }
  function branches(path?: string): DirectoryItem[] {
    return all.value.filter(dir => dir.hasChildren && (!path || dir.path === path || dir.path.startsWith(path + '/')))
  }
  function branchExpanded(path?: string): boolean {
    const items = branches(path)
    return items.length > 0 && items.every(dir => expanded.has(dir.path))
  }
  function toggleBranch(path?: string): void {
    const items = branches(path)
    const collapse = branchExpanded(path)
    if (collapse) {
      for (const expandedPath of [...expanded]) if (!path || expandedPath === path || expandedPath.startsWith(path + '/')) expanded.delete(expandedPath)
    } else for (const dir of items) expanded.add(dir.path)
  }
  const canExpand = computed(() => all.value.some(dir => dir.hasChildren))
  function revealDirectory(path: string): void {
    for (const dir of all.value) if (path.startsWith(dir.path + '/')) expanded.add(dir.path)
  }
  function locationFor(path: string | null): LibraryScope | null {
    if (!path) return null
    if (path.startsWith('ideas/')) return { collection: 'ideas' }
    if (path.startsWith('inbox/')) return { collection: 'pending' }
    if (!path.startsWith('content/')) return null
    const parent = path.split('/').slice(0, -1).join('/')
    if (parent === 'content') return { collection: 'all' }
    return all.value.some(dir => dir.path === parent) ? { directoryPath: parent } : null
  }
  function applyMoves(changes: PathChange[]): void {
    if (scope.value.directoryPath) scope.value = { directoryPath: mappedPath(scope.value.directoryPath, changes) }
    for (const [key, state] of [...remembered]) if (key.startsWith('directory:')) {
      const next = 'directory:' + mappedPath(key.slice(10), changes)
      if (next !== key) { remembered.delete(key); remembered.set(next, state) }
    }
    const paths = [...expanded].map(path => mappedPath(path, changes))
    expanded.clear(); paths.forEach(path => expanded.add(path))
  }
  function clearFilters(): void {
    Object.assign(filters.value, initialView(scope.value).filters)
    scrollTop.value = 0
  }
  function select(next: LibraryScope): void {
    if (next.directoryPath) revealDirectory(next.directoryPath)
    if (scopeKey(next) !== scopeKey(scope.value)) {
      remembered.set(scopeKey(scope.value), view.value)
      restoring = true
      scope.value = next
      view.value = remembered.get(scopeKey(next)) ?? initialView(next)
      restoring = false
      void refresh().catch(e => useToastsStore().error((e as Error).message))
    }
    void useTabsStore().open(LIBRARY_TAB, { newTab: true, title: t.library.title })
  }
  return { scope, directories, expanded, roots, children, current, ancestors, unavailable, filters, scrollTop, title, loadChildren, refresh, select, toggle, canExpand, branchExpanded, toggleBranch, revealDirectory, locationFor, applyMoves, clearFilters }
})
