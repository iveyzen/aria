import * as fs from 'fs'
import * as path from 'path'
import { Scenario } from './types'

/** The eval/ directory (screenshots and scenarios both live here, separate from build output) */
export function evalDir(): string {
  // dist/eval/scenarios.js → repo root → eval/
  return path.resolve(__dirname, '../../eval')
}

export function loadScenarios(only?: string[]): Scenario[] {
  const dir = path.join(evalDir(), 'scenarios')
  let files: string[]
  try {
    files = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort()
  } catch {
    throw new Error(`No scenarios found at ${dir}`)
  }

  const scenarios: Scenario[] = []
  for (const f of files) {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))
    const list: Scenario[] = Array.isArray(raw) ? raw : [raw]
    for (const s of list) {
      if (!s.id) throw new Error(`Scenario in ${f} is missing an id`)
      scenarios.push(s)
    }
  }

  const ids = new Set(scenarios.map(s => s.id))
  if (ids.size !== scenarios.length) throw new Error('Duplicate scenario ids')

  if (!only?.length) return scenarios
  const picked = scenarios.filter(s => only.includes(s.id))
  const missing = only.filter(id => !ids.has(id))
  if (missing.length) throw new Error(`Unknown scenario id(s): ${missing.join(', ')}`)
  return picked
}

/**
 * Load the scenario's screenshot and convert it to the dataURL the Realtime API expects.
 * Returns null when the file is missing — the caller falls back to a text-only scenario
 * and marks it degraded in the report, rather than pretending this one ran normally.
 */
export function loadScreen(scenario: Scenario): string | null {
  if (!scenario.screen) return null
  const p = path.join(evalDir(), scenario.screen)
  try {
    const buf = fs.readFileSync(p)
    const ext = path.extname(p).toLowerCase()
    const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg'
    return `data:${mime};base64,${buf.toString('base64')}`
  } catch {
    return null
  }
}
