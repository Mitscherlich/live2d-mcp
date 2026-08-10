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
  displayNameFromIdentity,
  identityMatches,
  listApplicationSources,
  listPlatformProcesses,
  mapProcessesToApplicationSources,
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
  const firefox = { name: '/Applications/Firefox.app/Contents/MacOS/firefox', executable: '/Applications/Firefox.app/Contents/MacOS/firefox', command: '-foreground' }
  assert.equal(identityMatches(firefox, DEFAULT_VOICE_APP_PATTERN), false)
  // 自定义 pattern 可命中命令行参数（如 CLI 启动的 codex，comm 只是 node）
  const cli = { name: '/usr/local/bin/node', executable: '/usr/local/bin/node', command: 'node /opt/codex/bin/codex' }
  assert.equal(identityMatches(cli, DEFAULT_VOICE_APP_PATTERN), true)
  // 匹配文本只拼 name + command：executable 与 name 同源（parseMacProcessList 同一捕获组），
  // 拼进去只是让每个进程多匹配一遍相同文本
  const commandOnly = { name: 'node', command: 'node --flag' }
  assert.equal(identityMatches(commandOnly, /--flag/i), true)
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

test('listPlatformProcesses：includeArgs:false 只跑 comm 那一次 ps（application 模式）', async () => {
  const invocations = []
  const run = async (_cmd, args) => {
    invocations.push(args[1])
    return args[1].startsWith('pid=,ppid=') ? { stdout: PS_COMM } : { stdout: PS_ARGS }
  }
  const list = await listPlatformProcesses({ platform: 'darwin', run, includeArgs: false })
  assert.deepEqual(invocations, ['pid=,ppid=,comm='], '不得执行 args 那一次 ps')
  assert.equal(list.length, 6)
  assert.equal(list.find((p) => p.pid === 200).command, '', 'command 留空（该模式无人消费）')
})

test('mapProcessesToApplicationSources：同 identity 多 PID 去重，无 command 字段', () => {
  const processes = [
    {
      pid: 10,
      parentId: 1,
      name: '/Applications/NeteaseMusic.app/Contents/MacOS/NeteaseMusic',
      executable: '/Applications/NeteaseMusic.app/Contents/MacOS/NeteaseMusic',
      command: 'should-not-appear --secret',
    },
    {
      pid: 11,
      parentId: 10,
      name: '/Applications/NeteaseMusic.app/Contents/MacOS/NeteaseMusic',
      executable: '/Applications/NeteaseMusic.app/Contents/MacOS/NeteaseMusic',
      command: 'another-args',
    },
    {
      pid: 20,
      parentId: 1,
      name: '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT',
      executable: '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT',
      command: '',
    },
    { pid: 99, parentId: 1, name: 'self', executable: 'self', command: '' },
  ]
  const list = mapProcessesToApplicationSources(processes, {
    platform: 'darwin',
    ownProcessId: 99,
  })
  assert.equal(list.length, 2)
  const netease = list.find((item) => item.source_name === 'NeteaseMusic')
  const chatgpt = list.find((item) => item.source_name === 'ChatGPT')
  assert.ok(netease)
  assert.ok(chatgpt)
  assert.equal(netease.pidCount, 2)
  assert.equal(chatgpt.pidCount, 1)
  assert.equal(
    netease.source_id,
    processSourceId('darwin', processes[0]),
  )
  assert.match(netease.source_id, /^process:darwin:[A-Za-z0-9_-]+$/)
  for (const item of list) {
    assert.deepEqual(Object.keys(item).sort(), ['pidCount', 'source_id', 'source_name'])
    assert.equal('command' in item, false)
    assert.equal('args' in item, false)
  }
  // 按 source_name 排序：ChatGPT 在 NeteaseMusic 前
  assert.equal(list[0].source_name, 'ChatGPT')
  assert.equal(list[1].source_name, 'NeteaseMusic')
  // 自身 pid 已排除
  assert.equal(list.some((item) => item.source_name === 'self'), false)
})

test('mapProcessesToApplicationSources：非 darwin / 空输入 → []', () => {
  const sample = [
    { pid: 1, parentId: 0, name: 'NeteaseMusic', executable: 'NeteaseMusic', command: '' },
  ]
  assert.deepEqual(mapProcessesToApplicationSources(sample, { platform: 'linux' }), [])
  assert.deepEqual(mapProcessesToApplicationSources([], { platform: 'darwin' }), [])
  assert.deepEqual(mapProcessesToApplicationSources(null, { platform: 'darwin' }), [])
})

test('displayNameFromIdentity：路径取 basename', () => {
  assert.equal(
    displayNameFromIdentity('/Applications/NeteaseMusic.app/Contents/MacOS/NeteaseMusic'),
    'NeteaseMusic',
  )
  assert.equal(displayNameFromIdentity('  codex  '), 'codex')
  assert.equal(displayNameFromIdentity(''), '')
})

test('listApplicationSources：注入 ps 快照时返回去重 sources，且不含 command', async () => {
  const run = async (_cmd, args) => {
    assert.equal(args[1], 'pid=,ppid=,comm=', '设置列表不得请求完整 args')
    return {
      stdout: `  10     1 /Applications/NeteaseMusic.app/Contents/MacOS/NeteaseMusic
  11    10 /Applications/NeteaseMusic.app/Contents/MacOS/NeteaseMusic
  20     1 /Applications/ChatGPT.app/Contents/MacOS/ChatGPT
`,
    }
  }
  const result = await listApplicationSources({
    platform: 'darwin',
    run,
    ownProcessId: 999,
  })
  assert.equal(result.platform, 'darwin')
  assert.equal(result.note, null)
  assert.equal(result.sources.length, 2)
  assert.equal(result.sources.find((s) => s.source_name === 'NeteaseMusic').pidCount, 2)
  for (const item of result.sources) {
    assert.deepEqual(Object.keys(item).sort(), ['pidCount', 'source_id', 'source_name'])
  }
})

test('listApplicationSources：非 darwin → 空列表 + note', async () => {
  const result = await listApplicationSources({
    platform: 'linux',
    run: async () => {
      throw new Error('不应调用 ps')
    },
    ownProcessId: 1,
  })
  assert.deepEqual(result.sources, [])
  assert.equal(result.platform, 'linux')
  assert.match(result.note, /不支持|macOS/)
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

test('discoverVoiceProcesses：application 模式跳过 args 那次 ps；automatic 仍需要', async () => {
  const runWith = (invocations) => async (_cmd, args) => {
    invocations.push(args[1])
    return args[1].startsWith('pid=,ppid=') ? { stdout: PS_COMM } : { stdout: PS_ARGS }
  }
  const appCalls = []
  await discoverVoiceProcesses({
    platform: 'darwin',
    run: runWith(appCalls),
    ownProcessId: 999,
    voiceSource: {
      mode: 'application',
      source_id: `process:darwin:${encodeIdentity('/usr/sbin/afplay')}`,
      source_name: 'afplay',
    },
  })
  assert.deepEqual(appCalls, ['pid=,ppid=,comm='])

  const autoCalls = []
  await discoverVoiceProcesses({
    platform: 'darwin',
    run: runWith(autoCalls),
    ownProcessId: 999,
    pattern: DEFAULT_VOICE_APP_PATTERN,
    voiceSource: { mode: 'automatic' },
  })
  assert.equal(autoCalls.length, 2, 'automatic 需要 args（CLI 启动的 codex，comm 只是 node）')
})
