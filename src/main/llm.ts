import * as https from 'https'

/**
 * Minimal Chat Completions client for the memory pipeline (screen captions + LTM distillation).
 * Separate from the Realtime path on purpose: these are cheap background text calls, never audio,
 * and losing one must never affect the live conversation.
 */

/** Cheap multimodal model for screen transcription and distillation (nano tier, priced for high volume) */
export const MEMORY_MODEL = process.env.ARIA_MEMORY_MODEL ?? 'gpt-5.6-luna'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string | unknown[]
}

function postJson(apiKey: string, body: unknown): Promise<any> {
  const payload = JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'api.openai.com',
        path: '/v1/chat/completions',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          Authorization: `Bearer ${apiKey}`
        }
      },
      res => {
        const chunks: Buffer[] = []
        res.on('data', c => chunks.push(c))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let parsed: any
          try {
            parsed = JSON.parse(text)
          } catch {
            reject(new Error(`Bad JSON from OpenAI: ${text.slice(0, 200)}`))
            return
          }
          if (parsed.error) {
            reject(new Error(`${parsed.error.type ?? 'api_error'}: ${parsed.error.message}`))
            return
          }
          resolve(parsed)
        })
      }
    )
    req.on('error', reject)
    req.setTimeout(60_000, () => req.destroy(new Error('OpenAI request timed out')))
    req.write(payload)
    req.end()
  })
}

/** Plain text completion (used for screen captions; messages may contain image_url parts) */
export async function chatText(apiKey: string, model: string, messages: ChatMessage[]): Promise<string> {
  const res = await postJson(apiKey, { model, messages })
  const content = res?.choices?.[0]?.message?.content
  return typeof content === 'string' ? content : ''
}

/** JSON-mode completion (used for distillation); throws on parse failure, caller decides how to recover */
export async function chatJson(apiKey: string, model: string, messages: ChatMessage[]): Promise<any> {
  const res = await postJson(apiKey, {
    model,
    messages,
    response_format: { type: 'json_object' }
  })
  const content = res?.choices?.[0]?.message?.content
  if (typeof content !== 'string') throw new Error('Model returned no content')
  try {
    return JSON.parse(content)
  } catch {
    throw new Error(`Model returned non-JSON: ${content.slice(0, 200)}`)
  }
}
