'use strict'

/**
 * renderer-command-channel.cjs 单测（ADR 0001 · F5 · NFR-3）
 *
 * 用 fake ipcMain / fake BrowserWindow 直测请求-响应关联器的全部路径：
 * ready 门禁、结果帧配对、超时、窗口关闭冲销、非法帧丢弃、非目标 sender 忽略。
 * 这套逻辑此前内联在 main.cjs（需真实 Electron 才能跑），零覆盖。
 */

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  COMMAND_CHANNEL,
  COMMAND_READY_CHANNEL,
  COMMAND_RESULT_CHANNEL,
} = require('../renderer-commands.cjs')
const {
  ERROR_NOT_READY,
  ERROR_NO_WINDOW,
  ERROR_TIMEOUT,
  ERROR_WINDOW_CLOSED,
  createRendererCommandChannel,
} = require('../renderer-command-channel.cjs')

/** 最小 ipcMain：记录 handler，供测试直接触发 */
function createFakeIpcMain() {
  const handlers = new Map()
  return {
    on(channel, handler) {
      if (!handlers.has(channel)) handlers.set(channel, [])
      handlers.get(channel).push(handler)
    },
    removeListener(channel, handler) {
      const list = handlers.get(channel) ?? []
      const index = list.indexOf(handler)
      if (index >= 0) list.splice(index, 1)
    },
    /** 模拟 renderer 发帧 */
    emit(channel, event, payload) {
      for (const handler of [...(handlers.get(channel) ?? [])]) handler(event, payload)
    },
    listenerCount(channel) {
      return (handlers.get(channel) ?? []).length
    },
  }
}

/** 最小 BrowserWindow：webContents.send 记账，可标记销毁 */
function createFakeWindow() {
  const sent = []
  const webContents = { send: (channel, frame) => sent.push({ channel, frame }) }
    return {
    sent,
    webContents,
    destroyed: false,
    isDestroyed() {
      return this.destroyed
    },
  }
}

/** 建一套「窗口已就绪 + 通道已挂接」的常用夹具 */
function setup({ timeoutMs = 50, logger } = {}) {
  const ipcMain = createFakeIpcMain()
  const win = createFakeWindow()
  const warnings = []
  const channel = createRendererCommandChannel({
    ipcMain,
    getWindow: () => win,
    timeoutMs,
    logger: logger ?? { warn: (message) => warnings.push(message) },
  })
  const rendererEvent = { sender: win.webContents }
  return { ipcMain, win, channel, warnings, rendererEvent }
}

/** 取最近一条 main → renderer 命令帧 */
function lastCommand(win) {
  const entry = win.sent.at(-1)
  assert.equal(entry?.channel, COMMAND_CHANNEL)
  return entry.frame
}

test('构造参数缺失时立即抛错（ipcMain / getWindow 必填）', () => {
  assert.throws(() => createRendererCommandChannel({ getWindow: () => null }), /ipcMain 必填/)
  assert.throws(
    () => createRendererCommandChannel({ ipcMain: createFakeIpcMain() }),
    /getWindow 必填/,
  )
})

test('ready 之前发送立即失败，不占用挂起表也不触碰 webContents', async () => {
  const { win, channel } = setup()

  assert.equal(channel.isReady(), false)
  assert.deepEqual(await channel.send('getModelInfo', {}), {
    ok: false,
    error: ERROR_NOT_READY,
  })
  assert.equal(win.sent.length, 0)
})

test('窗口不存在或已销毁时发送立即失败', async () => {
  const ipcMain = createFakeIpcMain()
  let win = null
  const channel = createRendererCommandChannel({ ipcMain, getWindow: () => win })

  assert.deepEqual(await channel.send('reset', {}), { ok: false, error: ERROR_NO_WINDOW })

  win = createFakeWindow()
  win.destroyed = true
  assert.deepEqual(await channel.send('reset', {}), { ok: false, error: ERROR_NO_WINDOW })
})

