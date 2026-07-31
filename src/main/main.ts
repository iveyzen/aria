import { app, BrowserWindow, ipcMain, session } from 'electron'
import * as path from 'path'
import { AriaConfig, PROACTIVITY_PRESETS, loadConfig, saveConfig } from './config'
import { Copilot, CopilotCommand } from './copilot'
import { addFact, memoryContext } from './memory'
import { INITIATIVE_PROMPT, PROACTIVE_PROMPT, sessionContext } from './persona'
import { RealtimeClient } from './realtime'
import { CaptureTarget, ScreenWatcher } from './screen'
import { ShortTermMemory } from './stm'
import { searchWeb } from './websearch'

const WINDOW_TITLE = 'Aria'

let win: BrowserWindow | null = null
let client: RealtimeClient | null = null
let cfg: AriaConfig
let copilot: Copilot
const stm = new ShortTermMemory((type, data) => copilot?.record(type, data))
const watcher = new ScreenWatcher()

let watchEnabled = true
let captureTimer: ReturnType<typeof setInterval> | null = null
let initiativeTimer: ReturnType<typeof setInterval> | null = null
let lastImageAt = 0
let lastProactiveAt = 0
/** Timestamp of the last "someone spoke" moment (user spoke up or Aria finished); idle initiative timing is based on this */
let lastActivityAt = 0
/** Self-started lines since the user last said anything — she backs off instead of monologuing */
let unansweredInitiatives = 0

/** How often to check "is it time to strike up a conversation" */
const INITIATIVE_TICK_MS = 5_000

function ui(channel: string, payload?: unknown): void {
  win?.webContents.send('ui', { channel, payload })
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 390,
    height: 580,
    minWidth: 340,
    minHeight: 480,
    frame: false,
    alwaysOnTop: cfg.alwaysOnTop,
    backgroundColor: '#f7f2ea',
    title: WINDOW_TITLE,
    webPreferences: {
      preload: path.join(__dirname, '../preload.js')
    }
  })
  void win.loadFile(path.join(app.getAppPath(), 'renderer/index.html'))
  win.on('closed', () => {
    win = null
  })
}

function startWatching(): void {
  stopWatching()
  captureTimer = setInterval(() => void captureAndMaybeSend(false), cfg.captureIntervalMs)
}

function stopWatching(): void {
  if (captureTimer) {
    clearInterval(captureTimer)
    captureTimer = null
  }
}

function stopInitiative(): void {
  if (initiativeTimer) {
    clearInterval(initiativeTimer)
    initiativeTimer = null
  }
}

/**
 * Idle initiative: after enough quiet, glance at the screen and let her decide for herself whether to speak.
 * The judgment runs as a text-only response (cheap, silent); whether anything gets said is up to her, PASS means silence.
 */
async function maybeStartSomething(): Promise<void> {
  if (!client?.isOpen) return
  if (!cfg.proactive || cfg.idleInitiativeMs <= 0) return
  if (client.isResponding || client.isUserSpeaking) return

  const now = Date.now()
  // Unanswered self-started lines stretch the wait: a friend who got no reply twice stops pushing
  const idleNeeded = cfg.idleInitiativeMs * Math.min(4, 1 + unansweredInitiatives)
  if (now - lastActivityAt < idleNeeded) return
  if (now - lastProactiveAt < cfg.proactiveCooldownMs) return

  // Send a fresh screenshot first so she knows what is on the screen right now
  if (watchEnabled) await captureAndMaybeSend(true)
  if (!client?.isOpen || client.isResponding || client.isUserSpeaking) return

  lastProactiveAt = now
  lastActivityAt = now // Restart the timer whether or not she speaks, to avoid judging on every tick
  copilot.record('initiative_check')
  client.requestJudgment(INITIATIVE_PROMPT)
}

/** Copilot mode: commands appended to copilot/inbox.jsonl land here */
function handleCopilotCommand(c: CopilotCommand): void {
  switch (c.cmd) {
    case 'say':
      if (c.text && client?.isOpen) {
        lastActivityAt = Date.now()
        stm.add('user', c.text)
        client.sayAsUser(c.text)
      }
      break
    case 'probe':
      if (c.text) client?.probe(c.text)
      break
    case 'note':
      if (c.text) client?.sendSystemNote(c.text)
      break
    case 'look':
      if (client?.isOpen) void captureAndMaybeSend(true)
      break
    case 'reload_persona': {
      const override = copilot.loadPersonaOverride()
      client?.setPersona(override)
      copilot.record('persona_reload', {
        source: override ? 'copilot/persona.md' : 'built-in',
        chars: override?.length ?? 0
      })
      break
    }
    default:
      copilot.record('command_unknown', { cmd: c.cmd })
  }
}

