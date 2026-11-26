import { createApp } from 'vue'
import { createPinia } from 'pinia'
import ModelForm from '../../src/components/ModelForm.vue'
import { useAppStore } from '../../src/stores/app'
import '../../src/styles/base.css'

window.jot = {
  invoke: (channel, args) => fetch('/__jot-test-ipc', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ channel, args }) }).then(async response => {
    const text = await response.text()
    if (!response.ok) throw new Error('Test IPC ' + response.status + ': ' + text)
    return JSON.parse(text)
  }),
  on: () => () => {},
}
const pinia = createPinia(), app = createApp(ModelForm)
app.use(pinia)
const store = useAppStore(pinia)
store.settings = (await window.jot.invoke('settings:get')).data
document.documentElement.dataset.theme = store.settings.appearance.theme
app.mount('#app')
