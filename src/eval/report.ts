import { score } from './judge'
import { Exchange, RunReport, ScenarioRun } from './types'

/** 把一次跑的结果写成 markdown。目标是让人（或我）看完就知道下一步改人设哪一条。 */

interface Scored {
  run: ScenarioRun
  ex: Exchange
  s: number
}

function allScored(report: RunReport): Scored[] {
  const out: Scored[] = []
  for (const run of report.runs) {
    for (const ex of run.exchanges) {
      if (ex.verdict) out.push({ run, ex, s: score(ex.verdict) })
    }
  }
  return out
}

function avg(nums: number[]): number {
  return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0
}

function bar(n: number): string {
  const full = Math.round(n)
  return '█'.repeat(full) + '░'.repeat(5 - full)
}

export function renderReport(report: RunReport): string {
  const scored = allScored(report)
  const L: string[] = []

  L.push('# Aria humanness report')
  L.push('')
  L.push(`- Run: ${report.startedAt}`)
  L.push(`- Aria model: \`${report.model}\``)
  L.push(`- Judge model: \`${report.judgeModel}\``)
  L.push(`- Persona fingerprint: \`${report.personaHash}\``)
  L.push('')

  if (!scored.length) {
    L.push('_No judged replies (ran with --no-judge, or every scenario errored)._')
    L.push('')
  } else {
    const overall = avg(scored.map(s => s.s))
    const counts = { human: 0, borderline: 0, robotic: 0 }
    for (const s of scored) counts[s.ex.verdict!.verdict]++

    L.push('## Overall')
    L.push('')
    L.push(`**${overall.toFixed(2)} / 5**  ${bar(overall)}`)
    L.push('')
    L.push('| Metric | Score |')
    L.push('| --- | --- |')
    L.push(`| Humanness | ${avg(scored.map(s => s.ex.verdict!.humanness)).toFixed(2)} |`)
    L.push(`| Brevity | ${avg(scored.map(s => s.ex.verdict!.brevity)).toFixed(2)} |`)
    L.push(`| In character | ${avg(scored.map(s => s.ex.verdict!.inCharacter)).toFixed(2)} |`)
    L.push('')
    L.push(
      `Verdicts: **${counts.human} human** · ${counts.borderline} borderline · ` +
        `**${counts.robotic} robotic** (of ${scored.length})`
    )
    L.push('')

    // AI 腔标签统计——这就是改人设的优先级列表
    const tally = new Map<string, number>()
    for (const s of scored) {
      for (const t of s.ex.verdict!.aiTells) tally.set(t, (tally.get(t) ?? 0) + 1)
    }
    if (tally.size) {
      L.push('## What still sounds like AI')
      L.push('')
      L.push('Fix these in `src/main/persona.ts`, most frequent first.')
      L.push('')
      L.push('| Tell | Times |')
      L.push('| --- | --- |')
      for (const [tag, n] of [...tally.entries()].sort((a, b) => b[1] - a[1])) {
        L.push(`| \`${tag}\` | ${n} |`)
      }
      L.push('')
    }

    L.push('## Worst lines')
    L.push('')
    for (const s of [...scored].sort((a, b) => a.s - b.s).slice(0, 10)) {
      const v = s.ex.verdict!
      L.push(`### ${s.s.toFixed(1)}/5 · ${s.run.title} · \`${v.verdict}\``)
      L.push('')
      if (s.ex.user) L.push(`> **Them:** ${s.ex.user}`)
      else L.push(`> _(${s.ex.trigger})_`)
      L.push('>')
      L.push(`> **Aria:** ${s.ex.aria || '_(silence)_'}`)
      L.push('')
      L.push(`- Why: ${v.why}`)
      if (v.aiTells.length) L.push(`- Tells: ${v.aiTells.map(t => `\`${t}\``).join(', ')}`)
      L.push(`- A person would say: **${v.rewrite}**`)
      L.push('')
    }
  }

  L.push('## Every scenario')
  L.push('')
  for (const run of report.runs) {
    const runScores = run.exchanges.filter(e => e.verdict).map(e => score(e.verdict!))
    const head = runScores.length ? `${avg(runScores).toFixed(1)}/5` : '—'
    L.push(`### ${run.title} · ${head}`)
    L.push('')
    L.push(`\`${run.scenarioId}\` · mode \`${run.mode}\`${run.degraded ? ' · **no screenshot (degraded)**' : ''}`)
    L.push('')
    if (run.error) {
      L.push(`> **Failed:** ${run.error}`)
      L.push('')
      continue
    }
    for (const ex of run.exchanges) {
      if (ex.user) L.push(`- **Them:** ${ex.user}`)
      else L.push(`- _${ex.trigger}_`)
      L.push(`- **Aria:** ${ex.passed ? '_(stayed quiet)_' : ex.aria || '_(nothing)_'}`)
      if (ex.toolCalls.length) {
        L.push(`- _tools: ${ex.toolCalls.map(t => `${t.name}(${JSON.stringify(t.args)})`).join(', ')}_`)
      }
      if (ex.verdict) L.push(`- _${score(ex.verdict).toFixed(1)}/5 — ${ex.verdict.why}_`)
      L.push('')
    }
  }

  return L.join('\n')
}

