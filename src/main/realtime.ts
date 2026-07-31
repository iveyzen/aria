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
 *  ariaLine({text, interrupted}) — one complete spoken line, assembled per response id so
 *    concurrent judgments and late deltas from a cancelled response can never splice together
 *  speechStarted / speechStopped / responseState(boolean)
 *  judged({line, spoke, kind}) — outcome of a silent judgment ('initiative' | 'proactive')
 *  lineDiscarded({line, kind, reason}) — a judged line that was never spoken (moment passed)
 *  truncated({itemId, heardMs, sentMs}) — barge-in cut this item; server context matches ears
 *  probeResult(string) — reply to a copilot probe (out-of-band, never enters her context)
 *
 * Every response WE create carries metadata {kind, requestId, gen}; server-VAD replies carry
 * none. response.done routes by that metadata — matching "the next response.done" by arrival
 * order mis-attributed judgments in real sessions (a spoken line logged as spoke=false).
 * Kinds: 'greeting' | 'judge' | 'speak_judged' | 'probe' | 'tool_continue' | 'say' | 'image_prompt'.
 *
 * Playback accounting: the renderer reports the samples actually played; a barge-in both
 * clears local playback AND truncates the item server-side at the ms the user really heard,
 * so her context never keeps speech nobody received.
 */
export class RealtimeClient extends EventEmitter {
  private static generationCounter = 0
  /** Distinguishes this connection — stale async work from an old session must never reach a new one */
  readonly generation = ++RealtimeClient.generationCounter
  private ws: WebSocket | null = null
  private readonly cfg: AriaConfig
  private imageItemIds: string[] = []
  private userSpeaking = false
  private closedByUs = false
  private greeted = false
  private nextRequestId = 1
  /** In-flight silent judgments by requestId — concurrent judgments stay independent */
  private readonly pendingJudges = new Map<string, string>()
  /** All responses the server currently has in flight (default-conversation and out-of-band) */
  private readonly activeResponses = new Set<string>()
  /** The response currently producing audible output — the one a barge-in must cancel */
  private audibleResponseId: string | null = null
  /** Copilot persona override; null = the built-in ARIA_INSTRUCTIONS */
  private personaOverride: string | null = null
  /** Transcript text accumulated per response id (see ariaLine in the class doc) */
  private readonly transcripts = new Map<string, string>()
  /** Audio samples generated (sent to the renderer) since the last clear */
  private sentSamplesTotal = 0
  /** Audio samples actually played, as reported by the renderer (clamped to sent) */
  private playedSamplesTotal = 0
  /** The assistant item currently streaming audio, with its window in the sample timeline */
  private currentAudioItem: { id: string; baseSamples: number; samples: number } | null = null

