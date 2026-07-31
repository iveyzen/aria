import { app } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { MEMORY_MODEL, chatText } from './llm'
import { distill } from './memory'
import { ocrImage } from './ocr'
import { classifyScreen } from './privacy'

/**
 * Short-term memory: a budgeted queue of everything that just happened, as enveloped text
 * events — both sides of the conversation, tool use, and screen text.
 *
 * Envelope over raw text (design-principles.md): every event carries provenance (speaker,
 * sourceApp, capture, confidence, privacy) and a content hash. Structure the provenance and
 * lifecycle, not the semantics.
 *
 * Screen memory is split: `latestScreens` holds the current full transcription per source;
 * the queue only receives the lines that are NEW versus that state (local diff — never
 * model-side delta transcription, which can permanently lose whatever one call skips).
 * Sensitive/secret screens never persist at all.
 *
 * Jobs: the tail is injected at session start (continuity across reconnects/restarts), the
 * recall_screen tool reads the current states, and whatever falls off the front is batched
 * through the distiller (memory.ts).
 */

export type StmKind = 'user' | 'aria' | 'screen' | 'tool' | 'note'

export interface StmEvent {
  id: string
  t: number
  kind: StmKind
  speaker: 'user' | 'aria' | 'screen-author' | 'system'
  sourceApp?: string
  captureId?: string
  /** sensitive/secret content never enters the queue, so only these two appear */
  privacy: 'normal' | 'personal'
  /** ASR and OCR are lossy → low; verbatim vision transcription → high */
  confidence: 'high' | 'low'
  text: string
  hash: string
}

export interface FrameMeta {
  sourceApp: string
  captureId?: string
  /** Copilot frame file for this capture, so a sensitive verdict can delete it retroactively */
  framePath?: string | null
}

/** Capacity is a character budget (≈ tokens·3), not an event count; screens get a sub-quota */
const CHAR_BUDGET_TOTAL = 36_000
const CHAR_BUDGET_SCREEN = 22_000
const DISTILL_BATCH = 40 // evicted lines per distillation call
const FLUSH_MIN = 8 // don't distill scraps smaller than this on disconnect; they persist to next time
const SCREEN_TEXT_GAP_MS = 10_000
const SCREEN_TEXT_MAX = 900 // cap on one frame's NEW text in the queue
const HINT_MAX = 1_600 // cap on the full-state text kept for ASR hinting and the journal
const SAVE_DEBOUNCE_MS = 2_000

const TRANSCRIBE_PROMPT =
  'You are the eyes of a companion AI watching a friend\'s screen. Transcribe the readable ' +
  'content of this screen verbatim, in reading order, one line per visual line or post. Keep ' +
  'names, handles, numbers and titles exactly as written. Skip window chrome, menus, icons and ' +
  'ads. If there is little or no text (a game scene, a video), instead say in one or two ' +
  'telegraphic lines what app or game this is and what is happening. No commentary, no speculation.'

function contentHash(s: string): string {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0).toString(36)
}

const SPEAKER: Record<StmKind, StmEvent['speaker']> = {
  user: 'user',
  aria: 'aria',
  screen: 'screen-author',
  tool: 'system',
  note: 'system'
}

export class ShortTermMemory {
  private events: StmEvent[] = []
  private pending: string[] = [] // evicted lines awaiting distillation; persisted, so quitting loses nothing
  /** Current full transcription per source, most recently updated last (re-inserted on update) */
  private readonly latestScreens = new Map<string, string>()
  private apiKey = ''
  private lastCaptionAt = 0
  private saveTimer: ReturnType<typeof setTimeout> | null = null
  private distilling = false
  private seq = 1

  constructor(
    private readonly log: (type: string, data: Record<string, unknown>) => void = () => {}
  ) {}

  /** Set at connect time; without a key the queue still works, transcription and distillation just skip */
  configure(apiKey: string): void {
    this.apiKey = apiKey
  }

  private file(): string {
    return path.join(app.getPath('userData'), 'aria-stm.json')
  }

