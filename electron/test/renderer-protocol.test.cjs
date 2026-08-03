'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')

const {
  RENDERER_SCHEME,
  RENDERER_HOST,
  RENDERER_ORIGIN,
  mimeFor,
  resolveDistFile,
} = require('../renderer-protocol.cjs')

const DIST = path.join(path.sep, 'fake', 'renderer', 'dist')

test('scheme 常量稳定（renderer 绝对路径解析依赖其语义）', () => {
  assert.equal(RENDERER_SCHEME, 'live2d-app')
  assert.equal(RENDERER_HOST, 'root')
  assert.equal(RENDERER_ORIGIN, 'live2d-app://root')
})

test('mimeFor 覆盖页面与 Live2D 模型资源', () => {
  assert.equal(mimeFor('/d/index.html'), 'text/html; charset=utf-8')
  assert.equal(mimeFor('/d/assets/index-a1b2.js'), 'text/javascript; charset=utf-8')
  assert.equal(mimeFor('/d/assets/index-a1b2.css'), 'text/css; charset=utf-8')
  assert.equal(mimeFor('/d/model/x.model3.json'), 'application/json; charset=utf-8')
  assert.equal(mimeFor('/d/model/x.motion3.json'), 'application/json; charset=utf-8')
  assert.equal(mimeFor('/d/model/x.moc3'), 'application/octet-stream')
  assert.equal(mimeFor('/d/model/texture_00.png'), 'image/png')
  assert.equal(mimeFor('/d/live2dcubismcore.min.js'), 'text/javascript; charset=utf-8')
  assert.equal(mimeFor('/d/x.unknown-ext'), 'application/octet-stream')
})

test('resolveDistFile: 根路径解析为 index.html', () => {
  assert.equal(resolveDistFile(DIST, '/'), path.join(DIST, 'index.html'))
  assert.equal(resolveDistFile(DIST, ''), path.join(DIST, 'index.html'))
})

test('resolveDistFile: 常规资源落在 dist 内', () => {
  assert.equal(
    resolveDistFile(DIST, '/assets/index-a1b2.js'),
    path.join(DIST, 'assets/index-a1b2.js'),
  )
  assert.equal(
    resolveDistFile(DIST, '/model/HiyoriPro/hiyori_pro_t11.model3.json'),
    path.join(DIST, 'model/HiyoriPro/hiyori_pro_t11.model3.json'),
  )
})

test('resolveDistFile: 目录穿越（明文与 URL 编码）被拒绝', () => {
  assert.equal(resolveDistFile(DIST, '/../secret.txt'), null)
  assert.equal(resolveDistFile(DIST, '/../../etc/passwd'), null)
  assert.equal(resolveDistFile(DIST, '/model/../../../etc/passwd'), null)
  assert.equal(resolveDistFile(DIST, '/%2e%2e/%2e%2e/etc/passwd'), null)
  assert.equal(resolveDistFile(DIST, '/%2E%2E%2Fsecret'), null)
})

test('resolveDistFile: 非法 URL 编码被拒绝', () => {
  assert.equal(resolveDistFile(DIST, '/%E0%A4%A'), null)
})

test('resolveDistFile: 多重前导斜杠归一为 dist 内相对路径', () => {
  assert.equal(resolveDistFile(DIST, '//assets/a.js'), path.join(DIST, 'assets/a.js'))
})
