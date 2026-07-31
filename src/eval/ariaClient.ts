import WebSocket from 'ws'
import { ARIA_INSTRUCTIONS, ARIA_TOOLS, oneOffInstructions, sessionContext } from '../main/persona'
import { searchWeb } from '../main/websearch'
import { ToolCall } from './types'

/**
 * Realtime client for the eval harness.
 *
 * Key point: instructions use the real persona from src/main/persona.ts directly —
 * no copying, no rewriting. The eval must run the exact Aria that ships in
 * production, otherwise the tuned scores are meaningless.
 * The only difference is output_modalities is text: cheap, fast, readable — the
 * persona's behavior is the same.
 */

interface ResponseResult {
  text: string
  functionCalls: { name: string; callId: string; args: Record<string, unknown> }[]
}

export class EvalAriaClient {
  private ws: WebSocket | null = null
  private deltas = ''
  private functionCalls: ResponseResult['functionCalls'] = []
  private waiter: ((r: ResponseResult) => void) | null = null
  private failWaiter: ((e: Error) => void) | null = null
  private imageItemIds: string[] = []
  private sessionInstructions = ''

  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly memory = '',
    /** Max images kept in the conversation, kept in sync with production maxImagesKept */
    private readonly maxImagesKept = 4
  ) {}

  async connect(): Promise<void> {
    const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(this.model)}`
    this.ws = new WebSocket(url, { headers: { Authorization: `Bearer ${this.apiKey}` } })

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Realtime connect timed out')), 30_000)
      this.ws!.once('open', () => {
        clearTimeout(timer)
        resolve()
      })
      this.ws!.once('error', err => {
        clearTimeout(timer)
        reject(err)
      })
    })

    this.ws.on('message', raw => this.handleEvent(raw.toString()))
    this.ws.on('close', () => {
      this.failWaiter?.(new Error('Realtime socket closed mid-response'))
      this.waiter = null
      this.failWaiter = null
    })

    // Same as production: real persona + time/memory context, only output switched to text
    this.sessionInstructions = ARIA_INSTRUCTIONS + sessionContext(this.memory)
    this.send({
      type: 'session.update',
      session: {
        type: 'realtime',
        instructions: this.sessionInstructions,
        tools: ARIA_TOOLS,
        tool_choice: 'auto',
        output_modalities: ['text']
      }
    })
    await this.waitFor('session.updated', 20_000)
  }

  close(): void {
    this.ws?.close()
    this.ws = null
  }

  /** Inject a user utterance (does not trigger a response) */
  addUserText(text: string): void {
    this.send({
      type: 'conversation.item.create',
      item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] }
    })
  }

  /** Inject a screenshot (does not trigger a response), pruning old images per the production rule */
  addImage(dataUrl: string): void {
    this.send({
      type: 'conversation.item.create',
      item: { type: 'message', role: 'user', content: [{ type: 'input_image', image_url: dataUrl }] }
    })
  }

  /**
   * Have her respond once. instructions corresponds to the one-shot prompts used
   * in production (PROACTIVE_PROMPT / INITIATIVE_PROMPT); omit it for a normal
   * conversation turn. If she calls a tool midway, it is actually executed here
   * and she continues speaking, matching production behavior.
   * One-shot prompts get the same oneOffInstructions() persona wrapping as production —
   * response.create instructions REPLACE session instructions, so bare prompts would
   * eval a persona-less Aria that never ships.
   */
  async respond(instructions?: string): Promise<{ text: string; toolCalls: ToolCall[] }> {
    const toolCalls: ToolCall[] = []
    let text = ''

    this.send({
      type: 'response.create',
      response: instructions
        ? { instructions: oneOffInstructions(this.sessionInstructions, instructions) }
        : {}
    })

    // Allow at most 4 "call tool → keep talking" round trips to guard against infinite loops
    for (let hop = 0; hop < 4; hop++) {
      const res = await this.awaitResponse()
      if (res.text) text += (text ? ' ' : '') + res.text
      if (!res.functionCalls.length) break

      for (const fc of res.functionCalls) {
        toolCalls.push({ name: fc.name, args: fc.args })
        const output = await this.execTool(fc.name, fc.args)
        this.send({
          type: 'conversation.item.create',
          item: { type: 'function_call_output', call_id: fc.callId, output }
        })
      }
      this.send({ type: 'response.create' })
    }
    return { text: text.trim(), toolCalls }
  }

  private async execTool(name: string, args: Record<string, unknown>): Promise<string> {
    if (name === 'search_web') {
      const q = String(args.query ?? '').trim()
      return q ? await searchWeb(q) : 'No search query provided'
    }
    // remember_fact: not persisted to disk in evals — acknowledging is enough (whether she chooses to remember is itself a scoring signal)
    if (name === 'remember_fact') return 'Noted'
    return `Unknown tool: ${name}`
  }

  private awaitResponse(): Promise<ResponseResult> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null
        this.failWaiter = null
        reject(new Error('Timed out waiting for a response'))
      }, 90_000)
      this.waiter = r => {
        clearTimeout(timer)
        this.waiter = null
        this.failWaiter = null
        resolve(r)
      }
      this.failWaiter = e => {
        clearTimeout(timer)
        this.waiter = null
        this.failWaiter = null
        reject(e)
      }
    })
  }

  private waitFor(type: string, ms: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${type}`)), ms)
      const onMsg = (raw: WebSocket.RawData) => {
        try {
          if (JSON.parse(raw.toString()).type === type) {
            clearTimeout(timer)
            this.ws?.off('message', onMsg)
            resolve()
          }
        } catch {
          // Ignore anything that isn't JSON
        }
      }
      this.ws?.on('message', onMsg)
    })
  }

  private send(event: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(event))
  }

  private handleEvent(raw: string): void {
    let ev: any
    try {
      ev = JSON.parse(raw)
    } catch {
      return
    }

    switch (ev.type) {
      case 'response.output_text.delta':
      case 'response.text.delta':
        if (ev.delta) this.deltas += ev.delta
        break

      case 'conversation.item.added':
      case 'conversation.item.created': {
        const item = ev.item
        if (
          item?.role === 'user' &&
          Array.isArray(item.content) &&
          item.content.some((c: any) => c?.type === 'input_image')
        ) {
          this.trackImageItem(item.id)
        }
        break
      }

      case 'response.output_item.done': {
        const item = ev.item
        if (item?.type === 'function_call') {
          let args: Record<string, unknown> = {}
          try {
            args = JSON.parse(item.arguments ?? '{}')
          } catch {
            // If parsing fails, treat it as empty args; execTool will handle it
          }
          this.functionCalls.push({ name: item.name, callId: item.call_id, args })
        }
        break
      }

      case 'response.done': {
        // Streaming deltas occasionally arrive incomplete; fall back to the full text in response.done
        const text = this.deltas.trim() || this.extractText(ev.response)
        const result = { text, functionCalls: this.functionCalls }
        this.deltas = ''
        this.functionCalls = []
        this.waiter?.(result)
        break
      }

      case 'error': {
        const msg: string = ev.error?.message ?? JSON.stringify(ev.error ?? ev)
        if (!/no active response|cancellation failed|already has an active response/i.test(msg)) {
          this.failWaiter?.(new Error(msg))
        }
        break
      }
    }
  }

  private extractText(resp: any): string {
    if (!Array.isArray(resp?.output)) return ''
    let text = ''
    for (const item of resp.output) {
      if (item?.type === 'message' && Array.isArray(item.content)) {
        for (const c of item.content) {
          if (typeof c?.text === 'string') text += c.text
        }
      }
    }
    return text.trim()
  }

  private trackImageItem(id: string | undefined): void {
    if (!id || this.imageItemIds.includes(id)) return
    this.imageItemIds.push(id)
    while (this.imageItemIds.length > this.maxImagesKept) {
      const oldest = this.imageItemIds.shift()!
      this.send({ type: 'conversation.item.delete', item_id: oldest })
    }
  }
}
