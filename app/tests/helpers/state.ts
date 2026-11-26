/** 迁移测试明确恢复旧版建议表，不能仅把新版数据库版本号改小。 */
export const LEGACY_SUGGESTIONS_SQL = `
  DROP TABLE suggestions;
  CREATE TABLE suggestions (
    path TEXT PRIMARY KEY, classification TEXT NOT NULL, confidence REAL NOT NULL,
    reason TEXT NOT NULL DEFAULT '', at INTEGER NOT NULL
  );
`
