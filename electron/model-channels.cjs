'use strict'

/**
 * IPC channel names for model management. Pure constants (no Electron), so node:test can load them.
 *
 * preload.cjs (avatar window) and settings-preload.cjs are sandboxed and cannot require this
 * module; they inline the same literals. electron/test/model-channels.test.cjs compares the
 * source text of both preloads against these values.
 */

// Avatar renderer <-> main
const MODEL_GET_ACTIVE_CHANNEL = 'live2d:model:get-active' // invoke -> ActiveModel | { missing }
const MODEL_CHANGED_CHANNEL = 'live2d:model:changed' // main -> avatar { requestId, active }
const MODEL_LOAD_RESULT_CHANNEL = 'live2d:model:load-result' // invoke { requestId, ok, error? }

// Settings windows <-> main
const MODEL_IMPORT_CHANNEL = 'live2d:model:import' // invoke (path) -> { ok, id?, error? }
const MODEL_PROGRESS_CHANNEL = 'live2d:model:progress' // main -> settings { step, total, label }
const CORE_IMPORT_CHANNEL = 'live2d:core:import' // invoke (path) -> { ok, error? }
const MODEL_SAVE_THUMB_CHANNEL = 'live2d:model:save-thumb' // invoke { id, png: ArrayBuffer }

module.exports = {
  CORE_IMPORT_CHANNEL,
  MODEL_CHANGED_CHANNEL,
  MODEL_GET_ACTIVE_CHANNEL,
  MODEL_IMPORT_CHANNEL,
  MODEL_LOAD_RESULT_CHANNEL,
  MODEL_PROGRESS_CHANNEL,
  MODEL_SAVE_THUMB_CHANNEL,
}
