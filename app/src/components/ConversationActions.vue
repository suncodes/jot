<script setup lang="ts">
import { computed, ref } from 'vue'
import { call } from '@/api'
import ObjectMenu from '@/components/ObjectMenu.vue'
import AppDialog from '@/components/AppDialog.vue'
import { useToastsStore } from '@/stores/toasts'
import { t } from '@/strings'

const { conversationId } = defineProps<{ conversationId: string }>()
const toasts = useToastsStore()
const mode = ref('')
const title = ref('')
const busy = ref(false)
const error = ref('')
const exportError = ref('')
const actions = computed(() => [
  { id: 'rename', label: t.actions.rename, testId: 'conversation-rename' },
  { id: 'markdown', label: t.agent.exportMarkdown, testId: 'conversation-export-markdown' },
  { id: 'jsonl', label: t.agent.exportJsonl, testId: 'conversation-export-jsonl' },
  { id: 'delete', label: t.agent.deleteChat, danger: true, separated: true, testId: 'agent-conversation-delete' },
].map(action => ({ ...action, disabled: busy.value })))
async function choose(action: string): Promise<void> {
  if (busy.value) return
  if (action === 'markdown' || action === 'jsonl') {
    busy.value = true
    try {
      const result = await call('agent:export', { conversationId, format: action })
      if (result) toasts.info(t.agent.exported(result.path))
    } catch (e) { exportError.value = (e as Error).message }
    finally { busy.value = false }
    return
  }
  try {
    title.value = (await call('agent:get', { conversationId })).info.title
    error.value = ''
    mode.value = action
  } catch (e) { toasts.error((e as Error).message) }
}
async function submit(): Promise<void> {
  if (busy.value) return
  busy.value = true; error.value = ''
  try {
    if (mode.value === 'rename') await call('agent:rename', { conversationId, title: title.value.trim() })
    else await call('agent:delete', { conversationId })
    mode.value = ''
  } catch (e) { error.value = (e as Error).message }
  finally { busy.value = false }
}
</script>
<template>
  <ObjectMenu :actions trigger-id="conversation-more" menu-id="conversation-menu" @select="choose" />
  <AppDialog v-if="exportError" :title="t.agent.exportFailed" compact @close="exportError = ''">
    <p class="dialog-error" role="alert" data-testid="conversation-export-error">{{ exportError }}</p>
    <template #footer><button @click="exportError = ''">{{ t.common.close }}</button></template>
  </AppDialog>
  <AppDialog v-if="mode" :title="mode === 'rename' ? t.actions.rename : t.agent.deleteChat" :busy :compact="mode === 'rename'" @close="mode = ''">
    <form @submit.prevent="submit">
      <label v-if="mode === 'rename'" class="dialog-field">
        {{ t.actions.name }}
        <input v-model="title" class="dialog-input" type="text" maxlength="200" autofocus data-select-on-open data-testid="conversation-name" />
      </label>
      <p v-else>{{ t.actions.deleteConversation(title) }}</p>
      <p v-if="error" class="dialog-error" role="alert">{{ error }}</p>
      <div class="dialog-actions"><button type="button" class="ghost" :disabled="busy" @click="mode = ''">{{ t.actions.cancel }}</button><button class="primary" :disabled="busy || !title.trim()" :data-testid="mode === 'rename' ? 'conversation-confirm' : 'agent-delete-confirm'">{{ busy ? t.actions.busy : mode === 'rename' ? t.actions.save : t.actions.permanentConfirm }}</button></div>
    </form>
  </AppDialog>
</template>
