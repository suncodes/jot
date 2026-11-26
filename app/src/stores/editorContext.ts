import { defineStore } from 'pinia'
import { ref } from 'vue'

export interface OpenDocumentContext { path: string; title: string; body: string; dirty: boolean }
export const useEditorContextStore = defineStore('editorContext', () => {
  const current = ref<OpenDocumentContext | null>(null)
  let owner = ''
  function publish(id: string, value: OpenDocumentContext): void { owner = id; current.value = value }
  function clear(id: string): void { if (owner === id) { current.value = null; owner = '' } }
  return { current, publish, clear }
})
