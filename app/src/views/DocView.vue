<script setup lang="ts">
import { Columns2, Eye, Pencil, Search } from 'lucide-vue-next'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch, watchEffect } from 'vue'
import type { Doc } from '@shared/types'
import { call, invoke, on } from '@/api'
import { registerPendingEditor } from '@/utils/pendingEdits'
import MarkdownEditor from '@/components/MarkdownEditor.vue'
import AppDialog from '@/components/AppDialog.vue'
import DocumentToolbar from '@/components/DocumentToolbar.vue'
import PropertyButton from '@/components/PropertyButton.vue'

import PropertyPanel from '@/components/PropertyPanel.vue'
import { renderMarkdown } from '@/markdown'
import { useTabsStore, type Tab } from '@/stores/tabs'
import { useToastsStore } from '@/stores/toasts'
import { t } from '@/strings'
import { useEditorContextStore } from '@/stores/editorContext'

// 一篇文档的标签页：默认预览，点击正文或按 Ctrl+E 进入编辑；停止输入 1 秒后自动保存。
// 见 docs/user-guide.md。
const props = defineProps<{ tab: Tab; active: boolean; embedded?: boolean; readOnly?: boolean; properties?: boolean }>()
const tabs = useTabsStore()
const toasts = useToastsStore()

const doc = ref<Doc | null>(null)
const text = ref('')
const title = ref('')
const editing = ref(false)
const propertiesOpen = ref(false)
const propertiesId = useId()
const splitPreview = ref(localStorage.getItem('jot.editor.preview') === 'split')
watch(splitPreview, (split) => localStorage.setItem('jot.editor.preview', split ? 'split' : 'single'))
watch(() => props.tab.startEditing, (value) => { if (value && !props.readOnly) editing.value = true })
const error = ref('')
const conflict = ref(false)
const confirmDiscard = ref(false)
const saving = ref(false)
const editor = ref<InstanceType<typeof MarkdownEditor> | null>(null)
const preview = ref<HTMLDivElement | null>(null)
let timer: ReturnType<typeof setTimeout> | undefined
let savingTask: Promise<void> | null = null
let renamingTitle = false
const offs: (() => void)[] = []
let refreshTimer: ReturnType<typeof setTimeout> | undefined

const editorContext = useEditorContextStore()
const contextOwner = crypto.randomUUID()
watchEffect(() => {
  if (props.active && doc.value) editorContext.publish(contextOwner, { path: doc.value.path, title: doc.value.title, body: text.value, dirty: text.value !== doc.value.body })
  else editorContext.clear(contextOwner)
})
onBeforeUnmount(() => editorContext.clear(contextOwner))

const dirty = computed(() => !!doc.value && text.value !== doc.value.body)
const isMarkdown = computed(() => /\.(md|markdown)$/i.test(props.tab.path))
const html = computed(() => (doc.value && isMarkdown.value ? renderMarkdown(text.value) : ''))
const hasProperties = computed(() => !!doc.value && (!props.embedded || props.properties) && isMarkdown.value && doc.value.editable && !props.readOnly)

let loadSequence = 0
async function load(): Promise<void> {
  const request = ++loadSequence
  const path = props.tab.path
  if (savingTask) await savingTask
  if (request !== loadSequence) return
  const r = await invoke('doc:get', { ref: { path } })
  if (request !== loadSequence || path !== props.tab.path) return
  if (saving.value) { loadSoon(); return }
  if (!r.ok) {
    error.value = r.error.message
    return
  }
  error.value = ''
  if (dirty.value && doc.value?.path === r.data.path) {
    conflict.value = r.data.body !== doc.value?.body
    if (!conflict.value) { doc.value = r.data; title.value = r.data.title }
    return
  }
  doc.value = r.data
  text.value = r.data.body
  title.value = r.data.title
  if (!props.embedded && props.tab.startEditing) editing.value = true
  conflict.value = false
  if (!props.embedded) tabs.setTitle(props.tab.path, r.data.title)
}

