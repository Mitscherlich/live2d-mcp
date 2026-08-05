'use strict'

/**
 * Structural check: package manager entrypoints are bun-first.
 * Proves shipped package.json / lockfile contract after npm → bun migration.
 */

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '../..')

function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'))
}

test('packageManager field declares bun and engines.bun', () => {
  const pkg = readJson('package.json')
  assert.match(String(pkg.packageManager || ''), /^bun@/)
  assert.ok(pkg.engines && pkg.engines.bun, 'engines.bun required')
})

test('root scripts use bun for workspace orchestration (not npm run)', () => {
  const pkg = readJson('package.json')
  const scripts = pkg.scripts || {}
  for (const name of [
    'build',
    'dev',
    'dev:electron',
    'dev:mcp-server',
    'dev:renderer',
    'dev:legacy',
  ]) {
    assert.ok(scripts[name], `missing script ${name}`)
    assert.doesNotMatch(
      scripts[name],
      /\bnpm\b/,
      `${name} must not invoke npm: ${scripts[name]}`,
    )
    if (name === 'build' || name.startsWith('dev')) {
      assert.match(scripts[name], /\bbun\b/, `${name} should use bun: ${scripts[name]}`)
    }
  }
})

test('lockfile is bun.lock (package-lock.json must not exist)', () => {
  const bunLockText = path.join(root, 'bun.lock')
  const bunLockBin = path.join(root, 'bun.lockb')
  const npmLock = path.join(root, 'package-lock.json')
  assert.ok(
    fs.existsSync(bunLockText) || fs.existsSync(bunLockBin),
    'expected bun.lock or bun.lockb after bun install',
  )
  assert.equal(
    fs.existsSync(npmLock),
    false,
    'package-lock.json must be removed so bun is the install source of truth',
  )
})

test('mcp-server dev uses bun runtime', () => {
  const pkg = readJson('mcp-server/package.json')
  assert.match(pkg.scripts.dev, /\bbun\b/)
  assert.doesNotMatch(pkg.scripts.dev, /\bnpm\b/)
})

test('test script still drives node:test on real shipped entry (node-compatible)', () => {
  const pkg = readJson('package.json')
  assert.match(pkg.scripts.test, /node --test/)
  assert.doesNotMatch(pkg.scripts.test, /\bnpm\b/)
})
