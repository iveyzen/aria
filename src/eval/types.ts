/**
 * 调教用评测集的数据结构。
 *
 * 一条 scenario = 一张屏幕截图 + 一串用户台词（或一个主动开口的触发点），
 * 跑一遍拿到 Aria 的真实回复，再交给裁判打分。分数和"哪里像机器人"就是改人设的依据。
 */

export type ScenarioMode =
  /** 用户打字说话，多轮；她一定会回 */
  | 'chat'
  /** 画面剧变，走 PROACTIVE_PROMPT：她该主动吐槽一句 */
  | 'proactive'
  /** 安静太久，走 INITIATIVE_PROMPT：她自己决定要不要开口（PASS 也是合法答案） */
  | 'initiative'

export interface Scenario {
  id: string
  title: string
  mode: ScenarioMode
  /** 截图路径，相对 eval/ 目录。缺失时降级成纯文字场景并在报告里标注 */
  screen?: string
  /** 截图的文字描述。有截图时给裁判当参考，没截图时代替截图 */
  screenNote?: string
  /** 注入的长期记忆，测她引用共同过去的样子 */
  memory?: string
  /** chat 模式下用户依次说的话 */
  turns?: string[]
  /** 这一条什么样算好，交给裁判当评分参考 */
  expect?: string
}

export interface ToolCall {
  name: string
  args: Record<string, unknown>
}

export interface Exchange {
  /** 用户这一轮说了什么；主动开口类场景为 null */
  user: string | null
  /** 触发这次回复的原因，写进报告方便看 */
  trigger: string
  /** Aria 说出来的话 */
  aria: string
  /** initiative/judge 类：她选择了闭嘴 */
  passed: boolean
  toolCalls: ToolCall[]
  verdict?: Verdict
}

export interface ScenarioRun {
  scenarioId: string
  title: string
  mode: ScenarioMode
  /** 缺少截图，退化成纯文字跑的 */
  degraded: boolean
  exchanges: Exchange[]
  error?: string
}

export interface Verdict {
  /** 听起来像真人还是像 AI，1~5 */
  humanness: number
  /** 长度是否像真人随口说的，1~5 */
  brevity: number
  /** 是否还是 Aria 这个人，1~5 */
  inCharacter: number
  verdict: 'human' | 'borderline' | 'robotic'
  /** 具体哪些地方暴露了 AI 腔，直接对应人设里要改的条目 */
  aiTells: string[]
  why: string
  /** 真人会怎么说这句——改人设时最有用的信号 */
  rewrite: string
}

export interface RunReport {
  startedAt: string
  model: string
  judgeModel: string
  /** 人设文本的指纹，用来确认两次跑的是不是同一版人设 */
  personaHash: string
  runs: ScenarioRun[]
}
