<script setup lang="ts">
import { autocompletion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { search, searchKeymap } from '@codemirror/search'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap, lineNumbers, placeholder } from '@codemirror/view'
import { tags } from '@lezer/highlight'
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { call } from '@/api'

// 源码编辑器（CodeMirror 6）：Markdown 语法着色，输入 [[ 时提示库里的文件名。
const props = defineProps<{ modelValue: string; plain?: boolean; readOnly?: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [value: string] }>()
const host = ref<HTMLDivElement | null>(null)
let view: EditorView | null = null

const theme = EditorView.theme({
  '&': { height: '100%', fontSize: 'var(--font-size-text)', color: 'var(--text-normal)', backgroundColor: 'transparent' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.6', overflow: 'auto' },
  '.cm-content': { padding: '16px 0', caretColor: 'var(--accent)', maxWidth: 'var(--line-width)', margin: '0 auto' },
  '.cm-line': { padding: '0 24px' },
  '.cm-cursor': { borderLeftColor: 'var(--accent)' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: 'var(--accent-soft)' },
  '.cm-tooltip': { background: 'var(--bg-primary)', border: '1px solid var(--border)', borderRadius: 'var(--radius-m)', boxShadow: 'var(--shadow)' },
  '.cm-tooltip-autocomplete ul li[aria-selected]': { background: 'var(--bg-active)', color: 'var(--text-normal)' },
  '.cm-placeholder': { color: 'var(--text-faint)' },
  '.cm-panels': { border: 'none', background: 'transparent' },
  '.cm-searchMatch': { backgroundColor: 'var(--accent-soft)', outline: 'none' },
  '.cm-searchMatch-selected': { backgroundColor: 'var(--accent)', color: 'var(--on-accent)' },
})

const highlight = HighlightStyle.define([
  { tag: tags.heading, fontWeight: '600', color: 'var(--text-normal)' },
  { tag: tags.strong, fontWeight: '600' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { tag: [tags.link, tags.url], color: 'var(--accent)' },
  { tag: tags.monospace, color: 'var(--text-muted)' },
  { tag: tags.quote, color: 'var(--text-muted)' },
  { tag: [tags.processingInstruction, tags.meta, tags.contentSeparator], color: 'var(--text-faint)' },
])

async function wikilinks(ctx: CompletionContext): Promise<CompletionResult | null> {
  const m = ctx.matchBefore(/\[\[[^\]\n]*/)
  if (!m) return null
  const docs = await call('doc:quickOpen', { query: m.text.slice(2), limit: 12 })
  return {
    from: m.from + 2,
    filter: false,
    options: docs.map((d) => ({ label: d.path.replace(/\.(md|markdown)$/i, '').split('/').pop()!, detail: d.path, apply: `${d.path.replace(/\.(md|markdown)$/i, '')}]]` })),
  }
}

onMounted(() => {
  view = new EditorView({
    parent: host.value!,
    state: EditorState.create({
      doc: props.modelValue,
      extensions: [
        history(),
        EditorState.readOnly.of(!!props.readOnly),
        EditorView.editable.of(!props.readOnly),
        EditorView.contentAttributes.of({ tabindex: '0' }),
        ...(props.readOnly ? [lineNumbers()] : []),
        keymap.of([...searchKeymap.filter((binding) => !['Mod-f', 'Mod-h', 'F3', 'Mod-g', 'Escape'].includes(binding.key ?? '')), ...defaultKeymap, ...historyKeymap]),
        // 搜索 UI 由左侧共享工作区渲染；编辑器只提供搜索状态和高亮。
        search({ top: true, createPanel: () => { const dom = document.createElement('div'); dom.hidden = true; return { dom } } }),
        EditorView.lineWrapping,
        ...(props.plain ? [] : [markdown(), syntaxHighlighting(highlight), autocompletion({ override: [wikilinks] })]),
        placeholder(''),
        theme,
        EditorView.updateListener.of((u) => {
          if (u.docChanged) emit('update:modelValue', u.state.doc.toString())
        }),
      ],
    }),
  })
  if (!props.readOnly) view.focus()
})

// 外部换了内容（重新加载）时同步进编辑器
watch(
  () => props.modelValue,
  (value) => {
    if (view && value !== view.state.doc.toString()) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } })
    }
  },
)

onBeforeUnmount(() => view?.destroy())

defineExpose({
  /** 滚动到正文的第几行（从 1 开始）并把光标放过去 */
  gotoLine(line: number) {
    if (!view) return
    const l = view.state.doc.line(Math.min(Math.max(line, 1), view.state.doc.lines))
    view.dispatch({ selection: { anchor: l.from }, effects: EditorView.scrollIntoView(l.from, { y: 'center' }) })
  },
  focus: () => view?.focus(),
})
</script>

<template>
  <div ref="host" class="cm-host selectable" data-testid="editor" />
</template>

<style scoped>
.cm-host {
  height: 100%;
  min-height: 0;
}
</style>
