/**
 * TTS + 口型同步工具（腾讯云 TTS）
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { sendCommand, isRendererConnected } from '../ws-bridge.js'

// API 配置 - 从环境变量读取
const TENCENT_SECRET_ID = process.env.TENCENT_SECRET_ID || ''
const TENCENT_SECRET_KEY = process.env.TENCENT_SECRET_KEY || ''

// 字级时间戳 → lipSyncData（每个字张嘴，停顿闭嘴）
function subtitlesToLipSync(
  subtitles: Array<{ Text: string; BeginTime: number; EndTime: number }>
): Array<{ time: number; value: number }> {
  if (subtitles.length === 0) return []

  const data: Array<{ time: number; value: number }> = []
  const PUNCT = /^[，。！？、；：""''（）【】…—,.!?;: \s]$/

  for (const { Text, BeginTime, EndTime } of subtitles) {
    const duration = EndTime - BeginTime
    if (PUNCT.test(Text) || duration <= 0) {
      // 标点/停顿：嘴巴闭合
      data.push({ time: BeginTime, value: 0 })
      continue
    }
    const ramp = Math.min(40, duration * 0.25)
    data.push({ time: BeginTime, value: 0 })                   // 开始张嘴
    data.push({ time: BeginTime + ramp, value: 0.85 })         // 张开
    data.push({ time: EndTime - ramp, value: 0.85 })           // 保持
    data.push({ time: EndTime, value: 0 })                     // 闭嘴
  }

  return data
}

// 腾讯云 TTS 支持
// 参考文档: https://cloud.tencent.com/document/product/1073/108595
async function speakWithTencentTTS(
  text: string,
  emotion: string,
  speed: number,
  customVoiceType?: number
): Promise<{ success: boolean; audioBase64?: string; duration?: number; lipSyncData?: Array<{ time: number; value: number }>; error?: string }> {
  if (!TENCENT_SECRET_ID || !TENCENT_SECRET_KEY) {
    return { success: false, error: 'No Tencent Cloud credentials' }
  }

  try {
    const endpoint = 'tts.tencentcloudapi.com'
    const service = 'tts'
    const version = '2019-08-23'
    const action = 'TextToVoice'
    const region = 'ap-beijing'

    // 根据情感选择声音类型，或使用自定义音色
    // 0: 亲和女声, 1: 亲和男声, 2: 成熟男声, 4: 温暖女声, 5: 情感女声, 6: 情感男声
    // 603004: 温柔小柠 (超自然大模型音色)
    let voiceType = customVoiceType
    if (voiceType === undefined) {
      voiceType = 603004 // 默认温柔小柠（超自然大模型音色）
    }

    // 语速: 0 ~ 2, 0.5 为正常语速，2 为 2 倍速
    const tencentSpeed = Math.max(0, Math.min(2, speed))
    const payload = {
      Text: text,
      SessionId: `session-${Date.now()}`,
      ModelType: 1,
      VoiceType: voiceType,
      Speed: tencentSpeed,
      EnableSubtitle: true,
    }

    const payloadJson = JSON.stringify(payload)

    const timestamp = Math.floor(Date.now() / 1000)
    const date = new Date(timestamp * 1000).toISOString().split('T')[0]

    // TC3-HMAC-SHA256 签名
    const httpRequestMethod = 'POST'
    const canonicalUri = '/'
    const canonicalQueryString = ''
    const canonicalHeaders = `content-type:application/json\nhost:${endpoint}\n`
    const signedHeaders = 'content-type;host'

    const crypto = await import('crypto')
    const payloadHash = crypto.createHash('sha256').update(payloadJson).digest('hex')

    const canonicalRequest = `${httpRequestMethod}\n${canonicalUri}\n${canonicalQueryString}\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`

    const algorithm = 'TC3-HMAC-SHA256'
    const credentialScope = `${date}/${service}/tc3_request`
    const hashedCanonicalRequest = crypto.createHash('sha256').update(canonicalRequest).digest('hex')
    const stringToSign = `${algorithm}\n${timestamp}\n${credentialScope}\n${hashedCanonicalRequest}`

    const secretDate = crypto.createHmac('sha256', `TC3${TENCENT_SECRET_KEY}`).update(date).digest()
    const secretService = crypto.createHmac('sha256', secretDate).update(service).digest()
    const secretSigning = crypto.createHmac('sha256', secretService).update('tc3_request').digest()
    const signature = crypto.createHmac('sha256', secretSigning).update(stringToSign).digest('hex')

    const authorization = `${algorithm} Credential=${TENCENT_SECRET_ID}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`

    const response = await fetch(`https://${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Host': endpoint,
        'X-TC-Action': action,
        'X-TC-Version': version,
        'X-TC-Timestamp': String(timestamp),
        'X-TC-Region': region,
        'Authorization': authorization,
      },
      body: payloadJson,
    })

    const result = await response.json() as {
      Response?: {
        Audio?: string
        Subtitles?: Array<{ Text: string; BeginTime: number; EndTime: number }>
        Error?: { Message?: string }
      }
    }

    if (result.Response?.Error) {
      throw new Error(`Tencent TTS error: ${result.Response.Error.Message}`)
    }

    if (!result.Response?.Audio) {
      throw new Error('Tencent TTS returned no audio')
    }

    const audioBase64 = result.Response.Audio
    const duration = (text.length / 5) * 1000 / speed
    const lipSyncData = subtitlesToLipSync(result.Response.Subtitles ?? [])

    return { success: true, audioBase64, duration, lipSyncData }
  } catch (e) {
    console.error('[TTS] Tencent TTS error:', e)
    return { success: false, error: String(e) }
  }
}

export function registerTTSTools(server: McpServer): void {
  // TTS 说话 + 口型同步
  server.tool(
    'speak',
    '让 Live2D 角色说话，并同步口型动画。优先使用腾讯云 TTS，其次 ElevenLabs，最后回退到 Web Speech API。',
    {
      text: z.string().describe('要说的文本内容'),
      emotion: z
        .enum(['neutral', 'happy', 'sad', 'angry', 'surprised'])
        .default('neutral')
        .describe('说话的情感/语气'),
      speed: z
        .number()
        .min(0.5)
        .max(2.0)
        .default(1.0)
        .describe('语速倍率，1.0 为正常语速'),
      voice_id: z
        .string()
        .optional()
        .describe('ElevenLabs Voice ID（可选）'),
      voice_type: z
        .number()
        .optional()
        .describe('腾讯云 TTS VoiceType（可选），例如：603004 是温柔小柠'),
    },
    async ({ text, emotion, speed, voice_type }) => {
      if (!isRendererConnected()) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: false,
                error: '渲染器未连接，请先在浏览器中打开 renderer 页面（http://localhost:5173）',
              }),
            },
          ],
        }
      }

      const result = await speakWithTencentTTS(text, emotion, speed, voice_type)

      if (!result.success || !result.audioBase64) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ success: false, error: result.error }),
            },
          ],
        }
      }

      await sendCommand('setExpression', { expression: emotion })
      await sendCommand('lipSync', {
        audioBase64: result.audioBase64,
        lipSyncData: result.lipSyncData,
      })

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              text: text.slice(0, 50) + (text.length > 50 ? '...' : ''),
              emotion,
              speed,
              engine: 'Tencent TTS',
              estimatedDurationMs: result.duration,
            }),
          },
        ],
      }
    }
  )

  // 仅口型动画 - 用于配合外部 TTS
  server.tool(
    'lip_sync_estimate',
    '仅启动口型动画，不播放音频。用于配合外部 TTS（如 OpenClaw Talk 模式）时同步口型。',
    {
      text: z.string().describe('要说的文本内容（用于估算时长）'),
      duration_ms: z.number().optional(),
      emotion: z.enum(['neutral', 'happy', 'sad', 'angry', 'surprised']).default('neutral'),
      speed: z.number().min(0.5).max(2.0).default(1.0),
    },
    async ({ text, duration_ms, emotion, speed }) => {
      if (!isRendererConnected()) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ success: false, error: '渲染器未连接' }) }],
        }
      }

      const duration = duration_ms || (text.length / 5) * 1000 / speed

      await sendCommand('setExpression', { expression: emotion })
      await sendCommand('startLipSyncOnly', { duration, emotion })

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              text: text.slice(0, 50) + (text.length > 50 ? '...' : ''),
              emotion,
              estimatedDurationMs: duration,
            }),
          },
        ],
      }
    }
  )

  // 外部音频口型同步
  server.tool(
    'lip_sync',
    '根据音频播放进度控制口型。',
    {
      audio_url: z.string().optional(),
      audio_base64: z.string().optional(),
      lip_sync_data: z.array(z.object({ time: z.number(), value: z.number() })).optional(),
    },
    async ({ audio_url, audio_base64, lip_sync_data }) => {
      if (!isRendererConnected()) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ success: false, error: '渲染器未连接' }) }],
        }
      }

      const result = await sendCommand('lipSync', {
        audioUrl: audio_url,
        audioBase64: audio_base64,
        lipSyncData: lip_sync_data,
      })

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ success: result.success }),
          },
        ],
      }
    }
  )
}
