<script setup lang="ts">
import { Check, FolderOpen, Pencil, X } from 'lucide-vue-next'
import { computed, ref, watch } from 'vue'
import type { InboxItem } from '@shared/types'
import type { SuggestionKind } from '@shared/pending'
import ContentDirectorySelect from './ContentDirectorySelect.vue'
import { t } from '@/strings'

const { item, busy } = defineProps<{ item: InboxItem; busy: boolean }>()
const emit = defineEmits<{ accept: [kind: SuggestionKind, toDir?: string]; skip: [kind: SuggestionKind]; analyze: []; cancel: []; edit: [] }>()
const directory = computed(() => item.suggestions.find(s => s.kind === 'directory'))
const properties = computed(() => item.suggestions.find(s => s.kind === 'properties'))
const running = computed(() => item.analysis && ['queued', 'running'].includes(item.analysis.state))
const unfinished = computed(() => item.analysis && ['queued', 'running', 'waiting-model', 'failed'].includes(item.analysis.state))
const choosing = ref(false)
const target = ref('')
watch(() => item.doc.path, () => { choosing.value = false; target.value = '' })
function choose(): void {
  target.value = directory.value?.kind === 'directory' ? directory.value.directoryPath : ''
  choosing.value = !choosing.value
}
</script>

<template>
  <div class="decisions">
    <p v-if="item.analysis && (item.analysis.state !== 'done' || item.analysis.note)" class="analysis small" role="status" data-testid="inbox-analysis-status" :data-state="item.analysis.state">
      <strong>{{ item.analysis.state === 'done' ? t.inbox.analysisDone : t.jobs.states[item.analysis.state] }}</strong>
      <span v-if="item.analysis.error || item.analysis.note">{{ item.analysis.error || item.analysis.note }}</span>
    </p>
    <section v-if="item.reasons.includes('directory')" class="decision-card" data-testid="inbox-directory-decision">
      <div class="suggestion-title"><strong>{{ directory ? t.inbox.suggestionTitles.directory : t.inbox.reasons.directory }}</strong><span v-if="directory" class="small muted">{{ t.inbox.confidence(directory.confidence) }}</span></div>
      <template v-if="directory?.kind === 'directory'">
        <p class="directory small selectable">{{ directory.directoryPath.replace(/^content\//, '') }}</p>
        <p v-if="directory.reason" class="small muted">{{ directory.reason }}</p>
      </template>
      <p v-else class="small muted" data-testid="inbox-waiting">{{ t.inbox.waitingDirectory }}</p>
      <div class="actions">
        <button v-if="directory" class="primary" :disabled="busy" data-testid="inbox-accept-directory" @click="emit('accept', 'directory')"><Check :size="14" />{{ t.inbox.accept.directory }}</button>
        <button :disabled="busy" data-testid="inbox-choose-directory" :aria-expanded="choosing" @click="choose"><FolderOpen :size="13" />{{ directory ? t.inbox.changeDirectory : t.inbox.chooseDirectory }}</button>
        <button class="ghost" :disabled="busy" data-testid="inbox-skip-directory" @click="emit('skip', 'directory')">{{ t.inbox.skip.directory }}</button>
      </div>
      <form v-if="choosing" class="directory-form" @submit.prevent="target && emit('accept', 'directory', target)">
        <label class="small">{{ t.actions.target }}<ContentDirectorySelect v-model="target" :allow-root="false" :disabled="busy" data-testid="inbox-directory-target" /></label>
        <button class="primary" :disabled="busy || !target" data-testid="inbox-confirm-directory">{{ t.inbox.accept.directory }}</button>
      </form>
      <small class="faint">{{ t.inbox.deferHint }}</small>
    </section>
    <section v-if="properties || unfinished" class="decision-card" data-testid="inbox-properties-decision">
      <div class="suggestion-title"><strong>{{ properties ? t.inbox.suggestionTitles.properties : t.inbox.analysisProperties }}</strong><span v-if="properties" class="small muted">{{ t.inbox.confidence(properties.confidence) }}</span></div>
      <template v-if="properties?.kind === 'properties'">
        <div class="suggested-tags small"><span v-for="tag in properties.properties.tags ?? []" :key="tag">#{{ tag }}</span><span v-for="person in properties.properties.people ?? []" :key="person">@{{ person }}</span><span v-if="properties.properties.place">{{ properties.properties.place }}</span></div>
        <p v-if="properties.reason" class="small muted">{{ properties.reason }}</p>
        <div class="actions"><button class="primary" :disabled="busy" data-testid="inbox-accept-properties" @click="emit('accept', 'properties')"><Check :size="14" />{{ t.inbox.accept.properties }}</button><button :disabled="busy" data-testid="inbox-adjust-properties" @click="emit('edit')"><Pencil :size="13" />{{ t.inbox.adjustProperties }}</button></div>
      </template>
      <p v-else class="small muted">{{ t.inbox.analysisPending }}</p>
      <button class="ghost ignore" :disabled="busy" data-testid="inbox-skip-properties" @click="emit('skip', 'properties')"><X :size="13" />{{ properties ? t.inbox.skip.properties : t.inbox.dismissAnalysis }}</button>
    </section>
    <div class="actions">
      <button :disabled="busy" data-testid="inbox-edit" @click="emit('edit')"><Pencil :size="13" />{{ t.inbox.edit }}</button>
      <button class="ghost" :disabled="busy || !!running" data-testid="inbox-analyze" @click="emit('analyze')">{{ unfinished && !running ? t.inbox.retryAnalysis : t.inbox.analyze }}</button>
      <button v-if="item.analysis && ['queued', 'running', 'waiting-model'].includes(item.analysis.state)" class="ghost" :disabled="busy" data-testid="inbox-cancel-analysis" @click="emit('cancel')">{{ t.inbox.cancelAnalysis }}</button>
    </div>
  </div>
</template>

<style scoped>
.decisions { display:grid; gap:var(--space-3); }
.analysis { display:grid; gap:var(--space-1); margin:0; padding:var(--space-2) var(--space-3); background:var(--canvas); border-radius:var(--radius-s); color:var(--text-muted); overflow-wrap:anywhere; }
.analysis[data-state='failed'], .analysis[data-state='waiting-model'] { color:var(--warning); }
.analysis strong { font-weight:550; }
.decision-card { display:grid; gap:var(--space-2); padding:var(--space-3); background:var(--canvas); border:1px solid var(--border); border-radius:var(--radius-m); min-width:0; }
.suggestion-title { display:flex; justify-content:space-between; align-items:center; gap:var(--space-2); flex-wrap:wrap; }
.suggestion-title strong { font-weight:550; font-size:var(--font-size-small); }
.decision-card p { margin:0; overflow-wrap:anywhere; }
.directory { color:var(--accent); }
.suggested-tags, .actions { display:flex; gap:var(--space-2); flex-wrap:wrap; }
.suggested-tags span { padding:2px var(--space-2); background:var(--accent-soft); color:var(--accent); border-radius:var(--radius-s); }
.actions button, .ignore { display:inline-flex; align-items:center; gap:var(--space-1); font-size:var(--font-size-small); }
.ignore { justify-self:start; padding:0; }
.directory-form { display:flex; gap:var(--space-2); align-items:end; flex-wrap:wrap; }
.directory-form label { display:grid; gap:var(--space-1); flex:1; min-width:160px; }
</style>
