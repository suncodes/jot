<script setup lang="ts">
import { computed, ref, useId } from 'vue'
import { FilePlus2 } from 'lucide-vue-next'
import type { ChatMessage } from '@shared/types'
import { answerNoteBody } from '@shared/answer-note'
import { call } from '@/api'
import { renderMarkdown } from '@/markdown'
import { t } from '@/strings'
import { useTabsStore } from '@/stores/tabs'
import { useToastsStore } from '@/stores/toasts'
import AppDialog from '@/components/AppDialog.vue'
import ContentDirectorySelect from '@/components/ContentDirectorySelect.vue'
import MarkdownEditor from '@/components/MarkdownEditor.vue'

const { message } = defineProps<{ message: ChatMessage }>()
const emit = defineEmits<{ close: [] }>()
const c = t.agent
const tabs = useTabsStore()
const toasts = useToastsStore()
const formId = useId()
const heading = /^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/m.exec(message.text)?.[1]
const title = ref((heading ?? c.defaultNoteTitle).replace(/[\\/:*?"<>|]/g, ' ').trim().slice(0, 120))
const directory = ref('')
const body = ref(message.text)
const editing = ref(false)
const saving = ref(false)
const error = ref('')
const noteBody = computed(() => answerNoteBody(body.value, message.citations ?? [], directory.value))
const preview = computed(() => renderMarkdown(noteBody.value))
const canSave = computed(() => !!title.value.trim() && !!body.value.trim() && directory.value.startsWith('content/'))

async function save(): Promise<void> {
  if (saving.value || !canSave.value) return
  saving.value = true
  error.value = ''
  let savedPath: string
  try {
    const note = await call('doc:create', { dir: directory.value, title: title.value.trim(), body: noteBody.value })
    savedPath = note.path
  } catch (e) { error.value = (e as Error).message; saving.value = false; return }
  emit('close')
  toasts.info(c.noteSaved)
  try { await tabs.open(savedPath, { newTab: true }) }
  catch (e) { toasts.error((e as Error).message) }
}
</script>

<template>
  <AppDialog :title="c.saveAsNote" :busy="saving" class="assistant-dialog assistant-note-dialog" scroll-body @close="emit('close')">
    <template #heading><div class="assistant-dialog-heading"><p>{{ c.noteDraft }}</p><h2>{{ c.saveAsNote }}</h2></div></template>
    <form :id="formId" @submit.prevent="save">
      <fieldset :disabled="saving">
        <div class="note-fields">
          <label class="dialog-field">{{ c.noteTitle }}<input v-model="title" class="dialog-input" maxlength="120" autofocus data-testid="agent-note-title" /></label>
          <div class="dialog-field note-directory"><span>{{ c.noteDirectory }}</span><ContentDirectorySelect v-model="directory" :allow-root="false" /></div>
        </div>
        <div class="note-toolbar"><span class="small muted">{{ c.noteDraftHint }}</span><button type="button" class="ghost" :aria-pressed="editing" data-testid="agent-note-toggle" @click="editing = !editing">{{ editing ? t.editor.preview : t.editor.edit }}</button></div>
        <div class="note-content" data-testid="agent-note-content">
          <MarkdownEditor v-if="editing" v-model="body" />
          <!-- eslint-disable-next-line vue/no-v-html -- Markdown 经 DOMPurify 过滤 -->
          <div v-else class="markdown selectable note-preview" data-testid="agent-note-preview" @click.prevent v-html="preview" />
        </div>
      </fieldset>
      <p v-if="error" class="dialog-error" role="alert" data-testid="agent-note-error">{{ error }}</p>
    </form>
    <template #footer><span class="small muted">{{ c.noteSaveHint }}</span><div class="dialog-actions"><button type="button" :disabled="saving" @click="emit('close')">{{ t.actions.cancel }}</button><button type="submit" :form="formId" class="primary" :disabled="saving || !canSave" data-testid="agent-note-save"><FilePlus2 :size="14" />{{ saving ? t.library.saving : t.actions.save }}</button></div></template>
  </AppDialog>
</template>

<style>
.assistant-dialog.assistant-note-dialog.app-dialog { width:min(760px,calc(100vw - 28px)); }
.assistant-note-dialog fieldset { min-width:0; margin:0; padding:0; border:0; display:grid; gap:var(--space-3); }
.assistant-note-dialog .note-fields { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); gap:var(--space-3); }
.assistant-note-dialog .note-directory { display:grid; gap:var(--space-2); }
.assistant-note-dialog .note-directory .app-select { width:100%; align-self:end; }
.assistant-note-dialog .note-toolbar { display:flex; align-items:center; justify-content:space-between; gap:var(--space-3); }
.assistant-note-dialog .note-toolbar button { flex:none; font-size:var(--font-size-small); }
.assistant-note-dialog .note-content { height:clamp(180px,40dvh,390px); border:1px solid var(--border); border-radius:var(--radius-m); overflow:hidden; }
.assistant-note-dialog .note-preview { height:100%; overflow:auto; padding:var(--space-4) var(--space-5); font-size:var(--font-size-text); line-height:1.8; overflow-wrap:anywhere; }
.assistant-note-dialog .note-preview > :first-child { margin-top:0; }
.assistant-note-dialog.app-dialog .note-preview h1 { font-size:var(--font-size-dialog-title); line-height:1.5; margin-bottom:var(--space-4); }
.assistant-note-dialog.app-dialog .note-preview h2 { font-size:var(--font-size-text); line-height:1.5; margin:var(--space-4) 0 var(--space-2); }
.assistant-note-dialog .note-preview pre { overflow:auto; }
.assistant-note-dialog .note-preview img { max-width:100%; }
.assistant-note-dialog .note-preview a { color:var(--accent); }
.assistant-note-dialog .note-preview table { display:block; overflow:auto; }
.assistant-note-dialog .dialog-actions button { display:inline-flex; align-items:center; justify-content:center; gap:var(--space-2); }
@media (max-width:600px) { .assistant-note-dialog .note-fields { grid-template-columns:minmax(0,1fr); } }
</style>
