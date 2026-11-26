import { mappedPath } from '@shared/files'
import { reasoningModelKey } from '@shared/reasoning'
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import type { AssistantContext, MaterialReference, ToolCall } from '@shared/assistant'
import type { AgentEvent, ChatMessage, ConversationInfo } from '@shared/types'
import { t } from '@/strings'
import { call, on } from '@/api'
import { useCapabilitiesStore } from '@/stores/capabilities'
import { useEditorContextStore } from '@/stores/editorContext'
import { useAppStore } from '@/stores/app'
import { prepareContentAction } from '@/utils/pendingEdits'

interface Draft { text: string; context: AssistantContext; touched: boolean; submitted: boolean; automaticReference: string | null }
const blank = (): Draft => ({ text: '', context: { agentId: 'default', references: [], strict: false, skillIds: [] }, touched: false, submitted: false, automaticReference: null })
export function useAssistantConversation() {
  const app = useAppStore()
  const cap = useCapabilitiesStore()
  const editor = useEditorContextStore()
  const drafts = reactive<Record<string, Draft>>({ new: blank() })
  const current = ref<ConversationInfo | null>(null)
  const key = computed(() => current.value?.conversationId ?? 'new')
  const draft = computed(() => drafts[key.value] ?? (drafts[key.value] = blank()))
  const messages = ref<ChatMessage[]>([])
  const stream = ref<ChatMessage | null>(null)
  const error = ref('')
  const loading = ref(false)
  const conversations = ref<ConversationInfo[]>([])
  const historyTotal = ref(0)
  const historyPage = ref(1)
  const historyQuery = ref('')
  const showHistory = ref(false)
  const scroller = ref<HTMLElement | null>(null)
  const follow = ref(true)
  const busy = computed(() => !!stream.value)
  let openSequence = 0
  let historySequence = 0
  const off: (() => void)[] = []
  const currentReference = computed<MaterialReference | null>(() => editor.current ? { kind: 'file', value: editor.current.path, title: editor.current.title } : null)
  const canAddCurrent = computed(() => currentReference.value && !draft.value.context.references.some(r => r.kind === 'file' && r.value === currentReference.value!.value))
  watch(currentReference, reference => {
    if (reference && !draft.value.submitted && !draft.value.touched) { draft.value.context.references = [reference]; draft.value.automaticReference = reference.value }
  }, { immediate: true })

  async function bottom(force = false): Promise<void> {
    if (!force && !follow.value) return
    await nextTick()
    scroller.value?.scrollTo({ top: scroller.value.scrollHeight })
  }
  function trackScroll(): void {
    const el = scroller.value
    if (el) follow.value = el.scrollHeight - el.scrollTop - el.clientHeight < 70
  }
  async function loadList(): Promise<void> {
    const mine = ++historySequence
    const data = await call('agent:conversations', { text: historyQuery.value, offset: (historyPage.value - 1) * 30, limit: 30 })
    if (mine !== historySequence) return
    conversations.value = data.items; historyTotal.value = data.total
    const info = data.items.find(c => c.conversationId === current.value?.conversationId)
    if (info) current.value = info
  }
  function restoreDraft(id: string, data: ChatMessage[], selection?: AssistantContext): void {
    if (drafts[id]) return
    const context = selection ?? data.filter(m => m.role === 'user' && m.context).at(-1)?.context
    drafts[id] = { ...blank(), submitted: data.length > 0, ...(context ? { context: { agentId: context.agentId, strict: context.strict, skillIds: [], references: context.references.map(r => ({ ...r })), reasoningEffort: context.reasoningEffort, reasoningModel: context.reasoningModel } } : {}) }
  }
  async function openConversation(id: string): Promise<void> {
    const mine = ++openSequence
    loading.value = true
    try {
      const data = await call('agent:get', { conversationId: id })
      if (mine !== openSequence) return
      restoreDraft(id, data.messages, data.context)
      current.value = data.info; messages.value = data.messages
      stream.value = data.live ?? (data.running ? { messageId: data.running, runId: data.running, role: 'assistant', text: '', parts: [], createdAt: new Date().toISOString() } : null)
      error.value = ''; showHistory.value = false; follow.value = true
      await bottom(true)
    } catch (e) { if (mine === openSequence) error.value = (e as Error).message }
    finally { if (mine === openSequence) loading.value = false }
  }
  function newChat(): void {
    openSequence++
    current.value = null; messages.value = []; stream.value = null; error.value = ''; showHistory.value = false
    drafts.new ??= blank()
    if (currentReference.value && !drafts.new.touched && !drafts.new.text) { drafts.new.context.references = [currentReference.value]; drafts.new.automaticReference = currentReference.value.value }
    follow.value = true
  }
  function addReference(reference: MaterialReference, replace = false): void {
    const d = draft.value
    d.touched = true
    if (replace) { d.context.references = []; d.automaticReference = null }
    if (!d.context.references.some(r => r.kind === reference.kind && r.value === reference.value)) d.context.references.push(reference)
  }
  function removeReference(index: number): void {
    const d = draft.value
    d.touched = true
    const removed = d.context.references.splice(index, 1)[0]
    if (removed?.kind === 'file' && removed.value === d.automaticReference) d.automaticReference = null
  }
  function historyPreview(conversation: ConversationInfo): string {
    const unsent = drafts[conversation.conversationId]?.text.trim()
    return unsent ? t.agent.historyDraft(unsent) : conversation.preview || t.agent.historyNotStarted
  }
  function addCurrent(): void { if (currentReference.value) addReference(currentReference.value) }
  async function send(retryMessageId?: string): Promise<void> {
    const text = retryMessageId ? messages.value.find(m => m.messageId === retryMessageId)?.text ?? '' : draft.value.text.trim()
    if (!text || busy.value || loading.value) return
    if (!retryMessageId && draft.value.context.strict && !draft.value.context.references.length) { error.value = t.agent.emptyStrictError; return }
    error.value = ''
    const originalKey = key.value
    const originalDraft = draft.value
    const context = JSON.parse(JSON.stringify(originalDraft.context)) as AssistantContext
    try {
      loading.value = true
      await prepareContentAction()
      if (!current.value) {
        current.value = await call('agent:create')
        drafts[current.value.conversationId] = drafts[originalKey]!
        drafts.new = blank()
      }
      const conversationId = current.value.conversationId
      const pending: ChatMessage = { messageId: 'pending', role: 'assistant', text: '', parts: [], toolCalls: [], createdAt: new Date().toISOString() }
      stream.value = pending
      follow.value = true
      const result = await call('agent:send', { conversationId, text, ...(retryMessageId ? { retryMessageId } : { context }) })
      if (stream.value === pending || !stream.value?.runId) { pending.runId = result.runId; stream.value = pending }
      if (!retryMessageId) { originalDraft.text = ''; originalDraft.context.skillIds = []; originalDraft.submitted = true }
      const data = await call('agent:get', { conversationId })
      if (current.value?.conversationId === conversationId) {
        messages.value = data.messages
        if (data.live) stream.value = data.live
        else if (!data.running) stream.value = null
      }
      await bottom(true)
      await loadList()
    } catch (e) { stream.value = null; error.value = (e as Error).message }
    finally { loading.value = false }
  }
  async function setContext(context: AssistantContext): Promise<void> {
    const original = draft.value, previous = original.context
    original.context = context
    if (!current.value || previous.reasoningEffort === context.reasoningEffort && previous.reasoningModel === context.reasoningModel) return
    try { await call('agent:setReasoning', { conversationId: current.value.conversationId, effort: context.reasoningEffort ?? null }) }
    catch (e) { error.value = (e as Error).message }
  }
  async function stop(): Promise<void> { if (stream.value?.runId) await call('agent:abort', { runId: stream.value.runId }) }
  function appendPart(delta: string): void {
    const s = stream.value!
    s.text += delta; s.parts ??= []
    const last = s.parts.at(-1)
    if (last?.type === 'text') last.text += delta
    else s.parts.push({ type: 'text', text: delta })
  }
  function updateTool(call: ToolCall, ending: boolean): void {
    const s = stream.value!
    s.parts ??= []; s.toolCalls ??= []
    const part = [...s.parts].reverse().find(p => p.type === 'tool' && (call.id ? p.call.id === call.id : p.call.name === call.name && p.call.ok === undefined))
    if (part?.type === 'tool') part.call = call
    else s.parts.push({ type: 'tool', call })
    if (ending) s.toolCalls.push(call)
  }
  async function event(e: AgentEvent): Promise<void> {
    if (e.conversationId !== current.value?.conversationId) return
    if (!stream.value) return
    if (stream.value.runId && stream.value.runId !== e.runId) return
    stream.value.runId = e.runId
    if (e.type === 'text') appendPart(e.delta)
    else if (e.type === 'tool-start' || e.type === 'tool-end') updateTool(e.call ?? { name: e.name, summary: e.summary, ...(e.type === 'tool-end' ? { ok: e.ok } : {}) }, e.type === 'tool-end')
    else if (e.type === 'tool-update') updateTool(e.call, false)
    else if (e.type === 'compacting') stream.value.waitingForCompaction = e.waiting
    else if (e.type === 'budget') stream.value.budget = e.budget
    else {
      const conversationId = e.conversationId
      stream.value = null
      const data = await call('agent:get', { conversationId })
      if (current.value?.conversationId === conversationId) messages.value = data.messages
      void loadList()
    }
    await bottom()
  }
  onMounted(async () => {
    off.push(on('storage:changed', change => {
      if (!change.moves) return
      for (const item of Object.values(drafts)) {
        if (item.automaticReference) item.automaticReference = mappedPath(item.automaticReference, change.moves)
        item.context.references = item.context.references.map(reference => {
          const value = mappedPath(reference.value, change.moves!)
          return { ...reference, value, title: value === reference.value ? reference.title : value.split('/').pop()!.replace(/\.(md|markdown)$/i, '') }
        })
      }
    }))
    off.push(on('agent:event', e => { void event(e).catch(e => { error.value = (e as Error).message }) }))
    off.push(on('agent:changed', e => {
      if (e.deleted) {
        delete drafts[e.conversationId]
        if (current.value?.conversationId === e.conversationId) newChat()
      }
      void cap.loadRuns().catch(e => { error.value = (e as Error).message })
      void loadList().catch(e => { error.value = (e as Error).message })
    }))
    try { await cap.load(); await loadList() } catch (e) { error.value = (e as Error).message }
    // 初次展开保留当前文件作为新对话的起点，历史通过顶部入口打开。
  })
  watch([historyPage, historyQuery], () => { void loadList().catch(e => { error.value = (e as Error).message }) })
  watch(historyQuery, () => { historyPage.value = 1 })
  watch(() => app.openConversation, value => {
    if (value) { app.openConversation = null; void openConversation(value) }
  }, { immediate: true })
  watch(() => cap.conversationRequest, value => { if (value) void openConversation(value.id) }, { immediate: true })
  watch(() => app.settings && reasoningModelKey(app.settings.model), (value, previous) => {
    if (!previous || value === previous) return
    for (const item of Object.values(drafts)) {
      delete item.context.reasoningEffort
      delete item.context.reasoningModel
    }
  })
  watch(() => app.vault.path, () => { for (const id of Object.keys(drafts)) delete drafts[id]; newChat(); void cap.load() })
  onBeforeUnmount(() => off.forEach(fn => fn()))
  return { current, draft, messages, stream, error, loading, conversations, historyTotal, historyPage, historyQuery, showHistory, scroller, follow, busy, canAddCurrent, historyPreview, bottom, trackScroll, openConversation, newChat, addReference, removeReference, addCurrent, send, stop, setContext }
}
