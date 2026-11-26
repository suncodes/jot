<script setup lang="ts">
import { X } from 'lucide-vue-next'
import { useToastsStore, type Toast } from '@/stores/toasts'
import { t } from '@/strings'

const toasts = useToastsStore()

async function act(toast: Toast): Promise<void> {
  toasts.dismiss(toast.id)
  try {
    await toast.action?.run()
  } catch (e) {
    toasts.error(e instanceof Error ? e.message : String(e))
  }
}
</script>

<template>
  <div v-if="toasts.items.length" class="toasts" aria-live="polite">
    <div v-for="toast in toasts.items" :key="toast.id" class="toast small" :class="toast.kind" data-testid="toast" :data-kind="toast.kind">
      <span class="text selectable">{{ toast.text }}</span>
      <button v-if="toast.action" class="ghost action" data-testid="toast-action" @click="act(toast)">{{ toast.action.label }}</button>
      <button class="ghost close" :title="t.common.close" @click="toasts.dismiss(toast.id)"><X :size="14" /></button>
    </div>
  </div>
</template>

<style scoped>
.toasts {
  position: fixed;
  right: var(--space-4);
  bottom: calc(var(--statusbar-height) + var(--space-3));
  z-index: 90;
  width: min(480px, calc(100vw - var(--space-4) * 2));
  max-height: min(25vh, 180px);
  overflow: auto;
  pointer-events: none;
  align-items: flex-end;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.toast {
  pointer-events: auto;
  flex: none;
  max-width: min(480px, 100%);
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  background: var(--bg-primary);
  border: 1px solid var(--border);
  border-radius: var(--radius-m);
  box-shadow: var(--shadow);
}
.toast.error {
  border-color: var(--danger);
}
.text {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
}
.action {
  flex: none;
  white-space: nowrap;
  color: var(--accent);
  padding: 0 var(--space-1);
}
.close {
  flex: none;
  padding: 2px;
  display: grid;
}
</style>