async function save(): Promise<void> {
  clearTimeout(timer)
  if (savingTask) {
    await savingTask
    if (dirty.value && !conflict.value) await save()
    return
  }
  if (props.readOnly || !doc.value || !dirty.value || conflict.value || error.value) return
  const current = doc.value
  const body = text.value
  // 保存开始后，丢弃此前尚未返回的回读结果。
  loadSequence++
  let retry = false
  saving.value = true
  savingTask = (async () => {
    const r = await invoke('doc:saveBody', { ref: { path: current.path }, body, baseHash: current.hash })
    if (r.ok) {
      doc.value = { ...doc.value!, body, hash: r.data.hash }
      retry = true
    } else if (r.error.code === 'CONFLICT') {
      // 只是文件头变了：更新指纹后立即重试，操作门禁必须等到正文真正保存。
      const latest = await invoke('doc:get', { ref: { path: current.path } })
      if (latest.ok && latest.data.body === current.body) { doc.value = latest.data; retry = true }
      else conflict.value = true
    } else toasts.error(r.error.message, { label: t.common.retry, run: save })
  })().finally(() => { saving.value = false; savingTask = null })
  await savingTask
  if (retry && dirty.value && !conflict.value) await save()
}

function schedule(): void {
  clearTimeout(timer)
  timer = setTimeout(() => void save(), 1000)
}
watch(text, () => dirty.value && schedule())

/** 从当前路径回读；附属属性、删除和恢复也刷新，不靠正文指纹判断元数据。 */
function loadSoon(): void {
  clearTimeout(refreshTimer)
  refreshTimer = setTimeout(() => void load(), 60)
}

function discardDraft(): void {
  text.value = doc.value?.body ?? ''
  conflict.value = false
  confirmDiscard.value = false
}

async function resolveConflict(keepMine: boolean): Promise<void> {
  const r = await invoke('doc:get', { ref: { path: props.tab.path } })
  if (!r.ok) { error.value = r.error.message; return }
  error.value = ''
  const mine = text.value
  doc.value = r.data
  conflict.value = false
  if (keepMine) {
    text.value = mine
    await save()
  } else {
    text.value = r.data.body
    title.value = r.data.title
  }
}

/** 摘要页顶部的“打开原件”：文本在标签页里打开，其他格式用系统默认程序打开 */
async function openSource(): Promise<void> {
  const source = doc.value?.sourcePath
  if (!source) return
  if (/\.(md|markdown|txt|log|csv|json|ya?ml|xml|ini|conf|tsv)$/i.test(source)) tabs.open(source, { newTab: true })
  else await call('doc:openExternal', { path: source })
}

async function saveTitle(): Promise<void> {
  if (renamingTitle || !doc.value || doc.value.type !== 'note' || !title.value.trim() || title.value === doc.value.title) return
  const name = title.value.trim()
  renamingTitle = true
  try {
    await beforeAction()
    const meta = await call('doc:rename', { ref: { path: doc.value.path }, newName: name })
    tabs.retarget(props.tab.path, meta.path)
    if (meta.notUpdated?.length) toasts.error(t.library.linksNotUpdated + meta.notUpdated.map(item => item.path).join('、'))
  } catch (e) { toasts.error((e as Error).message); title.value = doc.value.title }
  finally { renamingTitle = false }
}

function findText(): void {
  const element = editing.value || !isMarkdown.value || props.readOnly ? editor.value?.$el : preview.value
  if (element) window.dispatchEvent(new CustomEvent('jot:find', { detail: element }))
}

async function beforeAction(): Promise<void> {
  await save()
  if (dirty.value || conflict.value) throw new Error(t.editor.saveBeforeLeaving)
}

function enterEdit(): void {
  if (doc.value?.editable && !props.readOnly) editing.value = true
}

async function toggleEdit(): Promise<void> {
  if (!doc.value?.editable || props.readOnly) return
  if (editing.value) await save()
  editing.value = !editing.value
}

/** 定位到文件的第几行，并高亮 2 秒 */
async function gotoLine(fileLine: number): Promise<void> {
  if (!doc.value) return
  const bodyLine = Math.max(1, fileLine - doc.value.bodyStartLine + 1)
  await nextTick()
  if (editing.value || !isMarkdown.value || props.readOnly) {
    editor.value?.gotoLine(bodyLine)
    return
  }
  let target: HTMLElement | null = null
  for (const el of preview.value?.querySelectorAll<HTMLElement>('[data-line]') ?? []) {
    if (Number(el.dataset.line) <= bodyLine) target = el
    else break
  }
  if (!target) return
  target.scrollIntoView({ block: 'center' })
  target.classList.add('flash')
  setTimeout(() => target?.classList.remove('flash'), 2000)
}