/** 两次跑的对比：调完人设看有没有真的变好 */
export function renderComparison(before: RunReport, after: RunReport): string {
  const b = allScored(before)
  const a = allScored(after)
  const L: string[] = []

  L.push('# Aria humanness — before vs after')
  L.push('')
  L.push(`- Before: ${before.startedAt} (persona \`${before.personaHash}\`)`)
  L.push(`- After:  ${after.startedAt} (persona \`${after.personaHash}\`)`)
  L.push('')

  const row = (name: string, pick: (s: Scored) => number): string => {
    const bv = avg(b.map(pick))
    const av = avg(a.map(pick))
    const d = av - bv
    const arrow = d > 0.05 ? '▲' : d < -0.05 ? '▼' : '—'
    return `| ${name} | ${bv.toFixed(2)} | ${av.toFixed(2)} | ${arrow} ${d >= 0 ? '+' : ''}${d.toFixed(2)} |`
  }

  L.push('| Metric | Before | After | Change |')
  L.push('| --- | --- | --- | --- |')
  L.push(row('Overall', s => s.s))
  L.push(row('Humanness', s => s.ex.verdict!.humanness))
  L.push(row('Brevity', s => s.ex.verdict!.brevity))
  L.push(row('In character', s => s.ex.verdict!.inCharacter))
  L.push('')

  // 逐条场景对比，找出改坏了的
  const byId = new Map<string, number[]>()
  for (const s of b) {
    const k = s.run.scenarioId
    byId.set(k, [...(byId.get(k) ?? []), s.s])
  }
  const afterById = new Map<string, number[]>()
  for (const s of a) {
    const k = s.run.scenarioId
    afterById.set(k, [...(afterById.get(k) ?? []), s.s])
  }

  const rows: { id: string; before: number; after: number; d: number }[] = []
  for (const [id, bs] of byId) {
    const as = afterById.get(id)
    if (!as) continue
    const bAvg = avg(bs)
    const aAvg = avg(as)
    rows.push({ id, before: bAvg, after: aAvg, d: aAvg - bAvg })
  }
  rows.sort((x, y) => x.d - y.d)

  if (rows.length) {
    L.push('## Per scenario')
    L.push('')
    L.push('Regressions first — these are what a persona edit broke.')
    L.push('')
    L.push('| Scenario | Before | After | Change |')
    L.push('| --- | --- | --- | --- |')
    for (const r of rows) {
      const arrow = r.d > 0.05 ? '▲' : r.d < -0.05 ? '▼' : '—'
      L.push(
        `| \`${r.id}\` | ${r.before.toFixed(1)} | ${r.after.toFixed(1)} | ` +
          `${arrow} ${r.d >= 0 ? '+' : ''}${r.d.toFixed(1)} |`
      )
    }
    L.push('')
  }

  return L.join('\n')
}
