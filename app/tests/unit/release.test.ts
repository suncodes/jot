import fs from 'node:fs'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'

const appRoot = path.resolve(import.meta.dirname, '../..')
const root = path.dirname(appRoot)
const temp: (() => void)[] = []
function scratch() {
  const parent = path.join(root, 'tmp/open-source')
  fs.mkdirSync(parent, { recursive: true })
  const dir = fs.mkdtempSync(path.join(parent, 'test-'))
  temp.push(() => {
    if (!path.resolve(dir).startsWith(parent + path.sep)) throw new Error('源码导出测试路径越界')
    fs.rmSync(dir, { recursive: true, force: true })
  })
  return dir
}
const script = (name: string) => path.join(appRoot, 'scripts', name)
const run = (file: string, args: string[]) => execFileSync(process.execPath, [file, ...args], { encoding: 'utf8', env: { ...process.env, JOT_NO_DOTENV: '1' } })
interface Manifest { version: string; files: { path: string; bytes: number; sha256: string }[] }
afterEach(() => { for (const cleanup of temp.splice(0)) cleanup() })

describe('公开源码与发行入口', () => {
  it('标签与当前版本必须匹配；校验不会修改版本或创建Git记录', () => {
    const file = path.join(appRoot, 'package.json'), before = fs.readFileSync(file, 'utf8')
    const version = (JSON.parse(before.replace(/^\uFEFF/, '')) as { version: string }).version
    expect(run(script('version.mjs'), ['check', '--tag', 'v' + version])).toContain('valid')
    const failed = spawnSync(process.execPath, [script('version.mjs'), 'check', '--tag', 'v999.0.0'], { encoding: 'utf8' })
    expect(failed.status).toBe(1)
    expect(failed.stderr).toContain('must match')
    expect(fs.readFileSync(file, 'utf8')).toBe(before)
  })

  it('实际公开清单有可核对哈希，排除凭证、开发历史、依赖和打包文件', () => {
    const out = path.join(scratch(), 'source')
    run(script('export-source.mjs'), ['--out', out])
    const manifest = JSON.parse(fs.readFileSync(path.join(out, 'SOURCE_MANIFEST.json'), 'utf8')) as Manifest
    const paths = manifest.files.map(file => file.path)
    expect(paths).toContain('app/resources/plugins/jot-productivity/skills/skill-manager/SKILL.md')
    expect(paths).toContain('app/resources/app-extensions/work-diary/extension.json')
    expect(paths).toContain('app/pnpm-lock.yaml')
    expect(paths).toContain('app/playwright.chrome.config.ts')
    expect(paths).toContain('app/shared/model-protocol.ts')
    expect(paths).toContain('app/shared/model-discovery.ts')
    expect(paths).toContain('app/electron/llm/model-discovery.ts')
    expect(paths).toContain('app/src/components/ModelDiscoveryDialog.vue')
    expect(paths).toContain('app/scripts/test-chrome.mjs')
    expect(paths).toContain('.env.example')
    expect(paths).toContain('.github/workflows/release.yml')
    expect(paths).toContain('licenses/THIRD_PARTY_LICENSES.txt')
    expect(paths.some(file => /(^|\/)(?:\.git|\.jot|tmp|node_modules|dist|out)(\/|$)/.test(file))).toBe(false)
    expect(paths.some(file => file === '.env' || file === 'CLAUDE.md' || file.startsWith('docs/progress/') || file.startsWith('docs/prototypes/'))).toBe(false)
    for (const file of manifest.files) {
      const content = fs.readFileSync(path.join(out, file.path))
      expect(content.length).toBe(file.bytes)
      expect(createHash('sha256').update(content).digest('hex')).toBe(file.sha256)
    }
    expect(fs.existsSync(path.join(out, '.git'))).toBe(false)
  })

  it('拒绝覆盖已有目录，也拒绝把源码导出到工程源码目录', () => {
    const out = scratch()
    fs.writeFileSync(path.join(out, 'keep.txt'), 'keep', 'utf8')
    const failed = spawnSync(process.execPath, [script('export-source.mjs'), '--out', out], { encoding: 'utf8' })
    expect(failed.status).toBe(1)
    expect(failed.stderr).toContain('must be empty')
    expect(fs.readFileSync(path.join(out, 'keep.txt'), 'utf8')).toBe('keep')
    const inside = spawnSync(process.execPath, [script('export-source.mjs'), '--out', path.join(root, 'app/new-public-source')], { encoding: 'utf8' })
    expect(inside.status).toBe(1)
    expect(inside.stderr).toContain('separate directory')
    expect(fs.existsSync(path.join(root, 'app/new-public-source'))).toBe(false)
  })

  it('源码中的链接或junction不能把公开范围扩展到外部文件', () => {
    const base = scratch(), source = path.join(base, 'fixture'), out = path.join(base, 'out')
    run(script('export-source.mjs'), ['--out', source])
    const external = path.join(base, 'private')
    fs.mkdirSync(external); fs.writeFileSync(path.join(external, 'secret.txt'), 'private fixture')
    fs.symlinkSync(external, path.join(source, 'app/resources/external'), process.platform === 'win32' ? 'junction' : 'dir')
    const failed = spawnSync(process.execPath, [path.join(source, 'app/scripts/export-source.mjs'), '--out', out], { encoding: 'utf8' })
    expect(failed.status).toBe(1)
    expect(failed.stderr).toContain('Symbolic link')
    expect(fs.existsSync(out)).toBe(false)
  })
})
