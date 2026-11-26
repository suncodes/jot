<script setup lang="ts">
import { computed, ref } from 'vue'
import { Clock3, Pencil } from 'lucide-vue-next'
import type { DocMeta } from '@shared/types'
import { call } from '@/api'
import AppDialog from '@/components/AppDialog.vue'
import DateTimeField from '@/components/DateTimeField.vue'
import { t } from '@/strings'

const { doc, menuOnly = false } = defineProps<{ doc: DocMeta; menuOnly?: boolean }>()
const emit = defineEmits<{ updated: [doc: DocMeta] }>()
const open = ref(false)
const busy = ref(false)
const error = ref('')
const start = ref('')
const end = ref('')
const validStart = ref(true)
const validEnd = ref(true)
const valid = computed(() => validStart.value && validEnd.value &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(start.value) &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(end.value) && end.value >= start.value)
const timeText = computed(() => {
  const from = doc.start?.slice(0, 16).replace('T', ' ')
  const to = doc.end?.slice(0, 16).replace('T', ' ')
  if (!from || !to || from === to) return from || to || t.props.none
  const endLabel = from.slice(0, 10) === to.slice(0, 10) && to.length > 10 ? to.slice(11) : to
  return from + ' — ' + endLabel
})
function edit(): void {
  start.value = doc.start?.slice(0, 16) ?? ''
  end.value = doc.end?.slice(0, 16) ?? ''
  validStart.value = true
  validEnd.value = true
  error.value = ''
  open.value = true
}
async function save(): Promise<void> {
  if (!valid.value || busy.value) return
  busy.value = true
  try {
    emit('updated', await call('doc:setLogTime', { ref: { path: doc.path }, start: start.value, end: end.value }))
    open.value = false
  } catch (e) { error.value = (e as Error).message }
  finally { busy.value = false }
}
defineExpose({ edit })
</script>

<template>
  <div v-if="!menuOnly" class="time-edit">
    <div class="time-value" data-testid="log-time-value" :title="timeText"><Clock3 :size="14" aria-hidden="true" /><span>{{ timeText }}</span></div>
    <button type="button" class="ghost edit-time" :aria-label="t.actions.logTime" data-testid="log-edit-time" @click="edit"><Pencil :size="13" aria-hidden="true" />{{ t.props.editTime }}</button>
  </div>
  <AppDialog v-if="open" :title="t.actions.logTime" :busy @close="open = false">
    <form @submit.prevent="save">
      <DateTimeField v-model="start" :label="t.today.logStart" testid="log-edit-start" @validity="validStart = $event" />
      <DateTimeField v-model="end" :label="t.today.logEnd" testid="log-edit-end" @validity="validEnd = $event" />
      <p v-if="error" class="dialog-error" role="alert">{{ error }}</p>
      <div class="dialog-actions">
        <button type="button" class="ghost" :disabled="busy" @click="open = false">{{ t.common.cancel }}</button>
        <button class="primary" :disabled="!valid || busy" data-testid="log-time-save">{{ t.actions.save }}</button>
      </div>
    </form>
  </AppDialog>
</template>

<style scoped>
.time-edit {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  min-width: 0;
  min-height: var(--control-height);
  padding: 0 var(--space-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-m);
  background: var(--canvas);
}
.time-value {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
}
.time-value svg { flex: none; }
.time-value span { overflow-wrap: anywhere; }
.edit-time {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  flex: none;
  padding: var(--space-1) var(--space-2);
  color: var(--accent);
  font-size: var(--font-size-small);
}
</style>
