'use strict'

/**
 * URL path -> file mapping for user-supplied assets under the Mayuka home directory.
 * Shared by the prod scheme handler (renderer-protocol.cjs) and the dev Vite middleware
 * (renderer/vite.config.ts), so both enforce the same containment rules.
 *
 *   /user-models/<id>/<path...>          -> <home>/models/<id>/<path...>
 *   /user-core/live2dcubismcore.min.js   -> <home>/core/live2dcubismcore.min.js
 */

const path = require('node:path')
const { CORE_FILE_NAME, isValidModelId, resolvePaths } = require('./mayuka-paths.cjs')

const USER_MODELS_PREFIX = '/user-models/'
const USER_CORE_PREFIX = '/user-core/'

/** True when the path belongs to the user-asset namespace (even if it is invalid). */
function isUserAssetPath(urlPath) {
  return typeof urlPath === 'string' && (urlPath.startsWith(USER_MODELS_PREFIX) || urlPath.startsWith(USER_CORE_PREFIX) || urlPath === '/user-models' || urlPath === '/user-core')
}

/** Join `rel` under `root`; null when the result escapes `root` (or equals it). */
function resolveWithin(root, rel) {
  const target = path.resolve(root, rel)
  const relative = path.relative(root, target)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null
  return target
}

/** Returns an absolute file path, or null for anything invalid or escaping. */
function resolveUserAsset(home, urlPath) {
  if (typeof urlPath !== 'string') return null
  let decoded
  try {
    decoded = decodeURIComponent(urlPath)
  } catch {
    return null
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return null
  const paths = resolvePaths(home)
  if (decoded.startsWith(USER_CORE_PREFIX)) {
    return decoded === `${USER_CORE_PREFIX}${CORE_FILE_NAME}` ? paths.coreFile : null
  }
  if (decoded.startsWith(USER_MODELS_PREFIX)) {
    const rest = decoded.slice(USER_MODELS_PREFIX.length)
    const slash = rest.indexOf('/')
    if (slash <= 0) return null
    const id = rest.slice(0, slash)
    if (!isValidModelId(id)) return null
    return resolveWithin(path.join(paths.modelsDir, id), rest.slice(slash + 1))
  }
  return null
}

module.exports = {
  USER_CORE_PREFIX,
  USER_MODELS_PREFIX,
  isUserAssetPath,
  resolveUserAsset,
  resolveWithin,
}
