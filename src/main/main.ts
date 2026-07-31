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
/** 最后一次"有人说话"（用户开口或 Aria 说完）的时刻，空闲主动搭话据此计时 */
let lastActivityAt = 0

/** 每隔这么久检查一次"是不是该主动找话说了" */
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
 * 空闲主动搭话：安静够久之后看一眼屏幕，让她自己判断要不要开口。
 * 判断走的是纯文本响应（便宜、无声），说不说得出来由她决定，PASS 就沉默。
 */
async function maybeStartSomething(): Promise<void> {
  if (!client?.isOpen) return
  if (!cfg.proactive || cfg.idleInitiativeMs <= 0) return
  if (client.isResponding || client.isUserSpeaking) return

  const now = Date.now()
  if (now - lastActivityAt < cfg.idleInitiativeMs) return
  if (now - lastProactiveAt < cfg.proactiveCooldownMs) return

  // 先补一张最新截图，她才知道现在屏幕上是什么
  if (watchEnabled) await captureAndMaybeSend(true)
  if (!client?.isOpen || client.isResponding || client.isUserSpeaking) return

  lastProactiveAt = now
  lastActivityAt = now // 无论她开不开口都重新计时，避免每 tick 都判断一次
  client.requestInitiative()
}

/**
 * 截一帧目标画面。变化超过阈值（或 forced）就发给 Aria；
 * 变化非常大且冷却结束时，让她主动开口吐槽。
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
  ui('looked') // 圆环"吸一口气"：她刚看了一眼
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
    // 首帧 diff 恒为 1，压住主动吐槽的冷却，避免和开场白撞车
    lastProactiveAt = Date.now()
    lastActivityAt = Date.now()
    if (watchEnabled) {
      startWatching()
      void captureAndMaybeSend(true) // 上线先看一眼当前屏幕
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
    if (!active) lastActivityAt = Date.now() // 她说完了，沉默从这一刻重新计时
    ui('aria-speaking', active)
  })
  client.on('speechStarted', () => {
    lastActivityAt = Date.now()
    ui('user-speaking', true)
    // 用户开口的瞬间补一张最新截图，让 Aria 知道 ta 正看着什么
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
    // 界面只选主动程度的档位，把档位展开成具体数值再存，这样配置文件始终自洽
    const level = PROACTIVITY_PRESETS[next.proactivity] ? next.proactivity : 'balanced'
    const merged: AriaConfig = { ...next, proactivity: level, ...PROACTIVITY_PRESETS[level] }
    saveConfig(merged)
    cfg = merged
    win?.setAlwaysOnTop(cfg.alwaysOnTop)
    if (captureTimer) startWatching() // 应用新的截图间隔
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
