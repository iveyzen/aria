import { app, BrowserWindow } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { evalDir } from './scenarios'

/**
 * 给评测集生成"看得见的"素材：把一组 HTML 拟真界面离屏渲染成 PNG。
 *
 *   npm run eval:mockups
 *
 * 为什么不直接截用户的真屏幕：那是 ta 的私人桌面。这里生成的图不涉及隐私，
 * 又能让评测真正走到"看图"这条路上，而不是只喂一句文字描述。
 * 拿到真实游戏截图后，用 eval:capture 覆盖同名文件即可，场景不用改。
 */

const W = 1536
const H = 864

const BASE = `
  *{margin:0;padding:0;box-sizing:border-box}
  body{width:${W}px;height:${H}px;overflow:hidden;font-family:'Segoe UI',system-ui,sans-serif;color:#fff}
  .fill{width:100%;height:100%;position:relative}
  .center{display:flex;align-items:center;justify-content:center;flex-direction:column}
`

/** 一个昏暗的 boss 场景背景，好几张图共用 */
const arena = `
  background:
    radial-gradient(60% 50% at 50% 60%, #4a3a2e 0%, #1a1512 70%, #0b0908 100%);
`

const MOCKUPS: Record<string, string> = {
  'wipe-frustration': `
    <div class="fill center" style="${arena}">
      <div style="font-size:104px;letter-spacing:.22em;color:#c9a227;text-shadow:0 0 40px #000;
                  font-family:Georgia,serif">YOU DIED</div>
      <div style="position:absolute;bottom:64px;width:62%;">
        <div style="font-size:19px;letter-spacing:.14em;margin-bottom:8px;opacity:.85">MARGIT, THE FELL OMEN</div>
        <div style="height:14px;background:#2a1f1a;border:1px solid #6b5a44">
          <div style="width:71%;height:100%;background:linear-gradient(#b8342c,#7d1f19)"></div>
        </div>
      </div>
    </div>`,

  'asks-for-help': `
    <div class="fill" style="${arena}">
      <div style="position:absolute;top:40px;left:48px;width:300px">
        <div style="height:16px;background:#241a16;border:1px solid #5a4a38">
          <div style="width:12%;height:100%;background:linear-gradient(#c0392b,#7d1f19)"></div>
        </div>
        <div style="height:10px;margin-top:6px;background:#241a16;border:1px solid #5a4a38">
          <div style="width:34%;height:100%;background:linear-gradient(#2e86c1,#1b4f72)"></div>
        </div>
      </div>
      <div style="position:absolute;left:50%;top:46%;transform:translate(-50%,-50%);
                  width:280px;height:340px;background:rgba(20,14,10,.55);border-radius:50% 50% 45% 45%;
                  box-shadow:0 0 90px 30px rgba(0,0,0,.7)"></div>
      <div style="position:absolute;bottom:56px;width:100%;text-align:center">
        <div style="font-size:18px;letter-spacing:.14em;opacity:.85;margin-bottom:8px">MARGIT, THE FELL OMEN</div>
        <div style="margin:0 auto;width:60%;height:14px;background:#2a1f1a;border:1px solid #6b5a44">
          <div style="width:64%;height:100%;background:linear-gradient(#b8342c,#7d1f19)"></div>
        </div>
      </div>
    </div>`,

  'talking-to-the-game': `
    <div class="fill" style="background:linear-gradient(#2b3540,#171d24)">
      <div style="position:absolute;top:26px;left:50%;transform:translateX(-50%);text-align:center">
        <div style="font-size:15px;letter-spacing:.2em;color:#ffcf6b">FINAL ROUND</div>
        <div style="font-size:44px;font-weight:600;margin-top:4px">12 : 12</div>
      </div>
      <div style="position:absolute;bottom:40px;left:48px">
        <div style="font-size:13px;opacity:.7;letter-spacing:.1em">HEALTH</div>
        <div style="font-size:60px;font-weight:700;color:#e74c3c;line-height:1">14</div>
        <div style="width:280px;height:10px;background:#20262d;margin-top:8px">
          <div style="width:14%;height:100%;background:#e74c3c"></div>
        </div>
      </div>
      <div style="position:absolute;bottom:40px;right:48px;text-align:right">
        <div style="font-size:15px;opacity:.75">SPIKE PLANTED</div>
        <div style="font-size:40px;font-weight:700;color:#ffcf6b">0:07</div>
      </div>
    </div>`,

  'fishing-for-praise': `
    <div class="fill" style="background:linear-gradient(#3a4450,#1b2129)">
      <div style="position:absolute;top:30px;right:40px;text-align:right;font-size:17px">
        <div style="background:rgba(0,0,0,.45);padding:7px 13px;margin-bottom:6px">
          <b style="color:#7fd4ff">you</b> ⌁ Viper</div>
        <div style="background:rgba(0,0,0,.45);padding:7px 13px;margin-bottom:6px">
          <b style="color:#7fd4ff">you</b> ⌁ Jett</div>
        <div style="background:rgba(0,0,0,.45);padding:7px 13px">
          <b style="color:#7fd4ff">you</b> ⌁ Sova</div>
      </div>
      <div style="position:absolute;top:44%;left:50%;transform:translate(-50%,-50%);
                  font-size:66px;font-weight:800;color:#ffcf6b;letter-spacing:.05em;
                  text-shadow:0 0 30px rgba(255,207,107,.5)">TRIPLE KILL</div>
    </div>`,

  'memory-callback': `
    <div class="fill" style="background:radial-gradient(70% 70% at 30% 40%,#2a3550,#10141f)">
      <div style="position:absolute;left:90px;top:180px">
        <div style="font-size:52px;font-weight:300;letter-spacing:.18em;opacity:.9">OVERWATCH</div>
        <div style="margin-top:56px;font-size:22px;line-height:2.4;opacity:.8">
          <div>PLAY</div><div>HERO GALLERY</div><div>CAREER PROFILE</div><div>OPTIONS</div>
        </div>
      </div>
    </div>`,

  'needs-a-lookup': `
    <div class="fill" style="background:linear-gradient(#1c1813,#0d0b09)">
      <div style="position:absolute;inset:52px;border:1px solid #5a4a38;background:rgba(12,10,8,.7)">
        <div style="padding:20px 28px;border-bottom:1px solid #3d332a;font-size:20px;
                    letter-spacing:.2em;color:#c9a227;font-family:Georgia,serif">INVENTORY</div>
        <div style="display:flex">
          <div style="width:44%;padding:22px 28px;font-size:19px;line-height:2.3;opacity:.88">
            <div style="color:#c9a227">▸ Longbow</div>
            <div>Shortbow</div><div>Composite Bow</div><div>Serpent Bow</div>
            <div>Black Bow</div><div>Erdtree Bow</div>
          </div>
          <div style="flex:1;padding:22px 28px;border-left:1px solid #3d332a;font-family:Georgia,serif">
            <div style="font-size:26px;color:#c9a227;margin-bottom:14px">Longbow</div>
            <div style="font-size:17px;line-height:2;opacity:.8">
              Attack &nbsp; Phy 68 &nbsp; Crit 100<br/>
              Scaling &nbsp; Str D &nbsp; Dex C<br/>
              Weight 4.0 &nbsp;·&nbsp; Req Str 9 / Dex 14
            </div>
          </div>
        </div>
      </div>
    </div>`,

  'quiet-focus-interrupt': `
    <div class="fill" style="background:#fff;color:#222">
      <div style="height:34px;background:#217346"></div>
      <div style="display:grid;grid-template-columns:repeat(7,1fr);font-size:15px">
        ${Array.from({ length: 7 * 22 }, (_, i) => {
          const head = i < 7
          const v = head
            ? ['Region', 'Q1', 'Q2', 'Q3', 'Q4', 'Total', 'Δ%'][i]
            : i % 7 === 0
              ? `Region ${Math.floor(i / 7)}`
              : i % 7 === 6
                ? `${((i * 37) % 40) - 12}%`
                : `${((i * 811) % 9000) + 400}`
          return `<div style="border:1px solid #e2e2e2;padding:6px 9px;${head ? 'background:#f2f2f2;font-weight:600' : ''}">${v}</div>`
        }).join('')}
      </div>
    </div>`,

  'boss-entrance': `
    <div class="fill" style="${arena}">
      <div style="position:absolute;left:50%;top:40%;transform:translate(-50%,-50%);
                  width:420px;height:420px;background:radial-gradient(circle,#6b3a2a,#180f0b 70%);
                  border-radius:50%;filter:blur(2px)"></div>
      <div style="position:absolute;bottom:52px;width:100%;text-align:center">
        <div style="font-size:26px;letter-spacing:.2em;font-family:Georgia,serif;color:#e8d9b0;
                    text-shadow:0 0 24px #000;margin-bottom:12px">STARSCOURGE RADAHN</div>
        <div style="margin:0 auto;width:72%;height:18px;background:#2a1f1a;border:1px solid #8a7454">
          <div style="width:100%;height:100%;background:linear-gradient(#d24b3f,#7d1f19)"></div>
        </div>
      </div>
    </div>`,

  'sudden-team-wipe': `
    <div class="fill" style="background:linear-gradient(#232a33,#12161b)">
      <div style="position:absolute;top:34px;left:50%;transform:translateX(-50%);display:flex;gap:14px">
        ${Array.from({ length: 5 }, (_, i) => `
          <div style="width:112px;height:132px;background:#2c333c;filter:grayscale(1);opacity:.45;
                      border-bottom:4px solid #555;display:flex;align-items:flex-end;justify-content:center;
                      font-size:15px;padding-bottom:8px">P${i + 1}</div>`).join('')}
      </div>
      <div style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);text-align:center">
        <div style="font-size:30px;letter-spacing:.2em;opacity:.75">RESPAWNING IN</div>
        <div style="font-size:110px;font-weight:800;color:#e74c3c;line-height:1.1">9</div>
      </div>
    </div>`,

  'look-at-my-character': `
    <div class="fill" style="background:linear-gradient(#242a33,#15181d)">
      <div style="position:absolute;left:60px;top:44px;font-size:22px;letter-spacing:.2em;opacity:.8">
        CHARACTER CREATION</div>
      <div style="position:absolute;left:50%;top:52%;transform:translate(-50%,-50%);text-align:center">
        <div style="width:210px;height:250px;background:#c8a887;border-radius:48% 48% 42% 42%;
                    margin:0 auto;position:relative">
          <div style="position:absolute;top:78px;left:28px;width:52px;height:20px;background:#fff;border-radius:50%"></div>
          <div style="position:absolute;top:78px;right:28px;width:52px;height:20px;background:#fff;border-radius:50%"></div>
          <div style="position:absolute;bottom:34px;left:50%;transform:translateX(-50%);
                      width:120px;height:44px;background:#7a3b3b;border-radius:0 0 60px 60px"></div>
        </div>
        <div style="width:66px;height:150px;background:#c8a887;margin:-8px auto 0"></div>
      </div>
      <div style="position:absolute;right:60px;top:120px;width:330px;font-size:16px;opacity:.85">
        ${['Head Size', 'Jaw Width', 'Eye Spacing', 'Brow Height', 'Nose Length', 'Neck Girth']
          .map((n, i) => `
          <div style="margin-bottom:22px">
            <div style="display:flex;justify-content:space-between"><span>${n}</span><span>${[100, 100, 98, 3, 100, 97][i]}</span></div>
            <div style="height:6px;background:#333b45;margin-top:7px">
              <div style="width:${[100, 100, 98, 3, 100, 97][i]}%;height:100%;background:#7fd4ff"></div></div>
          </div>`).join('')}
      </div>
    </div>`,

  'look-at-error': `
    <div class="fill" style="background:#0a0a0a">
      <div style="position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);
                  width:640px;background:#f0f0f0;color:#111;box-shadow:0 20px 60px rgba(0,0,0,.8);
                  font-size:17px">
        <div style="background:#e1e1e1;padding:12px 18px;font-weight:600;display:flex;justify-content:space-between">
          <span>Application Error</span><span style="opacity:.6">✕</span></div>
        <div style="padding:30px 26px;line-height:1.8">
          <b>DXGI_ERROR_DEVICE_REMOVED</b><br/>
          The graphics device has been lost. The application will now close.<br/>
          <span style="opacity:.6;font-size:15px">Error code: 0x887A0005</span>
        </div>
        <div style="padding:0 26px 24px;text-align:right">
          <span style="border:1px solid #999;background:#fafafa;padding:8px 30px">OK</span></div>
      </div>
    </div>`,

  'idle-in-lobby': `
    <div class="fill" style="background:linear-gradient(120deg,#2b3a4a,#141a21)">
      <div style="position:absolute;top:40px;left:50%;transform:translateX(-50%);
                  font-size:24px;letter-spacing:.24em;opacity:.75">LOBBY · WAITING FOR PLAYERS</div>
      <div style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);display:flex;gap:22px">
        ${Array.from({ length: 5 }, (_, i) => `
          <div style="width:150px;height:196px;background:${i === 0 ? '#33506b' : 'rgba(255,255,255,.05)'};
                      border:1px solid rgba(255,255,255,.14);display:flex;align-items:center;
                      justify-content:center;font-size:15px;opacity:${i === 0 ? 1 : 0.5}">
            ${i === 0 ? 'YOU' : 'empty'}</div>`).join('')}
      </div>
      <div style="position:absolute;bottom:60px;left:50%;transform:translateX(-50%);
                  border:1px solid #7fd4ff;color:#7fd4ff;padding:14px 60px;font-size:20px;
                  letter-spacing:.2em">START</div>
    </div>`,

  'deep-in-work': `
    <div class="fill" style="background:#1e1e1e;font-family:Consolas,monospace;font-size:15px">
      <div style="height:34px;background:#252526;display:flex;align-items:center;padding:0 16px;
                  font-size:13px;color:#bbb">server.ts — aria — Debugging</div>
      <div style="display:flex;height:calc(100% - 34px)">
        <div style="width:62%;padding:14px 18px;line-height:1.75;color:#d4d4d4">
          <div style="color:#569cd6">async function <span style="color:#dcdcaa">handleFrame</span>(buf: Buffer) {</div>
          <div style="background:#4a3f1d;margin:0 -18px;padding:0 18px">
            &nbsp;&nbsp;<span style="color:#c586c0">const</span> parsed = <span style="color:#dcdcaa">decode</span>(buf)</div>
          <div>&nbsp;&nbsp;<span style="color:#c586c0">if</span> (!parsed.header) <span style="color:#c586c0">throw new</span> Error(<span style="color:#ce9178">'bad frame'</span>)</div>
          <div>&nbsp;&nbsp;<span style="color:#c586c0">return</span> parsed.payload</div>
          <div>}</div>
        </div>
        <div style="flex:1;background:#181818;border-left:1px solid #333;padding:14px 16px;
                    color:#f48771;line-height:1.8;font-size:14px">
          <div style="color:#ccc;margin-bottom:10px">DEBUG CONSOLE</div>
          <div>TypeError: Cannot read properties of undefined</div>
          <div>&nbsp;&nbsp;at decode (codec.ts:88:19)</div>
          <div>&nbsp;&nbsp;at handleFrame (server.ts:42:18)</div>
          <div>&nbsp;&nbsp;at Socket.&lt;anonymous&gt; (server.ts:117:7)</div>
          <div style="color:#9cdcfe;margin-top:14px">⏸ paused on breakpoint</div>
        </div>
      </div>
    </div>`,

  'idle-with-memory': `
    <div class="fill" style="background:#1b2838;font-size:16px">
      <div style="height:56px;background:#171a21;display:flex;align-items:center;padding:0 26px;
                  letter-spacing:.16em;color:#c7d5e0">STEAM &nbsp;·&nbsp; LIBRARY</div>
      <div style="display:flex;height:calc(100% - 56px)">
        <div style="width:280px;background:#16202d;padding:18px 22px;line-height:2.5;color:#8f98a0">
          ${['Hollow Knight', 'Elden Ring', 'Hades', 'Celeste', 'Stardew Valley', 'Valorant']
            .map((g, i) => `<div style="${i === 0 ? 'color:#fff' : ''}">${g}</div>`).join('')}
        </div>
        <div style="flex:1;padding:34px 40px">
          <div style="height:300px;background:linear-gradient(140deg,#31465e,#0f1a26);
                      display:flex;align-items:flex-end;padding:26px;font-size:40px;font-weight:300;
                      letter-spacing:.06em">Hollow Knight</div>
          <div style="margin-top:24px;color:#8f98a0">Last played 7 months ago &nbsp;·&nbsp; 31.4 hrs on record</div>
        </div>
      </div>
    </div>`,

  'afk-screensaver': `
    <div class="fill" style="background:linear-gradient(160deg,#0e1a2b,#050a12)">
      <div style="position:absolute;inset:0;background:
        radial-gradient(40% 30% at 22% 20%, rgba(90,130,180,.20), transparent 70%)"></div>
    </div>`
}

/**
 * 全程复用同一个离屏窗口：每张图新建再销毁会让下一次 loadFile 直接 ERR_FAILED。
 */
async function shoot(
  win: BrowserWindow,
  name: string,
  html: string,
  dir: string,
  tmp: string
): Promise<void> {
  // 走临时文件而不是 data: URL——这些页面太长，loadURL 会直接拒掉
  const page = path.join(tmp, `${name}.html`)
  fs.writeFileSync(page, `<!doctype html><meta charset="utf-8"><style>${BASE}</style>${html}`, 'utf8')
  await win.loadFile(page)
  // 等一帧渲染完，不然拿到空白图
  await new Promise(r => setTimeout(r, 400))
  const img = await win.webContents.capturePage()
  fs.writeFileSync(path.join(dir, `${name}.png`), img.toPNG())
  console.log(`  ${name}.png`)
}

app.whenReady().then(async () => {
  const dir = path.join(evalDir(), 'screens')
  const tmp = path.join(app.getPath('temp'), 'aria-mockups')
  fs.mkdirSync(dir, { recursive: true })
  fs.mkdirSync(tmp, { recursive: true })
  console.log(`Rendering ${Object.keys(MOCKUPS).length} mockups → ${dir}`)
  const win = new BrowserWindow({
    width: W,
    height: H,
    show: false,
    webPreferences: { offscreen: true }
  })
  for (const [name, html] of Object.entries(MOCKUPS)) {
    await shoot(win, name, html, dir, tmp)
  }
  win.destroy()
  fs.rmSync(tmp, { recursive: true, force: true })
  console.log('Done. Replace any of these with real captures via: npm run eval:capture -- <name>')
  app.quit()
}).catch(err => {
  console.error(err)
  app.exit(1)
})
