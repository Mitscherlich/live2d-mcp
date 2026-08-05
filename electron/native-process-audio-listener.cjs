'use strict'

/**
 * Native 进程音频监听器（ADR 0001 · F6 · FR-V3；darwin 优先）
 *
 * 生命周期：poll（默认 1.5s）经 process-discovery 发现目标进程树 → 匹配集变化时
 * spawn native helper（native/bin/darwin/live2d-audio-listener，Core Audio process
 * tap）→ NDJSON 协议消费 waiting/ready/level/error：
 *
 *  - waiting：目标进程已匹配但尚无 Core Audio 输出对象（helper 内等待，不 churn）
 *  - ready  ：tap 已附着，resolved pids 并入捕获 key（worker churn 吸收，思路对齐 persona）
 *  - level  ：峰值电平（helper 已归一化）；> 0.008 开启/续期会话（sessionIdleMs 默认
 *            8s 无声音符结束会话），电平过 AudioActivityGate 产出 onLevel/onActivity
 *  - error  ：带机读 code（tap-create-failed / unsupported-os / no-audio-process …）
 *            + permissionHint（helper 的 TCC preflight），分类进状态负载
 *
 * 状态负载（onStatus；listener-status.cjs 据此映射公开枚举）：
 *   { available, capturing, monitoring, source, matched, detail, error, permissionHint }
 *
 * 失败退避：terminal 失败（tap-create-failed/spawn-failed/helper 异常退出）对同一
 * 捕获 key 冷却 failureRetryMs（默认 60s，权限授予后无需重启即可恢复）；key 变化
 * （目标进程集改变）立即清除冷却。
 *
 * 隐私（NFR-1）：helper 只在内存算 level，不采麦克风、样本不落盘不上传；本模块
 * 不接触音频数据。分层与 NDJSON 契约借鉴 persona native-process-audio-listener
 * （只读，MIT）；命名/状态分类/退避为本仓实现。
 */

const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const {
  AudioActivityGate,
  DEFAULT_SPEECH_RELEASE_MS,
} = require('./audio-activity-gate.cjs')
const { discoverVoiceProcesses } = require('./process-discovery.cjs')
const { normalizeVoiceSource } = require('./voice-source.cjs')

const SESSION_IDLE_MS = 8_000
const DEFAULT_POLL_INTERVAL_MS = 1_500
const DEFAULT_FAILURE_RETRY_MS = 60_000
/** level 超过该值视作会话活跃（对齐 persona 0.008 与 renderer audibleFloor） */
const SESSION_AUDIBLE_LEVEL = 0.008

/** terminal 失败 detail 集合：命中后对同一捕获 key 进入冷却退避 */
const TERMINAL_FAILURE_DETAILS = new Set(['tap-create-failed', 'spawn-failed', 'helper-exited', 'unsupported-os'])

function helperExecutableName(platform) {
  return platform === 'win32' ? 'live2d-audio-listener.exe' : 'live2d-audio-listener'
}

/**
 * 解析 helper 路径：LIVE2D_NATIVE_HELPER_PATH 覆盖 > 打包 resources > 仓内 native/bin。
 */
function resolveNativeHelperPath({
  platform = process.platform,
  isPackaged = false,
  resourcesPath = process.resourcesPath,
  projectRoot = path.join(__dirname, '..'),
  environment = process.env,
} = {}) {
  const override = environment?.LIVE2D_NATIVE_HELPER_PATH
  if (typeof override === 'string' && override.trim()) return override.trim()
  const executable = helperExecutableName(platform)
  const platformPath = platform === 'win32' ? path.win32 : path.posix
  return isPackaged
    ? platformPath.join(resourcesPath, 'native', platform, executable)
    : platformPath.join(projectRoot, 'native', 'bin', platform, executable)
}

/** NDJSON 行解析器（helper stdout 协议）；非法行回调 onInvalid */
function createNdjsonParser(onMessage, onInvalid = () => {}) {
  let pending = ''
  return (chunk) => {
    pending += chunk.toString('utf8')
    const lines = pending.split(/\r?\n/)
    pending = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        onMessage(JSON.parse(line))
      } catch {
        onInvalid(line)
      }
    }
  }
}

