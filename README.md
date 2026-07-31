# Aria — a desktop companion who watches your screen and talks to you

Aria is a Windows desktop companion AI: a girl in her early twenties who plays games and watches too
much anime. She talks to you in real time through OpenAI's **gpt-realtime-2.1** (Realtime API, voice
+ image in → voice out), and periodically *looks* at your screen, so she knows what you're playing
and what you're doing.

## Features

- 🎙 **Real-time voice** — server-side semantic VAD handles turn-taking; interrupt her any time
- 👀 **Screen awareness** — frame-diff detection, so screenshots are only sent when the picture
  actually changes (saves tokens); the moment you start speaking she grabs a fresh one
- 💬 **She starts conversations** — she doesn't wait to be spoken to. She reacts when something
  happens on screen, and when it's been quiet a while she brings something up herself. The only
  time she stays quiet is when you're visibly deep in focused work
- 🧠 **Two-tier memory** — a short-term queue holds everything that just happened: conversation,
  tool use, and screens transcribed verbatim by a nano vision model (Windows OCR as the keyless
  fallback), so names and numbers survive. What falls off the end gets distilled, and only the
  facts worth keeping — what you go by, what you play, recurring things — graduate into a
  long-term store that grows slowly. Reconnects and restarts pick up mid-thought
- 🧹 **Context trimming** — only the last few screenshots stay in the session; older ones are deleted
- 🎛 **Three controls, nothing else** — mute, pick a screen, settings. That's the whole interface
- 📝 Live subtitles and a particle orb that moves with her voice

## Requirements

- Windows 10/11 — screen capture and audio must run on Windows natively, **not inside WSL**
- Node.js 20+ (`winget install OpenJS.NodeJS.LTS`)
- An OpenAI API key with Realtime API access

## Running on Windows

If this repo lives in WSL, copy it to the Windows side first (no need to copy `node_modules`):

```powershell
robocopy \\wsl.localhost\Debian\home\zengp\code\aria C:\aria /E /XD node_modules dist .git
cd C:\aria
npm install
npm start
```

If `npm install` prints a warning about install scripts not being approved, Electron's binary hasn't
been downloaded yet. Fix it with either:

```powershell
npm approve-scripts --allow-scripts-pending
# or, directly:
cd node_modules\electron && node install.js
```

Once it's up, open settings and paste your API key (or set `OPENAI_API_KEY`), then click the orb to
connect. Settings holds the key and one choice: how much she talks — Quiet, Balanced or Chatty.
Screenshot interval and her voice live in the config file if you ever need them.

## Tips

- **Play in borderless windowed mode.** Exclusive fullscreen can't be captured by the Windows
  desktop capturer.
- Use headphones. Echo cancellation is on, but loud speakers can still make her interrupt herself.
- Cost (gpt-realtime-2.1): audio in $32/1M, audio out $64/1M, image in $5/1M tokens. Screenshot
  frequency is kept low by default, but watch your usage on long sessions.
- Config file: `%APPDATA%/aria/aria-config.json`

## Making her sound more human

There's a tuning harness in [`eval/`](eval/README.md). It replays scripted situations — a screenshot
plus what you say — against the real persona, has a second model grade each reply on whether a
*person* would have said it, and reports what still sounds like a bot.

```bash
npm run eval -- --repeat 3
```

Read `eval/runs/latest.md`, edit `src/main/persona.ts`, re-run, compare. See
[`eval/README.md`](eval/README.md) for the full loop.

## Layout

```
src/main/        main process (TypeScript)
  main.ts        window + IPC + screenshot scheduling + idle initiative
  realtime.ts    gpt-realtime-2.1 WebSocket client
  screen.ts      desktopCapturer + frame-diff detection
  persona.ts     Aria's persona and prompts  ← tune her here
  stm.ts         short-term memory: event queue + screen captions
  memory.ts      long-term memory: fact store + distiller
  llm.ts         cheap Chat Completions client for the memory pipeline
  copilot.ts     --copilot live tuning tap (see eval/README.md)
  config.ts      config read/write
  websearch.ts   keyless web search
src/preload.ts   contextBridge API
src/eval/        the tuning harness (see eval/README.md)
renderer/        renderer process (vanilla JS, no build step)
  renderer.js    UI + microphone/playback audio pipeline
  orb.js         the particle orb
  worklets/      AudioWorklets (capture / streaming playback)
eval/            scenarios, screenshots and reports
```

## Roadmap

Agreed with external review (2026-07-31), in order — correctness before cleverness:

- [ ] **Response protocol model**: every self-created response tracked by id + metadata end to
  end; true barge-in via `conversation.item.truncate` at the ms the user actually heard (today
  only the local playback buffer is cleared, so her context keeps speech that was never heard)
- [x] **STM envelope + privacy classes**: events carry speaker/sourceApp/privacy/confidence/
  contentHash; screen memory becomes latestScreenState per window + local line-diff events
  (no model-side delta transcription); four privacy tiers — sensitive pages get no proactive,
  no persistence, frames retro-deleted; capacity by character budget, not event count; LTM
  deletions hold via tombstones (forget_fact / correct_fact / never_remember_topic)
- [ ] **Session replay eval**: the recorded copilot JSONLs become timeline test assets —
  deterministic metrics (initiations/hour, semantic repetition, pre-search narration, truncate
  residue), 2-4 min episode judges, whole-session pairwise A/B; headline metric: "first moment
  you wanted to mute her"
- [ ] **Single-hop initiative experiment**: out-of-band audio candidate (buffer, read transcript
  head, PASS → cancel by id, else release audio; spoken transcript inserted back as assistant
  item) replacing the two-hop judge → speakJudged chain
- [ ] **Memory-driven callbacks**: LTM facts gain status/openLoop/lastReferencedAt; she brings
  up yesterday's unfinished business herself
- [ ] **Adaptive pacing, later**: instrument every initiative (activity class, reply latency,
  interruptions) now; learn only within the user-chosen preset once enough sessions exist
- [ ] Live2D / VRM avatar mode (transparent always-on-top window)
