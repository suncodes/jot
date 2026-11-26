import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { databaseUsage, maintainDatabase } from '../util/database'
import { JotError } from '@shared/result'
import { contentArea } from '@shared/storage'
import type { ContentSuggestion, SuggestionKind } from '@shared/pending'
import { mappedPath } from '../vault/links'
import type { PathChange } from '@shared/files'
import type { TermKind } from '@shared/types'

// 仅保存不能从内容文件重建的应用资料，不保存文件身份、属性副本或编辑历史。
export const STATE_VERSION = 11
const SCHEMA = `
CREATE TABLE jobs (
  id TEXT PRIMARY KEY, type TEXT NOT NULL, payload TEXT NOT NULL, dedupe_key TEXT,
  state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, model_waits INTEGER NOT NULL DEFAULT 0,
  next_run_at INTEGER NOT NULL, error TEXT, target TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX idx_jobs_state ON jobs(state, next_run_at);
CREATE TABLE suggestions (
  path TEXT NOT NULL COLLATE NOCASE, kind TEXT NOT NULL, suggestion TEXT NOT NULL,
  at INTEGER NOT NULL, PRIMARY KEY (path, kind)
);
CREATE TABLE vocab (kind TEXT NOT NULL, name TEXT NOT NULL, state TEXT NOT NULL, PRIMARY KEY (kind, name));
CREATE TABLE synonyms (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, names TEXT NOT NULL, suggested TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '', at INTEGER NOT NULL
);
CREATE TABLE conversations (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, selection TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE messages (
  id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL,
  tool_calls TEXT, citations TEXT, error TEXT, created_at TEXT NOT NULL
);
CREATE INDEX idx_messages_conv ON messages(conversation_id, created_at);
CREATE TABLE conversation_summaries (
  conversation_id TEXT NOT NULL, mode TEXT NOT NULL, through_message_id TEXT NOT NULL,
  summary TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (conversation_id, mode)
);
`
type VocabularyState = 'official' | 'preset'

export class StateStore {
  private db: Database.Database | null = null
  get raw(): Database.Database {
    if (!this.db) throw new JotError('VAULT_NOT_OPEN', '还没有打开库')
    return this.db
  }
  get isOpen(): boolean { return this.db !== null }
  databaseUsage() { return databaseUsage(this.raw, 'state') }
  maintainStorage(compact: boolean, automatic = false): number { return maintainDatabase(this.raw, compact, automatic) }

  open(file: string): void {
    this.close()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const db = new Database(file)
    try {
      const version = db.pragma('user_version', { simple: true }) as number
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()
      if (version !== STATE_VERSION && (version !== 0 || tables.length)) {
        throw new JotError('INVALID_INPUT', '此状态库属于其他格式，请先备份并处理旧应用资料；不会自动迁移或清空对话')
      }
      if (version === 0) db.transaction(() => { db.exec(SCHEMA); db.pragma('user_version = ' + STATE_VERSION) })()
      db.pragma('journal_mode = WAL')
      this.db = db
    } catch (error) { db.close(); throw error }
  }
  close(): void { this.db?.close(); this.db = null }

