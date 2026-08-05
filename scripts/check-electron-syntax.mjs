#!/usr/bin/env node
/**
 * electron/ 顶层脚本语法检查
 *
 * 取代 package.json 里 18 条手写的 `node --check electron/xxx.cjs` 串联：
 *  1. 清单自动发现 —— 扫描 electron/ 顶层的 .cjs / .js，新增文件自动纳入检查，
 *     删除文件也不会留下失效条目（不递归 electron/test/，那里由 node --test 覆盖）。
 *  2. 单进程完成 —— 逐文件用 vm.Script 编译，省掉 18 次 Node 启动开销。
 *
 * 本仓库 package.json 无 "type": "module"，.cjs / .js 一律是 CommonJS 脚本，
 * vm.Script 直接编译即可判定语法，无需 ESM 包装。
 */

import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const TARGET_DIR = path.join(ROOT, 'electron')
const EXTENSIONS = new Set(['.cjs', '.js'])

/** 列出 electron/ 顶层待检查的脚本（排序保证输出稳定）。 */
function listScripts() {
  return fs
    .readdirSync(TARGET_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && EXTENSIONS.has(path.extname(entry.name)))
    .map((entry) => entry.name)
    .sort()
}

const files = listScripts()
if (files.length === 0) {
  console.error(`✘ electron/ 顶层未发现任何 .cjs / .js，清单发现逻辑可能已失效：${TARGET_DIR}`)
  process.exit(1)
}

const failures = []
for (const name of files) {
  const absolute = path.join(TARGET_DIR, name)
  try {
    // filename 让 V8 的报错定位到真实路径，便于直接跳转。
    new vm.Script(fs.readFileSync(absolute, 'utf8'), { filename: absolute })
  } catch (error) {
    failures.push({ file: path.join('electron', name), error })
  }
}

if (failures.length > 0) {
  for (const { file, error } of failures) {
    console.error(`✘ ${file}`)
    console.error(`  ${error.message}`)
  }
  console.error(`✘ electron 语法检查失败：${failures.length}/${files.length} 个文件有语法错误`)
  process.exit(1)
}

console.log(`✔ electron 语法检查通过（${files.length} 个文件：electron/*.cjs、electron/*.js）`)
