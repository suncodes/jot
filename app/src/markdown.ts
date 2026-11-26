import DOMPurify from 'dompurify'
import MarkdownIt from 'markdown-it'
import { CITATION_SOURCE } from '@shared/citations'

// Markdown 预览：不允许内嵌 HTML，渲染结果再过滤一遍，不执行其中的脚本。
const md = new MarkdownIt({ html: false, linkify: true, breaks: true })
const validateLink = md.validateLink
md.validateLink = url => /^file:\/\//i.test(url) || validateLink(url)
// 本地文件链接交给应用点击处理，避免让页面导航到 file URL。
md.renderer.rules.link_open = (tokens, idx, options, _env, self) => {
  const token = tokens[idx]!
  const href = token.attrGet('href')
  if (typeof href === 'string' && /^file:\/\//i.test(href)) {
    token.attrSet('data-file', href)
    token.attrSet('href', '#')
  }
  return self.renderToken(tokens, idx, options)
}

// 给块级元素记下它在正文里的起始行，用来从搜索结果定位到对应位置
for (const rule of ['paragraph_open', 'heading_open', 'blockquote_open', 'bullet_list_open', 'ordered_list_open', 'list_item_open', 'table_open', 'hr'] as const) {
  const fallback = md.renderer.rules[rule]
  md.renderer.rules[rule] = (tokens, idx, options, env, self) => {
    const token = tokens[idx]
    if (token?.map) token.attrSet('data-line', String(token.map[0] + 1))
    return fallback ? fallback(tokens, idx, options, env, self) : self.renderToken(tokens, idx, options)
  }
}
const fence = md.renderer.rules.fence!
md.renderer.rules.fence = (tokens, idx, options, env, self) => {
  const line = tokens[idx]?.map?.[0]
  const html = fence(tokens, idx, options, env, self)
  return line === undefined ? html : html.replace(/^<pre/, `<pre data-line="${line + 1}"`)
}

// [[双链]]：渲染成可点击的链接，目标写在 data-wikilink 里
md.inline.ruler.before('link', 'wikilink', (state, silent) => {
  const src = state.src
  if (src.charCodeAt(state.pos) !== 0x5b || src.charCodeAt(state.pos + 1) !== 0x5b) return false
  const end = src.indexOf(']]', state.pos + 2)
  if (end < 0) return false
  const inner = src.slice(state.pos + 2, end)
  if (!inner.trim() || inner.includes('\n')) return false
  if (!silent) {
    const [target = '', label] = inner.split('|')
    const open = state.push('link_open', 'a', 1)
    open.attrSet('href', '#')
    open.attrSet('class', 'wikilink')
    open.attrSet('data-wikilink', target.split('#')[0]!.trim())
    state.push('text', '', 0).content = (label ?? target).trim()
    state.push('link_close', 'a', -1)
  }
  state.pos = end + 2
  return true
})

// 助手回答里的出处标记 [^片段编号]：渲染成可点击的小标签。只在渲染回答时启用。
export interface CiteInfo {
  label: string
  title: string
  state: 'valid' | 'invalid' | 'pending'
  ai: boolean
}
md.inline.ruler.before('link', 'cite', (state, silent) => {
  const lookup = (state.env as { cite?: (marker: string) => CiteInfo } | undefined)?.cite
  if (!lookup || state.src.charCodeAt(state.pos) !== 0x5b || state.src.charCodeAt(state.pos + 1) !== 0x5e) return false
  const m = new RegExp('^' + CITATION_SOURCE).exec(state.src.slice(state.pos, state.pos + 83))
  if (!m) return false
  if (!silent) {
    const info = lookup(m[1]!)
    const open = state.push('link_open', 'a', 1)
    open.attrSet('href', '#')
    open.attrSet('class', `cite ${info.state}${info.ai ? ' ai' : ''}`)
    open.attrSet('data-cite', m[1]!)
    open.attrSet('title', info.title)
    state.push('text', '', 0).content = info.label
    state.push('link_close', 'a', -1)
  }
  state.pos += m[0].length
  return true
})

const PURIFY = { ADD_ATTR: ['data-line', 'data-wikilink', 'data-cite', 'data-file', 'target'] }

export function renderMarkdown(body: string): string {
  return DOMPurify.sanitize(md.render(body), PURIFY)
}

/** 渲染助手的回答：出处标记变成标签，标签上的文字和状态由 cite 提供 */
export function renderAnswer(text: string, cite: (marker: string) => CiteInfo): string {
  return DOMPurify.sanitize(md.render(text, { cite }), PURIFY)
}
