// 实际开包验证两个校验和、重复打包的可恢复性，以及可选预览图；临时目录保留供复核。
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'monitor-theme-package-test-'))
const script = join(import.meta.dirname, 'package.mjs')
const versioned = 'monitor-theme-jikasei-1.26.1.tar.gz'

function fixture(name, preview) {
  const dir = join(root, name)
  for (const sub of ['src', 'public', 'dist/flags']) mkdirSync(join(dir, sub), { recursive: true })
  for (const [file, contents] of Object.entries({
    'theme.json': JSON.stringify({ short: 'jikasei', version: '1.26.1' }),
    'package.json': JSON.stringify({ version: '1.26.1' }),
    'LICENSE': 'test license\n',
    'index.html': '<html>source</html>',
    'vite.config.ts': 'export default {}\n',
    'src/main.ts': 'export const ready = true\n',
    'public/favicon.svg': '<svg/>',
    'dist/favicon.svg': '<svg/>',
    'dist/favicon.ico': 'ico',
    'dist/apple-touch-icon.png': 'png',
    'dist/title-probe.js': '// probe\n',
    'dist/flags/JP.svg': '<svg/>',
  })) writeFileSync(join(dir, file), contents)
  if (preview) writeFileSync(join(dir, 'preview.png'), 'preview')
  writeFileSync(join(dir, 'dist/index.html'), '<html>built</html>')
  // 明确模拟「构建产物比源码新」，不依赖文件系统的时间戳精度。
  const built = new Date(Date.now() + 1000)
  utimesSync(join(dir, 'dist/index.html'), built, built)
  return dir
}

function pack(dir) {
  execFileSync(process.execPath, [script], { cwd: dir, encoding: 'utf8' })
  return execFileSync('tar', ['-tzf', 'release/theme.tar.gz'], { cwd: dir, encoding: 'utf8' }).trim().split(/\r?\n/)
}

function verifyChecksums(dir) {
  for (const file of ['theme.tar.gz', versioned]) {
    const contents = readFileSync(join(dir, 'release', file))
    const digest = createHash('sha256').update(contents).digest('hex')
    assert.equal(readFileSync(join(dir, 'release', `${file}.sha256`), 'utf8'), `${digest}  ${file}\n`)
  }
  assert.deepEqual(readFileSync(join(dir, 'release/theme.tar.gz')), readFileSync(join(dir, 'release', versioned)))
}

const withPreview = fixture('with-preview', true)
assert.ok(pack(withPreview).includes('preview.png'))
verifyChecksums(withPreview)
const oldArchive = readFileSync(join(withPreview, 'release/theme.tar.gz'))
writeFileSync(join(withPreview, 'release/sentinel.txt'), 'previous result must survive\n')
const secondListing = pack(withPreview)
verifyChecksums(withPreview)
const backups = readdirSync(withPreview).filter((name) => name.startsWith('release-backup-'))
assert.equal(backups.length, 1)
const savedRelease = join(withPreview, backups[0], 'release')
assert.equal(readFileSync(join(savedRelease, 'sentinel.txt'), 'utf8'), 'previous result must survive\n')
assert.deepEqual(readFileSync(join(savedRelease, 'theme.tar.gz')), oldArchive)
assert.equal(existsSync(join(withPreview, 'release/sentinel.txt')), false)
assert.ok(secondListing.every((name) => !name.startsWith('release') && !name.includes('sentinel.txt')))

const withoutPreview = fixture('without-preview', false)
assert.equal(pack(withoutPreview).includes('preview.png'), false)
verifyChecksums(withoutPreview)

console.log(`打包验证通过：两个校验和、重复打包保留旧产物、可选预览图；临时目录保留在 ${root}`)
