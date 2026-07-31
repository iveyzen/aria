import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import { ARIA_INSTRUCTIONS, INITIATIVE_PROMPT, PROACTIVE_PROMPT } from '../main/persona'
import { EvalAriaClient } from './ariaClient'
import { judgeExchange, score } from './judge'
import { renderComparison, renderReport } from './report'
import { evalDir, loadScenarios, loadScreen } from './scenarios'
import { Exchange, RunReport, Scenario, ScenarioRun } from './types'

/**
 * Usage:
 *   npm run eval                      run all scenarios, score them, produce a report
 *   npm run eval -- --only boss-wipe  run only certain ones (comma-separated)
 *   npm run eval -- --repeat 3        run each 3 times and average (the model is stochastic; always use this for before/after persona comparisons)
 *   npm run eval -- --no-judge        run without scoring (cheaper; quick look at what she said)
 *   npm run eval -- --compare a.json b.json   compare the results of two runs
 *
 * Note: scores from a single pass are very noisy, especially for initiative's binary "speak or stay quiet" call.
 * To judge whether a persona edit made things better or worse, use at least --repeat 3.
 */

const MODEL = process.env.ARIA_EVAL_MODEL ?? 'gpt-realtime-2.1'
const JUDGE_MODEL = process.env.ARIA_JUDGE_MODEL ?? 'gpt-4o'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const hasFlag = (name: string): boolean => process.argv.includes(`--${name}`)

/** Prefer the env var, then the config file saved by the desktop app — so running evals doesn't require entering the key again */
function resolveApiKey(): string {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY
  const appData =
    process.env.APPDATA ??
    (process.platform === 'darwin'
      ? path.join(process.env.HOME ?? '', 'Library', 'Application Support')
      : path.join(process.env.HOME ?? '', '.config'))
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(appData, 'aria', 'aria-config.json'), 'utf8'))
    if (cfg.apiKey) return String(cfg.apiKey)
  } catch {
    // No config file — fall through and throw, prompting the user
  }
  throw new Error(
    'No API key. Set OPENAI_API_KEY, or run the desktop app once and save your key in settings.'
  )
}

async function runScenario(
  apiKey: string,
  scenario: Scenario
): Promise<{ run: ScenarioRun; screen: string | null }> {
  const screen = loadScreen(scenario)
  const degraded = Boolean(scenario.screen) && !screen
  const run: ScenarioRun = {
    scenarioId: scenario.id,
    title: scenario.title,
    mode: scenario.mode,
    degraded,
    exchanges: []
  }

  const client = new EvalAriaClient(apiKey, MODEL, scenario.memory ?? '')
  try {
    await client.connect()

    if (screen) {
      client.addImage(screen)
    } else if (scenario.screenNote) {
      // No screenshot: inject the screen description as text instead; the report marks this degraded — don't treat it as equivalent evidence
      client.addUserText(`[on screen right now: ${scenario.screenNote}]`)
    }

    if (scenario.mode === 'chat') {
      for (const turn of scenario.turns ?? []) {
        client.addUserText(turn)
        const { text, toolCalls } = await client.respond()
        run.exchanges.push({
          user: turn,
          trigger: 'user spoke',
          aria: text,
          passed: false,
          toolCalls
        })
      }
    } else {
      const prompt = scenario.mode === 'proactive' ? PROACTIVE_PROMPT : INITIATIVE_PROMPT
      const triggers: Record<string, string> = {
        proactive: 'screen changed a lot — she may comment',
        initiative: 'it has been quiet — she decides whether to speak up'
      }
      const { text, toolCalls } = await client.respond(prompt)
      const passed = /^pass\b/i.test(text.trim())
      run.exchanges.push({
        user: null,
        trigger: triggers[scenario.mode],
        aria: text,
        passed,
        toolCalls
      })
    }
  } catch (err) {
    run.error = (err as Error).message
  } finally {
    client.close()
  }

  return { run, screen }
}

