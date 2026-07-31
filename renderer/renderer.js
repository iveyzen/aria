const $ = id => document.getElementById(id)

const els = {
  orb: $('orb'),
  status: $('status'),
  ariaLine: $('aria-line'),
  micBtn: $('mic-btn'),
  watchBtn: $('watch-btn'),
  settingsBtn: $('settings-btn'),
  minBtn: $('min-btn'),
  closeBtn: $('close-btn'),
  picker: $('picker'),
  pickerList: $('picker-list'),
  pickerOff: $('picker-off'),
  pickerClose: $('picker-close'),
  settings: $('settings'),
  cfgApiKey: $('cfg-apikey'),
  proactivityGrid: $('proactivity-grid'),
  levelHint: $('level-hint'),
  cfgCaptions: $('cfg-captions'),
  cfgOnTop: $('cfg-ontop'),
  cfgSave: $('cfg-save'),
  cfgClose: $('cfg-close')
}

let connected = false
let connecting = false
let micEnabled = true
let watchingName = null
let watchingId = null
let userSpeaking = false
let ariaSpeaking = false
let showCaptions = true
let audioReady = false
let audioLive = false // whether her voice is actually coming out of the speakers right now
let playerNode = null
let selectedLevel = 'balanced'
let statusTimer = null
let lineTimer = null

const LEVEL_HINTS = {
  quiet: 'Only speaks when you talk to her.',
  balanced: 'Reacts when something big happens, and breaks a long silence.',
  chatty: 'Comments often and starts conversations on her own.'
}

Orb.init(els.orb)
void window.aria.getConfig().then(cfg => {
  showCaptions = cfg.showCaptions !== false
})
flashStatus('Click the orb to connect', 6000)

/* ---------- Status text: only flashes briefly, never persists — the orb itself is the status ---------- */

function flashStatus(msg, dur = 3500) {
  els.status.textContent = msg
  els.status.classList.remove('faded')
  if (statusTimer) clearTimeout(statusTimer)
  statusTimer = setTimeout(() => els.status.classList.add('faded'), dur)
}

function refreshOrb() {
  Orb.setState(
    !connected
      ? connecting
        ? 'connecting'
        : 'disconnected'
      : ariaSpeaking
        ? audioLive
          ? 'speaking'
          : 'thinking' // response has started but no sound yet: composing her words / looking things up
        : userSpeaking
          ? 'listening'
          : 'idle'
  )
}

/* ---------- Audio pipeline ---------- */

async function ensureAudio() {
  if (audioReady) return

  // Playback: Aria's voice (PCM16 24kHz streaming)
  const outCtx = new AudioContext({ sampleRate: 24000 })
  await outCtx.audioWorklet.addModule('worklets/player-worklet.js')
  playerNode = new AudioWorkletNode(outCtx, 'player', { outputChannelCount: [1] })
  playerNode.connect(outCtx.destination)
  let lastPosSentAt = 0
  playerNode.port.onmessage = e => {
    if (e.data.type !== 'level') return
    Orb.setLevel(e.data.playing ? e.data.level : 0)
    if (e.data.playing !== audioLive) {
      audioLive = e.data.playing
      refreshOrb() // thinking ↔ speaking switch
    }
    // Main needs real playback position for honest server-side truncation on barge-in
    const now = performance.now()
    if (now - lastPosSentAt > 120) {
      lastPosSentAt = now
      window.aria.sendAudioPos(e.data.played)
    }
  }

  // Capture: microphone → PCM16 24kHz → main process
  const inCtx = new AudioContext({ sampleRate: 24000 })
  await inCtx.audioWorklet.addModule('worklets/mic-worklet.js')
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true, // crucial: otherwise Aria would hear herself talking
      noiseSuppression: true,
      autoGainControl: true
    }
  })
  const source = inCtx.createMediaStreamSource(stream)
  const micNode = new AudioWorkletNode(inCtx, 'mic')
  source.connect(micNode)
  micNode.connect(inCtx.destination) // the worklet outputs silence; connected only to keep the graph running
  micNode.port.onmessage = e => {
    if (!connected || !micEnabled) return
    const f32 = e.data
    const i16 = new Int16Array(f32.length)
    for (let i = 0; i < f32.length; i++) {
      const s = Math.max(-1, Math.min(1, f32[i]))
      i16[i] = s < 0 ? s * 0x8000 : s * 0x7fff
    }
    window.aria.sendAudio(new Uint8Array(i16.buffer))
  }

  audioReady = true
}

