import yaml from 'js-yaml'

// 文件头（frontmatter）的解析与生成。键名用英文，取值用中文。见 docs/architecture.md。

const BLOCK = /^---\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/

/** 写出时的键顺序；不在列表里的键按原有顺序排在后面 */
const KEY_ORDER = [
  'type', 'date', 'created', 'occurred_at', 'source', 'start', 'end',
  'generated_by', 'generated_at', 'model', 'source_hash',
  'tags', 'place', 'people', 'aliases',
]

export interface ParsedDoc {
  data: Record<string, unknown>
  body: string
  /** 正文第一行在文件里的行号（从 1 开始） */
  bodyStartLine: number
  hasFrontmatter: boolean
  /** 文件头不是合法的 YAML：按没有属性处理，并且不允许改写文件头 */
  invalid: boolean
}

export function parseDoc(text: string): ParsedDoc {
  const src = text.replace(/^﻿/, '')
  const m = BLOCK.exec(src)
  if (!m) return { data: {}, body: src, bodyStartLine: 1, hasFrontmatter: false, invalid: false }
  const body = src.slice(m[0].length)
  const bodyStartLine = m[0].split('\n').length
  try {
    // JSON_SCHEMA：时间保持为字符串，不转成 Date
    const loaded = m[1] ? yaml.load(m[1], { schema: yaml.JSON_SCHEMA }) : {}
    if (loaded !== undefined && loaded !== null && (typeof loaded !== 'object' || Array.isArray(loaded))) throw new Error('文件头必须是 YAML 对象')
    return { data: (loaded ?? {}) as Record<string, unknown>, body, bodyStartLine, hasFrontmatter: true, invalid: false }
  } catch {
    return { data: {}, body, bodyStartLine, hasFrontmatter: true, invalid: true }
  }
}

export function stringifyDoc(data: Record<string, unknown>, body: string): string {
  const keys = Object.keys(data).filter((k) => data[k] !== undefined)
  if (keys.length === 0) return body
  const rank = (k: string) => {
    const i = KEY_ORDER.indexOf(k)
    return i < 0 ? KEY_ORDER.length : i
  }
  const ordered: Record<string, unknown> = {}
  for (const k of keys.map((k, i) => [k, i] as const).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1])) {
    ordered[k[0]] = data[k[0]]
  }
  // flowLevel: 1 —— 数组写成 [a, b] 的行内形式，和 Obsidian 的属性显示一致
  const head = yaml.dump(ordered, { schema: yaml.JSON_SCHEMA, lineWidth: -1, flowLevel: 1, quotingType: '"' })
  return `---\n${head}---\n${body}`
}
