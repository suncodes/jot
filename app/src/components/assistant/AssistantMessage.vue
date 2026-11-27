<script setup lang="ts">
import { t } from '@/strings'
import { isAbsoluteFilePath } from '@shared/file-links'
import { call } from '@/api'
import { computed, nextTick, ref } from 'vue'
import { Check, AlertCircle, ArrowUpRight, ChevronRight, Copy, FileText, Link, LoaderCircle, RotateCcw, Square } from 'lucide-vue-next'
import type { ChatMessage, Chunk, Citation } from '@shared/types'
import type { ToolCall } from '@shared/assistant'
import AppDialog from '@/components/AppDialog.vue'
import ReasoningDetails from '@/components/ReasoningDetails.vue'
import ObjectMenu from '@/components/ObjectMenu.vue'
import ToolProcess from './ToolProcess.vue'
import AssistantNoteDialog from './AssistantNoteDialog.vue'
import { renderAnswer, type CiteInfo } from '@/markdown'
import { useTabsStore } from '@/stores/tabs'
import { useToastsStore } from '@/stores/toasts'
import '@/styles/assistant.css'

const { message, streaming = false, retry = false, question = '', loadedSkills = [] } = defineProps<{ message: ChatMessage; streaming?: boolean; retry?: boolean; question?: string; loadedSkills?: string[] }>()
const emit = defineEmits<{ retry: [] }>()
const tabs = useTabsStore()
const toasts = useToastsStore()
const c = t.agent
const root = ref<HTMLElement | null>(null)
const passage = ref<Chunk | null>(null)
const inspectContext = ref(false)
const manualCopy = ref<string | null>(null)
const savingNote = ref(false)
const manualInput = ref<HTMLTextAreaElement | null>(null)
const processes = ref<InstanceType<typeof ToolProcess>[]>([])
const sourceList = ref<HTMLDetailsElement | null>(null)
const preview = ref<{ chunk: Chunk; left: number; top: number } | null>(null)
function answerHtml(text: string): string {
  // 正文先经过既有净化流程，随后只添加固定的代码工具栏和表格滚动容器。
  return renderAnswer(text, citeInfo)
    .replace(/(<pre(?: [^>]*)?>)<code(?: class="language-([^"]+)")?>/g, (_, opening: string, language: string | undefined) => '<div class="code-block"><div class="code-head"><span>' + (language?.replace(/[^a-zA-Z0-9+.#-]/g, '') || c.code) + '</span><button type="button" class="copy-code">' + c.copyCode + '</button></div>' + opening + '<code>')
    .replace(/<\/pre>/g, '</pre></div>')
    .replace(/<table(?: [^>]*)?>/g, opening => '<div class="table-scroll">' + opening).replace(/<\/table>/g, '</table></div>')
}
async function copyText(text: string): Promise<void> {
  try { await navigator.clipboard.writeText(text); toasts.info(c.copied) }
  catch { manualCopy.value = text; await nextTick(); manualInput.value?.select() }
}
const fileName = (p: string) => p.split('/').pop()!.replace(/\.(md|markdown)$/i, '')
const blocks = computed(() => {
  const parts = message.parts?.length ? message.parts : [
    ...(message.toolCalls ?? []).map(call => ({ type: 'tool' as const, call })),
    ...(message.text ? [{ type: 'text' as const, text: message.text }] : []),
  ]
  const out: ({ type: 'text'; text: string } | { type: 'tools'; calls: ToolCall[] })[] = []
  for (const part of parts) {
    const last = out.at(-1)
    if (part.type === 'tool') {
      if (last?.type === 'tools') last.calls.push(part.call)
      else out.push({ type: 'tools', calls: [part.call] })
    } else out.push(part)
  }
  return out
})
// 仅高亮当轮实际加载的技能，普通文本仍由 Vue 转义。
const questionParts = computed(() => {
  const context = message.context
  const names = new Set(context?.skills.filter(skill => context.skillIds.includes(skill.id)).flatMap(skill => [skill.id, skill.name]))
  const parts: { text: string; skill: boolean }[] = []
  let start = 0
  for (const match of message.text.matchAll(/(?:^|\s)([/$]([^\s/$，。！？,;]+))/g)) {
    if (!names.has(match[2]!)) continue
    const index = match.index + match[0].length - match[1]!.length
    parts.push({ text: message.text.slice(start, index), skill: false }, { text: match[1]!, skill: true })
    start = index + match[1]!.length
  }
  parts.push({ text: message.text.slice(start), skill: false })
  return parts
})
const sources = computed(() => {
  const seen = new Set<string>()
  return (message.citations ?? []).filter(citation => {
    if (!citation.valid || !citation.chunk || seen.has(citation.chunk.path)) return false
    seen.add(citation.chunk.path); return true
  })
})
const menu = computed(() => [
  ...(message.context ? [{ id: 'details', label: t.reasoning.details }] : []),
  ...(question ? [{ id: 'question', label: c.copyQuestion }] : []),
  ...(blocks.value.some(block => block.type === 'tools') ? [{ id: 'process', label: c.showProcess }] : []),
  ...(sources.value.length ? [{ id: 'sources', label: c.showSources }] : []),
])
function citeInfo(marker: string): CiteInfo {
  if (streaming) return { label: c.pendingSource, title: c.pendingSourceHint, state: 'pending', ai: false }
  const cite = message.citations?.find(citation => citation.marker === marker)
  if (!cite?.valid || !cite.chunk) return { label: c.unverifiedSource, title: c.invalidCite, state: 'invalid', ai: false }
  return { label: fileName(cite.chunk.path) + ':' + cite.chunk.lineStart, title: cite.chunk.text.slice(0, 240) + (cite.chunk.generatedByAi ? '\n\n' + c.aiPage + (cite.basedOn?.length ? '，' + c.basedOn(cite.basedOn.join('、')) : '') : ''), state: 'valid', ai: cite.chunk.generatedByAi }
}
async function answerClick(e: MouseEvent): Promise<void> {
  const button = (e.target as HTMLElement).closest('button.copy-code')
  if (button) { e.preventDefault(); void copyText(button.closest('.code-block')?.querySelector('code')?.textContent ?? ''); return }
  const link = (e.target as HTMLElement).closest('a')
  if (!link) return
  e.preventDefault(); preview.value = null
  if (link.dataset.cite) {
    const citation = message.citations?.find(cite => cite.marker === link.dataset.cite)
    if (citation?.valid && citation.chunk) passage.value = citation.chunk
  } else {
    const href = link.dataset.file ?? link.getAttribute('href')
    if (!href) return
    if (/^https?:/.test(href)) { window.open(href); return }
    try {
      if (/^file:/i.test(href)) { await call('doc:openExternal', { path: href }); return }
      const path = decodeURIComponent(href.split(/[?#]/, 1)[0] ?? '')
      if (isAbsoluteFilePath(path)) { await call('doc:openExternal', { path }); return }
      if (!/^(ideas|content|inbox|wiki|journal)\//.test(path)) return
      const doc = await call('doc:get', { ref: { path } })
      await tabs.open(doc.path, { newTab: true })
    } catch (error) { toasts.error((error as Error).message) }
  }
}
function hoverSource(e: MouseEvent | FocusEvent): void {
  const link = (e.target as HTMLElement).closest('a.cite.valid')
  const chunk = message.citations?.find(cite => cite.marker === (link as HTMLElement | null)?.dataset.cite)?.chunk
  if (!link || !chunk) { preview.value = null; return }
  const rect = link.getBoundingClientRect()
  preview.value = { chunk, left: Math.max(12, Math.min(innerWidth - 277, rect.left)), top: Math.max(12, Math.min(innerHeight - 200, rect.bottom + 7)) }
}
async function openCurrentSource(): Promise<void> {
  const chunk = passage.value
  if (!chunk) return
  try {
    if (isAbsoluteFilePath(chunk.path)) {
      await call('doc:openExternal', { path: chunk.path })
      passage.value = null
      return
    }
    const doc = await call('doc:get', { ref: { path: chunk.path } })
    const body = doc.body.replace(/\r\n/g, '\n')
    const lines = chunk.text.replace(/\r\n/g, '\n').split('\n')
    const original = lines.slice(Math.max(0, doc.bodyStartLine - chunk.lineStart)).join('\n')
    const offset = body.indexOf(original)
    const exact = !!original && offset >= 0 && body.indexOf(original, offset + 1) < 0
    const line = exact ? doc.bodyStartLine + body.slice(0, offset).split('\n').length - 1 : undefined
    await tabs.open(doc.path, { newTab: true, line })
    if (!exact) toasts.info(c.sourceChanged)
    passage.value = null
  } catch (e) { toasts.error((e as Error).message) }
}
function showSource(citation: Citation): void { if (citation.chunk) passage.value = citation.chunk }
function more(action: string): void {
  if (action === 'details') { inspectContext.value = true; return }
  if (action === 'question') void copyText(question)
  else if (action === 'process') { processes.value.forEach(process => process.expand()); void nextTick(() => root.value?.querySelector('.process')?.scrollIntoView({ block: 'nearest' })) }
  else if (sourceList.value) { sourceList.value.open = true; sourceList.value.scrollIntoView({ block: 'nearest' }) }
}
</script>
<template>
  <article ref="root" class="chat-message" :class="message.role" :data-testid="message.role === 'user' ? 'agent-user' : 'agent-answer'">
    <template v-if="message.role === 'user'">
      <div class="question selectable"><span v-for="(part, index) in questionParts" :key="index" :class="{ 'skill-mention': part.skill }">{{ part.text }}</span></div>
      <button v-if="message.context" class="ghost message-context" data-testid="agent-turn-context" :title="c.turnBasis" aria-haspopup="dialog" @click="inspectContext = true"><Link :size="11" /><span>{{ message.context.strict ? c.limited : c.referenceCaption }} · {{ c.materialCount(message.context.references.length) }}</span><ChevronRight :size="11" /></button>
    </template>
    <template v-else>
      <div v-if="loadedSkills.length" class="skill-status"><Check :size="12" /><span>{{ c.loadedSkills(loadedSkills.join('、')) }}</span></div>
      <template v-for="(block, index) in blocks" :key="index">
        <ToolProcess v-if="block.type === 'tools'" ref="processes" :calls="block.calls" :streaming :run-id="message.runId" />
        <!-- eslint-disable-next-line vue/no-v-html -- Markdown 经过 DOMPurify 过滤 -->
        <div v-else class="answer markdown selectable" data-find-target @click="answerClick" @mouseover="hoverSource" @focusin="hoverSource" @mouseleave="preview = null" @focusout="preview = null" v-html="answerHtml(block.text)" />
      </template>
      <div v-if="streaming && (message.waitingForCompaction || !message.text && !message.parts?.length)" class="waiting" role="status"><LoaderCircle :size="14" class="spin" /><span :data-testid="message.waitingForCompaction ? 'agent-compacting' : undefined">{{ message.waitingForCompaction ? c.compacting : c.preparing }}</span></div>
      <div v-if="message.error" class="run-status" :class="{ failed: message.error !== c.stopped }" data-testid="agent-message-error"><Square v-if="message.error === c.stopped" :size="14" /><AlertCircle v-else :size="14" /><span>{{ message.error }}</span></div>
      <details v-if="sources.length" ref="sourceList" class="sources" data-testid="agent-sources"><summary><ChevronRight :size="13" class="chevron" /><FileText :size="13" />{{ c.sources }}<span>· {{ c.sourceCount(sources.length) }}</span></summary><div class="source-list"><button v-for="citation in sources" :key="citation.chunk!.path" class="ghost source-row" :title="citation.chunk!.path" @click="showSource(citation)"><FileText :size="14" /><span><strong>{{ fileName(citation.chunk!.path) }}<small v-if="citation.chunk!.generatedByAi" class="source-ai">AI</small></strong><small>{{ citation.chunk!.path }}</small></span><span class="source-line">:{{ citation.chunk!.lineStart }}</span><ArrowUpRight :size="13" /></button></div></details>
      <div v-if="!streaming" class="message-actions"><button class="ghost icon-button" :title="c.copyAnswer" :aria-label="c.copyAnswer" data-testid="agent-copy" @click="copyText(message.text)"><Copy :size="14" /></button><button v-if="message.text.trim()" class="ghost icon-button" :title="c.saveAsNote" :aria-label="c.saveAsNote" data-testid="agent-save-note" @click="savingNote = true"><FileText :size="14" /></button><button v-if="retry" class="ghost retry-action" :title="c.retryHint" :aria-label="c.retry" data-testid="agent-retry" @click="emit('retry')"><RotateCcw :size="14" />{{ c.retry }}</button><ObjectMenu v-if="menu.length" :actions="menu" :label="c.moreAnswer" trigger-id="agent-answer-more" menu-id="agent-answer-menu" @select="more" /></div>
    </template>
    <AssistantNoteDialog v-if="savingNote" :message @close="savingNote = false" />
    <AppDialog v-if="inspectContext && message.context" :title="c.referenceMaterials" class="assistant-dialog assistant-reference-dialog" scroll-body @close="inspectContext = false">
      <template #heading><div class="assistant-dialog-heading"><p>{{ c.turnBasis }}</p><h2>{{ c.referenceMaterials }}</h2></div></template>
      <p class="reference-detail-note">{{ message.context.agent.name }} · {{ message.context.strict ? c.limited : c.referenceCaption }}</p>
      <p v-if="message.context.model" class="reference-detail-note">{{ t.capabilities.model }}：{{ message.context.modelUse?.channelName ? message.context.modelUse.channelName + ' / ' : '' }}{{ message.context.modelUse?.name || message.context.model }}</p>
      <ReasoningDetails v-if="message.context.reasoning" :reasoning="message.context.reasoning" />
      <p v-if="!message.context.references.length" class="reference-detail-note">{{ c.noMaterials }}</p>
      <details v-for="reference in message.context.references" :key="reference.kind + reference.value" class="material-reference" data-testid="agent-material-reference">
        <summary><FileText v-if="reference.kind === 'file'" :size="14" /><Link v-else :size="14" /><span>{{ reference.title }}<small>{{ reference.kind === 'folder' ? c.folderReference : c.fileReference }}</small></span><ChevronRight :size="13" class="chevron" /></summary>
        <p class="muted selectable">{{ reference.value }}</p><p class="muted">{{ c.currentMaterial }}</p>
      </details>
      <p v-if="message.context.skillIds.length" class="reference-detail-note">{{ c.explicitSkills }}：{{ message.context.skills.filter(skill => message.context!.skillIds.includes(skill.id)).map(skill => skill.title).join('、') }}</p>
      <template #footer><span class="small muted">{{ c.turnBasis }}</span><button @click="inspectContext = false">{{ c.backToConversation }}</button></template>
    </AppDialog>
    <AppDialog v-if="manualCopy !== null" :title="c.copyContent" class="assistant-dialog assistant-copy-dialog" @close="manualCopy = null"><p class="small muted">{{ c.copyManualHint }}</p><textarea ref="manualInput" :value="manualCopy" class="manual-copy" readonly :aria-label="c.copyContentLabel" @focus="manualInput?.select()" /></AppDialog>
    <AppDialog v-if="passage" :title="fileName(passage.path)" class="assistant-dialog assistant-source-dialog" scroll-body @close="passage = null">
      <template #heading><div class="assistant-dialog-heading"><p>{{ c.sourcePassage }}</p><h2>{{ fileName(passage.path) }}</h2></div></template>
      <p class="source-path muted small">{{ passage.path }} · {{ c.atLine(passage.lineStart) }}</p>
      <div class="source-passage selectable"><div v-for="(line, index) in passage.text.split('\n')" :key="index" class="source-text-line"><span>{{ passage.lineStart + index }}</span><span>{{ line || ' ' }}</span></div></div>
      <template #footer><span class="small muted">{{ c.sourceHint }}</span><button data-testid="agent-source-open" @click="openCurrentSource">{{ c.openCurrent }}</button></template>
    </AppDialog>
    <Teleport to="body"><aside v-if="preview" class="assistant-source-preview" role="tooltip" :style="{ left: preview.left + 'px', top: preview.top + 'px' }"><strong>{{ fileName(preview.chunk.path) }}</strong><small>{{ c.atLine(preview.chunk.lineStart) }}</small><p>{{ preview.chunk.text.slice(0, 200) }}</p></aside></Teleport>
  </article>
</template>
