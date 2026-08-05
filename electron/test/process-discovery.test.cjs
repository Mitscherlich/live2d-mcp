'use strict'

/**
 * process-discovery.cjs 单测（ADR 0001 · F6 · NFR-3）
 * ps 输出解析、identity 匹配、进程树选择（后代包含/自身排除/根计算）、
 * application source_id 匹配、非 darwin 平台空列表（预留）。
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const {
  discoverVoiceProcesses,
  identityMatches,
  listPlatformProcesses,
  parseMacCommandList,
  parseMacProcessList,
  selectVoiceProcessTree,
} = require('../process-discovery.cjs')
const {
  DEFAULT_VOICE_APP_PATTERN,
  encodeIdentity,
  processSourceId,
} = require('../voice-source.cjs')

const PS_COMM = `  1     0 /sbin/launchd
 100     1 /Applications/ChatGPT.app/Contents/MacOS/ChatGPT
 101   100 /Applications/ChatGPT.app/Contents/Frameworks/Codex Framework.framework/Helpers/Codex (Service).app/Contents/MacOS/Codex (Service)
 102   100 /Applications/ChatGPT.app/Contents/Frameworks/Codex Framework.framework/Helpers/browser_crashpad_handler
 200     1 /usr/sbin/afplay
 300     1 /Applications/Firefox.app/Contents/MacOS/firefox
`

const PS_ARGS = `  1 /sbin/launchd
 100 /Applications/ChatGPT.app/Contents/MacOS/ChatGPT
 101 /Applications/ChatGPT.app/Contents/Frameworks/Codex Framework.framework/Helpers/Codex (Service).app/Contents/MacOS/Codex (Service)
 102 /Applications/ChatGPT.app/Contents/Frameworks/Codex Framework.framework/Helpers/browser_crashpad_handler --annotation
 200 /usr/sbin/afplay /System/Library/Sounds/Glass.aiff
 300 /Applications/Firefox.app/Contents/MacOS/firefox -foreground
`

test('parseMacProcessList：解析 pid/ppid/comm', () => {
  const list = parseMacProcessList(PS_COMM)
  assert.equal(list.length, 6)
  assert.deepEqual(list[1], {
    pid: 100,
    parentId: 1,
    name: '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT',
    executable: '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT',
    command: '',
  })
  assert.equal(parseMacProcessList('').length, 0)
})

test('parseMacCommandList：pid → 完整命令行', () => {
  const map = parseMacCommandList(PS_ARGS)
  assert.equal(map.get(200), '/usr/sbin/afplay /System/Library/Sounds/Glass.aiff')
  assert.equal(map.size, 6)
})

test('identityMatches：默认 pattern 命中 comm 或 args，miss 无关进程', () => {
  const chatgpt = { name: '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT', executable: '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT', command: '' }
  assert.equal(identityMatches(chatgpt, DEFAULT_VOICE_APP_PATTERN), true)
  const firefox = { name: 'firefox', executable: '/Applications/Firefox.app/Contents/MacOS/firefox', command: '-foreground' }
  assert.equal(identityMatches(firefox, DEFAULT_VOICE_APP_PATTERN), false)
  // 自定义 pattern 可命中命令行参数（如 afplay 播放声音的路径）
  const afplay = { name: '/usr/sbin/afplay', executable: '/usr/sbin/afplay', command: '/usr/sbin/afplay Glass.aiff' }
  assert.equal(identityMatches(afplay, /afplay/i), true)
})

test('selectVoiceProcessTree：直配 + 后代纳入，根为父未匹配的直配进程', () => {
  const processes = parseMacProcessList(PS_COMM)
  const { pids, rootPids } = selectVoiceProcessTree(processes, {
    ownProcessId: 999,
    pattern: DEFAULT_VOICE_APP_PATTERN,
    platform: 'darwin',
  })
  // ChatGPT(100) 与 Codex (Service)(101) 直配；crashpad(102) 作为 100 的后代纳入
  assert.deepEqual(pids, [100, 101, 102])
  assert.deepEqual(rootPids, [100]) // 101 的父 100 也是直配 → 根只有 100
})

test('selectVoiceProcessTree：排除自身 pid；无匹配返回空', () => {
  const processes = [
    { pid: 5, parentId: 1, name: 'codex', executable: 'codex', command: '' },
    { pid: 6, parentId: 5, name: 'worker', executable: 'worker', command: '' },
  ]
  const selfExcluded = selectVoiceProcessTree(processes, {
    ownProcessId: 5,
    pattern: /codex/i,
    platform: 'darwin',
  })
  assert.deepEqual(selfExcluded.pids, [])
  const none = selectVoiceProcessTree(processes, {
    ownProcessId: 999,
    pattern: /no-such-app/i,
    platform: 'darwin',
  })
  assert.deepEqual(none, { pids: [], rootPids: [] })
})

test('selectVoiceProcessTree：application 模式按 source_id 精确匹配（忽略 regex）', () => {
  const processes = parseMacProcessList(PS_COMM)
  const target = processes[1] // ChatGPT
  const id = processSourceId('darwin', target)
  assert.equal(id, `process:darwin:${encodeIdentity(target.executable)}`)
  const { pids, rootPids } = selectVoiceProcessTree(processes, {
    ownProcessId: 999,
    sourceId: id,
    platform: 'darwin',
    pattern: /this-regex-must-be-ignored/i,
  })
  assert.deepEqual(pids, [100, 101, 102]) // 树仍含后代
  assert.deepEqual(rootPids, [100])
})

test('listPlatformProcesses：非 darwin 返回空（linux/win 预留）；darwin 走 ps 解析', async () => {
  assert.deepEqual(await listPlatformProcesses({ platform: 'linux', run: async () => ({ stdout: '' }) }), [])
  const run = async (_cmd, args) =>
    args[1].startsWith('pid=,ppid=') ? { stdout: PS_COMM } : { stdout: PS_ARGS }
  const list = await listPlatformProcesses({ platform: 'darwin', run })
  assert.equal(list.length, 6)
  assert.match(list.find((p) => p.pid === 200).command, /Glass\.aiff/)
})

test('discoverVoiceProcesses：voice source → sourceId/pattern 分派', async () => {
  const run = async (_cmd, args) =>
    args[1].startsWith('pid=,ppid=') ? { stdout: PS_COMM } : { stdout: PS_ARGS }
  const auto = await discoverVoiceProcesses({
    platform: 'darwin',
    run,
    ownProcessId: 999,
    pattern: DEFAULT_VOICE_APP_PATTERN,
    voiceSource: { mode: 'automatic' },
  })
  assert.deepEqual(auto.pids, [100, 101, 102])

  const id = `process:darwin:${encodeIdentity('/usr/sbin/afplay')}`
  const app = await discoverVoiceProcesses({
    platform: 'darwin',
    run,
    ownProcessId: 999,
    voiceSource: { mode: 'application', source_id: id, source_name: 'afplay' },
  })
  assert.deepEqual(app.pids, [200])
})
