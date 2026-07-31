/**
 * Data structures for the persona-tuning eval set.
 *
 * One scenario = one screenshot + a sequence of user lines (or one trigger for speaking up unprompted).
 * Run it to get Aria's real replies, then hand them to the judge for scoring. The scores and the
 * "where it sounds like a bot" notes are what persona edits are based on.
 */

export type ScenarioMode =
  /** The user types messages, multi-turn; she always replies */
  | 'chat'
  /** The screen changed drastically, uses PROACTIVE_PROMPT: she should volunteer a quip */
  | 'proactive'
  /** It has been quiet too long, uses INITIATIVE_PROMPT: she decides for herself whether to speak (PASS is a valid answer) */
  | 'initiative'

export interface Scenario {
  id: string
  title: string
  mode: ScenarioMode
  /** Screenshot path, relative to the eval/ directory. When missing, degrades to a text-only scenario and is flagged in the report */
  screen?: string
  /** Text description of the screenshot. A reference for the judge when the screenshot exists; a stand-in for it when it doesn't */
  screenNote?: string
  /** Long-term memory to inject, to test how she references their shared past */
  memory?: string
  /** What the user says, turn by turn, in chat mode */
  turns?: string[]
  /** What a good outcome looks like for this scenario, given to the judge as a scoring reference */
  expect?: string
}

export interface ToolCall {
  name: string
  args: Record<string, unknown>
}

export interface Exchange {
  /** What the user said this turn; null for speak-up-unprompted scenarios */
  user: string | null
  /** What triggered this reply; written into the report for easy reading */
  trigger: string
  /** What Aria said out loud */
  aria: string
  /** For initiative/judge cases: she chose to stay quiet */
  passed: boolean
  toolCalls: ToolCall[]
  verdict?: Verdict
}

export interface ScenarioRun {
  scenarioId: string
  title: string
  mode: ScenarioMode
  /** Screenshot was missing; this run fell back to text-only */
  degraded: boolean
  exchanges: Exchange[]
  error?: string
}

export interface Verdict {
  /** Does it sound like a real person or like an AI, 1~5 */
  humanness: number
  /** Is the length what a person would casually say out loud, 1~5 */
  brevity: number
  /** Is this still recognisably Aria the person, 1~5 */
  inCharacter: number
  verdict: 'human' | 'borderline' | 'robotic'
  /** Exactly where AI-speak leaked through; maps directly to persona entries to fix */
  aiTells: string[]
  why: string
  /** How a real person would say this line — the most useful signal when editing the persona */
  rewrite: string
}

export interface RunReport {
  startedAt: string
  model: string
  judgeModel: string
  /** Fingerprint of the persona text, used to confirm whether two runs used the same persona version */
  personaHash: string
  runs: ScenarioRun[]
}
