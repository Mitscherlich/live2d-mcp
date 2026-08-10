'use strict'

/**
 * Architecture deliverables gate (docs/architecture-graph.json + docs/architecture-diagram.html).
 *
 * Proves:
 *  - JSON parses and has non-empty nodes/edges/flows with steps
 *  - edge endpoints and flow steps reference existing node ids
 *  - HTML is self-contained (no remote script/link/cdn) and embeds matching graph data
 *  - HTML ships flow-selection → path highlight + tooltip interaction logic
 *  - core real modules from the repo appear in the graph
 */

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '../..')
const JSON_PATH = path.join(ROOT, 'docs/architecture-graph.json')
const HTML_PATH = path.join(ROOT, 'docs/architecture-diagram.html')

function loadJson() {
  const raw = fs.readFileSync(JSON_PATH, 'utf8')
  return JSON.parse(raw)
}

function extractEmbeddedArchData(html) {
  const m = html.match(
    /<script[^>]*id=["']arch-data["'][^>]*>([\s\S]*?)<\/script>/i,
  )
  assert.ok(m, 'HTML must embed <script id="arch-data"> with architecture JSON')
  return JSON.parse(m[1])
}

function ids(arr) {
  return new Set(arr.map((x) => x.id))
}

describe('architecture-graph deliverables', () => {
  it('JSON exists and has valid top-level shape', () => {
    assert.ok(fs.existsSync(JSON_PATH), `missing ${JSON_PATH}`)
    const data = loadJson()
    assert.ok(Array.isArray(data.nodes) && data.nodes.length > 0, 'nodes non-empty')
    assert.ok(Array.isArray(data.edges) && data.edges.length > 0, 'edges non-empty')
    assert.ok(Array.isArray(data.flows) && data.flows.length > 0, 'flows non-empty')
    for (const f of data.flows) {
      assert.ok(Array.isArray(f.steps) && f.steps.length >= 2, `flow ${f.id} steps >= 2`)
      assert.ok(typeof f.id === 'string' && f.id.length > 0, 'flow id')
      assert.ok(typeof f.name === 'string' && f.name.length > 0, 'flow name')
    }
  })

  it('edge and flow references resolve to node ids', () => {
    const data = loadJson()
    const nodeIds = ids(data.nodes)
    for (const n of data.nodes) {
      assert.ok(typeof n.id === 'string' && n.id.length > 0, 'node id')
      assert.ok(typeof n.label === 'string' && n.label.length > 0, 'node label')
    }
    for (const e of data.edges) {
      assert.ok(nodeIds.has(e.source), `edge ${e.id} source ${e.source}`)
      assert.ok(nodeIds.has(e.target), `edge ${e.id} target ${e.target}`)
    }
    for (const f of data.flows) {
      for (const step of f.steps) {
        assert.ok(nodeIds.has(step), `flow ${f.id} step ${step}`)
      }
    }
  })

  it('covers real core modules and main paths from ARCHITECTURE', () => {
    const data = loadJson()
    const nodeIds = ids(data.nodes)
    const requiredNodes = [
      'mcp-client',
      'bridge-server',
      'mcp-server',
      'electron-main',
      'voice-events',
      'cmd-channel',
      'audio-listener',
      'native-process-listener',
      'native-helper',
      'avatar-preload',
      'renderer-main',
      'lip-sync',
      'voice-state',
      'live2d-app',
      'tray',
      'settings-store',
    ]
    for (const id of requiredNodes) {
      assert.ok(nodeIds.has(id), `required node ${id}`)
    }

    // file fields that claim a path must exist in-repo (when provided)
    for (const n of data.nodes) {
      if (!n.file) continue
      const abs = path.join(ROOT, n.file)
      assert.ok(fs.existsSync(abs), `node ${n.id} file missing: ${n.file}`)
    }

    const flowIds = new Set(data.flows.map((f) => f.id))
    const requiredFlows = [
      'flow-mcp-visual-command',
      'flow-events-lipsync',
      'flow-native-lipsync',
      'flow-tray-lifecycle',
    ]
    for (const id of requiredFlows) {
      assert.ok(flowIds.has(id), `required flow ${id}`)
    }

    // MCP visual path must go agent → bridge → mcp → main → cmd → preload → renderer → live2d
    const mcp = data.flows.find((f) => f.id === 'flow-mcp-visual-command')
    for (const step of [
      'mcp-client',
      'bridge-server',
      'mcp-server',
      'electron-main',
      'cmd-channel',
      'avatar-preload',
      'renderer-main',
      'live2d-app',
    ]) {
      assert.ok(mcp.steps.includes(step), `mcp visual flow includes ${step}`)
    }

    // native lipsync must include helper + lip-sync
    const native = data.flows.find((f) => f.id === 'flow-native-lipsync')
    for (const step of [
      'native-helper',
      'native-process-listener',
      'electron-main',
      'avatar-preload',
      'lip-sync',
      'live2d-app',
    ]) {
      assert.ok(native.steps.includes(step), `native flow includes ${step}`)
    }
  })

  it('HTML is self-contained and embeds graph data consistent with JSON', () => {
    assert.ok(fs.existsSync(HTML_PATH), `missing ${HTML_PATH}`)
    const html = fs.readFileSync(HTML_PATH, 'utf8')

    // no remote CSS/JS (allow data: only)
    const remoteScript = html.match(
      /<script[^>]+src=["']https?:\/\//i,
    )
    const remoteLink = html.match(
      /<link[^>]+href=["']https?:\/\//i,
    )
    assert.equal(remoteScript, null, 'HTML must not load remote scripts')
    assert.equal(remoteLink, null, 'HTML must not load remote stylesheets')

    // structure: diagram + flow panel + tooltip
    assert.match(html, /id=["']diagram["']/)
    assert.match(html, /id=["']flow-list["']/)
    assert.match(html, /id=["']tooltip["']/)
    assert.match(html, /class=["'][^"']*side[^"']*["']/)

    // interaction logic present
    assert.match(html, /selectFlow/)
    assert.match(html, /applyHighlight|resolveStepEdgeIds/)
    assert.match(html, /showTooltip/)
    assert.match(html, /window\.__ARCH_DIAGRAM__/)

    const embedded = extractEmbeddedArchData(html)
    const fileData = loadJson()

    const fileNodeIds = [...ids(fileData.nodes)].sort()
    const embNodeIds = [...ids(embedded.nodes)].sort()
    assert.deepEqual(embNodeIds, fileNodeIds, 'HTML nodes must match JSON node ids')

    const fileFlowIds = fileData.flows.map((f) => f.id).sort()
    const embFlowIds = embedded.flows.map((f) => f.id).sort()
    assert.deepEqual(embFlowIds, fileFlowIds, 'HTML flows must match JSON flow ids')

    for (const f of fileData.flows) {
      const emb = embedded.flows.find((x) => x.id === f.id)
      assert.ok(emb, `embedded flow ${f.id}`)
      assert.deepEqual(emb.steps, f.steps, `steps for ${f.id}`)
    }

    const fileEdgeKeys = fileData.edges
      .map((e) => `${e.source}->${e.target}`)
      .sort()
    const embEdgeKeys = embedded.edges
      .map((e) => `${e.source}->${e.target}`)
      .sort()
    assert.deepEqual(embEdgeKeys, fileEdgeKeys, 'HTML edges must match JSON edge endpoints')
  })

  it('flow step sequences form a coherent path over known edges (undirected hop)', () => {
    const data = loadJson()
    const undirected = new Map()
    function add(a, b) {
      if (!undirected.has(a)) undirected.set(a, new Set())
      undirected.get(a).add(b)
    }
    for (const e of data.edges) {
      add(e.source, e.target)
      add(e.target, e.source)
    }

    // BFS reachability within graph for consecutive steps — allow multi-hop
    // only when direct edge missing but both nodes exist (orchestration hops via main).
    // Gate: every consecutive pair must share a path of length ≤ 3 in the undirected graph.
    function reachableWithin(start, goal, maxHops) {
      if (start === goal) return true
      const q = [[start, 0]]
      const seen = new Set([start])
      while (q.length) {
        const [cur, d] = q.shift()
        if (d >= maxHops) continue
        for (const nxt of undirected.get(cur) || []) {
          if (seen.has(nxt)) continue
          if (nxt === goal) return true
          seen.add(nxt)
          q.push([nxt, d + 1])
        }
      }
      return false
    }

    for (const f of data.flows) {
      for (let i = 0; i < f.steps.length - 1; i++) {
        const a = f.steps[i]
        const b = f.steps[i + 1]
        assert.ok(
          reachableWithin(a, b, 3),
          `flow ${f.id}: no path ≤3 hops between ${a} and ${b}`,
        )
      }
    }
  })
})
