import fs from 'node:fs'
import path from 'node:path'

const appRoot = path.resolve(import.meta.dirname, '..')
const repoRoot = path.dirname(appRoot)
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0
const normalize = text => text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').trimEnd() + '\n'
const pkg = readJson(path.join(appRoot, 'package.json'))
const target = { os: 'win32', cpu: 'x64' }

function locate(name, from) {
  for (let dir = from; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'node_modules', name, 'package.json')
    if (fs.existsSync(candidate)) return fs.realpathSync(path.dirname(candidate))
    if (path.dirname(dir) === dir) return null
  }
}

function supported(values, current) {
  if (!values) return true
  return !values.includes('!' + current) && (!values.some(value => !value.startsWith('!')) || values.includes(current) || values.includes('any'))
}

function rendererRoots() {
  const roots = new Set(Object.keys(pkg.dependencies))
  const visit = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) visit(full)
      else if (/\.(?:ts|vue)$/.test(entry.name)) {
        const source = fs.readFileSync(full, 'utf8')
        for (const match of source.matchAll(/\b(?:from\s*|import\s*\(?\s*)['"]([^'"]+)['"]/g)) {
          const name = match[1].startsWith('@') ? match[1].split('/').slice(0, 2).join('/') : match[1].split('/')[0]
          if (Object.hasOwn(pkg.devDependencies, name)) roots.add(name)
        }
      }
    }
  }
  visit(path.join(appRoot, 'src'))
  return [...roots].sort(compare)
}

const supplemental = readJson(path.join(repoRoot, 'licenses/supplemental.json'))
const missing = []
function licenseFiles(dir, info) {
  const files = fs.readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isFile() && /^(?:licen[cs]e|copying|copyright|notice)(?:$|[.\-_])/i.test(entry.name))
    .sort((a, b) => compare(a.name, b.name))
    .map(entry => ({ label: entry.name, text: normalize(fs.readFileSync(path.join(dir, entry.name), 'utf8')) }))
  if (!files.length && info.name.startsWith('@earendil-works/pi-') && info.version === '1.5.2') {
    files.push({ label: 'Pi v1.5.2 upstream LICENSE (see licenses/pi-LICENSE.txt)', text: normalize(fs.readFileSync(path.join(repoRoot, 'licenses/pi-LICENSE.txt'), 'utf8')) })
  }
  if (!files.length) {
    const readme = ['README.md', 'readme.md'].map(file => path.join(dir, file)).find(file => fs.existsSync(file))
    const text = readme ? fs.readFileSync(readme, 'utf8') : ''
    if (/Permission is hereby granted/i.test(text) && /THE SOFTWARE IS PROVIDED/i.test(text)) files.push({ label: 'README.md (contains full license and copyright notice)', text: normalize(text) })
  }
  if (!files.length) {
    const extra = supplemental[info.name + '@' + info.version]
    if (extra) {
      if (info.license !== extra.license) throw new Error('Supplemental license mismatch: ' + info.name)
      files.push({ label: extra.source + '\n' + extra.note, text: normalize(fs.readFileSync(path.join(repoRoot, 'licenses', extra.file), 'utf8')) })
    }
  }
  if (!files.length) missing.push(info.name + '@' + info.version + ' — ' + JSON.stringify(info.repository ?? null))
  return files
}

const entries = new Map()
function visit(name, from, optional = false) {
  const dir = locate(name, from)
  if (!dir) {
    if (optional) return
    throw new Error('Dependency not installed: ' + name + '; run pnpm install --frozen-lockfile')
  }
  const info = readJson(path.join(dir, 'package.json'))
  if (!supported(info.os, target.os) || !supported(info.cpu, target.cpu)) return
  const id = info.name + '@' + info.version
  if (entries.has(id)) return
  const license = typeof info.license === 'string' ? info.license : info.license?.type
  if (!license) throw new Error('Missing SPDX license: ' + id)
  entries.set(id, { id, name: info.name, version: info.version, license, files: licenseFiles(dir, info) })
  const optionalNames = new Set(Object.keys(info.optionalDependencies ?? {}))
  for (const dep of Object.keys(info.dependencies ?? {}).sort(compare)) visit(dep, dir, optionalNames.has(dep))
  for (const dep of [...optionalNames].sort(compare)) visit(dep, dir, true)
  for (const dep of Object.keys(info.peerDependencies ?? {}).sort(compare)) visit(dep, dir, !!info.peerDependenciesMeta?.[dep]?.optional)
}

