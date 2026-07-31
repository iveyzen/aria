import { app } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { MEMORY_MODEL, chatText } from './llm'
import { distill } from './memory'
import { ocrImage } from './ocr'

/**
 * Short-term memory: a fixed-length queue of everything that just happened, as plain text —
 * both sides of the conversation, tool use, and screen captions (frames turned into words by
 * a cheap vision call, since images can't be kept and text can).
 *
 * Two jobs: the tail is injected at session start so she has continuity across reconnects and
 * restarts, and whatever falls off the front is batched through the distiller (memory.ts),
 * which decides what little of it becomes long-term memory.
 */

export type StmKind = 'user' | 'aria' | 'screen' | 'tool' | 'note'

export interface StmEvent {
  t: number
  kind: StmKind
  text: string
}

const STM_MAX = 150 // queue length — roughly an hour of lively session
const DISTILL_BATCH = 40 // evicted lines per distillation call
const FLUSH_MIN = 8 // don't distill scraps smaller than this on disconnect; they persist to next time
const SCREEN_TEXT_GAP_MS = 10_000 // OCR is local and free; this just keeps STM from drowning in near-duplicates
const SCREEN_TEXT_MAX = 900 // a full page of tweets is a lot of line; cap what one frame may occupy
const SAVE_DEBOUNCE_MS = 2_000

const TRANSCRIBE_PROMPT =
  'You are the eyes of a companion AI watching a friend\'s screen. Transcribe the readable ' +
  'content of this screen verbatim, in reading order, as compact plain text. Keep names, handles, ' +
  'numbers and titles exactly as written. Skip window chrome, menus, icons and ads. If there is ' +
  'little or no text (a game scene, a video), instead say in one or two telegraphic lines what app ' +
  'or game this is and what is happening. No commentary, no speculation.'

export class ShortTermMemory {
  private events: StmEvent[] = []
  private pending: string[] = [] // evicted lines awaiting distillation; persisted, so quitting loses nothing
  private apiKey = ''
  private lastCaptionAt = 0
  private saveTimer: ReturnType<typeof setTimeout> | null = null
  private distilling = false

  constructor(
    private readonly log: (type: string, data: Record<string, unknown>) => void = () => {}
  ) {}

  /** Set at connect time; without a key the queue still works, captions and distillation just skip */
  configure(apiKey: string): void {
    this.apiKey = apiKey
  }

  private file(): string {
    return path.join(app.getPath('userData'), 'aria-stm.json')
  }

  load(): void {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file(), 'utf8'))
      if (Array.isArray(parsed?.events)) this.events = parsed.events
      if (Array.isArray(parsed?.pending)) this.pending = parsed.pending
    } catch {
      // First run
    }
  }

  saveNow(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    try {
      fs.writeFileSync(this.file(), JSON.stringify({ events: this.events, pending: this.pending }))
    } catch {
      // Losing the debounced save is fine; the next one retries
    }
  }

  private scheduleSave(): void {
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      this.saveNow()
    }, SAVE_DEBOUNCE_MS)
  }

  add(kind: StmKind, text: string, t = Date.now()): void {
    const clean = text.replace(/\s+/g, ' ').trim()
    if (!clean) return
    this.events.push({ t, kind, text: clean })
    while (this.events.length > STM_MAX) {
      this.pending.push(this.line(this.events.shift()!))
    }
    if (this.pending.length >= DISTILL_BATCH) void this.distillPending(DISTILL_BATCH)
    this.scheduleSave()
  }

  /** Whether the next frame would be turned into screen text (lets the capturer skip full-res work otherwise) */
  wantsFrame(): boolean {
    return Date.now() - this.lastCaptionAt >= SCREEN_TEXT_GAP_MS
  }

  /**
   * A frame was just sent to Aria: turn it into a text memory too (throttled).
   * Verbatim first — Windows OCR reads rendered text word for word, which beats any summary
   * (a summarized tweet loses exactly the names and numbers she later gets asked about).
   * Only text-poor scenes (games, video) fall back to a vision caption.
   * Fire-and-forget — the text lands in the queue seconds later, stamped with capture time.
   */
  noteFrame(dataUrl: string): void {
    const now = Date.now()
    if (now - this.lastCaptionAt < SCREEN_TEXT_GAP_MS) return
    this.lastCaptionAt = now
    void this.frameToText(dataUrl, now)
  }

  private lastScreenText = ''

  private async frameToText(dataUrl: string, t: number): Promise<void> {
    // Primary: a nano vision model transcribing verbatim — it keeps reading order, skips icon
    // chrome, and handles mixed CJK/latin where raw OCR falls apart
    let text = ''
    let source = 'screen_text'
    if (this.apiKey) {
      try {
        text = (
          await chatText(this.apiKey, MEMORY_MODEL, [
            {
              role: 'user',
              content: [
                { type: 'image_url', image_url: { url: dataUrl, detail: 'high' } },
                { type: 'text', text: TRANSCRIBE_PROMPT }
              ]
            }
          ])
        ).trim()
      } catch (err) {
        this.log('screen_text_error', { error: String((err as Error)?.message ?? err) })
      }
    }
    if (!text) {
      // No key or the call failed: the free local OCR still beats remembering nothing.
      // Windows OCR spaces CJK glyph by glyph ("很 大 的 橙 子"); merge those gaps back into words.
      source = 'screen_ocr'
      text = (await ocrImage(dataUrl))
        .replace(/\s+/g, ' ')
        .replace(/(?<=[　-鿿＀-￯])\s+(?=[　-鿿＀-￯])/g, '')
        .trim()
    }
    text = text.replace(/\s+/g, ' ').slice(0, SCREEN_TEXT_MAX)
    if (!text || text === this.lastScreenText) return // an unchanged screen isn't a new memory
    this.lastScreenText = text
    this.add('screen', text, t)
    this.log(source, { text })
  }

  /**
   * The tail injected at session start, oldest first. Only genuinely recent events qualify —
   * the queue survives restarts, and yesterday's lines presented as "just now" would gaslight her.
   */
  recentBlock(n = 25, maxAgeMs = 6 * 3600_000): string {
    const cutoff = Date.now() - maxAgeMs
    return this.events
      .filter(ev => ev.t >= cutoff)
      .slice(-n)
      .sort((a, b) => a.t - b.t)
      .map(ev => this.line(ev))
      .join('\n')
  }

  /** Disconnect: distill what has expired instead of holding it until the next full batch */
  async flush(): Promise<void> {
    this.saveNow()
    if (this.pending.length >= FLUSH_MIN) await this.distillPending(this.pending.length)
  }

  private line(ev: StmEvent): string {
    const d = new Date(ev.t)
    const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
    const tag: Record<StmKind, string> = {
      user: 'they',
      aria: 'you',
      screen: 'screen',
      tool: 'you',
      note: 'note'
    }
    return `[${hhmm}] ${tag[ev.kind]}: ${ev.text}`
  }

  private async distillPending(nLines: number): Promise<void> {
    if (this.distilling || !this.apiKey) return
    this.distilling = true
    const batch = this.pending.splice(0, nLines)
    try {
      const res = await distill(batch, this.apiKey)
      this.log('distilled', { lines: batch.length, ...res })
    } catch (err) {
      // Losing one batch is acceptable; retrying a broken call forever is not
      this.log('distill_error', { lines: batch.length, error: String((err as Error)?.message ?? err) })
    } finally {
      this.distilling = false
      this.scheduleSave()
    }
  }
}
