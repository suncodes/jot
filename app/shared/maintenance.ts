/** 当前实际占用；维护只处理可识别的残留和数据库空闲页。 */
export interface DatabaseUsage {
  kind: 'index' | 'state'
  bytes: number
  walBytes: number
  reclaimableBytes: number
}
export interface StorageUsage {
  vaultPath: string
  contentBytes: number
  derivedBytes: number
  configurationBytes: number
  trash: { items: number; bytes: number; expiredItems: number }
  conversations: { count: number; messages: number }
  temporary: { files: number; bytes: number; retainedFiles: number; retainedBytes: number }
  databases: DatabaseUsage[]
}
export interface TemporaryCleanup {
  removed: number
  freedBytes: number
  failures: { path: string; message: string }[]
}
export interface DatabaseMaintenance {
  freedBytes: number
  failures: { database: DatabaseUsage['kind']; message: string }[]
}
