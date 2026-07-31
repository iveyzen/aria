import { EventEmitter } from 'events'
import WebSocket from 'ws'
import { AriaConfig } from './config'
import {
  ARIA_INSTRUCTIONS,
  ARIA_TOOLS,
  GREETING_PROMPT,
  oneOffInstructions,
  speakJudged
} from './persona'

/**
 * WebSocket client for gpt-realtime-2.1.
 *
 * Responsibilities: streaming audio in and out, injecting screenshots into the conversation,
 * pruning old screenshots to keep tokens in check, and cancelling the current response on barge-in.
 *
 * Emitted events:
 *  open / close({code, reason, intentional}) / status(string) / apiError(string)
 *  audioDelta(Buffer PCM16@24k) / audioClear
 *  userTranscript(string) / ariaTranscriptDelta(string) / ariaTranscriptDone
 *  speechStarted / speechStopped / responseState(boolean)
 *  judged({line, spoke}) — outcome of a silent initiative judgment
 *  probeResult(string) — reply to a copilot probe (out-of-band, never enters her context)
 */
export class RealtimeClient extends EventEmitter {
  private ws: WebSocket | null = null
  private readonly cfg: AriaConfig
  private imageItemIds: string[] = []
  private responseActive = false
  private userSpeaking = false
  private closedByUs = false
  private greeted = false
  /** Whether we are waiting on the result of a silent "should I speak" judgment */
  private pendingJudge = false
  /** Which judgment is in flight ('initiative' | 'proactive'), echoed back in the judged event */
  private pendingJudgeKind = 'initiative'
  /** Copilot persona override; null = the built-in ARIA_INSTRUCTIONS */
  private personaOverride: string | null = null

  /** extraContext: dynamic context at connect time (time, long-term memory), appended after the persona */
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

  /** Append a chunk of the user's mic audio (PCM16 mono 24kHz) */
  appendAudio(pcm16: Buffer): void {
    if (!this.isOpen) return
    this.send({ type: 'input_audio_buffer.append', audio: pcm16.toString('base64') })
  }

  /** Inject a system note (mode switches etc.) without triggering a response */
  sendSystemNote(text: string): void {
    if (!this.isOpen) return
    this.send({
      type: 'conversation.item.create',
      item: { type: 'message', role: 'system', content: [{ type: 'input_text', text }] }
    })
  }

  /**
   * Silently judge whether to speak (idle initiative, big screen changes). The judgment is
   * text-only (cheap, makes no sound); PASS output means act as if nothing happened,
   * a written line then gets actually spoken aloud.
   */
  requestJudgment(prompt: string, kind = 'initiative'): void {
    if (!this.isOpen || this.responseActive || this.userSpeaking || this.pendingJudge) return
    this.pendingJudge = true
    this.pendingJudgeKind = kind
    this.send({
      type: 'response.create',
      response: { output_modalities: ['text'], instructions: this.oneOff(prompt) }
    })
  }

  /**
   * Swap the persona live (copilot tuning). null reverts to the built-in persona.
   * session.update merges fields, so only instructions change; the greeting guard keeps her from re-greeting.
   */
  setPersona(text: string | null): void {
    this.personaOverride = text
    if (this.isOpen) {
      this.send({
        type: 'session.update',
        session: { type: 'realtime', instructions: this.instructionsText() }
      })
    }
  }