  /** extraContext: dynamic context at connect time (time, long-term memory), appended after the persona */
  constructor(cfg: AriaConfig, private readonly extraContext = '') {
    super()
    this.cfg = cfg
  }

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN
  }
  get isResponding(): boolean {
    return this.activeResponses.size > 0
  }
  get isUserSpeaking(): boolean {
    return this.userSpeaking
  }

  /** Metadata attached to every response we create; response.done routes by it */
  private newMeta(kind: string, extra?: Record<string, unknown>): Record<string, unknown> {
    // Metadata values must be strings — the API rejects integers
    return {
      kind,
      requestId: `g${this.generation}-${this.nextRequestId++}`,
      gen: String(this.generation),
      ...extra
    }
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
      this.activeResponses.clear()
      this.pendingJudges.clear()
      this.audibleResponseId = null
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
    if (!this.isOpen || this.isResponding || this.userSpeaking) return
    // Different judgment kinds may coexist; identical ones would just burn tokens on the same moment
    for (const pending of this.pendingJudges.values()) if (pending === kind) return
    const metadata = this.newMeta('judge', { judge: kind })
    this.pendingJudges.set(String(metadata.requestId), kind)
    this.send({
      type: 'response.create',
      response: {
        output_modalities: ['text'],
        metadata,
        instructions: this.oneOff(prompt)
      }
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
    if (this.isResponding) this.interruptPlayback()
    this.send({
      type: 'conversation.item.create',
      item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] }
    })
    this.send({ type: 'response.create', response: { metadata: this.newMeta('say') } })
  }

  /** The renderer's report of samples actually played since the last clear */
  setPlaybackPosition(playedSamples: number): void {
    // Clamp: a stale report from before a clear must not claim more was heard than was sent
    this.playedSamplesTotal = Math.max(0, Math.min(playedSamples, this.sentSamplesTotal))
  }

  /**
   * Barge-in: cancel the audible response, truncate the interrupted item server-side at the
   * ms the user actually heard (else her context keeps speech nobody received), clear playback.
   */
  private interruptPlayback(): void {
    this.truncateHeardAudio()
    if (this.audibleResponseId) {
      this.send({ type: 'response.cancel', response_id: this.audibleResponseId })
    } else if (this.activeResponses.size) {
      this.send({ type: 'response.cancel' })
    }
    this.emit('audioClear')
    this.sentSamplesTotal = 0
    this.playedSamplesTotal = 0
    this.currentAudioItem = null
  }

  private truncateHeardAudio(): void {
    const item = this.currentAudioItem
    if (!item || !this.isOpen) return
    const heard = Math.max(0, Math.min(this.playedSamplesTotal - item.baseSamples, item.samples))
    if (heard >= item.samples) return // fully heard; nothing to cut
    const heardMs = Math.floor((heard / 24000) * 1000)
    this.send({
      type: 'conversation.item.truncate',
      item_id: item.id,
      content_index: 0,
      audio_end_ms: heardMs
    })
    this.emit('truncated', {
      itemId: item.id,
      heardMs,
      sentMs: Math.floor((item.samples / 24000) * 1000)
    })
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
        metadata: this.newMeta('probe'),
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
    this.send({ type: 'response.create', response: { metadata: this.newMeta('tool_continue') } })
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
    if (respondPrompt && !this.isResponding && !this.userSpeaking) {
      this.send({
        type: 'response.create',
        response: { metadata: this.newMeta('image_prompt'), instructions: this.oneOff(respondPrompt) }
      })
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

  /** The full audio config; always sent whole, because session.update may not deep-merge nested objects */
  private audioConfig(transcriptionHint?: string): Record<string, unknown> {
    return {
      input: {
        format: { type: 'audio/pcm', rate: 24000 },
        transcription: {
          model: 'gpt-4o-transcribe',
          // Recent on-screen text biases recognition toward the names actually in front of them —
          // without it, ASR turns 王虹 into 网红 and 期权 into 气喘
          ...(transcriptionHint ? { prompt: transcriptionHint } : {})
        },
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

  /** What the ASR was last biased with; skip redundant session.updates */
  private lastHint = ''

  /** Feed the latest screen text to speech recognition as vocabulary context */
  setTranscriptionHint(hint: string): void {
    if (!this.isOpen) return
    const clean = hint.replace(/\s+/g, ' ').trim().slice(0, 200)
    if (!clean || clean === this.lastHint) return
    this.lastHint = clean
    this.send({
      type: 'session.update',
      session: { type: 'realtime', audio: this.audioConfig(clean) }
    })
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
        audio: this.audioConfig()
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
          this.send({
            type: 'response.create',
            response: { metadata: this.newMeta('greeting'), instructions: this.oneOff(GREETING_PROMPT) }
          })
        }
        break

      case 'input_audio_buffer.speech_started':
        this.userSpeaking = true
        this.emit('speechStarted')
        // User barge-in: cancel by id, truncate what they never heard, clear local playback
        this.interruptPlayback()
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

      case 'response.created': {
        const id = String(ev.response?.id ?? '')
        if (id) this.activeResponses.add(id)
        if (this.activeResponses.size === 1) this.emit('responseState', true)
        break
      }

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
        const resp = ev.response ?? {}
        const respId = String(resp.id ?? '')
        this.activeResponses.delete(respId)
        if (this.activeResponses.size === 0) this.emit('responseState', false)
        if (this.audibleResponseId === respId) this.audibleResponseId = null
        // A cancelled response never fires transcript.done; flush its partial as interrupted
        this.flushTranscript(respId, true)
        const kind = resp.metadata?.kind
        if (kind === 'probe') {
          this.emit('probeResult', this.extractText(resp))
          break
        }
        // Only the judge's own response resolves its own request — never arrival order
        if (kind === 'judge') {
          const requestId = String(resp.metadata?.requestId ?? '')
          if (!this.pendingJudges.delete(requestId)) break
          const judgeKind = String(resp.metadata?.judge ?? 'initiative')
          const line = this.extractText(resp)
          const spoke = Boolean(line && !/^pass\b/i.test(line) && !this.userSpeaking)
          this.emit('judged', { line, spoke, kind: judgeKind })
          // She decided to speak: say that line out loud; on PASS do nothing
          if (spoke) {
            if (this.isResponding || this.userSpeaking) {
              // The moment passed while judging — a queued line would collide or duplicate
              this.emit('lineDiscarded', {
                line,
                kind: judgeKind,
                reason: this.userSpeaking ? 'user-speaking' : 'response-active'
              })
            } else {
              this.send({
                type: 'response.create',
                response: {
                  metadata: this.newMeta('speak_judged'),
                  instructions: this.oneOff(speakJudged(line))
                }
              })
            }
          }
        }
        break
      }

      case 'response.output_audio.delta':
      case 'response.audio.delta':
        if (ev.delta) {
          const buf = Buffer.from(ev.delta, 'base64')
          const itemId = String(ev.item_id ?? '')
          if (itemId && this.currentAudioItem?.id !== itemId) {
            this.currentAudioItem = { id: itemId, baseSamples: this.sentSamplesTotal, samples: 0 }
          }
          if (this.currentAudioItem) this.currentAudioItem.samples += buf.length >> 1
          this.sentSamplesTotal += buf.length >> 1
          const respId = String(ev.response_id ?? '')
          if (respId) this.audibleResponseId = respId
          this.emit('audioDelta', buf)
        }
        break

      case 'response.output_audio_transcript.delta':
      case 'response.audio_transcript.delta':
        if (ev.delta) {
          const id = String(ev.response_id ?? 'unknown')
          this.transcripts.set(id, (this.transcripts.get(id) ?? '') + ev.delta)
          this.emit('ariaTranscriptDelta', ev.delta)
        }
        break

      case 'response.output_audio_transcript.done':
      case 'response.audio_transcript.done':
        this.flushTranscript(
          String(ev.response_id ?? 'unknown'),
          false,
          typeof ev.transcript === 'string' ? ev.transcript : undefined
        )
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

  /** Emit one finished spoken line for a response id; `authoritative` is the API's own full transcript */
  private flushTranscript(id: string | undefined, interrupted: boolean, authoritative?: string): void {
    if (!id || (!this.transcripts.has(id) && !authoritative)) return
    const text = (authoritative ?? this.transcripts.get(id) ?? '').trim()
    this.transcripts.delete(id)
    if (text) this.emit('ariaLine', { text, interrupted })
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
