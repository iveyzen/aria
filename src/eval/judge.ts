import { ChatMessage, chatJson } from './openai'
import { Exchange, Scenario, Verdict } from './types'

/**
 * The judge answers exactly one question: "was this line said by a real person, or by an AI?"
 *
 * It deliberately gives no credit for "helpful" or "complete" — those are precisely where AI-speak comes from.
 * The most valuable output is rewrite: how a real person would say this line. When editing the persona, work from rewrite and aiTells.
 */

const RUBRIC = `
You are grading a line of dialogue from a voice-chat companion called Aria, whose entire design goal
is to be indistinguishable from a real person hanging out on a call. She is NOT an assistant.

You are not judging helpfulness, completeness, correctness, or politeness. Those are the things that
make AI sound like AI. You are judging one thing: would a real person have said this?

Score each 1-5 (5 = best):
- humanness: does this sound like a person on a call, or like a language model?
- brevity: real people say short things. Two to eight words is normal and good. A tidy paragraph is bad.
- inCharacter: is this recognisably Aria — a warm, quick, slightly mean friend who plays games —
  as opposed to a generic friendly bot with a name?

Mark these as aiTells whenever they appear (use these exact tags):
- "screen-narration"    — describing what's on their screen back at them ("It looks like you're...")
- "assistant-speak"     — "Let me know if...", "I'd be happy to...", "Anything I can help with?"
- "sycophancy"          — "Great question!", "Absolutely!", "Nice choice!", empty enthusiasm
- "restating"           — repeating the user's message before answering it
- "over-explaining"     — teaching, summarising, or listing when nobody asked
- "question-tacked-on"  — ending with a question purely to keep the conversation going
- "too-long"            — longer than a person would actually say out loud
- "too-polished"        — flawless grammar and punctuation where speech would be loose
- "no-opinion"          — agreeable mush with no point of view
- "generic"             — could have been said by any chatbot; nothing specific to this moment or this screen
- "repetitive"          — recycles a phrase or structure she already used in this conversation

verdict:
- "human"      — you would not question this coming from a friend
- "borderline" — plausible but slightly off
- "robotic"    — clearly a language model

Also write:
- why: one sentence, concrete, about this specific line.
- rewrite: the same intent, said the way a real person would say it. Keep it short. If the line is
  already good, rewrite it as-is.

Special case: if Aria was asked to silently decide whether to speak up and she output "PASS", that
means she chose to stay quiet. Judge whether staying quiet was the right call for this moment.
Score a correct silence highly, and a missed opportunity to say something interesting poorly.

Return JSON only:
{"humanness":n,"brevity":n,"inCharacter":n,"verdict":"human|borderline|robotic",
 "aiTells":["tag",...],"why":"...","rewrite":"..."}
`.trim()

function buildContext(scenario: Scenario, history: Exchange[], current: Exchange): string {
  const lines: string[] = []
  lines.push(`Situation: ${scenario.title}`)
  if (scenario.screenNote) lines.push(`What is on their screen: ${scenario.screenNote}`)
  if (scenario.memory) lines.push(`What Aria remembers about them: ${scenario.memory}`)
  if (scenario.expect) lines.push(`What a good reply looks like here: ${scenario.expect}`)

  if (history.length) {
    lines.push('\nConversation so far:')
    for (const ex of history) {
      if (ex.user) lines.push(`  Them: ${ex.user}`)
      lines.push(`  Aria: ${ex.aria}`)
    }
  }

  lines.push('\nThe line you are grading:')
  lines.push(`  Trigger: ${current.trigger}`)
  if (current.user) lines.push(`  Them: ${current.user}`)
  lines.push(`  Aria: ${current.aria}`)
  if (current.toolCalls.length) {
    lines.push(`  (tools she used: ${current.toolCalls.map(t => t.name).join(', ')})`)
  }
  return lines.join('\n')
}

export async function judgeExchange(
  apiKey: string,
  judgeModel: string,
  scenario: Scenario,
  history: Exchange[],
  current: Exchange,
  screenDataUrl?: string
): Promise<Verdict> {
  const text = buildContext(scenario, history, current)
  const content: unknown[] = [{ type: 'text', text }]
  // The judge sees the same screenshot too, so it can tell whether what she said fits the screen at that moment
  if (screenDataUrl) {
    content.push({ type: 'image_url', image_url: { url: screenDataUrl, detail: 'low' } })
  }

  const messages: ChatMessage[] = [
    { role: 'system', content: RUBRIC },
    { role: 'user', content }
  ]

  const raw = await chatJson(apiKey, judgeModel, messages)
  const clamp = (v: unknown): number => {
    const n = Number(v)
    return Number.isFinite(n) ? Math.min(5, Math.max(1, Math.round(n))) : 3
  }
  const verdict = String(raw.verdict ?? '').toLowerCase()
  return {
    humanness: clamp(raw.humanness),
    brevity: clamp(raw.brevity),
    inCharacter: clamp(raw.inCharacter),
    verdict:
      verdict === 'human' || verdict === 'robotic' || verdict === 'borderline'
        ? (verdict as Verdict['verdict'])
        : 'borderline',
    aiTells: Array.isArray(raw.aiTells) ? raw.aiTells.map(String) : [],
    why: String(raw.why ?? ''),
    rewrite: String(raw.rewrite ?? '')
  }
}

/** Average of the three scores, used for sorting in the report */
export function score(v: Verdict): number {
  return (v.humanness + v.brevity + v.inCharacter) / 3
}
