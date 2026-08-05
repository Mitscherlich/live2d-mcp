'use strict'

/**
 * native-process-audio-listener.cjs 单测（ADR 0001 · F6 · NFR-3）
 * 全路径以 fake spawn（EventEmitter 假子进程）+ fake processDiscovery + 假钟驱动：
 * helper 缺失/平台不支持、spawn 参数、waiting/ready/level/error 协议、
 * 会话开落、连续零电平抑制、轮询分档、权限分类不退让、失败退避、stop 清理、
 * NDJSON 解析。
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const {
  DEFAULT_CAPTURING_POLL_INTERVAL_MS,
  NativeProcessAudioListener,
  createNdjsonParser,
  helperExecutableName,
  resolveNativeHelperPath,
} = require('../native-process-audio-listener.cjs')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 假钟：注入 listener 的 now()，让轮询分档与失败退避可精确推进（不碰真实定时器） */
function fakeClock(start = 1_700_000_000_000) {
  let value = start
  const now = () => value
  now.advance = (ms) => {
    value += ms
  }
  return now
}

/** fake 子进程：stdout/stderr 为独立 emitter；kill 记录并可手动触发 exit */
function fakeChild() {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.killed = false
  child.kill = () => {
    child.killed = true
  }
  child.emitLine = (obj) => child.stdout.emit('data', Buffer.from(JSON.stringify(obj) + '\n'))
  child.emitExit = (code, signal = null) => child.emit('exit', code, signal)
  return child
}

function harness({ pids = [4242], rootPids, listenerOptions = {}, spawnImpl } = {}) {
  const events = { levels: [], sessions: [], statuses: [] }
  const spawns = []
  const discoveries = []
  const clock = fakeClock()
  const listener = new NativeProcessAudioListener({
    platform: 'darwin',
    helperPath: '/fake/live2d-audio-listener',
    processDiscovery: async () => {
      discoveries.push(clock())
      return { pids, rootPids: rootPids ?? pids }
    },
    spawnProcess:
      spawnImpl ??
      ((file, args) => {
        const child = fakeChild()
        spawns.push({ file, args, child })
        return child
      }),
    onLevel: (level) => events.levels.push(level),
    onSession: (active) => events.sessions.push(active),
    onStatus: (status) => events.statuses.push(status),
    pollIntervalMs: 60_000, // 测试手动 poll，不依赖定时器
    now: clock,
    ...listenerOptions,
  })
  return { clock, discoveries, events, listener, spawns }
}

// existsSync 钩子：helperPath 是否存在由测试注入（构造里 helperPath 显式给定，
// 用特殊路径段模拟缺失；fs.existsSync 真实调用，/fake/... 必然不存在）
const EXISTING = '/tmp/live2d-f6-test-helper'
require('node:fs').writeFileSync(EXISTING, '')

test('helper 缺失 → unavailable/helper-missing，不 spawn、不轮询', async () => {
  const { events, listener, spawns } = harness()
  await listener.start()
  assert.equal(spawns.length, 0)
  assert.equal(listener.stopped, true)
  const last = events.statuses.at(-1)
  assert.equal(last.available, false)
  assert.equal(last.detail, 'helper-missing')
  assert.match(last.error, /live2d-audio-listener/)
})

test('非 darwin → platform-not-supported，不 spawn', async () => {
  const { events, listener, spawns } = harness()
  listener.platform = 'linux'
  listener.helperPath = EXISTING
  await listener.start()
  assert.equal(spawns.length, 0)
  assert.equal(events.statuses.at(-1).detail, 'platform-not-supported')
})

test('helper 路径解析：env 覆盖 > 打包 resources > 仓内 native/bin；命名 live2d 系', async () => {
  assert.equal(helperExecutableName('darwin'), 'live2d-audio-listener')
  assert.equal(helperExecutableName('win32'), 'live2d-audio-listener.exe')
  assert.equal(
    resolveNativeHelperPath({ environment: { LIVE2D_NATIVE_HELPER_PATH: ' /x/helper ' } }),
    '/x/helper',
  )
  assert.equal(
    resolveNativeHelperPath({ platform: 'darwin', projectRoot: '/repo', environment: {} }),
    '/repo/native/bin/darwin/live2d-audio-listener',
  )
  assert.equal(
    resolveNativeHelperPath({
      platform: 'darwin',
      isPackaged: true,
      resourcesPath: '/res',
      environment: {},
    }),
    '/res/native/darwin/live2d-audio-listener',
  )
})

test('匹配进程 → spawn --pid 列表；waiting → idle/waiting-for-audio 状态', async () => {
  const { events, listener, spawns } = harness({ pids: [4242, 4243] })
  listener.helperPath = EXISTING
  await listener.start()
  assert.equal(spawns.length, 1)
  assert.deepEqual(spawns[0].args, ['--pid', '4242', '--pid', '4243'])

  spawns[0].child.emitLine({ type: 'waiting', permissionHint: true })
  const last = events.statuses.at(-1)
  assert.equal(last.capturing, false)
  assert.equal(last.detail, 'waiting-for-audio')
  listener.stop()
})

