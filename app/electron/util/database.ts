import fs from 'node:fs'
import type Database from 'better-sqlite3'
import { JotError } from '@shared/result'
import type { DatabaseUsage } from '@shared/maintenance'

const fileSize = (file: string) => file === ':memory:' ? 0 : fs.statSync(file, { throwIfNoEntry: false })?.size ?? 0
const diskBytes = (db: Database.Database) => fileSize(db.name) + fileSize(db.name + '-wal')

export function databaseUsage(db: Database.Database, kind: DatabaseUsage['kind']): DatabaseUsage {
  return {
    kind, bytes: fileSize(db.name), walBytes: fileSize(db.name + '-wal'),
    reclaimableBytes: (db.pragma('freelist_count', { simple: true }) as number) * (db.pragma('page_size', { simple: true }) as number),
  }
}

/** 只回收已释放的页；自动维护不等待其他程序的锁，不在启动时强制压缩。 */
export function maintainDatabase(db: Database.Database, compact: boolean, automatic = false): number {
  if (db.inTransaction) {
    if (automatic) return 0
    throw new JotError('CONFLICT', '数据仍在保存，请稍后再维护数据库')
  }
  const before = diskBytes(db)
  const timeout = db.pragma('busy_timeout', { simple: true }) as number
  if (automatic) db.pragma('busy_timeout = 0')
  try {
    const [{ busy } = { busy: 0 }] = db.pragma('wal_checkpoint(TRUNCATE)') as { busy: number }[]
    if (busy) {
      if (automatic) return 0
      throw new JotError('CONFLICT', '数据库正在被使用，请稍后再维护')
    }
    const free = db.pragma('freelist_count', { simple: true }) as number
    const pages = db.pragma('page_count', { simple: true }) as number
    const pageSize = db.pragma('page_size', { simple: true }) as number
    if (compact && (!automatic || free * pageSize >= 32 * 1024 * 1024 && free >= pages / 4)) {
      db.exec('VACUUM')
      db.pragma('wal_checkpoint(TRUNCATE)')
    }
    return Math.max(0, before - diskBytes(db))
  } finally {
    if (automatic) db.pragma('busy_timeout = ' + timeout)
  }
}