/**
 * Capture one frame of the target. If the change exceeds the threshold (or forced), send it to Aria;
 * if the change is very large and the cooldown is over, have her comment on it proactively.
 */
async function captureAndMaybeSend(forced: boolean, respondPrompt?: string): Promise<void> {
  if (!client?.isOpen) return
  const frame = await watcher.captureNow(stm.wantsFrame())
  if (!frame) {
    if (watcher.targetLost) {
      stopWatching()
      watchEnabled = false
      watcher.setTarget(null)
      ui('watch-target', null)
      ui('status', 'Lost that window — vision paused')
    }
    return
  }

  const now = Date.now()
  const gapOk = now - lastImageAt >= (forced ? 1500 : cfg.minImageGapMs)
  const changed = frame.diff >= cfg.diffThreshold
  if (!gapOk || (!forced && !changed)) return
  lastImageAt = now

  const wantProactive =
    !respondPrompt &&
    cfg.proactive &&
    frame.diff >= cfg.proactiveDiffThreshold &&
    // Unanswered self-started lines stretch the cooldown too — same back-off as idle initiative
    now - lastProactiveAt >= cfg.proactiveCooldownMs * Math.min(4, 1 + unansweredInitiatives) &&
    !client.isResponding &&
    !client.isUserSpeaking

  client.sendImage(frame.dataUrl, respondPrompt)
  ui('looked') // The ring "takes a breath": she just took a look
  stm.noteFrame(frame.ocrDataUrl ?? frame.dataUrl)

  // Big change: judged, not spoken directly — app switches must be able to PASS silently
  if (wantProactive) {
    lastProactiveAt = now
    client.requestJudgment(PROACTIVE_PROMPT, 'proactive')
  }

  const saved = copilot.saveFrame(frame.dataUrl)
  if (saved) {
    copilot.record('screenshot', {
      file: saved,
      diff: Number(frame.diff.toFixed(3)),
      forced,
      prompted: Boolean(respondPrompt) || wantProactive
    })
  }
}