test('ready → capturing + source；resolved pids 并入捕获 key（churn 吸收）', async () => {
  const { events, listener, spawns } = harness({ pids: [100, 101], rootPids: [100] })
  listener.helperPath = EXISTING
  await listener.start()
  spawns[0].child.emitLine({ type: 'ready', source: 'macOS process audio', pids: [101] })
  const ready = events.statuses.at(-1)
  assert.equal(ready.capturing, true)
  assert.equal(ready.source, 'macOS process audio')
  // 捕获 key 合并 root(100) 与 resolved(101)
  assert.equal(listener.captureKey, '100,101')
  listener.stop()
})

test('level 直接转发 onLevel（不派生 activity）；8s 空闲落 session', async () => {
  const { events, listener, spawns } = harness({ listenerOptions: { sessionIdleMs: 120 } })
  listener.helperPath = EXISTING
  await listener.start()
  const child = spawns[0].child
  child.emitLine({ type: 'ready', source: 's', pids: [4242] })
  child.emitLine({ type: 'level', level: 0.6 })
  // 会话开启 + 电平原样转发（levels 首元素是启动 detach 时补发的首个 0）
  assert.deepEqual(events.sessions, [true])
  assert.deepEqual(events.levels, [0, 0.6])
  // listening ⇄ speaking 由 renderer 的 VoiceStateMachine 从同一条 level 流推导，
  // main 侧不再产出 activity：listener 契约只剩 onSession / onLevel / onStatus
  assert.equal(typeof listener.onActivity, 'undefined')
  // sessionIdleMs 无有声电平 → 会话结束并补一个 0
  child.emitLine({ type: 'level', level: 0 })
  await sleep(160)
  assert.deepEqual(events.sessions, [true, false])
  assert.deepEqual(events.levels, [0, 0.6, 0])
  listener.stop()
})

test('连续零电平抑制：非零通过、首零通过、连续零丢弃、零后非零恢复', async () => {
  const { events, listener, spawns } = harness({ listenerOptions: { sessionIdleMs: 10_000 } })
  listener.helperPath = EXISTING
  await listener.start()
  const child = spawns[0].child
  child.emitLine({ type: 'ready', source: 's', pids: [4242] })
  // 启动 detach 已补发首个 0（renderer 靠它起算 900ms 静音保持）
  assert.deepEqual(events.levels, [0])
  child.emitLine({ type: 'level', level: 0.4 })
  child.emitLine({ type: 'level', level: 0.5 })
  assert.deepEqual(events.levels, [0, 0.4, 0.5], '非零 level 逐条通过')
  child.emitLine({ type: 'level', level: 0 })
  assert.deepEqual(events.levels, [0, 0.4, 0.5, 0], '静音后第一条 0 必须送达')
  for (let i = 0; i < 30; i += 1) child.emitLine({ type: 'level', level: 0 })
  assert.deepEqual(events.levels, [0, 0.4, 0.5, 0], '此后连续 0 全部抑制')
  child.emitLine({ type: 'level', level: 0.3 })
  child.emitLine({ type: 'level', level: 0 })
  assert.deepEqual(events.levels, [0, 0.4, 0.5, 0, 0.3, 0], '再次非零后零抑制重新起算')
  listener.stop()
})

test('轮询分档：未捕获按 tick 发现；已捕获降到 12s 才真正跑一次 ps', async () => {
  let pids = []
  const { clock, discoveries, listener, spawns } = harness()
  listener.helperPath = EXISTING
  listener.processDiscovery = async () => {
    discoveries.push(clock())
    return { pids, rootPids: pids }
  }
  assert.equal(DEFAULT_CAPTURING_POLL_INTERVAL_MS, 12_000)

  await listener.start() // 第 1 次发现：无匹配进程
  assert.equal(discoveries.length, 1)
  // 未捕获：每次 tick 都真正执行发现，节奏不降档
  clock.advance(1_500)
  await listener.poll()
  clock.advance(1_500)
  await listener.poll()
  assert.equal(discoveries.length, 3)
  assert.equal(spawns.length, 0)

  pids = [4242]
  clock.advance(1_500)
  await listener.poll() // 第 4 次发现 → 捕获
  assert.equal(spawns.length, 1)
  assert.equal(discoveries.length, 4)

  // 已捕获：降档周期内的 tick 全部早退，不再 spawn ps
  for (let elapsed = 1_500; elapsed < DEFAULT_CAPTURING_POLL_INTERVAL_MS; elapsed += 1_500) {
    clock.advance(1_500)
    await listener.poll()
  }
  assert.equal(discoveries.length, 4, '捕获期 12s 内不再执行进程发现')
  clock.advance(1_500) // 距上次发现累计满 12s
  await listener.poll()
  assert.equal(discoveries.length, 5, '超过 capturingPollIntervalMs 后恢复一次发现')
  listener.stop()
})

