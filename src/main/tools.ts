import { searchWeb } from './websearch'

/**
 * The ONE place Aria's tools get executed. Production (main.ts) and the eval harness
 * (eval/ariaClient.ts) both call executeTool — they must never grow separate branches again:
 * set_chattiness shipped without eval knowing the tool existed, so a "talk less" scenario
 * would have scored her against "Unknown tool".
 *
 * Hosts differ only in side effects, injected via ToolEnv.
 */
export interface ToolEnv {
  /** Persist a long-term fact; returns the result text she hears (it may honestly refuse) */
  rememberFact(fact: string): string
  /** Verbatim text of recent screens (eval: canned) */
  recallScreens(): string
  /** Step the volume ladder; returns the confirmation text she hears back */
  setChattiness(direction: 'less' | 'more'): string
  /** Retire a memory on request; the deletion must hold against re-derivation */
  forgetFact(about: string): string
  /** Replace a wrong memory with the corrected one */
  correctFact(oldRef: string, newFact: string): string
  /** Never store anything about this topic again; retires existing matches */
  blockTopic(topic: string): string
  /** Override the real web search (eval may want it deterministic) */
  search?(query: string): Promise<string>
}

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  env: ToolEnv
): Promise<string> {
  switch (name) {
    case 'search_web': {
      const query = String(args.query ?? '').trim()
      return query ? await (env.search ?? searchWeb)(query) : 'No search query provided'
    }
    case 'remember_fact':
      return env.rememberFact(String(args.fact ?? '').trim())
    case 'forget_fact':
      return env.forgetFact(String(args.about ?? '').trim())
    case 'correct_fact':
      return env.correctFact(String(args.old ?? '').trim(), String(args.new ?? '').trim())
    case 'never_remember_topic':
      return env.blockTopic(String(args.topic ?? '').trim())
    case 'recall_screen':
      return env.recallScreens()
    case 'set_chattiness':
      return env.setChattiness(args.direction === 'more' ? 'more' : 'less')
    default:
      return `Unknown tool: ${name}`
  }
}
