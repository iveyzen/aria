import * as fs from 'fs'
import * as path from 'path'
import { Scenario } from './types'

/** eval/ 目录（截图和场景都放这儿，跟编译产物分开） */
export function evalDir(): string {
  // dist/eval/scenarios.js → 仓库根 → eval/
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
 * 读场景的截图，转成 Realtime 要的 dataURL。
 * 找不到文件返回 null——调用方会退化成纯文字场景并在报告里标 degraded，
 * 而不是假装这一条正常跑过了。
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
