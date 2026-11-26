import { describe, expect, it } from 'vitest'
import { resolveTarget, rewriteLinks, scanLinks } from '../../electron/vault/links'

describe('当前路径链接解析与维护', () => {
  it('识别相对链接、图片、引用定义和双链，排除代码和注释', () => {
    const body = '[资料](../a.md#锚点 "标题")\n![图](图.png)\n[引用]: <../含 空格.md>\n[[content/甲|别名]]\n`[内联](x)`\n~~~md\n[[示例]]\n~~~\n<!-- [注释](x) -->'
    expect(scanLinks(body).map(link => link.target)).toEqual(['../a.md#锚点', '图.png', '../含 空格.md', 'content/甲'])
  })
  it('链接目标含括号、编码空格和锚点时保留语义', () => {
    const body = '[资料](资料(甲).md#段落)\n[另一个](<有 空格.md>)'
    const next = rewriteLinks(body, 'content/A.md', 'content/A.md', [{ from: 'content/资料(甲).md', to: 'content/新 资料.md' }], ['content/资料(甲).md', 'content/有 空格.md'])
    expect(next).toContain('新%20资料.md'.replace('新', encodeURIComponent('新')).replace('资料', encodeURIComponent('资料')) + '#段落')
    expect(next).toContain('[另一个](<有 空格.md>)')
  })
  it('双链单名必须唯一，普通相对路径不按同名猜测，库外及应用目录不能访问', () => {
    const paths = ['content/A/同名.md', 'content/B/同名.md']
    expect(resolveTarget('content/笔记.md', '同名', 'wiki', paths).ambiguous).toHaveLength(2)
    expect(resolveTarget('content/笔记.md', '同名.md', 'markdown', paths).path).toBeUndefined()
    for (const target of ['../../secret', '%2e%2e/%2e%2e/secret', '../.jot/state.db', 'C:/secret', 'https://example.com']) {
      expect(resolveTarget('content/笔记.md', target, 'markdown', [...paths, '.jot/state.db']).path).toBeUndefined()
    }
  })
  it('移动文件重算出链，锚点和显示文字不变，歧义双链保持原样', () => {
    const next = rewriteLinks('[规则](规则.md#细则)\n[[同名|别名]]', 'content/甲.md', 'content/子目录/甲.md',
      [{ from: 'content/甲.md', to: 'content/子目录/甲.md' }], ['content/规则.md', 'content/A/同名.md', 'content/B/同名.md'])
    expect(next).toContain('[规则](' + encodeURI('../规则.md') + '#细则)')
    expect(next).toContain('[[同名|别名]]')
  })
})
