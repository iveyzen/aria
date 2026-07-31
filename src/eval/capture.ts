import { app, desktopCapturer, screen as electronScreen } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { evalDir } from './scenarios'

/**
 * 给评测集拍素材用的小工具，跑在 Electron 里（截屏要 desktopCapturer）。
 *
 *   npm run eval:capture -- boss-entrance --delay 5
 *   npm run eval:capture -- my-shot --match "Elden Ring"
 *   npm run eval:capture -- --list
 *
 * 存成 eval/screens/<name>.png，再在场景 JSON 里写 "screen": "screens/<name>.png"，
 * 那一条就从"文字描述"升级成真正的看图测试。
 */

function argv(): string[] {
  // electron dist/eval/capture.js foo --delay 5 → 去掉前两个
  return process.argv.slice(2)
}

function flag(name: string): string | undefined {
  const a = argv()
  const i = a.indexOf(`--${name}`)
  return i >= 0 ? a[i + 1] : undefined
}

async function main(): Promise<void> {
  const args = argv()
  const listOnly = args.includes('--list')
  const name = args.find(a => !a.startsWith('--') && args[args.indexOf(a) - 1]?.startsWith('--') !== true)

  const delaySec = Number(flag('delay') ?? 0)
  if (delaySec > 0) {
    console.log(`Capturing in ${delaySec}s — go set up the shot…`)
    for (let i = delaySec; i > 0; i--) {
      console.log(`  ${i}`)
      await new Promise(r => setTimeout(r, 1000))
    }
  }

  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 1536, height: 1536 }
  })

  if (listOnly) {
    console.log('Available sources:\n')
    sources.forEach((s, i) => console.log(`  [${i}] ${s.id.startsWith('screen') ? 'screen' : 'window'} — ${s.name}`))
    app.quit()
    return
  }

  if (!name) {
    console.error('Usage: npm run eval:capture -- <name> [--match "Window Title"] [--delay 5] [--list]')
    app.exit(1)
    return
  }

  const match = flag('match')
  let source = null
  if (match) {
    source = sources.find(s => s.name.toLowerCase().includes(match.toLowerCase())) ?? null
    if (!source) {
      console.error(`No source matching "${match}". Run with --list to see what's available.`)
      app.exit(1)
      return
    }
  } else {
    const primary = electronScreen.getPrimaryDisplay()
    source =
      sources.find(s => s.display_id === String(primary.id)) ??
      sources.find(s => s.id.startsWith('screen')) ??
      sources[0]
  }

  if (!source || source.thumbnail.isEmpty()) {
    console.error('Captured an empty frame. If this is a game, use borderless windowed mode.')
    app.exit(1)
    return
  }

  const dir = path.join(evalDir(), 'screens')
  fs.mkdirSync(dir, { recursive: true })
  const out = path.join(dir, `${name.replace(/[^\w.-]/g, '_')}.png`)
  fs.writeFileSync(out, source.thumbnail.toPNG())

  console.log(`Captured "${source.name}" → ${out}`)
  console.log(`Now add  "screen": "screens/${path.basename(out)}"  to that scenario.`)
  app.quit()
}

app.whenReady().then(main).catch(err => {
  console.error(err)
  app.exit(1)
})
