import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const appRoot = path.resolve(import.meta.dirname, '..')
const packageFile = path.join(appRoot, 'package.json')
const component = '(?:0|[1-9][0-9]*)'
const semver = new RegExp('^' + component + '\\.' + component + '\\.' + component + '(?:-([0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*))?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$')

export function isVersion(version) {
  if (typeof version !== 'string') return false
  const match = semver.exec(version)
  return !!match && (!match[1] || match[1].split('.').every(part => !/^0[0-9]+$/.test(part)))
}

export function checkVersionTag(version, tag) {
  if (!isVersion(version)) throw new Error('Invalid package version: ' + version)
  if (tag !== undefined && tag !== 'v' + version) throw new Error('Tag must match package version: v' + version)
}

export function checkMetadata(pkg, tag) {
  checkVersionTag(pkg.version, tag)
  if (pkg.license !== 'Apache-2.0') throw new Error('Expected Apache-2.0 project license')
  if (pkg.repository?.url !== 'git+https://github.com/suncodes/jot.git') throw new Error('Incorrect public repository URL')
  if (pkg.homepage !== 'https://github.com/suncodes/jot#readme' || pkg.bugs?.url !== 'https://github.com/suncodes/jot/issues') throw new Error('Incorrect public support links')
  if (pkg.packageManager !== 'pnpm@9.15.4' || pkg.engines?.node !== '>=24 <25') throw new Error('Use the documented Node and pnpm versions')
}

async function main(args) {
  const pkg = JSON.parse(fs.readFileSync(packageFile, 'utf8').replace(/^\uFEFF/, ''))
  if (args[0] === 'set' && args.length === 2) {
    checkVersionTag(args[1])
    pkg.version = args[1]
    fs.writeFileSync(packageFile, JSON.stringify(pkg, null, 2) + '\n', 'utf8')
    console.log('Version set to ' + pkg.version + '; no commit or tag was created.')
  } else if (args[0] === 'check' && (args.length === 1 || (args.length === 3 && args[1] === '--tag'))) {
    checkMetadata(pkg, args[2])
    console.log('Release metadata valid: v' + pkg.version)
  } else if (args[0] === 'check-packed' && args.length === 2) {
    checkMetadata(pkg)
    const { extractFile } = await import('@electron/asar')
    const packed = JSON.parse(extractFile(path.join(path.resolve(args[1]), 'resources/app.asar'), 'package.json').toString('utf8'))
    if (packed.name !== pkg.name || packed.version !== pkg.version) throw new Error('Packaged application does not match package.json: ' + packed.name + '@' + packed.version)
    console.log('Packaged version valid: v' + packed.version)
  } else {
    throw new Error('Usage: node scripts/version.mjs check [--tag vVERSION] | set VERSION | check-packed DIRECTORY')
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try { await main(process.argv.slice(2)) } catch (error) { console.error(error.message); process.exitCode = 1 }
}