async function onPreviewClick(e: MouseEvent): Promise<void> {
  const link = (e.target as HTMLElement).closest('a')
  if (!link) {
    if (!window.getSelection()?.toString()) enterEdit()
    return
  }
  e.preventDefault()
  const target = link.dataset.wikilink
  if (target === undefined) {
    const href = link.dataset.file ?? link.getAttribute('href') ?? ''
    if (/^https?:/.test(href)) { window.open(href); return }
    if (/^file:\/\//i.test(href)) {
      try { await call('doc:openExternal', { path: href }) }
      catch (error) { toasts.error((error as Error).message) }
      return
    }
    if (!href || href.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(href)) return
  }
  try {
    const match = await call('doc:resolveLink', { from: props.tab.path, target: target ?? link.getAttribute('href') ?? '', kind: target === undefined ? 'markdown' : 'wiki' })
    await tabs.open(match.path, { newTab: e.ctrlKey })
  } catch (e) { toasts.error((e as Error).message) }
}

function onKey(e: KeyboardEvent): void {
  if (!props.active) return
  if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'e') {
    e.preventDefault()
    void toggleEdit()
  }
}

onMounted(async () => {
  await load()
  if (props.tab.line) await gotoLine(props.tab.line)
  offs.push(on('files:changed', loadSoon), on('doc:updated', meta => {
    if (meta.path === props.tab.path) loadSoon()
  }))
  window.addEventListener('keydown', onKey)
})
const unregisterEditor = registerPendingEditor(() => props.tab.path, beforeAction)
onBeforeUnmount(() => {
  unregisterEditor()
  loadSequence++
  clearTimeout(refreshTimer)
  offs.forEach(off => off())
  window.removeEventListener('keydown', onKey)
  clearTimeout(timer)
  void save()
})
watch(() => props.tab.lineTick, () => props.tab.line && void gotoLine(props.tab.line))
// 已知移动沿用同一标签页的草稿，随后按新路径回读；不寻找外部移动的目标。
watch(() => props.tab.path, (path, oldPath) => {
  if (doc.value?.path === oldPath) doc.value = { ...doc.value, path }
  void load()
})

defineExpose({ dirty, flush: save })
</script>