  load(): void {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file(), 'utf8'))
      if (Array.isArray(parsed?.events)) {
        // Migrate pre-envelope events in place
        this.events = parsed.events
          .filter((e: any) => e && typeof e.text === 'string' && e.text)
          .map((e: any, i: number) => ({
            id: typeof e.id === 'string' ? e.id : `m${i}`,
            t: Number(e.t) || Date.now(),
            kind: (e.kind ?? 'note') as StmKind,
            speaker: e.speaker ?? SPEAKER[(e.kind ?? 'note') as StmKind],
            sourceApp: e.sourceApp,
            captureId: e.captureId,
            privacy: e.privacy === 'personal' ? 'personal' : 'normal',
            confidence: e.confidence === 'low' ? 'low' : 'high',
            text: e.text,
            hash: typeof e.hash === 'string' ? e.hash : contentHash(e.text)
          }))
      }
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

  add(
    kind: StmKind,
    text: string,
    opts: Partial<Pick<StmEvent, 't' | 'privacy' | 'confidence' | 'sourceApp' | 'captureId'>> = {}
  ): void {
    const clean = text.replace(/\s+/g, ' ').trim()
    if (!clean) return
    const hash = contentHash(clean)
    // Exact repeat of the latest event of the same kind (ASR double-fire, unchanged screen): skip
    const last = [...this.events].reverse().find(e => e.kind === kind)
    if (last?.hash === hash) return
    this.events.push({
      id: `e${this.seq++}`,
      t: opts.t ?? Date.now(),
      kind,
      speaker: SPEAKER[kind],
      sourceApp: opts.sourceApp,
      captureId: opts.captureId,
      privacy: opts.privacy ?? 'normal',
      confidence: opts.confidence ?? 'high',
      text: clean,
      hash
    })
    this.evictToBudget()
    if (this.pending.length >= DISTILL_BATCH) void this.distillPending(DISTILL_BATCH)
    this.scheduleSave()
  }

  private evictToBudget(): void {
    const chars = (pred: (e: StmEvent) => boolean) =>
      this.events.reduce((n, e) => (pred(e) ? n + e.text.length : n), 0)
    const evictOldest = (pred: (e: StmEvent) => boolean) => {
      const idx = this.events.findIndex(pred)
      if (idx < 0) return false
      this.pending.push(this.line(this.events[idx]))
      this.events.splice(idx, 1)
      return true
    }
    // Screens have a sub-quota so a chatty feed can't squeeze out the conversation
    while (chars(e => e.kind === 'screen') > CHAR_BUDGET_SCREEN) {
      if (!evictOldest(e => e.kind === 'screen')) break
    }
    while (chars(() => true) > CHAR_BUDGET_TOTAL) {
      if (!evictOldest(() => true)) break
    }
  }

  /** Whether the next frame would be turned into screen text (lets the capturer skip full-res work otherwise) */
  wantsFrame(): boolean {
    return Date.now() - this.lastCaptionAt >= SCREEN_TEXT_GAP_MS
  }

  /**
   * A frame was just sent to Aria: classify it, then remember only what is NEW versus the
   * current state of that source. Fire-and-forget; text lands stamped with capture time.
   */
  noteFrame(dataUrl: string, meta: FrameMeta): void {
    const now = Date.now()
    if (now - this.lastCaptionAt < SCREEN_TEXT_GAP_MS) return
    this.lastCaptionAt = now
    void this.frameToText(dataUrl, now, meta)
  }

  private async frameToText(dataUrl: string, t: number, meta: FrameMeta): Promise<void> {
    // Primary: a nano vision model transcribing verbatim — reading order, chrome skipped,
    // mixed CJK/latin intact. Fallback: local Windows OCR (lossy → low confidence).
    let text = ''
    let source = 'screen_text'
    let confidence: StmEvent['confidence'] = 'high'
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
      source = 'screen_ocr'
      confidence = 'low'
      text = (await ocrImage(dataUrl))
        .replace(/[ \t]+/g, ' ')
        .replace(/(?<=[　-鿿＀-￯])\s+(?=[　-鿿＀-￯])/g, '')
        .trim()
    }
    if (!text) return

    const verdict = classifyScreen(meta.sourceApp, text)
    // Always surfaced — main gates proactivity and deletes the copilot frame off this event
    this.log('screen_privacy', { ...verdict, sourceApp: meta.sourceApp, framePath: meta.framePath ?? null })
    if (verdict.privacy === 'sensitive' || verdict.privacy === 'secret') {
      // She may have glanced (transient context in the live session); nothing persists here.
      this.log('screen_redacted', { sourceApp: meta.sourceApp, privacy: verdict.privacy })
      return
    }

    // Local line-level diff against the current state of this source: only novel lines enter
    // the queue. The full state is kept for recall and ASR hinting.
    const lines = text
      .split('\n')
      .map(l => l.replace(/\s+/g, ' ').trim())
      .filter(Boolean)
    const prev = new Set(
      (this.latestScreens.get(meta.sourceApp) ?? '')
        .split('\n')
        .map(l => l.trim())
        .filter(Boolean)
    )
    const full = lines.join('\n').slice(0, HINT_MAX)
    this.latestScreens.delete(meta.sourceApp) // re-insert so Map order tracks recency
    this.latestScreens.set(meta.sourceApp, full)
    const novel = lines.filter(l => !prev.has(l))
    if (!novel.length) return

    const privacy = verdict.privacy === 'personal' ? 'personal' : 'normal'
    this.add('screen', novel.join(' | ').slice(0, SCREEN_TEXT_MAX), {
      t,
      privacy,
      confidence,
      sourceApp: meta.sourceApp,
      captureId: meta.captureId
    })
    this.log(source, {
      text: novel.join(' | ').slice(0, SCREEN_TEXT_MAX),
      full,
      sourceApp: meta.sourceApp,
      privacy,
      hintText: full
    })
  }

  /**
   * recall_screen: the current full state of the most recent sources, plus what scrolled past.
   */
  recentScreens(): string {
    const parts: string[] = []
    const states = [...this.latestScreens.entries()].slice(-2).reverse()
    for (const [src, full] of states) {
      parts.push(`— ${src} (current) —\n${full.slice(0, 1200)}`)
    }
    const deltas = this.events.filter(e => e.kind === 'screen').slice(-10)
    if (deltas.length) {
      parts.push('— earlier fragments —\n' + deltas.map(e => this.line(e)).join('\n'))
    }
    return parts.length ? parts.join('\n') : 'No screen text recorded yet.'
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
    if (ev.kind === 'screen') {
      const marks = [ev.sourceApp, ev.privacy === 'personal' ? 'personal' : '', ev.confidence === 'low' ? 'blurry' : '']
        .filter(Boolean)
        .join(', ')
      return `[${hhmm}] screen(${marks}): ${ev.text}`
    }
    const tag: Record<StmKind, string> = { user: 'they', aria: 'you', screen: 'screen', tool: 'you', note: 'note' }
    return `[${hhmm}] ${tag[ev.kind]}: ${ev.text}`
  }

  private async distillPending(nLines: number): Promise<void> {
    if (this.distilling || !this.apiKey) return
    this.distilling = true
    const batch = this.pending.splice(0, nLines)
    // Full batch into the copilot log (no-op otherwise): auditing the distiller means seeing its input
    this.log('distill_batch', { lines: batch })
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
