<script setup lang="ts">
import { resolveModelSettings } from '@shared/models'
import { t } from '@/strings'
import { ArrowDown, ArrowUpRight, CalendarDays, FileText, History, PanelRightClose, Plus, Search, Sparkles } from 'lucide-vue-next'
import { computed, ref } from 'vue'
import { useAppStore } from '@/stores/app'
import AssistantComposer from '@/components/assistant/AssistantComposer.vue'
import AssistantHistory from '@/components/assistant/AssistantHistory.vue'
import AssistantMessage from '@/components/assistant/AssistantMessage.vue'
import { useAssistantConversation } from '@/composables/useAssistantConversation'
import '@/styles/assistant.css'

const emit = defineEmits<{ close: [] }>()
const {
  current, draft, messages, stream, error, loading, conversations, historyTotal, historyPage, historyQuery, showHistory,
  scroller, follow, busy, canAddCurrent, historyPreview, bottom, trackScroll, openConversation, newChat, addReference, removeReference, addCurrent, send, stop, setContext,
} = useAssistantConversation()
const app = useAppStore()
const composer = ref<InstanceType<typeof AssistantComposer> | null>(null)
const budget = computed(() => stream.value?.budget ?? (stream.value ? undefined : messages.value.findLast(message => message.role === 'assistant')?.budget))
const currentBudget = computed(() => {
  const model = app.settings && resolveModelSettings(app.settings.models, draft.value.context.modelId ?? app.settings.models.defaultModelId)
  const message = stream.value ?? messages.value.findLast(message => message.role === 'assistant')
  return budget.value && model && message?.context?.modelUse?.id === model.id && message.context.modelUse.protocol === model.protocol
    && budget.value.model === model.model && (!model.contextWindow || budget.value.contextWindow === model.contextWindow) ? budget.value : undefined
})
const conversationDate = computed(() => {
  const stamp = messages.value[0]?.createdAt
  return stamp ? new Date(stamp).toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' }) : ''
})
function explicitSkills(index: number): string[] {
  const context = messages.value.slice(0, index).findLast(m => m.role === 'user')?.context
  return context?.skills.filter(skill => context.skillIds.includes(skill.id)).map(skill => skill.title) ?? []
}
function question(index: number): string { return messages.value.slice(0, index).findLast(m => m.role === 'user')?.text ?? '' }
function retry(index: number): void {
  const previous = messages.value.slice(0, index).findLast(m => m.role === 'user')
  if (previous) void send(previous.messageId)
}
function suggest(text: string): void { draft.value.text = text; composer.value?.focus() }
defineExpose({ focus: () => composer.value?.focus(), history: () => { showHistory.value = true } })
const c = t.agent
</script>
<template>
  <section class="agent-panel-content" data-testid="agent" data-find-scope :data-find-title="c.title">
    <header class="assistant-head">
      <div class="conversation-heading"><span class="assistant-symbol"><Sparkles :size="21" /></span><div><span class="assistant-label">{{ c.panelLabel }}</span><h1 class="head-title" data-testid="agent-title" :title="current?.title">{{ current?.title || c.newChat }}</h1></div></div>
      <div class="head-actions"><button class="ghost icon-button" :title="c.newChat" :aria-label="c.newChat" data-testid="agent-new" :disabled="loading" @click="newChat"><Plus :size="16" /></button><button class="ghost icon-button" :title="c.history" :aria-label="c.history" data-testid="agent-history" aria-haspopup="dialog" :aria-expanded="showHistory" @click="showHistory = true"><History :size="16" /></button><button class="ghost icon-button" :title="c.close" :aria-label="c.close" data-testid="agent-close" @click="emit('close')"><PanelRightClose :size="16" /></button></div>
    </header>
    <div v-if="!app.settings?.models.defaultModelId && !draft.context.modelId" class="model-hint small muted" data-testid="agent-no-model">{{ c.noModel }}<button class="ghost" @click="app.settingsSection = 'model'; app.showSettings = true">{{ c.goSettings }}</button></div>
    <div class="message-area">
      <div ref="scroller" class="messages" data-testid="agent-messages" role="region" :aria-label="c.history" tabindex="0" @scroll="trackScroll">
        <div v-if="!messages.length && !stream" class="welcome" data-testid="agent-empty">
          <Sparkles :size="29" /><h2>{{ c.welcome }}</h2><p>{{ c.welcomeLine1 }}<br />{{ c.welcomeLine2 }}</p>
          <div class="suggestion-list"><button class="ghost" @click="suggest(c.weeklyQuestion)"><CalendarDays :size="14" /><span>{{ c.weeklySuggestion }}</span><ArrowUpRight :size="14" /></button><button class="ghost" @click="suggest(c.summaryQuestion)"><FileText :size="14" /><span>{{ c.summarySuggestion }}</span><ArrowUpRight :size="14" /></button><button class="ghost" @click="suggest(c.projectQuestion)"><Search :size="14" /><span>{{ c.projectSuggestion }}</span><ArrowUpRight :size="14" /></button></div>
        </div>
        <p v-if="conversationDate" class="thread-date">{{ conversationDate }}</p>
        <AssistantMessage v-for="(message, index) in messages" :key="message.messageId" :message :question="question(index)" :loaded-skills="explicitSkills(index)" :retry="!busy && !loading" @retry="retry(index)" />
        <AssistantMessage v-if="stream" :message="stream" :loaded-skills="explicitSkills(messages.length)" streaming />
      </div>
      <button v-if="!follow" class="latest" data-testid="agent-latest" @click="follow = true; bottom(true)"><ArrowDown :size="13" />{{ c.latest }}</button>
    </div>
    <div v-if="error" class="error small" role="alert" data-testid="agent-error">{{ error }}<button class="ghost" :aria-label="c.closeError" @click="error = ''">×</button></div>
    <AssistantComposer ref="composer" v-model="draft.text" :context="draft.context" :automatic-reference="draft.automaticReference" :budget="currentBudget" :busy :loading :can-add-current="!!canAddCurrent" @context="setContext" @add="addReference" @remove="removeReference" @current="addCurrent" @send="send()" @stop="stop" />
    <AssistantHistory v-if="showHistory" v-model:query="historyQuery" :conversations :current-id="current?.conversationId" :total="historyTotal" :page="historyPage" :preview="historyPreview" @close="showHistory = false" @open="openConversation" @page="historyPage = $event" />
  </section>
</template>
