import * as fs from 'fs'
import * as path from 'path'

/** A command line appended to copilot/inbox.jsonl by the copilot (Claude Code on the WSL side) */
export interface CopilotCommand {
  cmd: string
  text?: string
}

/**
 * Copilot tuning mode (`--copilot` or ARIA_COPILOT=1): a file-based tap + control channel
 * so an external agent can watch a live session and steer it.
 *
 * Everything lives under `<app>/copilot/`, which on a D:\aria install is reachable from WSL
 * as /mnt/d/aria/copilot — files instead of sockets so nothing crosses the network boundary:
 *   session-<ts>.jsonl  every event of this run: frames sent, both transcripts, tool calls,
 *                       initiative checks and their verdicts, injected commands
 *   frames/*.jpg        the exact images Aria saw, one file per injected screenshot
 *   inbox.jsonl         append-only command channel INTO the app (see CopilotCommand)
 *   persona.md          optional persona override; hot-swapped via {"cmd":"reload_persona"}
 *
 * Contains real desktop captures — the whole directory is gitignored and must stay local.
 */
export class Copilot {
  readonly enabled: boolean
  private dir = ''
  private sessionFile = ''
  private inboxFile = ''
  /** Offset into the decoded inbox text that has already been consumed (we re-read the whole file each poll) */
  private inboxOffset = 0
  private poller: ReturnType<typeof setInterval> | null = null
  private onCommand: ((c: CopilotCommand) => void) | null = null

  constructor(appPath: string) {
    this.enabled = process.argv.includes('--copilot') || process.env.ARIA_COPILOT === '1'
    if (!this.enabled) return
    this.dir = path.join(appPath, 'copilot')
    fs.mkdirSync(path.join(this.dir, 'frames'), { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    this.sessionFile = path.join(this.dir, `session-${stamp}.jsonl`)
    this.inboxFile = path.join(this.dir, 'inbox.jsonl')
    if (!fs.existsSync(this.inboxFile)) fs.writeFileSync(this.inboxFile, '')
    // Skip anything already in the inbox: stale commands from a previous run must not replay
    this.inboxOffset = fs.readFileSync(this.inboxFile, 'utf8').length
  }

  /** Begin polling the inbox. Polling (not fs.watch) because writes come from the WSL side of a 9p mount. */
  start(onCommand: (c: CopilotCommand) => void): void {
    if (!this.enabled) return
    this.onCommand = onCommand
    this.poller = setInterval(() => this.pollInbox(), 400)
    this.record('copilot_start', { pid: process.pid, session: path.basename(this.sessionFile) })
  }

  stop(): void {
    if (this.poller) {
      clearInterval(this.poller)
      this.poller = null
    }
  }

  /**
   * Append one event to the session log. No-op when copilot mode is off, so call sites don't need guards.
   * Synchronous on purpose: event order in the log must match what actually happened, and the lines are tiny.
   */
  record(type: string, data: Record<string, unknown> = {}): void {
    if (!this.enabled) return
    const line = JSON.stringify({ t: new Date().toISOString(), type, ...data })
    try {
      fs.appendFileSync(this.sessionFile, line + '\n')
    } catch {
      // Never let a logging failure take the session down
    }
  }

  /** Save a frame Aria is about to see; returns its path relative to copilot/ (null when disabled) */
  saveFrame(dataUrl: string): string | null {
    if (!this.enabled) return null
    const m = /^data:image\/(\w+);base64,(.+)$/.exec(dataUrl)
    if (!m) return null
    const rel = `frames/${Date.now()}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`
    fs.writeFile(path.join(this.dir, rel), Buffer.from(m[2], 'base64'), () => {})
    return rel
  }

  /** Read copilot/persona.md; null = absent or empty → the built-in persona applies */
  loadPersonaOverride(): string | null {
    if (!this.enabled) return null
    try {
      const text = fs.readFileSync(path.join(this.dir, 'persona.md'), 'utf8').trim()
      return text || null
    } catch {
      return null
    }
  }

  private pollInbox(): void {
    let text: string
    try {
      text = fs.readFileSync(this.inboxFile, 'utf8')
    } catch {
      return
    }
    if (text.length < this.inboxOffset) this.inboxOffset = 0 // file was truncated: start over
    if (text.length === this.inboxOffset) return
    const fresh = text.slice(this.inboxOffset)
    const lastNl = fresh.lastIndexOf('\n')
    if (lastNl < 0) return // an incomplete trailing line is still being written; wait for its newline
    this.inboxOffset += lastNl + 1
    for (const raw of fresh.slice(0, lastNl).split('\n')) {
      const line = raw.trim()
      if (!line) continue
      try {
        const cmd = JSON.parse(line) as CopilotCommand
        this.record('command', { cmd: cmd.cmd, text: cmd.text })
        this.onCommand?.(cmd)
      } catch {
        this.record('command_error', { line })
      }
    }
  }
}
