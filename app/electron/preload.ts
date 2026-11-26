import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import { CHANNELS, EVENTS, type JotBridge } from '@shared/ipc'

// 界面只能通过这里暴露的接口访问主进程，通道和事件都限制在白名单内。
const channels = new Set<string>(CHANNELS)
const events = new Set<string>(EVENTS)

const bridge: JotBridge = {
  invoke(channel: string, args?: unknown) {
    if (!channels.has(channel)) return Promise.reject(new Error(`未知的通道：${channel}`))
    return ipcRenderer.invoke(channel, args)
  },
  on(event: string, listener: (data: unknown) => void) {
    if (!events.has(event)) throw new Error(`未知的事件：${event}`)
    const wrapped = (_e: IpcRendererEvent, data: unknown) => listener(data)
    ipcRenderer.on(event, wrapped)
    return () => ipcRenderer.removeListener(event, wrapped)
  },
  pathForFile(file: unknown) {
    try {
      return webUtils.getPathForFile(file as File)
    } catch {
      return ''
    }
  },
} as unknown as JotBridge

contextBridge.exposeInMainWorld('jot', bridge)
