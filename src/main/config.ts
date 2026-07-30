import { app } from 'electron'
import * as fs from 'fs'
import * as path from 'path'

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
  /** 主动吐槽的冷却时间 (ms) */
  proactiveCooldownMs: number
  /** 触发主动吐槽需要的画面变化幅度（0~1，应大于 diffThreshold） */
  proactiveDiffThreshold: number
  alwaysOnTop: boolean
  /** 圆环下方是否显示 Aria 说话的字幕 */
  showCaptions: boolean
  /** 共看模式：固定看帧间隔 (ms) */
  cowatchIntervalMs: number
  /** 共看模式：无声判断（要不要吐槽）的间隔 (ms) */
  cowatchJudgeIntervalMs: number
}

export const DEFAULT_CONFIG: AriaConfig = {
  apiKey: '',
  model: 'gpt-realtime-2.1',
  voice: 'marin',
  captureIntervalMs: 3000,
  diffThreshold: 0.06,
  minImageGapMs: 4000,
  maxImagesKept: 4,
  // 默认只回应用户说话；想让她主动吐槽画面在设置里打开
  proactive: false,
  proactiveCooldownMs: 90_000,
  proactiveDiffThreshold: 0.18,
  alwaysOnTop: true,
  showCaptions: true,
  cowatchIntervalMs: 12_000,
  cowatchJudgeIntervalMs: 150_000
}

function configPath(): string {
  return path.join(app.getPath('userData'), 'aria-config.json')
}

export function loadConfig(): AriaConfig {
  let cfg = { ...DEFAULT_CONFIG }
  try {
    cfg = { ...cfg, ...JSON.parse(fs.readFileSync(configPath(), 'utf8')) }
  } catch {
    // 首次运行没有配置文件，用默认值
  }
  if (!cfg.apiKey && process.env.OPENAI_API_KEY) cfg.apiKey = process.env.OPENAI_API_KEY
  return cfg
}

export function saveConfig(cfg: AriaConfig): void {
  fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2), 'utf8')
}