async function main(): Promise<void> {
  const compare = arg('compare')
  if (compare || hasFlag('compare')) {
    const i = process.argv.indexOf('--compare')
    const [beforePath, afterPath] = [process.argv[i + 1], process.argv[i + 2]]
    if (!beforePath || !afterPath) throw new Error('Usage: --compare <before.json> <after.json>')
    const before: RunReport = JSON.parse(fs.readFileSync(beforePath, 'utf8'))
    const after: RunReport = JSON.parse(fs.readFileSync(afterPath, 'utf8'))
    const md = renderComparison(before, after)
    const out = path.join(evalDir(), 'runs', 'comparison.md')
    fs.writeFileSync(out, md, 'utf8')
    console.log(md)
    console.log(`\nWritten to ${out}`)
    return
  }

  const apiKey = resolveApiKey()
  const only = arg('only')?.split(',').map(s => s.trim()).filter(Boolean)
  const scenarios = loadScenarios(only)
  const judging = !hasFlag('no-judge')
  const repeat = Math.max(1, Math.min(10, Number(arg('repeat') ?? 1) || 1))

  const report: RunReport = {
    startedAt: new Date().toISOString(),
    model: MODEL,
    judgeModel: judging ? JUDGE_MODEL : '(none)',
    personaHash: crypto.createHash('sha256').update(ARIA_INSTRUCTIONS).digest('hex').slice(0, 12),
    runs: []
  }

  console.log(
    `Running ${scenarios.length} scenario(s) against ${MODEL}` +
      (repeat > 1 ? ` × ${repeat} repeats` : '')
  )
  console.log(`Persona fingerprint: ${report.personaHash}\n`)
  if (repeat === 1) {
    console.log('Note: one pass per scenario is noisy. Use --repeat 3 before trusting a comparison.\n')
  }

  const queue = scenarios.flatMap(s => Array.from({ length: repeat }, (_, i) => ({ s, i })))

  for (const { s: scenario, i: pass } of queue) {
    const label = repeat > 1 ? `${scenario.id} #${pass + 1}` : scenario.id
    process.stdout.write(`· ${label} … `)
    const { run, screen } = await runScenario(apiKey, scenario)
    if (repeat > 1) run.title = `${run.title} #${pass + 1}`

    if (run.error) {
      console.log(`FAILED (${run.error})`)
    } else {
      const said = run.exchanges.map(e => (e.passed ? '(quiet)' : e.aria)).join(' | ')
      console.log(said.slice(0, 110) + (said.length > 110 ? '…' : ''))
      if (run.degraded) console.log(`  ! screenshot missing: ${scenario.screen} — ran text-only`)
    }

    if (judging && !run.error) {
      const history: Exchange[] = []
      for (const ex of run.exchanges) {
        try {
          ex.verdict = await judgeExchange(
            apiKey,
            JUDGE_MODEL,
            scenario,
            history,
            ex,
            screen ?? undefined
          )
          console.log(`  → ${score(ex.verdict).toFixed(1)}/5 ${ex.verdict.verdict}`)
        } catch (err) {
          console.log(`  → judge failed: ${(err as Error).message}`)
        }
        history.push(ex)
      }
    }
    report.runs.push(run)
  }

  const runsDir = path.join(evalDir(), 'runs')
  fs.mkdirSync(runsDir, { recursive: true })
  const stamp = report.startedAt.replace(/[:.]/g, '-')
  const jsonPath = path.join(runsDir, `${stamp}.json`)
  const mdPath = path.join(runsDir, `${stamp}.md`)
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf8')
  fs.writeFileSync(mdPath, renderReport(report), 'utf8')
  // latest.* use fixed names, so the most recent run is easy to open directly
  fs.writeFileSync(path.join(runsDir, 'latest.json'), JSON.stringify(report, null, 2), 'utf8')
  fs.writeFileSync(path.join(runsDir, 'latest.md'), renderReport(report), 'utf8')

  console.log(`\nReport:  ${mdPath}`)
  console.log(`Raw:     ${jsonPath}`)
  console.log(`(also copied to runs/latest.md and runs/latest.json)`)
}

main().catch(err => {
  console.error(`\n${(err as Error).message}`)
  process.exit(1)
})
