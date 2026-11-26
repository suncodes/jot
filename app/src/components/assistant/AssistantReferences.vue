<script setup lang="ts">
import { computed, ref } from 'vue'
import { FileText, Folder, X } from 'lucide-vue-next'
import type { AssistantContext, MaterialReference } from '@shared/assistant'
import AppDialog from '@/components/AppDialog.vue'
import { useEditorContextStore } from '@/stores/editorContext'
import { t } from '@/strings'

const { context, locked, automaticReference } = defineProps<{ context: AssistantContext; locked: boolean; automaticReference: string | null }>()
const emit = defineEmits<{ remove: [index: number]; strict: [value: boolean] }>()
const editor = useEditorContextStore()
const managing = ref(false)
const refs = computed(() => context.references.slice(0, 2))
const isDraft = (reference: MaterialReference) => reference.kind === 'file' && editor.current?.path === reference.value && editor.current.dirty
const c = t.agent
</script>
<template>
  <div v-if="context.references.length || context.strict" class="reference-tray" data-testid="agent-references" role="group" :aria-label="c.conversationMaterials">
    <button v-if="context.strict" class="ghost reference-limit" :title="c.unrestrict" :aria-label="c.unrestrict" data-testid="agent-unrestrict" :disabled="locked" @click="emit('strict', false)">{{ c.limited }}<X :size="10" /></button>
    <button v-else class="ghost reference-caption" data-testid="agent-reference-manage" :title="c.referenceMaterials" @click="managing = true">{{ c.referenceCaption }}</button>
    <span v-for="(reference, index) in refs" :key="reference.kind + reference.value" class="reference reference-chip" :title="reference.value">
      <Folder v-if="reference.kind === 'folder'" :size="12" /><FileText v-else :size="12" />
      <span>{{ reference.title }}</span><small v-if="reference.kind === 'file' && reference.value === automaticReference">{{ c.automatic }}</small><small v-if="isDraft(reference)">{{ c.draftBadge }}</small>
      <button class="ghost" :aria-label="c.removeReference(reference.title)" :disabled="locked" @click="emit('remove', index)"><X :size="10" /></button>
    </span>
    <button v-if="context.references.length > 2" class="ghost reference-more" data-testid="agent-reference-more" :title="c.referenceMore(context.references.length)" @click="managing = true">+{{ context.references.length - 2 }}</button>
    <span v-if="context.strict && !context.references.length" class="reference-empty">{{ c.emptyStrict }}</span>
    <button v-if="context.strict" class="ghost reference-caption" data-testid="agent-reference-manage" :title="c.referenceMaterials" @click="managing = true">{{ c.referenceMaterials }}</button>
  </div>
  <AppDialog v-if="managing" :title="c.referenceMaterials" class="assistant-dialog assistant-reference-dialog" scroll-body @close="managing = false">
    <template #heading><div class="assistant-dialog-heading"><p>{{ c.conversationMaterials }}</p><h2>{{ c.referenceMaterials }}</h2></div></template>
    <p class="reference-detail-note">{{ c.referenceModeHint }}</p>
    <div v-for="(reference, index) in context.references" :key="reference.kind + reference.value" class="reference-detail-row">
      <Folder v-if="reference.kind === 'folder'" :size="18" /><FileText v-else :size="18" />
      <span><strong>{{ reference.title }}<small v-if="reference.kind === 'file' && reference.value === automaticReference">{{ c.automatic }}</small><small v-if="isDraft(reference)" class="draft-version">{{ c.draftBadge }}</small></strong><small>{{ reference.value }}</small></span>
      <button class="ghost icon-button" :aria-label="c.removeReference(reference.title)" :disabled="locked" @click="emit('remove', index)"><X :size="15" /></button>
    </div>
    <label class="reference-mode"><input type="checkbox" :checked="context.strict" :disabled="locked || !context.references.length && !context.strict" data-testid="agent-strict" @change="emit('strict', ($event.target as HTMLInputElement).checked)" />{{ c.strictMaterials }}</label>
    <template #footer><span class="small muted">{{ c.referenceNote }}</span><button @click="managing = false">{{ c.backToConversation }}</button></template>
  </AppDialog>
</template>
