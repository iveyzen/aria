import { app } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { MEMORY_MODEL, chatJson } from './llm'

/**
 * Aria's long-term memory: a slowly growing store of facts worth keeping forever.
 *
 * Facts arrive two ways: she calls remember_fact herself (direct write), or the distiller
 * finds them in expiring short-term memory (see stm.ts). Repeated mentions reinforce a fact
 * (count++, fresh lastSeen) instead of duplicating it — recurring things earn their place.
 */

export interface LtmFact {
  fact: string
  /** profile | preference | life | habit | moment | stated (= she chose to remember it herself) */
  category: string
  firstSeen: string
  lastSeen: string
  count: number
}

let cache: LtmFact[] | null = null

function ltmPath(): string {
  return path.join(app.getPath('userData'), 'aria-ltm.json')
}

function today(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function load(): LtmFact[] {
  if (cache) return cache
  try {
    const parsed = JSON.parse(fs.readFileSync(ltmPath(), 'utf8'))
    if (Array.isArray(parsed?.facts)) {
      cache = parsed.facts
      return cache!
    }
  } catch {
    // No store yet — first run, or pre-LTM install
  }
  cache = migrateLegacy()
  if (cache.length) save()
  return cache
}

/** One-time import of the old flat-file memory ("- [date] fact" lines); the .md stays behind as a backup */
function migrateLegacy(): LtmFact[] {
  const facts: LtmFact[] = []
  try {
    const text = fs.readFileSync(path.join(app.getPath('userData'), 'aria-memory.md'), 'utf8')
    for (const line of text.split('\n')) {
      const m = /^-\s*(?:\[(\d{4}-\d{2}-\d{2})\])?\s*(.+)$/.exec(line.trim())
      if (!m || !m[2].trim()) continue
      const seen = m[1] ?? today()
      facts.push({ fact: m[2].trim(), category: 'stated', firstSeen: seen, lastSeen: seen, count: 1 })
    }
  } catch {
    // Nothing to migrate
  }
  return facts
}

function save(): void {
  try {
    fs.writeFileSync(ltmPath(), JSON.stringify({ facts: load() }, null, 2), 'utf8')
  } catch {
    // A failed save loses nothing until quit; the next save retries
  }
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}

/** Add a fact, or reinforce it if it's already known (near-exact match) */
export function addFact(fact: string, category = 'stated'): void {
  const clean = fact.replace(/\s+/g, ' ').trim()
  if (!clean) return
  const facts = load()
  const norm = normalize(clean)
  const existing = facts.find(f => normalize(f.fact) === norm)
  if (existing) {
    existing.count++
    existing.lastSeen = today()
  } else {
    facts.push({ fact: clean, category, firstSeen: today(), lastSeen: today(), count: 1 })
  }
  save()
}

/**
 * The block injected at session start: the most recent facts, plus older ones that keep
 * coming up — frequency buys a memory its spot even after recency has expired.
 */
export function memoryContext(max = 40): string {
  const facts = load()
  if (!facts.length) return ''
  const sorted = [...facts].sort(
    (a, b) => b.lastSeen.localeCompare(a.lastSeen) || b.count - a.count
  )
  const picked = sorted.slice(0, max)
  for (const f of sorted.slice(max)) {
    if (f.count >= 3 && picked.length < max + 10) picked.push(f)
  }
  return picked.map(f => `- ${f.fact}${f.count >= 5 ? ' (comes up a lot)' : ''}`).join('\n')
}

const DISTILL_SYSTEM = `You maintain the long-term memory of Aria, a companion AI who hangs out with her friend (the user) on voice chat while watching their screen. You will see a batch of expiring short-term events (conversation lines, screen captions, tool use) and her current long-term memories. Decide what deserves to be kept forever.

Worth keeping: stable facts about the user (what they go by, preferences, strong opinions), what they play and watch, people in their life, ongoing situations, plans and promises, and genuinely memorable shared moments. Not worth keeping: one-off screen activity, generic chatter, anything an existing memory already covers.

Return JSON:
{"new_facts": [{"fact": "one sentence, third person", "category": "profile|preference|life|habit|moment"}],
 "reinforce": [numbers of existing memories this batch confirms again]}

Both lists may be empty — most batches yield 0-2 new facts. Never rephrase an existing memory as a "new" fact; reinforce it instead.`

/** Distill expiring short-term lines into LTM. One cheap call per batch; a failure just drops the batch. */
export async function distill(
  lines: string[],
  apiKey: string
): Promise<{ added: number; reinforced: number }> {
  const facts = load()
  // The most recently added memories are the dedup context; a numbered list keeps reinforce references unambiguous
  const known = facts.slice(-80)
  const user =
    `Existing memories:\n${known.map((f, i) => `${i}. ${f.fact}`).join('\n') || '(none)'}` +
    `\n\nExpiring events:\n${lines.join('\n')}`
  const out = await chatJson(apiKey, MEMORY_MODEL, [
    { role: 'system', content: DISTILL_SYSTEM },
    { role: 'user', content: user }
  ])
  let added = 0
  let reinforced = 0
  if (Array.isArray(out?.reinforce)) {
    for (const n of out.reinforce) {
      const f = known[Number(n)]
      if (f) {
        f.count++
        f.lastSeen = today()
        reinforced++
      }
    }
  }
  if (Array.isArray(out?.new_facts)) {
    for (const nf of out.new_facts) {
      if (typeof nf?.fact === 'string' && nf.fact.trim()) {
        addFact(nf.fact, typeof nf.category === 'string' ? nf.category : 'moment')
        added++
      }
    }
  }
  save()
  return { added, reinforced }
}
