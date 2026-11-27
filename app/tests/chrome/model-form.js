import { createApp } from 'vue'
import { createPinia } from 'pinia'
import ModelForm from '../../src/components/ModelForm.vue'
import Shell from '../../src/components/Shell.vue'
import { useAppStore } from '../../src/stores/app'
import '../../src/styles/base.css'

const subscribers = new Map()
const events = new EventSource('/__jot-test-events')
events.onmessage = event => {
  const { name, payload } = JSON.parse(event.data)
  for (const listener of subscribers.get(name) ?? []) listener(payload)
}
window.jot = {
  invoke: (channel, args) => fetch('/__jot-test-ipc', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ channel, args }) }).then(async response => {
    const text = await response.text()
    if (!response.ok) throw new Error('Test IPC ' + response.status + ': ' + text)
    return JSON.parse(text)
  }),
  on: (name, listener) => {
    const listeners = subscribers.get(name) ?? new Set()
    listeners.add(listener); subscribers.set(name, listeners)
    return () => listeners.delete(listener)
  },
}
const pinia = createPinia(), app = createApp(new URLSearchParams(location.search).has('shell') ? Shell : ModelForm)
app.use(pinia)
const store = useAppStore(pinia)
await store.init()
app.mount('#app')
