'use strict'

/**
 * Per-model override seeds, keyed by the model3.json file name. Applied once at import time
 * (written into the manifest `overrides`), so models that need hand-tuned tables keep working
 * after the hard-coded tables left renderer/src/model-config.ts.
 *
 * Shape (renderer ModelOverrides): { hitAreaMotions, motionNames, physicsInputDrives }.
 */

const DAFEIYU_ENTRY = '大肥鱼.model3.json'

const OVERRIDE_SEEDS = Object.freeze({
  [DAFEIYU_ENTRY]: {
    hitAreaMotions: {},
    motionNames: {
      'Idle:0': '待机',
      '默认手切举手:0': '默认手切举手',
      '举手切默认手:0': '举手切默认手',
      '狗尾草切换出来:0': '狗尾草切换出来',
      '狗尾草切回默认手:0': '狗尾草切回默认手',
      '竖手指切出来动画:0': '竖手指切出来',
      '竖手指切回默认:0': '竖手指切回默认',
      '脱捕:0': '脱捕',
    },
    // This model drives AngleX/BodyAngleX through physics outputs, so gaze and breath must be
    // written as physics inputs (coefficients follow Cubism's default focus +-30 and breath).
    physicsInputDrives: [
      { id: 'AngleX', x: 30, y: 0, xy: 0, breathAmp: 7.5, breathCycle: 6.5345 },
      { id: 'AngleY', x: 0, y: 30, xy: 0, breathAmp: 4, breathCycle: 3.5345 },
      { id: 'AngleZ', x: 0, y: 0, xy: -30, breathAmp: 5, breathCycle: 5.5345 },
      { id: 'PositionX', x: 10, y: 0, xy: 0, breathAmp: 2, breathCycle: 15.5345 },
    ],
  },
})

module.exports = { DAFEIYU_ENTRY, OVERRIDE_SEEDS }
