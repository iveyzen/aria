import { app } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { MEMORY_MODEL, chatText } from './llm'
import { distill } from './memory'

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
const CAPTION_GAP_MS = 20_000 // frames flow faster than memory needs; caption at most this often
const SAVE_DEBOUNCE_MS = 2_000

const CAPTION_PROMPT =
  'You are the eyes of a companion AI watching a friend\'s screen. In one or two short lines: ' +
  'what app or game is this, and what is happening right now? Include important visible text ' +
  'verbatim (titles, names, numbers, errors). Telegraphic style, no commentary, no speculation.'

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

  /**
   * A frame was just sent to Aria: turn it into a text memory too (throttled).
   * Fire-and-forget — the caption lands in the queue seconds later, stamped with capture time.
   */
  noteFrame(dataUrl: string): void {
    if (!this.apiKey) return
    const now = Date.now()
    if (now - this.lastCaptionAt < CAPTION_GAP_MS) return
    this.lastCaptionAt = now
    chatText(this.apiKey, MEMORY_MODEL, [
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: dataUrl, detail: 'low' } },
          { type: 'text', text: CAPTION_PROMPT }
        ]
      }
    ])
      .then(text => {
        const caption = text.trim()
        if (caption) {
          this.add('screen', caption, now)
          this.log('caption', { text: caption })
        }
      })
      .catch(err => this.log('caption_error', { error: String((err as Error)?.message ?? err) }))
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
