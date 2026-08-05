'use strict'

/**
 * 进程发现（ADR 0001 · F6 · FR-V1；darwin 优先，linux/win 预留）
 *
 * macOS：ps 快照（pid/ppid/comm + pid/args）→ 按 voice source 选择目标进程树：
 *  - automatic/custom：identity regex 匹配 `name executable command` 拼接文本
 *  - application：process:darwin:<b64> source_id 精确匹配（忽略 regex）
 *  - 树选择：直接匹配进程 + 其全部后代（子进程 churn 由 listener 侧稳定 key 吸收；
 *    思路对齐 persona selectVoiceProcessTree，MIT）
 *  - 排除自身进程（避免 Electron 主进程名巧合命中时自我捕获）
 *
 * 其他平台：listPlatformProcesses 返回 []（listener 计划层报 platform-not-supported，
 * 见 electron/audio-listener.cjs）；win32 解析器属 F6 之后预留，不在本片。
 *
 * 纯函数均可注入 run/进程列表单测（NFR-3），无 Electron 依赖。
 */

const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const {
  DEFAULT_VOICE_APP_PATTERN,
  normalizeVoiceSource,
  processIdentity,
  voiceSourceIdentity,
} = require('./voice-source.cjs')

const execFileAsync = promisify(execFile)

/** 解析 `ps -axo pid=,ppid=,comm=` 输出 → [{ pid, parentId, name, executable, command:'' }] */
function parseMacProcessList(output) {
  return String(output ?? '')
    .split(/\r?\n/)
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line))
    .filter(Boolean)
    .map((match) => ({
      pid: Number(match[1]),
      parentId: Number(match[2]),
      name: match[3],
      executable: match[3],
      command: '',
    }))
}

/** 解析 `ps -axo pid=,args=` 输出 → Map<pid, command> */
function parseMacCommandList(output) {
  return new Map(
    String(output ?? '')
      .split(/\r?\n/)
      .map((line) => /^\s*(\d+)\s+(.+?)\s*$/.exec(line))
      .filter(Boolean)
      .map((match) => [Number(match[1]), match[2]]),
  )
}

function mergeMacProcessCommands(processes, commands) {
  return processes.map((proc) => ({ ...proc, command: commands.get(proc.pid) ?? '' }))
}

/**
 * identity 匹配：regex 命中 `name command` 拼接文本（词边界由 pattern 自身保证）。
 * 不再拼 executable —— parseMacProcessList 里 name 与 executable 同为 comm 捕获组，
 * 拼进去只是让每个进程多匹配一遍同样的文本。
 */
function identityMatches(proc, pattern = DEFAULT_VOICE_APP_PATTERN) {
  pattern.lastIndex = 0
  return pattern.test(`${proc.name} ${proc.command ?? ''}`)
}

/**
 * 选择目标进程树。
 * @param {Array} processes listPlatformProcesses 快照
 * @returns {{ pids: number[], rootPids: number[] }}
 *   pids：直接匹配进程 + 全部后代（升序）；rootPids：匹配树根（父未匹配的直配进程）
 */
function selectVoiceProcessTree(
  processes,
  {
    ownProcessId = process.pid,
    pattern = DEFAULT_VOICE_APP_PATTERN,
    platform = process.platform,
    sourceId = null,
  } = {},
) {
  const byId = new Map(processes.map((entry) => [entry.pid, entry]))
  // application 模式：目标 identity 只解码一次，逐进程直接比字符串
  // （反过来对每个进程 base64 编码再比 source_id 要贵一个数量级）
  const targetIdentity = sourceId ? voiceSourceIdentity(sourceId, platform) : null
  const matchesTarget = (entry) =>
    sourceId
      ? targetIdentity !== null && processIdentity(entry, platform) === targetIdentity
      : identityMatches(entry, pattern)
  const directlyMatched = new Set(
    processes
      .filter((entry) => entry.pid !== ownProcessId && matchesTarget(entry))
      .map((entry) => entry.pid),
  )
  const matched = new Set()
  for (const entry of processes) {
    let current = entry
    const visited = new Set()
    for (let depth = 0; current && depth < 20; depth += 1) {
      if (visited.has(current.pid)) break
      visited.add(current.pid)
      if (directlyMatched.has(current.pid)) {
        matched.add(entry.pid)
        break
      }
      current = byId.get(current.parentId)
    }
  }
  const roots = [...directlyMatched]
    .filter((pid) => !directlyMatched.has(byId.get(pid)?.parentId))
    .sort((left, right) => left - right)
  return { pids: [...matched].sort((left, right) => left - right), rootPids: roots }
}

/**
 * 平台进程快照。darwin → ps；其他平台 → []（预留；listener 计划层负责
 * platform-not-supported 状态，不在此报错）。
 *
 * @param {boolean} [includeArgs] 是否额外跑 `ps -axo pid=,args=` 取完整命令行。
 *   automatic/custom 需要（CLI 启动的 codex，comm 只是 node）；application 模式
 *   按 executable identity 匹配，不看 command，跑第二次 ps 纯属浪费。
 */
async function listPlatformProcesses({
  platform = process.platform,
  run = execFileAsync,
  includeArgs = true,
} = {}) {
  if (platform === 'darwin') {
    const options = { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 3_000 }
    if (!includeArgs) {
      const identityOnly = await run('ps', ['-axo', 'pid=,ppid=,comm='], options)
      return parseMacProcessList(identityOnly.stdout)
    }
    const [identityResult, commandResult] = await Promise.all([
      run('ps', ['-axo', 'pid=,ppid=,comm='], options),
      run('ps', ['-axo', 'pid=,args='], options),
    ])
    return mergeMacProcessCommands(
      parseMacProcessList(identityResult.stdout),
      parseMacCommandList(commandResult.stdout),
    )
  }
  // TODO(win32): Windows 进程枚举未实现；非 darwin 一律返回空快照，
  // 由 audio-listener.cjs 报 platform-not-supported 并降级到 external
  return []
}

/**
 * 发现目标语音进程（listener 每轮 poll 调用）。
 * @param {RegExp|null} [pattern] 已解析的有效 pattern（audio-listener 计划层传入；
 *   automatic/custom 语义）；application 模式忽略
 * @param {object|null} [voiceSource] 规范化前的 voice source（内部 normalize）
 */
async function discoverVoiceProcesses({
  platform = process.platform,
  run = execFileAsync,
  ownProcessId = process.pid,
  pattern = null,
  voiceSource = null,
} = {}) {
  const selected = normalizeVoiceSource(voiceSource)
  const sourceId = selected.mode === 'application' ? selected.source_id : null
  const processes = await listPlatformProcesses({ platform, run, includeArgs: sourceId === null })
  return selectVoiceProcessTree(processes, {
    ownProcessId,
    platform,
    sourceId,
    pattern: pattern ?? DEFAULT_VOICE_APP_PATTERN,
  })
}

module.exports = {
  discoverVoiceProcesses,
  identityMatches,
  listPlatformProcesses,
  mergeMacProcessCommands,
  parseMacCommandList,
  parseMacProcessList,
  selectVoiceProcessTree,
}
