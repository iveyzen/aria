import { app } from 'electron'
import * as fs from 'fs'
import * as path from 'path'

export type ProactivityLevel = 'quiet' | 'balanced' | 'chatty'

/** 三档主动程度对应的具体参数。UI 选一档，写进 config 的就是这些数值。 */
export const PROACTIVITY_PRESETS: Record<
  ProactivityLevel,
  Pick<AriaConfig, 'proactive' | 'proactiveCooldownMs' | 'proactiveDiffThreshold' | 'idleInitiativeMs'>
> = {
  // 基本只在被叫到时说话
  quiet: {
    proactive: true,
    proactiveCooldownMs: 90_000,
    proactiveDiffThreshold: 0.2,
    idleInitiativeMs: 120_000
  },
  // 默认档：画面有动静会吐槽，安静半分钟就会自己找话说
  balanced: {
    proactive: true,
    proactiveCooldownMs: 25_000,
    proactiveDiffThreshold: 0.12,
    idleInitiativeMs: 30_000
  },
  // 一直在旁边碎碎念的搭子
  chatty: {
    proactive: true,
    proactiveCooldownMs: 12_000,
    proactiveDiffThreshold: 0.08,
    idleInitiativeMs: 15_000
  }
}

export interface AriaConfig {
  apiKey: string
  model: string
  voice: string
  /** 屏幕截图轮询间隔 (ms) */
  captureIntervalMs: number
  /** 画面变化多大才发送截图（0~1，帧间平均像素差比例） */
  diffThreshold: number
  /** 两张发送给模型的截图之间的最小间隔 (ms) */
  minImageGapMs: number
  /** 会话里最多保留几张截图，旧的自动删除以省 token */
  maxImagesKept: number
  /** Aria 是否会主动开口吐槽画面 */
  proactive: boolean
  /** 主动程度预设，UI 用；改它会同时改写下面三个数值 */
  proactivity: ProactivityLevel
  /** 主动吐槽的冷却时间 (ms) */
  proactiveCooldownMs: number
  /** 触发主动吐槽需要的画面变化幅度（0~1，应大于 diffThreshold） */
  proactiveDiffThreshold: number
  /**
   * 安静多久之后她会看着屏幕主动找话说 (ms)；0 = 关闭。
   * 和"画面剧变吐槽"是两条路：那条靠画面变化触发，这条靠沉默触发。
   */
  idleInitiativeMs: number
  alwaysOnTop: boolean
  /** 圆环下方是否显示 Aria 说话的字幕 */
  showCaptions: boolean
}

export const DEFAULT_CONFIG: AriaConfig = {
  apiKey: '',
  model: 'gpt-realtime-2.1',
  voice: 'marin',
  captureIntervalMs: 3000,
  diffThreshold: 0.06,
  minImageGapMs: 4000,
  maxImagesKept: 4,
  // 默认就让她主动搭话；嫌吵在设置里调成 quiet
  proactivity: 'balanced',
  ...PROACTIVITY_PRESETS.balanced,
  alwaysOnTop: true,
  showCaptions: true
}

function configPath(): string {
  return path.join(app.getPath('userData'), 'aria-config.json')
}

export function loadConfig(): AriaConfig {
  let cfg = { ...DEFAULT_CONFIG }
  let saved: Partial<AriaConfig> = {}
  try {
    saved = JSON.parse(fs.readFileSync(configPath(), 'utf8'))
    cfg = { ...cfg, ...saved }
  } catch {
    // 首次运行没有配置文件，用默认值
  }
  // 旧配置文件只有 proactive 布尔值，没有 proactivity 档位：按布尔值推一个档位出来，
  // 不然会出现 proactivity='balanced' 但 proactive=false 这种自相矛盾的状态
  if (!saved.proactivity) {
    const level: ProactivityLevel = saved.proactive === false ? 'quiet' : 'balanced'
    cfg = { ...cfg, proactivity: level, ...PROACTIVITY_PRESETS[level] }
  }
  if (!cfg.apiKey && process.env.OPENAI_API_KEY) cfg.apiKey = process.env.OPENAI_API_KEY
  return cfg
}

export function saveConfig(cfg: AriaConfig): void {
  fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2), 'utf8')
}