const roots = rendererRoots()
for (const name of roots) visit(name, appRoot)
if (missing.length) throw new Error('Missing license texts:' + '\n' + missing.join('\n'))
const sorted = [...entries.values()].sort((a, b) => compare(a.id, b.id))
const electronVersion = readJson(path.join(locate('electron', appRoot), 'package.json')).version
const notices = `# Third-party notices

Jot's original work is licensed under Apache-2.0. Third-party components retain their own licenses and copyright notices.

This inventory is generated from the installed, locked dependencies for Windows x64: application runtime dependencies, packages imported by the renderer, and their installed dependency/peer closure. Development-only tools are not shipped. Regenerate with \`cd app && pnpm licenses:generate\`; validate with \`pnpm licenses:check\`.

Full copyright and license texts are included in [licenses/THIRD_PARTY_LICENSES.txt](licenses/THIRD_PARTY_LICENSES.txt). A package's presence in this conservative inventory does not imply that every module in it is executed. DOMPurify offers MPL-2.0 OR Apache-2.0; Jot distributes it under the Apache-2.0 option and preserves its notices.

Electron ${electronVersion} is distributed under MIT with additional Chromium and third-party terms. The Windows application includes \`LICENSE.electron.txt\` and \`LICENSES.chromium.html\`; keep both files with redistributed builds.

Some npm packages omit license files. Pinned upstream or shared repository texts and the reason for each substitution are recorded in [licenses/supplemental.json](licenses/supplemental.json); complete MIT notices embedded in package READMEs are also retained.

The Pi npm packages use the MIT license from the corresponding [upstream v1.5.2 release](https://github.com/earendil-works/pi/blob/v1.5.2/LICENSE); a copy is kept in [licenses/pi-LICENSE.txt](licenses/pi-LICENSE.txt).

The bundled Jot capability instructions and templates are maintained for Jot's own tool contracts. External plugins, skills, templates, fonts, and other files installed by users remain subject to their respective licenses. This inventory does not grant rights to arbitrary imported content.

## Distributed dependency inventory

| Package | Version | License |
| --- | --- | --- |
${sorted.map(entry => `| [${entry.name}](https://www.npmjs.com/package/${entry.name}/v/${entry.version}) | ${entry.version} | ${entry.license.replaceAll('|', '\\|')} |`).join('\n')}

## Inventory roots

${roots.map(name => '- \`' + name + '\`').join('\n')}
`
const texts = 'Jot — bundled third-party copyright and license texts\n'
  + 'Target: Windows x64. Generated by app/scripts/licenses.mjs.\n\n'
  + sorted.map(entry => '='.repeat(72) + '\n' + entry.id + '\nDeclared license: ' + entry.license + '\n\n'
    + entry.files.map(file => '--- ' + file.label + ' ---\n' + file.text).join('\n')).join('\n')
const outputs = [
  [path.join(repoRoot, 'THIRD_PARTY_NOTICES.md'), normalize(notices)],
  [path.join(repoRoot, 'licenses/THIRD_PARTY_LICENSES.txt'), normalize(texts)],
]
const args = process.argv.slice(2)
if (args.length && !(args.length === 1 && args[0] === '--check')) throw new Error('Usage: node scripts/licenses.mjs [--check]')
for (const [file, contents] of outputs) {
  if (args.includes('--check')) {
    if (!fs.existsSync(file) || normalize(fs.readFileSync(file, 'utf8')) !== contents) throw new Error('License inventory is stale; run pnpm licenses:generate')
  } else {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, contents, 'utf8')
  }
}
console.log((args.includes('--check') ? 'Verified' : 'Generated') + ' notices for ' + sorted.length + ' dependency versions.')
console.log('License expressions: ' + [...new Set(sorted.map(entry => entry.license))].sort(compare).join(', '))