test('ready 后发送：命令帧成形，结果帧按 requestId 配对 resolve', async () => {
  const { ipcMain, win, channel, rendererEvent } = setup()
  ipcMain.emit(COMMAND_READY_CHANNEL, rendererEvent)
  assert.equal(channel.isReady(), true)

  const inflight = channel.send('setExpression', { expression: 'smile' })
  const frame = lastCommand(win)
  assert.equal(frame.type, 'setExpression')
  assert.deepEqual(frame.params, { expression: 'smile' })
  assert.equal(typeof frame.requestId, 'string')
  assert.ok(frame.requestId.length > 0)

  ipcMain.emit(COMMAND_RESULT_CHANNEL, rendererEvent, {
    requestId: frame.requestId,
    result: { ok: true, data: { applied: 'smile' } },
  })

  assert.deepEqual(await inflight, { ok: true, data: { applied: 'smile' } })
})

test('并发命令各自按 requestId 配对，互不串线', async () => {
  const { ipcMain, win, channel, rendererEvent } = setup()
  ipcMain.emit(COMMAND_READY_CHANNEL, rendererEvent)

  const first = channel.send('getModelInfo', {})
  const firstId = lastCommand(win).requestId
  const second = channel.send('playMotion', { group: 'Idle' })
  const secondId = lastCommand(win).requestId
  assert.notEqual(firstId, secondId)

  // 乱序回执：先回第二条
  ipcMain.emit(COMMAND_RESULT_CHANNEL, rendererEvent, {
    requestId: secondId,
    result: { ok: true, data: 'motion' },
  })
  ipcMain.emit(COMMAND_RESULT_CHANNEL, rendererEvent, {
    requestId: firstId,
    result: { ok: true, data: 'info' },
  })

  assert.deepEqual(await first, { ok: true, data: 'info' })
  assert.deepEqual(await second, { ok: true, data: 'motion' })
})

test('renderer 失败回执原样透传（ok:false + error）', async () => {
  const { ipcMain, win, channel, rendererEvent } = setup()
  ipcMain.emit(COMMAND_READY_CHANNEL, rendererEvent)

  const inflight = channel.send('setExpression', { expression: 'nope' })
  ipcMain.emit(COMMAND_RESULT_CHANNEL, rendererEvent, {
    requestId: lastCommand(win).requestId,
    result: { ok: false, error: '模型未加载' },
  })

  assert.deepEqual(await inflight, { ok: false, error: '模型未加载' })
})

test('无回执时超时失败并带 timeout:true，挂起表随之清空', async () => {
  const { ipcMain, win, channel, rendererEvent } = setup({ timeoutMs: 10 })
  ipcMain.emit(COMMAND_READY_CHANNEL, rendererEvent)

  const result = await channel.send('lookAt', { x: 0, y: 0 })
  assert.deepEqual(result, { ok: false, error: ERROR_TIMEOUT, timeout: true })

  // 超时后迟到的回执不得再触发任何 resolve（已出表）；不抛错即通过
  ipcMain.emit(COMMAND_RESULT_CHANNEL, rendererEvent, {
    requestId: lastCommand(win).requestId,
    result: { ok: true, data: 'late' },
  })
})

test('窗口 closed：全部挂起命令立即失败，ready 复位', async () => {
  const { ipcMain, channel, rendererEvent } = setup({ timeoutMs: 5000 })
  ipcMain.emit(COMMAND_READY_CHANNEL, rendererEvent)

  const first = channel.send('getModelInfo', {})
  const second = channel.send('reset', {})

  channel.handleWindowClosed()

  assert.deepEqual(await first, { ok: false, error: ERROR_WINDOW_CLOSED })
  assert.deepEqual(await second, { ok: false, error: ERROR_WINDOW_CLOSED })
  assert.equal(channel.isReady(), false)
  // 复位后必须重新 ready 才能再发（窗口重建走同一条路径）
  assert.deepEqual(await channel.send('reset', {}), { ok: false, error: ERROR_NOT_READY })
})