function connect(): void {
  if (client?.isOpen) return
  cfg = loadConfig()
  if (!cfg.apiKey) {
    ui('status', 'Add your OpenAI API key in settings first')
    ui('state', 'disconnected')
    return
  }
  ui('state', 'connecting')
  ui('status', 'Connecting…')

  stm.configure(cfg.apiKey)
  client = new RealtimeClient(cfg, sessionContext(memoryContext(), stm.recentBlock()))
  const personaOverride = copilot.loadPersonaOverride()
  if (personaOverride) client.setPersona(personaOverride)
  client.on('open', () => {
    copilot.record('connected', {
      model: cfg.model,
      proactivity: cfg.proactivity,
      persona: personaOverride ? 'copilot/persona.md' : 'built-in'
    })
    ui('state', 'connected')
    watcher.reset()
    lastImageAt = 0
    // The first frame's diff is always 1; hold down the proactive cooldown so it doesn't collide with the greeting
    lastProactiveAt = Date.now()
    lastActivityAt = Date.now()
    if (watchEnabled) {
      startWatching()
      void captureAndMaybeSend(true) // Take a first look at the current screen on connect
    }
    stopInitiative()
    initiativeTimer = setInterval(() => void maybeStartSomething(), INITIATIVE_TICK_MS)
  })
  client.on('close', ({ code, intentional }: { code: number; intentional: boolean }) => {
    stopWatching()
    stopInitiative()
    void stm.flush() // session over: give expiring short-term lines their shot at long-term memory
    copilot.record('disconnected', { code, intentional })
    ui('state', 'disconnected')
    ui('status', intentional ? 'Disconnected' : `Connection dropped (${code}) — tap to reconnect`)
    client = null
  })
  client.on('status', (msg: string) => ui('status', msg))
  client.on('apiError', (msg: string) => {
    copilot.record('api_error', { text: msg })
    ui('status', `API error: ${msg}`)
  })
  // Accumulate her transcript for the copilot log; a barge-in never fires ariaTranscriptDone,
  // so the partial line is flushed (marked interrupted) when the audio gets cleared
  let ariaLine = ''
  const flushAriaLine = (interrupted: boolean): void => {
    const text = ariaLine.trim()
    ariaLine = ''
    if (!text) return
    copilot.record('aria_text', interrupted ? { text, interrupted } : { text })
    stm.add('aria', interrupted ? `${text} (got cut off)` : text)
  }
  client.on('audioDelta', (buf: Buffer) => win?.webContents.send('audio', buf))
  client.on('audioClear', () => {
    flushAriaLine(true)
    win?.webContents.send('audio-clear')
  })
  client.on('userTranscript', (t: string) => {
    lastActivityAt = Date.now()
    unansweredInitiatives = 0 // they're talking again; she can stop holding back
    copilot.record('user_text', { text: t })
    stm.add('user', t)
    ui('user-said', t)
  })
  client.on('ariaTranscriptDelta', (d: string) => {
    ariaLine += d
    ui('aria-delta', d)
  })
  client.on('ariaTranscriptDone', () => {
    flushAriaLine(false)
    ui('aria-done')
  })
  client.on(
    'judged',
    ({ line, spoke, kind }: { line: string; spoke: boolean; kind?: string }) => {
      if (spoke) unansweredInitiatives++
      copilot.record(`${kind ?? 'initiative'}_result`, { spoke, line })
    }
  )
  client.on('probeResult', (text: string) => copilot.record('probe_result', { text }))
  client.on('responseState', (active: boolean) => {
    if (!active) lastActivityAt = Date.now() // She finished speaking; the silence clock restarts from this moment
    ui('aria-speaking', active)
  })
  client.on('speechStarted', () => {
    lastActivityAt = Date.now()
    ui('user-speaking', true)
    // The moment the user starts speaking, send a fresh screenshot so Aria knows what they are looking at
    if (watchEnabled) void captureAndMaybeSend(true)
  })
  client.on('speechStopped', () => ui('user-speaking', false))
  client.on(
    'functionCall',
    async ({ name, callId, args }: { name: string; callId: string; args: Record<string, unknown> }) => {
      copilot.record('tool_call', { name, args })
      if (name === 'search_web') {
        const query = String(args.query ?? '').trim()
        ui('status', `Looking up: ${query}`)
        stm.add('tool', `searched the web for "${query}"`)
        const result = query ? await searchWeb(query) : 'No search query provided'
        copilot.record('tool_result', { name, text: result.slice(0, 300) })
        client?.sendFunctionResult(callId, result)
      } else if (name === 'recall_screen') {
        client?.sendFunctionResult(callId, stm.recentScreens())
      } else if (name === 'remember_fact') {
        const fact = String(args.fact ?? '')
        addFact(fact)
        stm.add('note', `made a point of remembering: ${fact}`)
        client?.sendFunctionResult(callId, 'Noted')
      } else {
        client?.sendFunctionResult(callId, `Unknown tool: ${name}`)
      }
    }
  )

  client.connect()
}

app.whenReady().then(() => {
  cfg = loadConfig()
  copilot = new Copilot(app.getAppPath())
  copilot.start(handleCopilotCommand)
  stm.load()
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'media')
  })

  ipcMain.on('connect', () => connect())
  ipcMain.on('disconnect', () => client?.close())
  ipcMain.on('audio-chunk', (_e, chunk: Uint8Array) => {
    client?.appendAudio(Buffer.from(chunk))
  })

  ipcMain.handle('get-sources', () => watcher.listSources(WINDOW_TITLE))
  ipcMain.on('set-target', (_e, target: CaptureTarget) => {
    watcher.setTarget(target)
    watchEnabled = true
    ui('watch-target', { kind: target.kind, name: target.name })
    if (client?.isOpen) {
      startWatching()
      void captureAndMaybeSend(true)
    }
  })
  ipcMain.on('set-watch', (_e, on: boolean) => {
    watchEnabled = on
    if (on && client?.isOpen) startWatching()
    else if (!on) {
      stopWatching()
      ui('watch-target', null)
    }
  })
  ipcMain.on('win-min', () => win?.minimize())
  ipcMain.on('win-close', () => win?.close())

  ipcMain.handle('get-config', () => loadConfig())
  ipcMain.handle('save-config', (_e, next: AriaConfig) => {
    // The UI only picks a proactivity level; expand the level into concrete values before saving so the config file stays self-consistent
    const level = PROACTIVITY_PRESETS[next.proactivity] ? next.proactivity : 'balanced'
    const merged: AriaConfig = { ...next, proactivity: level, ...PROACTIVITY_PRESETS[level] }
    saveConfig(merged)
    cfg = merged
    win?.setAlwaysOnTop(cfg.alwaysOnTop)
    if (captureTimer) startWatching() // Apply the new capture interval
    return cfg
  })

  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  client?.close()
  stm.saveNow() // pending lines persist to disk; the next launch distills them
  copilot?.stop()
  app.quit()
})
