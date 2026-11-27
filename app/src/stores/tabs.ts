import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { invoke } from '@/api'
import { useAppStore } from './app'
import { useToastsStore } from './toasts'
import { prepareContentAction } from '@/utils/pendingEdits'

/** 不对应文件的特殊标签页用这种路径 */
export const LIBRARY_TAB = 'jot://library'
export const REVIEW_TAB = 'jot://review'
export const ARCHIVE_TAB = 'jot://archive'
export const TODAY_TAB = 'jot://today'
export const TRASH_TAB = 'jot://trash'
export const CAPABILITIES_TAB = 'jot://capabilities'
export const TAXONOMY_TAB = 'jot://taxonomy'

export interface Tab {
  /** 仅在本次界面中标识标签页，移动文件时保留编辑组件。 */
  key: string
  path: string
  title: string
  /** 打开后要定位到的文件行号；每次定位后加一，同一行也能再次触发 */
  line?: number
  lineTick: number
  reader?: 'summary' | 'source'
  startEditing?: boolean
}

const titleOf = (path: string) => path.split('/').pop()!.replace(/\.(md|markdown)$/i, '')

/** 内容区的标签页。同一个文件不重复打开。 */
export const useTabsStore = defineStore('tabs', () => {
  const tabs = ref<Tab[]>([])
  const activePath = ref<string | null>(null)
  /** 要展开属性面板的文件（在“待整理”里点了“修改”） */
  const editProps = ref<string | null>(null)
  const active = computed(() => tabs.value.find((t) => t.path === activePath.value) ?? null)

  /** 单击：在当前标签页打开（替换）；newTab 为 true：在新标签页打开 */
  async function open(path: string, opts: { newTab?: boolean; line?: number; title?: string; reader?: 'summary' | 'source'; startEditing?: boolean } = {}): Promise<void> {
    if (!path.startsWith('jot://')) {
      const resolved = await invoke('library:resolve', { path })
      if (resolved.ok && resolved.data?.kind === 'file') {
        if (opts.line) opts.reader = path === resolved.data.summaryPath ? 'summary' : 'source'
        path = resolved.data.path
        opts.title = resolved.data.title
      }
    }
    const existing = tabs.value.find((t) => t.path === path)
    if (existing) {
      useAppStore().showSettings = false
      if (opts.startEditing) existing.startEditing = true
      existing.reader = opts.reader
      existing.line = opts.line
      existing.lineTick++
      activePath.value = existing.path
      return
    }
    const replacing = !opts.newTab ? activePath.value : null
    if (replacing && replacing !== path) {
      try { await prepareContentAction(replacing) }
      catch (e) { useToastsStore().error((e as Error).message); return }
      // 保存期间用户已切换标签时，取消旧的替换请求。
      if (activePath.value !== replacing) return
    }
    useAppStore().showSettings = false
    const tab: Tab = { key: crypto.randomUUID(), path, title: opts.title ?? titleOf(path), line: opts.line, lineTick: 0, reader: opts.reader, startEditing: opts.startEditing }
    const i = tabs.value.findIndex((t) => t.path === activePath.value)
    if (opts.newTab || i < 0) tabs.value.splice(i + 1, 0, tab)
    else tabs.value.splice(i, 1, tab)
    activePath.value = path
  }

  const closing = new Set<string>()
  async function close(path: string): Promise<void> {
    if (closing.has(path)) return
    closing.add(path)
    try {
      await prepareContentAction(path)
      const i = tabs.value.findIndex((t) => t.path === path)
      if (i < 0) return
      tabs.value.splice(i, 1)
      if (activePath.value === path) activePath.value = (tabs.value[i] ?? tabs.value[i - 1])?.path ?? null
    } catch (e) { useToastsStore().error((e as Error).message) }
    finally { closing.delete(path) }
  }

  const batchClosing = ref(false)
  async function closeRelative(path: string, side: 'others' | 'left' | 'right'): Promise<void> {
    if (batchClosing.value) return
    const index = tabs.value.findIndex(tab => tab.path === path), anchor = tabs.value[index]
    if (!anchor) return
    const targets = tabs.value.filter((_tab, position) => side === 'others' ? position !== index : side === 'left' ? position < index : position > index)
      .map(tab => ({ key: tab.key, path: tab.path }))
    if (!targets.length) return
    batchClosing.value = true
    try {
      // 全部保存成功后才移除标签；任何冲突保留原标签，避免部分关闭。
      for (const tab of targets) await prepareContentAction(tab.path)
      if (!tabs.value.some(tab => tab.key === anchor.key) || targets.some(target => tabs.value.find(tab => tab.key === target.key)?.path !== target.path)) return
      const keys = new Set(targets.map(tab => tab.key))
      const activeClosed = tabs.value.some(tab => tab.path === activePath.value && keys.has(tab.key))
      tabs.value = tabs.value.filter(tab => !keys.has(tab.key))
      if (activeClosed) activePath.value = anchor.path
    } catch (error) { useToastsStore().error((error as Error).message) }
    finally { batchClosing.value = false }
  }
  function cycle(step: 1 | -1): void {
    if (tabs.value.length < 2) return
    const i = tabs.value.findIndex((t) => t.path === activePath.value)
    activePath.value = tabs.value[(i + step + tabs.value.length) % tabs.value.length]!.path
  }

  function move(from: number, to: number): void {
    const [tab] = tabs.value.splice(from, 1)
    if (tab) tabs.value.splice(to, 0, tab)
  }

  /** 文件改名或移动后，标签页跟着换路径 */
  function retarget(oldPath: string, newPath: string): void {
    const tab = tabs.value.find((t) => t.path === oldPath)
    if (!tab || oldPath === newPath || oldPath.startsWith('jot://')) return
    tab.path = newPath
    tab.title = titleOf(newPath)
    if (activePath.value === oldPath) activePath.value = newPath
  }

  function setTitle(path: string, title: string): void {
    const tab = tabs.value.find((t) => t.path === path)
    if (tab && title) tab.title = title
  }

  return { tabs, activePath, active, editProps, open, close, closeRelative, batchClosing, cycle, move, retarget, setTitle }
})