<template>
  <div class="doc" :class="{ embedded, editing, 'read-only': readOnly }" data-testid="doc-view" :data-path="tab.path" data-find-scope :data-find-title="doc?.title" :data-find-active="active">
    <AppDialog v-if="confirmDiscard" :title="t.editor.discardDraftTitle" @close="confirmDiscard = false"><p>{{ t.editor.discardDraftHint }}</p><template #footer><div class="dialog-actions"><button @click="confirmDiscard = false">{{ t.common.cancel }}</button><button data-testid="doc-discard-confirm" @click="discardDraft">{{ t.editor.discardDraft }}</button></div></template></AppDialog>
    <div v-if="error && !dirty" class="state">
      <p class="danger selectable" data-testid="doc-error">{{ t.editor.loadFailed }}：{{ error }}</p>
      <button @click="load">{{ t.common.retry }}</button>
    </div>
    <template v-else-if="doc">
      <DocumentToolbar v-if="!embedded || (doc.editable && !readOnly)" :path="doc.path" :embedded class="detail-toolbar">
        <span v-if="dirty" class="dot" :title="t.editor.unsaved" data-testid="doc-unsaved" />
        <PropertyButton v-if="embedded && hasProperties" v-model="propertiesOpen" :doc :panel-id="propertiesId" />
        <button v-if="doc.editable" type="button" class="ghost document-tool" :title="t.editor.find + ' Ctrl+F'" :aria-label="t.editor.find" data-testid="doc-find" @click="findText"><Search :size="14" aria-hidden="true" /><span class="toolbar-label">{{ t.editor.find }}</span></button>
        <button v-if="editing && isMarkdown && !readOnly" type="button" class="ghost document-tool" :title="t.editor.splitPreview" :aria-label="t.editor.splitPreview" :aria-pressed="splitPreview" data-testid="doc-split" @click="splitPreview = !splitPreview"><Columns2 :size="14" aria-hidden="true" /><span class="toolbar-label">{{ t.editor.splitPreview }}</span></button>
        <button v-if="doc.editable && isMarkdown && !readOnly" type="button" class="ghost document-tool" data-testid="doc-toggle" :title="editing ? t.editor.preview : t.editor.edit" :aria-label="editing ? t.editor.preview : t.editor.edit" @click="toggleEdit"><Eye v-if="editing" :size="14" aria-hidden="true" /><Pencil v-else :size="14" aria-hidden="true" /><span class="toolbar-label">{{ editing ? t.editor.preview : t.editor.edit }}</span></button>
      </DocumentToolbar>
      <div v-if="!embedded" class="document-heading">
        <span class="type-badge" :class="doc.type === 'idea' || doc.type === 'log' ? 'type-record' : 'type-note'">{{ t.docTypes[doc.type] }}</span>
        <div class="document-title-row">
          <input v-if="editing && doc.type === 'note'" v-model="title" class="document-title" type="text" data-testid="doc-title" :aria-label="t.library.noteTitle" @change="saveTitle" @keydown.enter="($event.target as HTMLInputElement).blur()" />
          <h1 v-else>{{ doc.title }}</h1>
          <PropertyButton v-if="hasProperties" v-model="propertiesOpen" :doc :panel-id="propertiesId" />
        </div>
        <p v-if="doc.type === 'idea' || doc.type === 'log'" class="record-time small muted" data-testid="record-time">{{ t.library.recorded }} {{ new Date(doc.created).toLocaleString('zh-CN') }}<br v-if="doc.start" /><template v-if="doc.start">{{ t.library.happened }} {{ new Date(doc.start).toLocaleString('zh-CN') }}<template v-if="doc.end"> — {{ new Date(doc.end).toLocaleString('zh-CN') }}</template></template></p>
      </div>
      <PropertyPanel v-if="hasProperties" :id="propertiesId" v-model:open="propertiesOpen" :doc="doc" @updated="doc = { ...doc, classification: $event }" @log-time-updated="loadSoon" />
      <div v-if="error" class="banner" role="alert" data-testid="doc-draft-unavailable"><span>{{ t.editor.unavailableDraft }} {{ error }}</span><button @click="load">{{ t.common.retry }}</button><button data-testid="doc-discard-draft" @click="confirmDiscard = true">{{ t.editor.discardDraft }}</button></div>
      <div v-if="conflict && !error" class="banner" data-testid="doc-conflict">
        <span>{{ t.editor.conflictTitle }}</span>
        <button data-testid="conflict-mine" @click="resolveConflict(true)">{{ t.editor.keepMine }}</button>
        <button data-testid="conflict-theirs" @click="resolveConflict(false)">{{ t.editor.useTheirs }}</button>
      </div>
      <div v-else-if="doc.generatedByAi && !embedded" class="banner muted" data-testid="doc-ai-banner">
        <span>{{ t.editor.aiPageHint }}</span>
        <template v-if="doc.sourcePath">
          <span v-if="doc.sourceMissing" class="missing" data-testid="doc-source-missing">{{ t.archive.sourceMissing }}</span>
          <button v-else data-testid="doc-open-source" @click="openSource">{{ t.editor.openSource }}</button>
        </template>
      </div>
      <!-- 文本原件仍可只读预览；editable 只限制写入。 -->
      <div v-if="!doc.editable && !readOnly" class="state">
        <p class="muted">{{ t.editor.notEditable }}</p>
        <button data-testid="doc-open-external" @click="call('doc:openExternal', { path: doc.path })">{{ t.editor.openExternal }}</button>
      </div>
      <div v-else class="panes" :class="{ split: editing && splitPreview && isMarkdown && !readOnly }">
        <MarkdownEditor v-if="editing || !isMarkdown || readOnly" ref="editor" v-model="text" class="pane" :plain="!isMarkdown || readOnly" :read-only="readOnly" data-find-target />
        <div v-if="isMarkdown && !readOnly && (!editing || splitPreview)" class="pane preview-pane" :class="{ clickable: !editing }">
          <!-- eslint-disable-next-line vue/no-v-html -- 内容经过 DOMPurify 过滤 -->
          <div ref="preview" class="markdown selectable" tabindex="0" :data-text-edit="!editing ? '' : undefined" :data-find-target="!editing ? '' : undefined" data-testid="doc-preview" :data-markdown="text" @jot:edit.stop="enterEdit" @click="!editing ? onPreviewClick($event) : null" v-html="html" />
        </div>
      </div>

    </template>
  </div>
</template>

