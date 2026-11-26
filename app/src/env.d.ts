/// <reference types="vite/client" />
import type { JotBridge } from '@shared/ipc'

declare global {
  interface Window {
    jot: JotBridge
  }
}

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<object, object, unknown>
  export default component
}

export {}
