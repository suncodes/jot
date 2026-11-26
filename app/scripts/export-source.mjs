import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'

const ROOT_FILES = ['.env.example', '.gitattributes', '.gitignore', 'LICENSE', 'NOTICE', 'README.md', 'README.en.md', 'THIRD_PARTY_NOTICES.md', 'PRIVACY.md', 'SECURITY.md', 'CONTRIBUTING.md', 'KNOWN_ISSUES.md', 'CHANGELOG.md']
const APP_FILES = ['.npmrc', 'package.json', 'pnpm-lock.yaml', 'electron.vite.config.ts', 'eslint.config.js', 'playwright.config.ts', 'playwright.packed.config.ts', 'tsconfig.base.json', 'tsconfig.e2e.json', 'tsconfig.json', 'tsconfig.node.json', 'tsconfig.web.json', 'vitest.config.ts', 'vitest.llm.config.ts', 'vitest.perf.config.ts']
const DOC_FILES = ['README.md', 'user-guide.md', 'development.md', 'architecture.md', 'plugins.md', 'work-reports.md', 'release.md']
const DIRECTORIES = ['.github', 'licenses', 'app/electron', 'app/shared', 'app/src', 'app/resources', 'app/scripts', 'app/tests']
const BLOCKED = new Set(['.git', '.jot', 'node_modules', 'out', 'dist', 'dist-refresh', 'tmp', 'coverage', 'logs', 'test-results', 'playwright-report', 'blob-report'])
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0

function within(root, candidate) {
  const rel = path.relative(root, candidate)
  return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + path.sep))
}

function noLinks(file) {
  for (let current = file; ; current = path.dirname(current)) {
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error('Symbolic links and junctions are not allowed in source exports')
    if (path.dirname(current) === current) break
  }
}

function excluded(name) {
  return BLOCKED.has(name) || name.startsWith('.tmp-')
    || (name.startsWith('.env') && name !== '.env.example')
    || /\.(?:log|db(?:-wal|-shm)?|sqlite3?|pem|key|p8|p12|pfx|tsbuildinfo)$/i.test(name)
}

export function exportSource({ root = path.resolve(import.meta.dirname, '../..'), destination } = {}) {
  root = path.resolve(root)
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'app/package.json'), 'utf8').replace(/^\uFEFF/, ''))
  const output = path.resolve(destination ?? path.join(root, 'tmp/open-source', 'jot-' + pkg.version))
  if (within(output, root) || (within(root, output) && !within(path.join(root, 'tmp/open-source'), output))) throw new Error('Export must use tmp/open-source/ or a separate directory outside the development source')
  noLinks(root)
  noLinks(output)
  if (fs.existsSync(output) && (!fs.statSync(output).isDirectory() || fs.readdirSync(output).length)) throw new Error('Export destination must be empty; existing files will not be overwritten')

  const files = []
  function collect(relative) {
    const source = path.join(root, relative)
    const stat = fs.lstatSync(source)
    if (stat.isSymbolicLink()) throw new Error('Symbolic link in public source: ' + relative)
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(source).sort(compare)) {
        if (!excluded(entry)) collect(relative + '/' + entry)
      }
    } else if (stat.isFile()) {
      if (!within(root, source)) throw new Error('Source path escapes repository')
      files.push(relative.replaceAll('\\', '/'))
    } else throw new Error('Unsupported source entry: ' + relative)
  }
  for (const file of [...ROOT_FILES, ...APP_FILES.map(file => 'app/' + file), ...DOC_FILES.map(file => 'docs/' + file), ...DIRECTORIES]) collect(file)

  files.sort(compare)
  const manifest = { schemaVersion: 1, name: pkg.name, version: pkg.version, files: [] }
  fs.mkdirSync(output, { recursive: true })
  for (const file of files) {
    const content = fs.readFileSync(path.join(root, file))
    const target = path.join(output, file)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, content, { flag: 'wx' })
    manifest.files.push({ path: file, bytes: content.length, sha256: createHash('sha256').update(content).digest('hex') })
  }
  fs.writeFileSync(path.join(output, 'SOURCE_MANIFEST.json'), JSON.stringify(manifest, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' })
  return { output, manifest }
}

function main(args) {
  if (args.length && !(args.length === 2 && args[0] === '--out')) throw new Error('Usage: node scripts/export-source.mjs [--out EMPTY_DIRECTORY]')
  const { output, manifest } = exportSource({ destination: args[1] })
  console.log('Exported ' + manifest.files.length + ' public files to ' + output)
  console.log('Review SOURCE_MANIFEST.json before initializing or publishing a new repository.')
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try { main(process.argv.slice(2)) } catch (error) { console.error(error.message); process.exitCode = 1 }
}
