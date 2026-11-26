import { closeSearchPanel, getSearchQuery, openSearchPanel, searchPanelOpen, SearchQuery, setSearchQuery } from '@codemirror/search'
import { EditorView } from '@codemirror/view'
import { computed, nextTick, onBeforeUnmount, onMounted, readonly, ref, shallowRef, watch, type Ref } from 'vue'
import { editorAt } from '@/utils/textActions'
import { t } from '@/strings'

export interface DocumentMatch {
  from: number
  to: number
  snippet: string
  highlights: [number, number][]
  line: number
}

/** 当前正文的只读查找控制器，阅读和编辑共用定位、结果片段及生命周期。 */
export function useDocumentSearch(query: Ref<string>, enabled: Ref<boolean>, documentKey: Ref<string | null>) {
  const matches = shallowRef<DocumentMatch[]>([])
  const current = ref(-1)
  const title = ref('')
  const available = ref(false)
  const documentChanged = ref(false)
  let sourceKey = documentKey.value
  let root: HTMLElement | null = null
  let pinnedRoot: HTMLElement | null = null
  let pinnedTarget: HTMLElement | null = null
  let editor: EditorView | null = null
  let ranges: Range[] = []
  let observer: MutationObserver | undefined
  let frame = 0
  let signature = ''

  const visible = (element: HTMLElement | null | undefined): element is HTMLElement =>
    !!element?.isConnected && element.getClientRects().length > 0

  function clearHighlights(): void {
    CSS.highlights.delete('jot-find')
    CSS.highlights.delete('jot-find-current')
  }
  function releaseEditor(): void {
    if (editor?.dom.isConnected) closeSearchPanel(editor)
    editor = null
  }
  function paint(): void {
    clearHighlights()
    if (ranges.length) CSS.highlights.set('jot-find', new Highlight(...ranges))
    const range = ranges[current.value]
    if (range) CSS.highlights.set('jot-find-current', new Highlight(range))
  }
  function reset(): void {
    releaseEditor()
    clearHighlights()
    matches.value = []
    ranges = []
    current.value = -1
    signature = ''
    available.value = false
  }
  function resolve(): HTMLElement | null {
    if (pinnedRoot && !visible(pinnedRoot)) {
      pinnedRoot = null
      pinnedTarget = null
    }
    root = pinnedRoot ?? [...document.querySelectorAll<HTMLElement>('[data-testid="content"] [data-find-scope]')]
      .find((el) => visible(el) && el.dataset.findActive !== 'false') ?? null
    title.value = root?.dataset.findTitle ?? t.search.current
    if (!root) return null
    if (root instanceof HTMLInputElement || root instanceof HTMLTextAreaElement) return root
    return [...root.querySelectorAll<HTMLElement>('[data-find-target]')].find(visible)
      ?? (visible(pinnedTarget) ? pinnedTarget : null)
      ?? null
  }
  function refresh(): void {
    if (!enabled.value || documentChanged.value) return
    const target = resolve()
    const nextEditor = target ? editorAt(target) : null
    if (editor !== nextEditor) { releaseEditor(); clearHighlights(); editor = nextEditor }
    available.value = !!target
    if (!target || !query.value) { reset(); available.value = !!target; return }

    // 阅读使用同一段连续文本计算偏移，粗体、链接等内联节点不会截断关键词。
    const nodes: { node: Text; start: number; end: number }[] = []
    let source = ''
    if (editor) source = editor.state.doc.toString()
    else if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) source = target.value
    else {
      const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT)
      let block: Element | null = null
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const parent = node.parentElement
        if (parent?.closest('script, style, [hidden], [aria-hidden="true"]')) continue
        const nextBlock = parent?.closest('p, h1, h2, h3, h4, h5, h6, li, pre, td, th') ?? null
        if (block && nextBlock !== block) source += '\n'
        block = nextBlock
        const start = source.length
        source += node.textContent ?? ''
        nodes.push({ node: node as Text, start, end: source.length })
      }
    }

    const nextSignature = query.value + '\0' + source
    const changed = nextSignature !== signature
    signature = nextSignature
    const needle = query.value.replace(/[.*+?^\${}()|[\]\\]/g, '\\$&')
    const regex = new RegExp(needle, 'giu')
    const found: DocumentMatch[] = []
    const nextRanges: Range[] = []
    let line = 1
    let lastFrom = 0
    for (const result of source.matchAll(regex)) {
      const from = result.index
      const to = from + result[0].length
      if (nodes.length) {
        const start = nodes.find((n) => n.end > from)
        const end = nodes.find((n) => n.end >= to)
        if (!start || !end) continue
        const range = document.createRange()
        range.setStart(start.node, from - start.start)
        range.setEnd(end.node, to - end.start)
        nextRanges.push(range)
      }
      line += source.slice(lastFrom, from).split('\n').length - 1
      lastFrom = from
      const start = Math.max(0, from - 48)
      const end = Math.min(source.length, to + 72)
      const prefix = start ? '…' : ''
      found.push({
        from, to, line,
        snippet: prefix + source.slice(start, end) + (end < source.length ? '…' : ''),
        highlights: [[from - start + prefix.length, to - start + prefix.length]],
      })
    }
    if (changed || found.length !== matches.value.length) matches.value = found
    ranges = nextRanges
    current.value = found.length ? (changed ? 0 : Math.min(Math.max(0, current.value), found.length - 1)) : -1
    if (editor) {
      // 只启用 CodeMirror 的高亮状态；不在正文渲染搜索栏。
      if (!searchPanelOpen(editor.state)) openSearchPanel(editor)
      const search = new SearchQuery({ search: query.value, literal: true })
      if (!getSearchQuery(editor.state).eq(search)) editor.dispatch({ effects: setSearchQuery.of(search) })
    } else paint()
  }
  function schedule(): void {
    cancelAnimationFrame(frame)
    frame = requestAnimationFrame(refresh)
  }
  function select(index: number): void {
    if (!enabled.value || !matches.value.length) return
    current.value = (index + matches.value.length) % matches.value.length
    const match = matches.value[current.value]!
    if (editor) {
      editor.dispatch({ selection: { anchor: match.from, head: match.to }, effects: EditorView.scrollIntoView(match.from, { y: 'center' }) })
    } else if (root instanceof HTMLInputElement || root instanceof HTMLTextAreaElement) {
      root.focus({ preventScroll: true })
      root.setSelectionRange(match.from, match.to)
    } else {
      paint()
      ranges[current.value]?.startContainer.parentElement?.scrollIntoView({ block: 'center' })
    }
  }
  function start(target?: HTMLElement): void {
    sourceKey = documentKey.value
    documentChanged.value = false
    pinnedRoot = target?.closest<HTMLElement>('[data-testid="file-view"]') ?? target?.closest<HTMLElement>('[data-find-scope]') ?? target ?? null
    pinnedTarget = target ?? null
    signature = ''
    void nextTick(refresh)
  }

  watch([query, enabled], () => {
    if (enabled.value) void nextTick(refresh)
    else reset()
  }, { flush: 'post' })
  watch(documentKey, (key) => {
    // 跨标签先暂停定位，显式选择新目标；返回原标签则恢复原正文。
    documentChanged.value = key !== sourceKey
    reset()
    if (enabled.value && !documentChanged.value) void nextTick(refresh)
  }, { flush: 'post' })

  onMounted(() => {
    // 仅观察正文和助手，避免搜索结果本身引发观察循环；编辑器输入也触发此观察。
    observer = new MutationObserver((changes) => {
      if (changes.some((change) => !(change.target as Element).parentElement?.closest('[data-testid="side-panel"]'))) schedule()
    })
    for (const element of document.querySelectorAll('[data-search-observer]')) {
      observer.observe(element, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['style', 'hidden', 'data-find-active', 'data-find-target'] })
    }
    document.addEventListener('input', schedule)
  })
  onBeforeUnmount(() => {
    observer?.disconnect()
    cancelAnimationFrame(frame)
    document.removeEventListener('input', schedule)
    reset()
  })

  return {
    matches: readonly(matches), current: readonly(current), title: readonly(title), available: readonly(available),
    documentChanged: readonly(documentChanged), count: computed(() => matches.value.length), refresh, select, move: (delta: number) => select(current.value + delta), start,
  }
}