window.aria.onAudio(chunk => {
  if (!playerNode) return
  const bytes = new Uint8Array(chunk).slice() // copy to guarantee 2-byte alignment
  const i16 = new Int16Array(bytes.buffer, 0, bytes.byteLength >> 1)
  const f32 = new Float32Array(i16.length)
  for (let i = 0; i < i16.length; i++) f32[i] = i16[i] / 32768
  playerNode.port.postMessage({ type: 'chunk', data: f32 }, [f32.buffer])
})

window.aria.onAudioClear(() => {
  playerNode?.port.postMessage({ type: 'clear' })
})

/* ---------- Aria's one-line caption ---------- */

function ariaLineDelta(delta) {
  if (!showCaptions) return
  if (lineTimer) {
    clearTimeout(lineTimer)
    lineTimer = null
  }
  if (els.ariaLine.classList.contains('faded')) {
    els.ariaLine.textContent = ''
    els.ariaLine.classList.remove('faded')
  }
  els.ariaLine.textContent += delta
}

function ariaLineDone() {
  if (lineTimer) clearTimeout(lineTimer)
  lineTimer = setTimeout(() => els.ariaLine.classList.add('faded'), 6000)
}

/* ---------- Messages from the main process ---------- */

function setState(state) {
  const wasConnected = connected
  connected = state === 'connected'
  connecting = state === 'connecting'
  if (connected) {
    Sfx.on()
    flashStatus(watchingName ? `Online · watching ${watchingName}` : 'Online')
    // First thing after coming online: have the user pick a screen/window for her to watch
    if (!wasConnected && !watchingName) setTimeout(() => void openPicker(), 700)
  } else if (connecting) {
    flashStatus('Connecting', 20000)
  } else if (wasConnected) {
    Sfx.off()
    flashStatus('Disconnected')
  }
  refreshOrb()
}

window.aria.onUi(({ channel, payload }) => {
  switch (channel) {
    case 'state':
      setState(payload)
      break
    case 'status':
      flashStatus(payload)
      if (String(payload).startsWith('API error')) Sfx.err()
      break
    case 'aria-delta':
      ariaLineDelta(payload)
      break
    case 'aria-done':
      ariaLineDone()
      break
    case 'aria-speaking':
      ariaSpeaking = !!payload
      if (!ariaSpeaking) Orb.setLevel(0)
      refreshOrb()
      break
    case 'user-speaking':
      userSpeaking = !!payload
      refreshOrb()
      break
    case 'user-said':
      break // the minimal UI doesn't show user captions
    case 'watch-target':
      watchingName = payload ? payload.name : null
      if (!payload) watchingId = null
      els.watchBtn.classList.toggle('active', !!payload)
      flashStatus(payload ? `Watching ${payload.name}` : 'Vision off')
      break
    case 'looked':
      Orb.pulse() // she glanced at the screen: a soft intake of breath
      break
  }
})

/* ---------- The orb = connect toggle ---------- */

els.orb.addEventListener('click', async () => {
  if (connecting) return
  Sfx.tap()
  if (connected) {
    window.aria.disconnect()
    return
  }
  try {
    await ensureAudio()
  } catch (err) {
    flashStatus(`Microphone failed: ${err.message}`)
    Sfx.err()
    return
  }
  window.aria.connect()
})

/* ---------- dock ---------- */

els.micBtn.addEventListener('click', () => {
  Sfx.tap()
  micEnabled = !micEnabled
  els.micBtn.classList.toggle('muted', !micEnabled)
  flashStatus(micEnabled ? 'Mic on' : 'Mic muted')
})