  /** Copilot: inject a text message as the user and have her respond, barging in like real speech would */
  sayAsUser(text: string): void {
    if (!this.isOpen) return
    if (this.responseActive) {
      this.send({ type: 'response.cancel' })
      this.emit('audioClear')
    }
    this.send({
      type: 'conversation.item.create',
      item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] }
    })
    this.send({ type: 'response.create' })
  }

  /**
   * Copilot: ask her something out-of-band. The response is text-only and never joins the
   * conversation (conversation:'none'), so her state is probed without her "experiencing" it.
   */
  probe(question: string): void {
    if (!this.isOpen) return
    this.send({
      type: 'response.create',
      response: {
        conversation: 'none',
        output_modalities: ['text'],
        metadata: { kind: 'copilot_probe' },
        instructions: question
      }
    })
  }

  /** Return a tool call's result and let Aria continue speaking */
  sendFunctionResult(callId: string, output: string): void {
    if (!this.isOpen) return
    this.send({
      type: 'conversation.item.create',
      item: { type: 'function_call_output', call_id: callId, output }
    })
    this.send({ type: 'response.create' })
  }

  /** Inject a screenshot into the conversation as a user message; if respondPrompt is set, have Aria speak on it */
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
      this.send({ type: 'response.create', response: { instructions: this.oneOff(respondPrompt) } })
    }
  }

  private send(event: Record<string, unknown>): void {
    if (this.isOpen) this.ws!.send(JSON.stringify(event))
  }

  private instructionsText(): string {
    return (this.personaOverride ?? ARIA_INSTRUCTIONS) + this.extraContext
  }

  /**
   * Wrap a one-off prompt for response.create. Per-response instructions REPLACE the session
   * instructions rather than adding to them, so without this prefix the greeting, proactive
   * comments, initiative judgments and spoken judged lines would all run with no persona at all —
   * which is exactly where off-style replies (narration, menus, language drift) were coming from.
   */
  private oneOff(prompt: string): string {
    return oneOffInstructions(this.instructionsText(), prompt)
  }

  private configureSession(): void {
    this.send({
      type: 'session.update',
      session: {
        type: 'realtime',
        instructions: this.instructionsText(),
        tools: ARIA_TOOLS,
        tool_choice: 'auto',
        output_modalities: ['audio'],
        audio: {
          input: {
            format: { type: 'audio/pcm', rate: 24000 },
            transcription: { model: 'gpt-4o-transcribe' },
            turn_detection: {
              type: 'semantic_vad',
              // low: wait an extra beat before responding, fewer false triggers with game/background audio around
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
          this.send({ type: 'response.create', response: { instructions: this.oneOff(GREETING_PROMPT) } })
        }
        break

      case 'input_audio_buffer.speech_started':
        this.userSpeaking = true
        this.emit('speechStarted')
        // User barge-in: cancel the current response and have the playback side clear its buffer
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
            // If argument parsing fails, pass an empty object and let the handler do its own fallback
          }
          this.emit('functionCall', { name: item.name, callId: item.call_id, args })
        }
        break
      }

      case 'response.done': {
        this.responseActive = false
        this.emit('responseState', false)
        // Copilot probes are out-of-band; intercept them before the judge branch can mistake one for its result
        if (ev.response?.metadata?.kind === 'copilot_probe') {
          this.emit('probeResult', this.extractText(ev.response))
          break
        }
        if (this.pendingJudge) {
          this.pendingJudge = false
          const line = this.extractText(ev.response)
          const spoke = Boolean(line && !/^pass\b/i.test(line) && !this.userSpeaking)
          this.emit('judged', { line, spoke, kind: this.pendingJudgeKind })
          // She decided to speak: actually say that line out loud; on PASS do nothing
          if (spoke) {
            this.send({
              type: 'response.create',
              response: { instructions: this.oneOff(speakJudged(line)) }
            })
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
        // "no active response to cancel" and "already has an active response" are both normal races; don't bother the user
        if (!/no active response|cancellation failed|already has an active response/i.test(msg)) {
          this.emit('apiError', msg)
        }
        break
      }
    }
  }

  /** Extract the plain-text output from a response.done response object (used by the silent judgment) */
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

  /** Keep only the most recent N screenshots; delete earlier ones from the session so image tokens don't pile up */
  private trackImageItem(id: string | undefined): void {
    if (!id || this.imageItemIds.includes(id)) return
    this.imageItemIds.push(id)
    while (this.imageItemIds.length > this.cfg.maxImagesKept) {
      const oldest = this.imageItemIds.shift()!
      this.send({ type: 'conversation.item.delete', item_id: oldest })
    }
  }
}