<style scoped>
.detail-toolbar { padding:var(--space-4) var(--space-7) var(--space-3); }
.document-title-row { display:flex; align-items:flex-start; gap:var(--space-3); margin-top:var(--space-3); }
.document-title-row > :first-child { flex:1; min-width:0; }
.document-title-row > .property-button { margin-top:var(--space-1); }
.document-heading { padding:var(--space-3) var(--space-7) var(--space-4); flex:none; }
.document-heading h1 { font-size:var(--font-size-title); font-weight:650; letter-spacing:-.6px; line-height:1.5; margin:0; overflow-wrap:anywhere; }
.document-title { display:block; width:100%; min-width:0; font-size:var(--font-size-title); border:0; border-bottom:1px solid var(--border); border-radius:0; padding:0; }
.record-time { margin:var(--space-3) 0 0; line-height:1.9; }
.embedded .detail-toolbar { padding:var(--space-2) var(--space-5) 0; }
.embedded .markdown { padding:var(--space-4) var(--space-5) var(--space-6); }
@container content (max-width:600px) { .detail-toolbar { padding:var(--space-4) var(--space-5); }.document-heading { padding:var(--space-3) var(--space-5); } }
.doc {
  height: 100%;
  display: flex;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
}
/* 嵌入的文件摘要随整页滚动；编辑器和原文保持自己的可滚动编辑区域。 */
.doc.embedded { height:auto; min-height:0; }
.embedded .panes { flex:none; }
.embedded:not(.editing):not(.read-only) .panes { display:block; }
.embedded:not(.editing):not(.read-only) .pane { overflow:visible; }
.embedded .markdown { min-height:0; }
.embedded.editing .panes, .embedded.read-only .panes { height:400px; }
.dot {
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--text-muted);
}
.banner {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border);
  font-size: var(--font-size-small);
}
.missing {
  color: var(--danger);
}
.state {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
}
.danger {
  color: var(--danger);
}
.panes {
  flex: 1 0 160px;
  min-height: 0;
  display: grid;
  grid-template-columns: 1fr;
}
.panes.split {
  grid-template-columns: 1fr 1fr;
}
.pane {
  min-width: 0;
  min-height: 0;
  overflow: auto;
}
.split .preview-pane {
  border-left: 1px solid var(--border);
}
/* 分栏放不下时只显示编辑器，用 Ctrl+E 切换 */
@container content (max-width: 760px) {
  .panes.split {
    grid-template-columns: 1fr;
  }
  .split .preview-pane {
    display: none;
  }
}
.markdown {
  max-width: var(--line-width);
  min-height: 100%;
  margin: 0 auto;
  padding: var(--space-4) 24px 48px;
  font-size: var(--font-size-text);
  line-height: var(--line-height);
  word-break: break-word;
}
.clickable .markdown {
  cursor: text;
}
.markdown :deep(h1),
.markdown :deep(h2),
.markdown :deep(h3) {
  margin: 1.2em 0 0.5em;
  font-weight: 600;
  line-height: 1.3;
}
.markdown :deep(h1) {
  font-size: 1.6em;
}
.markdown :deep(h2) {
  font-size: 1.35em;
}
.markdown :deep(h3) {
  font-size: 1.15em;
}
.markdown :deep(p) {
  margin: 0 0 0.8em;
}
.markdown :deep(:first-child) {
  margin-top: 0;
}
.markdown :deep(code) {
  font-family: var(--font-mono);
  font-size: 0.9em;
  background: var(--bg-secondary);
  padding: 1px 4px;
  border-radius: var(--radius-s);
}
.markdown :deep(pre) {
  background: var(--bg-secondary);
  padding: var(--space-3);
  border-radius: var(--radius-m);
  overflow: auto;
}
.markdown :deep(pre code) {
  background: none;
  padding: 0;
}
.markdown :deep(blockquote) {
  margin: 0 0 0.8em;
  padding-left: var(--space-3);
  border-left: 3px solid var(--border);
  color: var(--text-muted);
}
.markdown :deep(table) {
  border-collapse: collapse;
  margin-bottom: 0.8em;
}
.markdown :deep(th),
.markdown :deep(td) {
  border: 1px solid var(--border);
  padding: var(--space-1) var(--space-2);
}
.markdown :deep(img) {
  max-width: 100%;
}
.markdown :deep(hr) {
  border: none;
  border-top: 1px solid var(--border);
}
.markdown :deep(a) {
  color: var(--accent);
  text-decoration: none;
  cursor: pointer;
}
.markdown :deep(a:hover) {
  text-decoration: underline;
}
.markdown :deep(.flash) {
  background: var(--accent-soft);
  border-radius: var(--radius-s);
  transition: background 0.3s;
}
</style>