class NativeProcessAudioListener {
  constructor({
    platform = process.platform,
    isPackaged = false,
    resourcesPath = process.resourcesPath,
    helperPath = null,
    environment = process.env,
    processDiscovery = discoverVoiceProcesses,
    spawnProcess = spawn,
    onActivity = () => {},
    onDebug = null,
    onLevel = () => {},
    onSession = () => {},
    onStatus = () => {},
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    sessionIdleMs = SESSION_IDLE_MS,
    speechReleaseMs = DEFAULT_SPEECH_RELEASE_MS,
    failureRetryMs = DEFAULT_FAILURE_RETRY_MS,
    processPattern = null,
    voiceSource = null,
  } = {}) {
    this.platform = platform
    this.helperPath =
      helperPath ?? resolveNativeHelperPath({ platform, isPackaged, resourcesPath, environment })
    this.processDiscovery = processDiscovery
    this.processPattern = processPattern
    this.voiceSource = normalizeVoiceSource(voiceSource)
    this.spawnProcess = spawnProcess
    this.onActivity = onActivity
    this.onDebug = onDebug
    this.onSession = onSession
    this.onStatus = onStatus
    this.pollIntervalMs = pollIntervalMs
    this.sessionIdleMs = sessionIdleMs
    this.failureRetryMs = failureRetryMs
    this.capture = null
    this.captureKey = null
    this.captureRootPids = new Set()
    this.resolvedPids = new Set()
    this.pollTimer = null
    this.sessionTimer = null
    this.sessionActive = false
    this.stopped = true
    this.pollInFlight = false
    this.lastStatusKey = null
    /** terminal 失败冷却：{ key, at } —— 同一捕获 key 在 failureRetryMs 内不再 spawn */
    this.failure = null
    /** 最近一次 helper error 消息的 detail（exit 时不回 flap 到 idle） */
    this.lastErrorDetail = null
    this.gate = new AudioActivityGate({
      onActivity,
      onLevel,
      shouldReturnToListening: () => this.sessionActive,
      speechReleaseMs,
    })
  }

  reportStatus(status) {
    const key = JSON.stringify(status)
    if (key === this.lastStatusKey) return
    this.lastStatusKey = key
    this.onStatus(status)
  }

  async start() {
    if (!this.stopped) return
    this.stopped = false
    if (this.platform !== 'darwin') {
      this.stopped = true
      this.reportStatus({
        available: false, capturing: false, monitoring: false,
        source: null, matched: 0, detail: 'platform-not-supported',
        error: `native listener 暂未支持平台 ${this.platform}（macOS 优先，linux/win 预留）`,
        permissionHint: null,
      })
      return
    }
    if (!fs.existsSync(this.helperPath)) {
      this.stopped = true
      this.reportStatus({
        available: false, capturing: false, monitoring: false,
        source: null, matched: 0, detail: 'helper-missing',
        error: `native listener helper 缺失: ${this.helperPath}`,
        permissionHint: null,
      })
      return
    }
    this.reportStatus({
      available: true, capturing: false, monitoring: true,
      source: null, matched: 0, detail: null, error: null, permissionHint: null,
    })
    await this.poll()
    this.pollTimer = setInterval(() => void this.poll(), this.pollIntervalMs)
    this.pollTimer.unref?.()
  }

  async poll() {
    if (this.stopped || this.pollInFlight) return
    this.pollInFlight = true
    try {
      const processes = await this.processDiscovery({
        platform: this.platform,
        voiceSource: this.voiceSource,
        ...(this.processPattern ? { pattern: this.processPattern } : {}),
      })
      if (this.stopped) return
      const spawnPids = processes.pids
      if (spawnPids.length === 0) {
        this.detach()
        return
      }
      // 捕获 key：匹配树根 ∪ helper 已解析出音频对象的 pid（吸收 worker churn）
      const stablePids = this.stableCapturePids(processes)
      const key = stablePids.join(',')
      if (this.capture && this.captureKey === key) return
      if (this.failure && this.failure.key !== key) this.failure = null // 目标集变化 → 解除冷却
      if (this.failure && Date.now() - this.failure.at < this.failureRetryMs) return
      this.detach({ sessionEnded: false })
      this.startCapture(spawnPids, key, processes.rootPids)
    } catch (error) {
      this.reportStatus({
        available: true, capturing: false, monitoring: true,
        source: null, matched: 0, detail: 'discovery-failed',
        error: error instanceof Error ? error.message : String(error),
        permissionHint: null,
      })
    } finally {
      this.pollInFlight = false
    }
  }

  stableCapturePids(processes) {
    const matched = new Set(processes.pids ?? [])
    const stable = new Set(processes.rootPids ?? [])
    for (const pid of this.resolvedPids) {
      if (matched.has(pid)) stable.add(pid)
    }
    return [...stable].sort((left, right) => left - right)
  }

  noteFailure(key, detail) {
    if (!TERMINAL_FAILURE_DETAILS.has(detail)) return
    this.failure = { key, at: Date.now() }
  }

