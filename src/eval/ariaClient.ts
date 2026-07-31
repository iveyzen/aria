import WebSocket from 'ws'
import { ARIA_INSTRUCTIONS, ARIA_TOOLS, sessionContext } from '../main/persona'
import { searchWeb } from '../main/websearch'
import { ToolCall } from './types'

/**
 * 评测用的 Realtime 客户端。
 *
 * 关键点：instructions 直接用 src/main/persona.ts 里那份真人设，不复制、不改写——
 * 评测跑的必须是线上那个 Aria，否则调完的分数没意义。
 * 唯一的区别是 output_modalities 走 text：便宜、快、可读，人设行为是一样的。
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

  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly memory = '',
    /** 会话里最多留几张图，和线上 maxImagesKept 保持一致 */
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

    // 和线上一样：真人设 + 时间/记忆上下文，只是输出改成文本
    this.send({
      type: 'session.update',
      session: {
        type: 'realtime',
        instructions: ARIA_INSTRUCTIONS + sessionContext(this.memory),
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

  /** 注入一句用户台词（不触发响应） */
  addUserText(text: string): void {
    this.send({
      type: 'conversation.item.create',
      item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] }
    })
  }

  /** 注入一张截图（不触发响应），并按线上规则修剪旧图 */
  addImage(dataUrl: string): void {
    this.send({
      type: 'conversation.item.create',
      item: { type: 'message', role: 'user', content: [{ type: 'input_image', image_url: dataUrl }] }
    })
  }

  /**
   * 让她回一次话。instructions 对应线上那几个一次性提示
   * （PROACTIVE_PROMPT / INITIATIVE_PROMPT），不传就是普通对话轮。
   * 中途她要是调工具，这里会真的执行再让她接着说，和线上行为一致。
   */
  async respond(instructions?: string): Promise<{ text: string; toolCalls: ToolCall[] }> {
    const toolCalls: ToolCall[] = []
    let text = ''

    this.send({
      type: 'response.create',
      response: instructions ? { instructions } : {}
    })

    // 最多让她"调工具→接着说"来回 4 次，防止死循环
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
    // remember_fact：评测里不落盘，记一笔就够了（是否记忆本身也是评分信号）
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
          // 不是 JSON 就忽略
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
            // 解析不了就当空参数，execTool 会兜底
          }
          this.functionCalls.push({ name: item.name, callId: item.call_id, args })
        }
        break
      }

      case 'response.done': {
        // 流式 delta 偶尔收不全，用 response.done 里的完整文本兜底
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
