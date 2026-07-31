import { app } from 'electron'
import * as fs from 'fs'
import * as path from 'path'

export type ProactivityLevel = 'quiet' | 'balanced' | 'chatty'

/** Concrete parameters for the three proactivity levels. The UI picks a level; these are the values written into config. */
export const PROACTIVITY_PRESETS: Record<
  ProactivityLevel,
  Pick<AriaConfig, 'proactive' | 'proactiveCooldownMs' | 'proactiveDiffThreshold' | 'idleInitiativeMs'>
> = {
  // The UI promises "Only speaks when you talk" — so quiet really is reactive-only
  quiet: {
    proactive: false,
    proactiveCooldownMs: 90_000,
    proactiveDiffThreshold: 1,
    idleInitiativeMs: 0
  },
  // Default level: comments when something happens on screen, and finds something to say after half a minute of quiet
  balanced: {
    proactive: true,
    proactiveCooldownMs: 25_000,
    proactiveDiffThreshold: 0.12,
    idleInitiativeMs: 30_000
  },
  // The companion who chatters away next to you the whole time
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
  /** Screen capture polling interval (ms) */
  captureIntervalMs: number
  /** How much the screen must change before a screenshot is sent (0~1, average per-pixel diff ratio between frames) */
  diffThreshold: number
  /** Minimum gap between two screenshots sent to the model (ms) */
  minImageGapMs: number
  /** Max screenshots kept in the session; older ones are auto-deleted to save tokens */
  maxImagesKept: number
  /** Whether Aria proactively comments on the screen */
  proactive: boolean
  /** Proactivity preset, used by the UI; changing it also rewrites the three values below */
  proactivity: ProactivityLevel
  /** Cooldown between proactive comments (ms) */
  proactiveCooldownMs: number
  /** Screen-change magnitude needed to trigger a proactive comment (0~1, should be greater than diffThreshold) */
  proactiveDiffThreshold: number
  /**
   * How long the quiet must last before she looks at the screen and starts a conversation herself (ms); 0 = off.
   * Separate path from the "big screen change" comments: that one is triggered by screen changes, this one by silence.
   */
  idleInitiativeMs: number
  alwaysOnTop: boolean
  /** Whether to show captions of Aria's speech below the ring */
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
  // Let her start conversations by default; if that is too noisy, switch to quiet in settings
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
    // No config file on first run; use defaults
  }
  // Old config files only have the proactive boolean, no proactivity level: infer a level from the boolean,
  // otherwise we would end up with self-contradictory states like proactivity='balanced' but proactive=false
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
