import { EventEmitter } from 'events'
import WebSocket from 'ws'
import { AriaConfig } from './config'
import {
  ARIA_INSTRUCTIONS,
  ARIA_TOOLS,
  GREETING_PROMPT,
  INITIATIVE_PROMPT,
  speakJudged
} from './persona'

/**
 * gpt-realtime-2.1 的 WebSocket 客户端。
 *
 * 职责：音频流进出、把屏幕截图注入对话、修剪旧截图控制 token、
 * 打断（barge-in）时取消当前响应。
 *
 * 对外事件：
 *  open / close({code, reason, intentional}) / status(string) / apiError(string)
 *  audioDelta(Buffer PCM16@24k) / audioClear
 *  userTranscript(string) / ariaTranscriptDelta(string) / ariaTranscriptDone
 *  speechStarted / speechStopped / responseState(boolean)
 */
export class RealtimeClient extends EventEmitter {
  private ws: WebSocket | null = null
  private readonly cfg: AriaConfig
  private imageItemIds: string[] = []
  private responseActive = false
  private userSpeaking = false
  private closedByUs = false
  private greeted = false
  /** 是否正在等一次"要不要开口"的无声判断结果 */
  private pendingJudge = false

  /** extraContext：连接时刻的动态上下文（时间、长期记忆），拼在人设后面 */
  constructor(cfg: AriaConfig, private readonly extraContext = '') {
    super()
    this.cfg = cfg
  }

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN
  }
  get isResponding(): boolean {
    return this.responseActive
  }
  get isUserSpeaking(): boolean {
    return this.userSpeaking
  }

  connect(): void {
    const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(this.cfg.model)}`
    this.closedByUs = false
    this.ws = new WebSocket(url, {
      headers: { Authorization: `Bearer ${this.cfg.apiKey}` }
    })
    this.ws.on('open', () => this.configureSession())
    this.ws.on('message', data => this.handleEvent(data.toString()))
    this.ws.on('error', err => this.emit('status', `Connection error: ${err.message}`))
    this.ws.on('close', (code, reason) => {
      this.responseActive = false
      this.emit('close', { code, reason: reason.toString(), intentional: this.closedByUs })
    })
  }

  close(): void {
    this.closedByUs = true
    this.ws?.close()
    this.ws = null
  }

  /** 追加一段用户麦克风音频（PCM16 mono 24kHz） */
  appendAudio(pcm16: Buffer): void {
    if (!this.isOpen) return
    this.send({ type: 'input_audio_buffer.append', audio: pcm16.toString('base64') })
  }

  /** 注入一条系统提示（模式切换等），不触发响应 */
  sendSystemNote(text: string): void {
    if (!this.isOpen) return
    this.send({
      type: 'conversation.item.create',
      item: { type: 'message', role: 'system', content: [{ type: 'input_text', text }] }
    })
  }

  /**
   * 空闲主动搭话：安静一阵之后，让她看着最新截图无声判断要不要开口。
   * 判断走纯文本（便宜、不出声）；输出 PASS 就当无事发生，写了台词就再让她真的说出来。
   */
  requestInitiative(): void {
    if (!this.isOpen || this.responseActive || this.userSpeaking || this.pendingJudge) return
    this.pendingJudge = true
    this.send({
      type: 'response.create',
      response: { output_modalities: ['text'], instructions: INITIATIVE_PROMPT }
    })
  }

  /** 回传工具执行结果，并让 Aria 接着说 */
  sendFunctionResult(callId: string, output: string): void {
    if (!this.isOpen) return
    this.send({
      type: 'conversation.item.create',
      item: { type: 'function_call_output', call_id: callId, output }
    })
    this.send({ type: 'response.create' })
  }

  /** 把截图作为用户消息注入对话；respondPrompt 非空时让 Aria 就此开口 */
  sendImage(jpegDataUrl: string, respondPrompt?: string): void {
    if (!this.isOpen) return
    this.send({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_image', image_url: jpegDataUrl }]
      }
    })
    if (respondPrompt && !this.responseActive && !this.userSpeaking) {
      this.send({ type: 'response.create', response: { instructions: respondPrompt } })
    }
  }

  private send(event: Record<string, unknown>): void {
    if (this.isOpen) this.ws!.send(JSON.stringify(event))
  }

  private configureSession(): void {
    this.send({
      type: 'session.update',
      session: {
        type: 'realtime',
        instructions: ARIA_INSTRUCTIONS + this.extraContext,
        tools: ARIA_TOOLS,
        tool_choice: 'auto',
        output_modalities: ['audio'],
        audio: {
          input: {
            format: { type: 'audio/pcm', rate: 24000 },
            transcription: { model: 'gpt-4o-transcribe' },
            turn_detection: {
              type: 'semantic_vad',
              // low：多等一拍再接话，游戏音/背景音环境下误触发更少
              eagerness: 'low',
              create_response: true,
              interrupt_response: true
            }
          },
          output: {
            format: { type: 'audio/pcm', rate: 24000 },
            voice: this.cfg.voice
          }
        }
      }
    })
  }

  private handleEvent(raw: string): void {
    let ev: any
    try {
      ev = JSON.parse(raw)
    } catch {
      return
    }
    switch (ev.type) {
      case 'session.created':
        this.emit('open')
        break

      case 'session.updated':
        if (!this.greeted) {
          this.greeted = true
          this.emit('status', 'Aria is online')
          this.send({ type: 'response.create', response: { instructions: GREETING_PROMPT } })
        }
        break

      case 'input_audio_buffer.speech_started':
        this.userSpeaking = true
        this.emit('speechStarted')
        // 用户开口打断：取消当前响应并让播放端清空缓冲
        if (this.responseActive) this.send({ type: 'response.cancel' })
        this.emit('audioClear')
        break

      case 'input_audio_buffer.speech_stopped':
        this.userSpeaking = false
        this.emit('speechStopped')
        break

      case 'conversation.item.input_audio_transcription.completed': {
        const heard = ev.transcript ? String(ev.transcript).trim() : ''
        if (heard) this.emit('userTranscript', heard)
        break
      }

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

      case 'response.created':
        this.responseActive = true
        this.emit('responseState', true)
        break

      case 'response.output_item.done': {
        const item = ev.item
        if (item?.type === 'function_call') {
          let args: Record<string, unknown> = {}
          try {
            args = JSON.parse(item.arguments ?? '{}')
          } catch {
            // 参数解析失败就给空对象，让处理端自行兜底
          }
          this.emit('functionCall', { name: item.name, callId: item.call_id, args })
        }
        break
      }

      case 'response.done': {
        this.responseActive = false
        this.emit('responseState', false)
        if (this.pendingJudge) {
          this.pendingJudge = false
          const line = this.extractText(ev.response)
          // 她决定要说：把刚才那句真的用声音说出来；PASS 就什么都不做
          if (line && !/^pass\b/i.test(line) && !this.userSpeaking) {
            this.send({ type: 'response.create', response: { instructions: speakJudged(line) } })
          }
        }
        break
      }

      case 'response.output_audio.delta':
      case 'response.audio.delta':
        if (ev.delta) this.emit('audioDelta', Buffer.from(ev.delta, 'base64'))
        break

      case 'response.output_audio_transcript.delta':
      case 'response.audio_transcript.delta':
        if (ev.delta) this.emit('ariaTranscriptDelta', ev.delta)
        break

      case 'response.output_audio_transcript.done':
      case 'response.audio_transcript.done':
        this.emit('ariaTranscriptDone')
        break

      case 'error': {
        const msg: string = ev.error?.message ?? JSON.stringify(ev.error ?? ev)
        // "无活跃响应可取消"和"已有活跃响应"都是正常竞态，不打扰用户
        if (!/no active response|cancellation failed|already has an active response/i.test(msg)) {
          this.emit('apiError', msg)
        }
        break
      }
    }
  }

  /** 从 response.done 的响应对象里抽出纯文本输出（无声判断用） */
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

  /** 只保留最近 N 张截图，更早的从会话里删掉，避免图像 token 累积 */
  private trackImageItem(id: string | undefined): void {
    if (!id || this.imageItemIds.includes(id)) return
    this.imageItemIds.push(id)
    while (this.imageItemIds.length > this.cfg.maxImagesKept) {
      const oldest = this.imageItemIds.shift()!
      this.send({ type: 'conversation.item.delete', item_id: oldest })
    }
  }
}
