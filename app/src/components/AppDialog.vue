<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { restoreObjectFocus } from '@/utils/objectFocus'
import { t } from '@/strings'
import { X } from 'lucide-vue-next'

const { title, busy = false, scrollBody = false, compact = false } = defineProps<{
  title: string
  busy?: boolean
  scrollBody?: boolean
  compact?: boolean
}>()
const emit = defineEmits<{ close: [] }>()
defineOptions({ inheritAttrs: false })

const dialog = ref<HTMLDialogElement | null>(null)
function close(): void { if (!busy) emit('close') }
let restoreFocus: (() => void) | undefined
onMounted(() => {
  restoreFocus = restoreObjectFocus(document.activeElement instanceof HTMLElement ? document.activeElement : null)
  dialog.value?.showModal()
  dialog.value?.querySelector<HTMLInputElement>('input[autofocus][data-select-on-open]')?.select()
})
onBeforeUnmount(() => { dialog.value?.close(); void nextTick(() => restoreFocus?.()) })
</script>

<template>
  <Teleport to="body">
    <dialog
      ref="dialog"
      v-bind="$attrs"
      class="app-dialog"
      :class="{ 'scroll-body': scrollBody, 'app-dialog-compact': compact }"
      :aria-label="title"
      data-testid="app-dialog"
      @cancel.prevent="close"
    >
      <header>
        <slot name="heading"><h2>{{ title }}</h2></slot>
        <button type="button" class="ghost icon-button dialog-close" :disabled="busy" :title="t.common.close" :aria-label="t.common.close" @click="close">
          <X :size="16" />
        </button>
      </header>
      <div class="dialog-body"><slot /></div>
      <footer v-if="$slots.footer" class="dialog-footer"><slot name="footer" /></footer>
    </dialog>
  </Teleport>
</template>

<style scoped>
.app-dialog {
  width:min(var(--dialog-width), calc(100vw - var(--space-7)));
  max-height:calc(100dvh - var(--space-8));
  padding:0;
  color:var(--text-normal);
  background:var(--bg-primary);
  border:1px solid var(--border);
  border-radius:var(--radius-l);
  box-shadow:var(--shadow);
}
.app-dialog-compact { width:min(var(--dialog-compact-width), calc(100vw - var(--space-7))); }
.app-dialog::backdrop { background:var(--overlay); }
.scroll-body[open] { display:flex; flex-direction:column; overflow:hidden; }
.scroll-body > header, .dialog-footer { flex:none; }
.scroll-body .dialog-body { min-height:0; overflow:auto; }
header {
  display:flex;
  align-items:center;
  justify-content:space-between;
  gap:var(--space-3);
  padding:var(--space-4) var(--space-5) var(--space-2);
}
h2 { min-width:0; margin:0; font-size:var(--font-size-dialog-title); font-weight:600; overflow-wrap:anywhere; }
header .dialog-close {
  flex:none;
  width:var(--space-6);
  height:var(--space-6);
  padding:0;
  color:var(--text-muted);
  border-radius:var(--radius-m);
}
header .dialog-close:hover:not(:disabled) { color:var(--text-normal); }
.dialog-body { padding:var(--space-2) var(--space-5) var(--space-5); }
.dialog-body :deep(form) { display:grid; gap:var(--space-3); }
.dialog-body :deep(label) { display:grid; gap:var(--space-2); }
.dialog-body :deep(.dialog-field) { color:var(--text-muted); font-size:var(--font-size-small); font-weight:500; }
.dialog-body :deep(.dialog-input) {
  width:100%;
  min-width:0;
  min-height:var(--control-height);
  padding:var(--space-1) var(--space-3);
  border:1px solid var(--border);
  border-radius:var(--radius-m);
  outline:none;
  background:var(--bg-secondary);
  color:var(--text-normal);
  font-size:var(--font-size-ui);
  font-weight:400;
  user-select:text;
}
.dialog-body :deep(.dialog-input:focus) {
  background:var(--bg-primary);
  border-color:var(--accent);
  box-shadow:0 0 0 var(--space-1) var(--accent-soft);
}
.dialog-body :deep(p) { margin:0; overflow-wrap:anywhere; }
.dialog-body :deep(.dialog-error) { color:var(--danger); font-size:var(--font-size-small); }
.dialog-footer {
  padding:var(--space-3) var(--space-5);
  border-top:1px solid var(--border);
  background:var(--bg-primary);
}
.dialog-body :deep(.dialog-actions), .dialog-footer :deep(.dialog-actions) {
  display:flex;
  justify-content:flex-end;
  flex-wrap:wrap;
  gap:var(--space-2);
}
.dialog-body :deep(:where(.dialog-actions > button)), .dialog-footer :deep(:where(.dialog-actions > button)) {
  min-height:var(--control-height);
  padding-inline:var(--space-4);
  border-radius:var(--radius-m);
}
</style>