  setSuggestion(rel: string, suggestion: ContentSuggestion): void {
    this.raw.prepare('INSERT OR REPLACE INTO suggestions VALUES (?,?,?,?)')
      .run(rel, suggestion.kind, JSON.stringify(suggestion), Date.now())
  }
  getSuggestions(rel: string): ContentSuggestion[] {
    const rows = this.raw.prepare('SELECT suggestion FROM suggestions WHERE path=? ORDER BY kind').all(rel) as { suggestion: string }[]
    return rows.map(row => JSON.parse(row.suggestion) as ContentSuggestion)
  }
  getSuggestion(rel: string, kind: SuggestionKind): ContentSuggestion | null {
    return this.getSuggestions(rel).find(suggestion => suggestion.kind === kind) ?? null
  }
  suggestionPaths(): string[] {
    return (this.raw.prepare("SELECT DISTINCT path FROM suggestions WHERE kind='properties'").all() as { path: string }[]).map(row => row.path)
  }
  removeSuggestion(rel: string, kind?: SuggestionKind): void {
    if (kind) this.raw.prepare('DELETE FROM suggestions WHERE path=? AND kind=?').run(rel, kind)
    else this.raw.prepare('DELETE FROM suggestions WHERE path=?').run(rel)
  }
  /** 人工修改仅清除对应属性的建议，不影响其他字段或目录推荐。 */
  discardPropertySuggestions(rel: string, fields: readonly string[]): void {
    const suggestion = this.getSuggestion(rel, 'properties')
    if (suggestion?.kind !== 'properties') return
    const remaining: Record<string, unknown> = { ...suggestion.properties }
    for (const field of fields) delete remaining[field]
    if (Object.keys(remaining).length) this.setSuggestion(rel, { ...suggestion, properties: remaining })
    else this.removeSuggestion(rel, 'properties')
  }
  /** 只跟随本次应用内已知映射，不按内容猜测外部移动。 */
  moveSuggestions(changes: PathChange[]): void {
    const rows = this.raw.prepare('SELECT path,kind,suggestion,at FROM suggestions').all() as { path: string; kind: SuggestionKind; suggestion: string; at: number }[]
    this.raw.transaction(() => {
      for (const row of rows) this.removeSuggestion(row.path)
      for (const row of rows) {
        const suggestion = JSON.parse(row.suggestion) as ContentSuggestion
        if (suggestion.kind === 'directory' && contentArea(mappedPath(row.path, changes)) !== 'inbox') continue
        if (suggestion.kind === 'directory') suggestion.directoryPath = mappedPath(suggestion.directoryPath, changes)
        this.raw.prepare('INSERT OR REPLACE INTO suggestions VALUES (?,?,?,?)')
          .run(mappedPath(row.path, changes), row.kind, JSON.stringify(suggestion), row.at)
      }
    })()
  }
  confirmTerms(kind: TermKind, names: string[], state: VocabularyState = 'official'): void {
    const stmt = this.raw.prepare("INSERT INTO vocab VALUES (?,?,?) ON CONFLICT(kind,name) DO UPDATE SET state=excluded.state WHERE vocab.state <> 'preset'")
    for (const name of names) if (name.trim()) stmt.run(kind, name.trim(), state)
  }
  vocabulary(kind: TermKind): Map<string, VocabularyState> {
    const rows = this.raw.prepare("SELECT name,state FROM vocab WHERE kind=? AND state IN ('official','preset')").all(kind) as { name: string; state: VocabularyState }[]
    return new Map(rows.map(row => [row.name, row.state]))
  }
  renameTerm(kind: TermKind, from: string, to: string): void {
    const db = this.raw
    db.transaction(() => {
      const source = db.prepare('SELECT state FROM vocab WHERE kind=? AND name=?').get(kind, from) as { state: string } | undefined
      db.prepare('DELETE FROM vocab WHERE kind=? AND name=?').run(kind, from)
      this.confirmTerms(kind, [to], source?.state === 'preset' ? 'preset' : 'official')
    })()
  }
  replaceSynonyms(kind: string, groups: { names: string[]; suggested: string; reason: string }[], makeId: () => string): void {
    this.raw.transaction(() => {
      this.raw.prepare('DELETE FROM synonyms WHERE kind=?').run(kind)
      const stmt = this.raw.prepare('INSERT INTO synonyms VALUES (?,?,?,?,?,?)')
      for (const g of groups) stmt.run(makeId(), kind, JSON.stringify(g.names), g.suggested, g.reason, Date.now())
    })()
  }
  synonyms(): { id: string; kind: string; names: string[]; suggested: string; reason: string }[] {
    const rows = this.raw.prepare('SELECT id,kind,names,suggested,reason FROM synonyms ORDER BY rowid').all() as { id: string; kind: string; names: string; suggested: string; reason: string }[]
    return rows.map(r => ({ ...r, names: JSON.parse(r.names) as string[] }))
  }
  removeSynonym(id: string): void { this.raw.prepare('DELETE FROM synonyms WHERE id=?').run(id) }
}