  startCapture(processIds, key, rootPids = []) {
    const args = processIds.flatMap((processId) => ['--pid', String(processId)])
    const child = this.spawnProcess(this.helperPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.capture = child
    this.captureKey = key
    this.captureRootPids = new Set(rootPids)
    const parse = createNdjsonParser(
      (message) => this.handleHelperMessage(child, message),
      (line) => this.onDebug?.('native helper 输出非法 JSON 行', line),
    )
    child.stdout.on('data', parse)
    child.stderr.on('data', (chunk) => this.onDebug?.('native helper stderr', chunk.toString()))
    child.once('error', (error) => {
      if (this.capture !== child) return
      this.capture = null
      this.captureKey = null
      this.captureRootPids = new Set()
      this.resolvedPids = new Set()
      this.lastErrorDetail = 'spawn-failed'
      this.noteFailure(key, 'spawn-failed')
      this.reportStatus({
        available: false, capturing: false, monitoring: true,
        source: null, matched: processIds.length, detail: 'spawn-failed',
        error: error.message, permissionHint: null,
      })
    })
    child.once('exit', (code, signal) => {
      if (this.capture !== child) return // 被我们 detach/kill 的正常退出不走这里
      this.capture = null
      this.captureKey = null
      this.captureRootPids = new Set()
      this.resolvedPids = new Set()
      this.gate.reset()
      this.endSession()
      if (this.lastErrorDetail) {
        // error 消息已分类上报（如 tap-create-failed → permission-denied），退出不回 flap
        this.lastErrorDetail = null
        return
      }
      if (code) {
        this.noteFailure(key, 'helper-exited')
        this.reportStatus({
          available: true, capturing: false, monitoring: !this.stopped,
          source: null, matched: processIds.length, detail: 'helper-exited',
          error: `native helper 意外退出（code ${code}${signal ? `, signal ${signal}` : ''}）`,
          permissionHint: null,
        })
        return
      }
      this.reportStatus({
        available: true, capturing: false, monitoring: !this.stopped,
        source: null, matched: processIds.length, detail: 'waiting-for-audio',
        error: null, permissionHint: null,
      })
    })
  }

  handleHelperMessage(child, message) {
    if (this.capture !== child || message == null || typeof message !== 'object') return
    if (message.type === 'waiting') {
      this.reportStatus({
        available: true, capturing: false, monitoring: true,
        source: null, matched: this.captureRootPids.size || null,
        detail: 'waiting-for-audio', error: null,
        permissionHint: typeof message.permissionHint === 'boolean' ? message.permissionHint : null,
      })
      return
    }
    if (message.type === 'ready') {
      const resolved = Array.isArray(message.pids)
        ? message.pids.filter((pid) => Number.isInteger(pid) && pid > 0)
        : []
      this.resolvedPids = new Set(resolved)
      this.captureKey = [...new Set([...this.captureRootPids, ...resolved])]
        .sort((left, right) => left - right)
        .join(',')
      this.failure = null
      this.lastErrorDetail = null
      this.reportStatus({
        available: true, capturing: true, monitoring: true,
        source: typeof message.source === 'string' && message.source ? message.source : 'macOS process audio',
        matched: this.captureRootPids.size || null, detail: null, error: null,
        permissionHint: typeof message.permissionHint === 'boolean' ? message.permissionHint : null,
      })
      return
    }
    if (message.type === 'error') {
      const code = typeof message.code === 'string' && message.code ? message.code : 'helper-error'
      const detail = code === 'no-audio-process' ? 'waiting-for-audio' : code
      this.lastErrorDetail = detail
      this.noteFailure(this.captureKey ?? '', detail)
      this.reportStatus({
        available: code !== 'unsupported-os',
        capturing: false, monitoring: true,
        source: null, matched: this.captureRootPids.size || null,
        detail,
        error: String(message.message || 'native helper 失败'),
        permissionHint: typeof message.permissionHint === 'boolean' ? message.permissionHint : null,
      })
      return
    }
    if (message.type !== 'level' || !Number.isFinite(message.level)) return

    const level = Math.max(0, Math.min(1, Number(message.level)))
    if (level > SESSION_AUDIBLE_LEVEL) {
      clearTimeout(this.sessionTimer)
      this.sessionTimer = setTimeout(() => this.endSession(), this.sessionIdleMs)
      this.sessionTimer.unref?.()
      if (!this.sessionActive) {
        this.sessionActive = true
        this.onSession(true)
      }
    }
    this.gate.handleLevel(level)
  }

  endSession() {
    clearTimeout(this.sessionTimer)
    this.sessionTimer = null
    if (!this.sessionActive) return
    this.sessionActive = false
    this.gate.reset()
    this.onSession(false)
  }

  detach({ sessionEnded = true } = {}) {
    if (this.capture) {
      const child = this.capture
      this.capture = null
      this.captureKey = null
      this.captureRootPids = new Set()
      child.kill()
    }
    if (sessionEnded) this.resolvedPids = new Set()
    this.gate.reset()
    if (sessionEnded) this.endSession()
    this.reportStatus({
      available: true, capturing: false, monitoring: !this.stopped,
      source: null, matched: 0, detail: 'no-matching-process',
      error: null, permissionHint: null,
    })
  }

  stop() {
    if (this.stopped) return
    this.stopped = true
    clearInterval(this.pollTimer)
    this.pollTimer = null
    this.detach()
  }
}

module.exports = {
  DEFAULT_FAILURE_RETRY_MS,
  DEFAULT_POLL_INTERVAL_MS,
  NativeProcessAudioListener,
  SESSION_AUDIBLE_LEVEL,
  SESSION_IDLE_MS,
  createNdjsonParser,
  helperExecutableName,
  resolveNativeHelperPath,
}