test('非法结果帧丢弃并告警，不影响挂起命令', async () => {
  const { ipcMain, win, channel, warnings, rendererEvent } = setup({ timeoutMs: 10 })
  ipcMain.emit(COMMAND_READY_CHANNEL, rendererEvent)

  const inflight = channel.send('getModelInfo', {})
  const { requestId } = lastCommand(win)

  // 缺 result / result.ok 非布尔 / error 非字符串 / 非对象：全部应被 normalize 拒绝
  ipcMain.emit(COMMAND_RESULT_CHANNEL, rendererEvent, { requestId })
  ipcMain.emit(COMMAND_RESULT_CHANNEL, rendererEvent, { requestId, result: { ok: 'yes' } })
  ipcMain.emit(COMMAND_RESULT_CHANNEL, rendererEvent, {
    requestId,
    result: { ok: true, error: 42 },
  })
  ipcMain.emit(COMMAND_RESULT_CHANNEL, rendererEvent, 'not-a-frame')

  assert.equal(warnings.length, 4)
  // 挂起命令未被非法帧提前结束，最终仍按超时收场
  assert.deepEqual(await inflight, { ok: false, error: ERROR_TIMEOUT, timeout: true })
})

test('非目标 sender 的 ready / result 帧一律忽略', async () => {
  const { ipcMain, win, channel, warnings, rendererEvent } = setup({ timeoutMs: 10 })
  const foreignEvent = { sender: { send: () => {} } }

  // 冒名 ready 不得挂接通道
  ipcMain.emit(COMMAND_READY_CHANNEL, foreignEvent)
  assert.equal(channel.isReady(), false)

  ipcMain.emit(COMMAND_READY_CHANNEL, rendererEvent)
  const inflight = channel.send('reset', {})
  const { requestId } = lastCommand(win)

  // 冒名结果帧既不配对也不告警（在 sender 校验处就被挡下）
  ipcMain.emit(COMMAND_RESULT_CHANNEL, foreignEvent, {
    requestId,
    result: { ok: true, data: 'spoofed' },
  })
  assert.equal(warnings.length, 0)

  assert.deepEqual(await inflight, { ok: false, error: ERROR_TIMEOUT, timeout: true })
})

test('窗口已销毁时到达的结果帧被忽略（sender 校验依赖活窗口）', async () => {
  const ipcMain = createFakeIpcMain()
  const win = createFakeWindow()
  const channel = createRendererCommandChannel({
    ipcMain,
    getWindow: () => win,
    timeoutMs: 10,
  })
  const rendererEvent = { sender: win.webContents }
  ipcMain.emit(COMMAND_READY_CHANNEL, rendererEvent)

  const inflight = channel.send('reset', {})
  const { requestId } = lastCommand(win)
  win.destroyed = true

  ipcMain.emit(COMMAND_RESULT_CHANNEL, rendererEvent, {
    requestId,
    result: { ok: true, data: 'too-late' },
  })

  assert.deepEqual(await inflight, { ok: false, error: ERROR_TIMEOUT, timeout: true })
})

test('dispose：注销监听并冲销挂起命令', async () => {
  const { ipcMain, win, channel, rendererEvent } = setup({ timeoutMs: 5000 })
  ipcMain.emit(COMMAND_READY_CHANNEL, rendererEvent)

  const inflight = channel.send('getModelInfo', {})
  const { requestId } = lastCommand(win)

  channel.dispose()

  assert.deepEqual(await inflight, { ok: false, error: ERROR_WINDOW_CLOSED })
  assert.equal(ipcMain.listenerCount(COMMAND_READY_CHANNEL), 0)
  assert.equal(ipcMain.listenerCount(COMMAND_RESULT_CHANNEL), 0)

  // 监听已摘除：迟到帧不再进入通道
  ipcMain.emit(COMMAND_RESULT_CHANNEL, rendererEvent, {
    requestId,
    result: { ok: true, data: 'ignored' },
  })
  assert.equal(channel.isReady(), false)
})