els.watchBtn.addEventListener('click', () => void openPicker())
els.settingsBtn.addEventListener('click', () => void openSettings())
els.minBtn.addEventListener('click', () => window.aria.winMin())
els.closeBtn.addEventListener('click', () => window.aria.winClose())

/* ---------- Perception target picker ---------- */

async function openPicker() {
  Sfx.tap()
  const sources = await window.aria.getSources()
  els.pickerList.innerHTML = ''
  let cardIndex = 0
  const addSection = (title, items) => {
    if (!items.length) return
    const head = document.createElement('div')
    head.className = 'picker-section'
    head.textContent = title
    els.pickerList.appendChild(head)
    const grid = document.createElement('div')
    grid.className = 'picker-grid'
    els.pickerList.appendChild(grid)
    for (const s of items) {
      const card = document.createElement('button')
      card.className = 'card' + (s.id === watchingId ? ' cur' : '')
      card.style.animationDelay = `${cardIndex++ * 45}ms` // cards fade in one after another
      const img = document.createElement('img')
      img.src = s.thumbnail
      const name = document.createElement('span')
      name.textContent = s.name
      card.append(img, name)
      card.addEventListener('click', () => {
        Sfx.tap()
        watchingId = s.id
        window.aria.setTarget({ kind: s.kind, id: s.id, name: s.name })
        els.picker.classList.add('hidden')
      })
      grid.appendChild(card)
    }
  }
  addSection('Screens', sources.filter(s => s.kind === 'screen'))
  addSection('Windows', sources.filter(s => s.kind === 'window'))
  els.picker.classList.remove('hidden')
}

els.pickerOff.addEventListener('click', () => {
  Sfx.tap()
  window.aria.setWatch(false)
  watchingName = null
  watchingId = null
  els.watchBtn.classList.remove('active')
  els.picker.classList.add('hidden')
})
els.pickerClose.addEventListener('click', () => {
  Sfx.tap()
  els.picker.classList.add('hidden')
})

/* ---------- Settings ---------- */

function selectLevel(level) {
  selectedLevel = LEVEL_HINTS[level] ? level : 'balanced'
  for (const btn of els.proactivityGrid.querySelectorAll('.level')) {
    btn.classList.toggle('sel', btn.dataset.level === selectedLevel)
  }
  els.levelHint.textContent = LEVEL_HINTS[selectedLevel]
}

els.proactivityGrid.addEventListener('click', e => {
  const btn = e.target.closest('.level')
  if (!btn) return
  Sfx.tap()
  selectLevel(btn.dataset.level)
})

async function openSettings() {
  Sfx.tap()
  const cfg = await window.aria.getConfig()
  els.cfgApiKey.value = cfg.apiKey
  selectLevel(cfg.proactivity)
  els.cfgCaptions.checked = cfg.showCaptions !== false
  els.cfgOnTop.checked = cfg.alwaysOnTop
  els.settings.classList.remove('hidden')
}

// While typing the key: glow + wind chime
els.cfgApiKey.addEventListener('input', () => {
  Sfx.key()
  els.cfgApiKey.classList.remove('pulse')
  void els.cfgApiKey.offsetWidth // restart the animation
  els.cfgApiKey.classList.add('pulse')
})

els.cfgClose.addEventListener('click', () => {
  Sfx.tap()
  els.settings.classList.add('hidden')
})

els.cfgSave.addEventListener('click', async () => {
  const cfg = await window.aria.getConfig()
  cfg.apiKey = els.cfgApiKey.value.trim()
  // Only send the level; the main process fills in the concrete cooldowns/thresholds from its presets
  cfg.proactivity = selectedLevel
  cfg.showCaptions = els.cfgCaptions.checked
  cfg.alwaysOnTop = els.cfgOnTop.checked
  await window.aria.saveConfig(cfg)
  showCaptions = cfg.showCaptions
  if (!showCaptions) {
    els.ariaLine.textContent = ''
    els.ariaLine.classList.add('faded')
  }
  els.settings.classList.add('hidden')
  flashStatus('Settings saved')
  Sfx.on()
})
