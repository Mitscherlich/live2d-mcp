'use strict'

/**
 * sandbox preload 源文本常量提取器（防漂移护栏共用）
 *
 * 为什么读源文本而不是 require：electron/preload.cjs 与
 * electron/settings-preload.cjs 都在 sandbox 下运行，只能 require
 * electron/events/timers/url，拿不到本仓模块，因此通道常量与白名单只能内联一份。
 * 平台硬约束无法消除，唯一能做的是让「内联副本与权威模块漂移」在单测里立刻变红：
 * 本模块把 preload 当纯文本解析，抽出内联字面量交给测试比对。
 *
 * fail loud：赋值写法一旦改变（换引号、改成模板串、拆成对象），提取会抛错而不是
 * 静默返回空——护栏宁可因为形式变化误报，也不允许因为提取失败假绿。
 */

const fs = require('node:fs')
const path = require('node:path')

const ELECTRON_DIR = path.join(__dirname, '..', '..')

/** 提取 `const NAME = '字面量'`（单引号、独占一行）。 */
function extractStringConst(source, name, fileName) {
  const match = new RegExp(`^const\\s+${name}\\s*=\\s*'([^']*)'\\s*$`, 'm').exec(source)
  if (match === null) {
    throw new Error(
      `未能从 ${fileName} 提取 \`const ${name} = '…'\`：` +
        '常量被改名/删除，或赋值写法已变更。请同步内联副本，' +
        '或更新 electron/test/helpers/source-probe.cjs 的正则——不要删除断言。',
    )
  }
  return match[1]
}

/** 提取 `const NAME = new Set([...])` 的字符串成员，按集合语义返回已排序数组。 */
function extractSetMembers(source, name, fileName) {
  const match = new RegExp(`^const\\s+${name}\\s*=\\s*new Set\\(\\[([^\\]]*)\\]\\)`, 'm').exec(
    source,
  )
  if (match === null) {
    throw new Error(
      `未能从 ${fileName} 提取 \`const ${name} = new Set([…])\`：` +
        '白名单被改名/删除，或写法已变更。请同步内联副本，' +
        '或更新 electron/test/helpers/source-probe.cjs 的正则——不要删除断言。',
    )
  }
  const members = [...match[1].matchAll(/'([^']*)'/g)].map((entry) => entry[1])
  if (members.length === 0) {
    throw new Error(`${fileName} 的 ${name} 提取到空集合：白名单不应为空，请检查写法`)
  }
  return members.sort()
}

/**
 * 载入 electron/ 下某个源文件，返回按名提取内联常量的探针。
 * @param {string} fileName electron/ 下的文件名，如 'preload.cjs'
 */
function loadSourceProbe(fileName) {
  const source = fs.readFileSync(path.join(ELECTRON_DIR, fileName), 'utf8')
  return {
    fileName,
    /** @returns {string} 内联的字符串常量值 */
    stringConst: (name) => extractStringConst(source, name, fileName),
    /** @returns {string[]} 内联 Set 的成员（已排序） */
    setMembers: (name) => extractSetMembers(source, name, fileName),
  }
}

module.exports = { loadSourceProbe }
