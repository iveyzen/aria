import { app, BrowserWindow, ipcMain, session } from 'electron'
import * as path from 'path'
import { AriaConfig, loadConfig, saveConfig } from './config'
import { appendMemory, loadMemory } from './memory'
import {
  COWATCH_OFF_NOTE,
  COWATCH_ON_NOTE,
  LOOK_PROMPT,
  PROACTIVE_PROMPT,
  sessionContext
} from './persona'
import { RealtimeClient } from './realtime'
import { CaptureTarget, ScreenWatcher } from './screen'
import { searchWeb } from './websearch'

const WINDOW_TITLE = 'Aria'

let win: BrowserWindow | null = null
let client: RealtimeClient | null = null
let cfg: AriaConfig
const watcher = new ScreenWatcher()

let watchEnabled = true
let cowatch = false
let captureTimer: ReturnType<typeof setInterval> | null = null
let judgeTimer: ReturnType<typeof setInterval> | null = null
let lastImageAt = 0
let lastProactiveAt = 0
let cowatchFrames = 0

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
  // 共看模式：固定节奏看帧（视频画面永远在变，帧差检测没有意义）
  const interval = cowatch ? cfg.cowatchIntervalMs : cfg.captureIntervalMs
  captureTimer = setInterval(() => void captureAndMaybeSend(cowatch), interval)
}

function stopWatching(): void {
  if (captureTimer) {
    clearInterval(captureTimer)
    captureTimer = null
  }
}

function setCowatch(on: boolean): void {
  if (cowatch === on) return
  cowatch = on
  if (judgeTimer) {
    clearInterval(judgeTimer)
    judgeTimer = null
  }
  if (on) {
    watchEnabled = true
    cowatchFrames = 0
    client?.sendSystemNote(COWATCH_ON_NOTE)
    judgeTimer = setInterval(() => {
      if (cowatch) client?.requestJudgment()
    }, cfg.cowatchJudgeIntervalMs)
  } else {
    client?.sendSystemNote(COWATCH_OFF_NOTE)
  }
  client?.setGatedListening(on) // 共看时视频人声多，先判断再回
  if (client?.isOpen && watchEnabled) startWatching()
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
      ui('status', '锁定的窗口不见了，感知已暂停')
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
    !cowatch && // 共看模式有自己的"无声判断"节奏，不走主动吐槽
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

  // 共看模式：每 3 帧默默记一次观影笔记（截图会被修剪，笔记文字长存）
  if (cowatch) {
    cowatchFrames++
    if (cowatchFrames % 3 === 0) client.requestNote()
  }
}

function connect(): void {
  if (client?.isOpen) return
  cfg = loadConfig()
  if (!cfg.apiKey) {
    ui('status', '请先在设置里填入 OpenAI API Key')
    ui('state', 'disconnected')
    return
  }
  ui('state', 'connecting')
  ui('status', '连接中…')

  client = new RealtimeClient(cfg, sessionContext(loadMemory()))
  client.on('open', () => {
    ui('state', 'connected')
    watcher.reset()
    lastImageAt = 0
    // 首帧 diff 恒为 1，压住主动吐槽的冷却，避免和开场白撞车
    lastProactiveAt = Date.now()
    if (watchEnabled) {
      startWatching()
      void captureAndMaybeSend(true) // 上线先看一眼当前屏幕
    }
  })
  client.on('close', ({ code, intentional }: { code: number; intentional: boolean }) => {
    stopWatching()
    cowatch = false
    if (judgeTimer) {
      clearInterval(judgeTimer)
      judgeTimer = null
    }
    ui('state', 'disconnected')
    ui('status', intentional ? '已断开' : `连接断开 (${code})，点"连接"重试`)
    client = null
  })
  client.on('status', (msg: string) => ui('status', msg))
  client.on('apiError', (msg: string) => ui('status', `API 错误: ${msg}`))
  client.on('audioDelta', (buf: Buffer) => win?.webContents.send('audio', buf))
  client.on('audioClear', () => win?.webContents.send('audio-clear'))
  client.on('userTranscript', (t: string) => ui('user-said', t))
  client.on('ariaTranscriptDelta', (d: string) => ui('aria-delta', d))
  client.on('ariaTranscriptDone', () => ui('aria-done'))
  client.on('responseState', (active: boolean) => ui('aria-speaking', active))
  client.on('speechStarted', () => {
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
        ui('status', `查资料：${query}`)
        const result = query ? await searchWeb(query) : '缺少搜索关键词'
        client?.sendFunctionResult(callId, result)
      } else if (name === 'remember_fact') {
        appendMemory(String(args.fact ?? ''))
        client?.sendFunctionResult(callId, '已记住')
      } else {
        client?.sendFunctionResult(callId, `未知工具: ${name}`)
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
  ipcMain.on('look-now', () => void captureAndMaybeSend(true, LOOK_PROMPT))
  ipcMain.on('set-cowatch', (_e, on: boolean) => setCowatch(on))

  ipcMain.on('win-min', () => win?.minimize())
  ipcMain.on('win-close', () => win?.close())

  ipcMain.handle('get-config', () => loadConfig())
  ipcMain.handle('save-config', (_e, next: AriaConfig) => {
    saveConfig(next)
    cfg = next
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
