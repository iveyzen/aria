import { app, BrowserWindow, ipcMain, session } from 'electron'
import * as path from 'path'
import { AriaConfig, PROACTIVITY_PRESETS, loadConfig, saveConfig } from './config'
import { appendMemory, loadMemory } from './memory'
import { PROACTIVE_PROMPT, sessionContext } from './persona'
import { RealtimeClient } from './realtime'
import { CaptureTarget, ScreenWatcher } from './screen'
import { searchWeb } from './websearch'

const WINDOW_TITLE = 'Aria'

let win: BrowserWindow | null = null
let client: RealtimeClient | null = null
let cfg: AriaConfig
const watcher = new ScreenWatcher()

let watchEnabled = true
let captureTimer: ReturnType<typeof setInterval> | null = null
let initiativeTimer: ReturnType<typeof setInterval> | null = null
let lastImageAt = 0
let lastProactiveAt = 0
/** Timestamp of the last "someone spoke" moment (user spoke up or Aria finished); idle initiative timing is based on this */
let lastActivityAt = 0

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
  if (now - lastActivityAt < cfg.idleInitiativeMs) return
  if (now - lastProactiveAt < cfg.proactiveCooldownMs) return

  // Send a fresh screenshot first so she knows what is on the screen right now
  if (watchEnabled) await captureAndMaybeSend(true)
  if (!client?.isOpen || client.isResponding || client.isUserSpeaking) return

  lastProactiveAt = now
  lastActivityAt = now // Restart the timer whether or not she speaks, to avoid judging on every tick
  client.requestInitiative()
}

/**
 * Capture one frame of the target. If the change exceeds the threshold (or forced), send it to Aria;
 * if the change is very large and the cooldown is over, have her comment on it proactively.
 */
async function captureAndMaybeSend(forced: boolean, respondPrompt?: string): Promise<void> {
  if (!client?.isOpen) return
  const frame = await watcher.captureNow()
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

  let prompt = respondPrompt
  if (
    !prompt &&
    cfg.proactive &&
    frame.diff >= cfg.proactiveDiffThreshold &&
    now - lastProactiveAt >= cfg.proactiveCooldownMs &&
    !client.isResponding &&
    !client.isUserSpeaking
  ) {
    lastProactiveAt = now
    prompt = PROACTIVE_PROMPT
  }
  client.sendImage(frame.dataUrl, prompt)
  ui('looked') // The ring "takes a breath": she just took a look
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

  client = new RealtimeClient(cfg, sessionContext(loadMemory()))
  client.on('open', () => {
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
    ui('state', 'disconnected')
    ui('status', intentional ? 'Disconnected' : `Connection dropped (${code}) — tap to reconnect`)
    client = null
  })
  client.on('status', (msg: string) => ui('status', msg))
  client.on('apiError', (msg: string) => ui('status', `API error: ${msg}`))
  client.on('audioDelta', (buf: Buffer) => win?.webContents.send('audio', buf))
  client.on('audioClear', () => win?.webContents.send('audio-clear'))
  client.on('userTranscript', (t: string) => {
    lastActivityAt = Date.now()
    ui('user-said', t)
  })
  client.on('ariaTranscriptDelta', (d: string) => ui('aria-delta', d))
  client.on('ariaTranscriptDone', () => ui('aria-done'))
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
      if (name === 'search_web') {
        const query = String(args.query ?? '').trim()
        ui('status', `Looking up: ${query}`)
        const result = query ? await searchWeb(query) : 'No search query provided'
        client?.sendFunctionResult(callId, result)
      } else if (name === 'remember_fact') {
        appendMemory(String(args.fact ?? ''))
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
  app.quit()
})