test('level 越界/非法被 clamp 或忽略；status 去重（同负载不重复上报）', async () => {
  const { events, listener, spawns } = harness()
  listener.helperPath = EXISTING
  await listener.start()
  const child = spawns[0].child
  child.emitLine({ type: 'level', level: 42 })
  child.emitLine({ type: 'level', level: 'loud' }) // 忽略
  child.emitLine({ type: 'level', level: -1 })
  // levels = [0(启动 detach reset), 1(clamp), 0(clamp)]；'loud' 被丢
  assert.deepEqual(events.levels, [0, 1, 0])
  const before = events.statuses.length
  child.emitLine({ type: 'waiting' })
  child.emitLine({ type: 'waiting' })
  assert.equal(events.statuses.length, before + 1) // 同负载去重
  listener.stop()
})

test('error tap-create-failed + permissionHint:false → 分类上报；随后 exit 不回 flap idle', async () => {
  const { events, listener, spawns } = harness()
  listener.helperPath = EXISTING
  await listener.start()
  const child = spawns[0].child
  child.emitLine({
    type: 'error',
    code: 'tap-create-failed',
    message: 'Unable to create a Core Audio process tap. (OSStatus -1)',
    permissionHint: false,
  })
  const classified = events.statuses.at(-1)
  assert.equal(classified.detail, 'tap-create-failed')
  assert.equal(classified.permissionHint, false)
  child.emitExit(1)
  await sleep(10)
  // exit 后状态未被 idle 覆盖（权限失败保持可见）
  assert.equal(events.statuses.at(-1).detail, 'tap-create-failed')
  listener.stop()
})

test('terminal 失败退避：同 key 冷却期内不 respawn；key 变化立即解除', async () => {
  let pids = [4242]
  const { listener, spawns } = harness({ listenerOptions: { failureRetryMs: 10_000 } })
  listener.helperPath = EXISTING
  listener.processDiscovery = async () => ({ pids, rootPids: pids })
  await listener.start()
  assert.equal(spawns.length, 1)
  spawns[0].child.emitExit(3) // helper-exited → terminal failure
  await sleep(10)
  await listener.poll() // 冷却期内
  assert.equal(spawns.length, 1, '冷却期内不重试')
  pids = [5555] // 目标集变化 → 解除冷却
  await listener.poll()
  assert.equal(spawns.length, 2, 'key 变化立即重试')
  listener.stop()
})

test('helper 无错误消息裸退（code≠0）→ helper-exited 分类', async () => {
  const { events, listener, spawns } = harness()
  listener.helperPath = EXISTING
  await listener.start()
  spawns[0].child.emitExit(2)
  await sleep(10)
  const last = events.statuses.at(-1)
  assert.equal(last.detail, 'helper-exited')
  assert.match(last.error, /code 2/)
  listener.stop()
})

test('无匹配进程 → detach 杀 helper 并报 no-matching-process；会话结束', async () => {
  let pids = [4242]
  const { clock, events, listener, spawns } = harness({ listenerOptions: { sessionIdleMs: 10_000 } })
  listener.helperPath = EXISTING
  listener.processDiscovery = async () => ({ pids, rootPids: pids })
  await listener.start()
  const child = spawns[0].child
  child.emitLine({ type: 'ready', source: 's', pids: [4242] })
  child.emitLine({ type: 'level', level: 0.5 })
  assert.deepEqual(events.sessions, [true])
  pids = [] // 目标进程消失
  clock.advance(DEFAULT_CAPTURING_POLL_INTERVAL_MS) // 捕获期分档：过了降档周期才真正发现
  await listener.poll()
  assert.equal(child.killed, true)
  assert.deepEqual(events.sessions, [true, false])
  const last = events.statuses.at(-1)
  assert.equal(last.detail, 'no-matching-process')
  assert.equal(last.capturing, false)
  listener.stop()
})

test('stop：杀 helper、清轮询、状态 monitoring:false', async () => {
  const { events, listener, spawns } = harness()
  listener.helperPath = EXISTING
  await listener.start()
  listener.stop()
  assert.equal(spawns[0].child.killed, true)
  assert.equal(events.statuses.at(-1).monitoring, false)
  await listener.poll() // stopped 后 poll 为空操作
  assert.equal(spawns.length, 1)
})

test('NDJSON 解析：半行缓冲、多行一 chunk、非法行回调', () => {
  const got = []
  const bad = []
  const parse = createNdjsonParser((m) => got.push(m), (line) => bad.push(line))
  parse(Buffer.from('{"type":"level","level":0.5}\n{"type":"wai'))
  parse(Buffer.from('ting"}\nnot-json\n'))
  assert.deepEqual(got, [{ type: 'level', level: 0.5 }, { type: 'waiting' }])
  assert.deepEqual(bad, ['not-json'])
})
