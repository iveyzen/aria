import * as https from 'https'

/** Plain Chat Completions call for the judge (the Realtime path lives in ariaClient) */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string | unknown[]
}

function postJson(path: string, apiKey: string, body: unknown): Promise<any> {
  const payload = JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'api.openai.com',
        path,
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
            reject(new Error(`Bad JSON from ${path}: ${text.slice(0, 300)}`))
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
    req.setTimeout(90_000, () => req.destroy(new Error('OpenAI request timed out')))
    req.write(payload)
    req.end()
  })
}

/** Ask the model to return a JSON object; throw on parse failure and let the caller decide how to recover */
export async function chatJson(
  apiKey: string,
  model: string,
  messages: ChatMessage[]
): Promise<any> {
  const res = await postJson('/v1/chat/completions', apiKey, {
    model,
    messages,
    response_format: { type: 'json_object' }
  })
  const content = res?.choices?.[0]?.message?.content
  if (typeof content !== 'string') throw new Error('Judge returned no content')
  try {
    return JSON.parse(content)
  } catch {
    throw new Error(`Judge returned non-JSON: ${content.slice(0, 300)}`)
  }
}
