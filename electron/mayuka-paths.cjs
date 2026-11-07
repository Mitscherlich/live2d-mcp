'use strict'

/**
 * Locations of user-supplied assets (Cubism Core and imported models).
 * Pure path math with no Electron dependency, so node:test can use it directly.
 *
 * Root: `MAYUKA_HOME` when set (tests, dev isolation), otherwise `~/.mayuka`.
 */

const os = require('node:os')
const path = require('node:path')

const CORE_FILE_NAME = 'live2dcubismcore.min.js'
const MANIFEST_FILE_NAME = 'mayuka-model.json'
// v2: earlier builds could write fully transparent thumb.png files; a new name makes them regenerate.
const THUMB_FILE_NAME = 'thumb-v2.png'
/** Model ids double as URL path segments and directory names. */
const MODEL_ID_PATTERN = /^[a-z0-9_-]{1,80}$/

function mayukaHome({ env = process.env, homedir = os.homedir } = {}) {
  const override = env.MAYUKA_HOME
  if (typeof override === 'string' && override.trim()) return path.resolve(override.trim())
  return path.join(homedir(), '.mayuka')
}

function resolvePaths(home) {
  return {
    home,
    coreDir: path.join(home, 'core'),
    coreFile: path.join(home, 'core', CORE_FILE_NAME),
    modelsDir: path.join(home, 'models'),
    tmpDir: path.join(home, '.tmp'),
  }
}

function isValidModelId(id) {
  return typeof id === 'string' && MODEL_ID_PATTERN.test(id)
}

module.exports = {
  CORE_FILE_NAME,
  MANIFEST_FILE_NAME,
  MODEL_ID_PATTERN,
  THUMB_FILE_NAME,
  isValidModelId,
  mayukaHome,
  resolvePaths,
}
