<script setup lang="ts">
import { History, Search } from 'lucide-vue-next'
import type { ConversationInfo } from '@shared/types'
import { t } from '@/strings'
import AppDialog from '@/components/AppDialog.vue'
import ConversationActions from '@/components/ConversationActions.vue'
import Pager from '@/components/Pager.vue'

const { conversations, currentId, total, page, preview } = defineProps<{
  conversations: ConversationInfo[]; currentId: string | undefined; total: number; page: number
  preview: (conversation: ConversationInfo) => string
}>()
const query = defineModel<string>('query', { required: true })
const emit = defineEmits<{ close: []; open: [id: string]; page: [value: number] }>()
const c = t.agent
</script>
<template>
  <AppDialog :title="c.history" class="assistant-dialog assistant-history-dialog" scroll-body @close="emit('close')">
    <template #heading><div class="assistant-dialog-heading"><p>{{ c.historyEyebrow }}</p><h2>{{ c.history }}</h2></div></template>
    <div data-testid="agent-history-list">
      <label class="assistant-popover-search"><Search :size="14" /><input v-model="query" type="search" :aria-label="c.searchHistory" :placeholder="c.searchHistoryPlaceholder" autocomplete="off" autofocus data-testid="agent-history-search" /></label>
      <p class="history-caption">{{ c.historyCount(total) }}</p>
      <div data-object-list>
        <div v-for="conversation in conversations" :key="conversation.conversationId" class="history-row" data-object-row data-testid="agent-conversation" :class="{ selected: conversation.conversationId === currentId }">
          <button class="ghost history-main" :aria-label="conversation.title" :aria-current="conversation.conversationId === currentId ? 'true' : undefined" @click="emit('open', conversation.conversationId)">
            <History :size="15" /><span><strong>{{ conversation.title }}</strong><small>{{ preview(conversation) }}</small></span><small v-if="conversation.conversationId === currentId" class="history-current">{{ c.currentConversation }}</small>
          </button>
          <ConversationActions :conversation-id="conversation.conversationId" />
        </div>
        <p v-if="!conversations.length" class="assistant-empty-options">{{ query ? c.noMatchingHistory : c.noHistory }}</p>
      </div>
      <Pager v-if="total > 30" :page :total :size="30" prefix="agent-history" @change="emit('page', $event)" />
    </div>
    <template #footer><span class="muted small">{{ c.historyDraftHint }}</span><button @click="emit('close')">{{ t.common.close }}</button></template>
  </AppDialog>
</template>
