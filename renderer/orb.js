/**
 * Aria —— 珊瑚色微尘星云环（《Her》的视觉语言）。
 *
 * 不再用描边圆环：170 颗预渲染的柔光粒子组成一个有景深的尘环，
 * 近处颗粒小而实，远处颗粒大而虚（bokeh），整体缓慢漂流、呼吸。
 * 所有状态切换都通过参数插值过渡，没有任何硬跳变。
 *
 * 状态: disconnected | connecting | idle | listening | thinking | speaking
 *  - 说话：尘环随音量向外绽开、加速、增亮
 *  - 聆听：尘环轻轻收拢、放慢，像屏息
 *  - 思考：微微收拢加速，内核缓慢明暗（在组织语言/查资料）
 *  - 连接中：整体缓慢明暗脉动
 *  - 离线：褪成暖灰，几乎静止
 * 另有 pulse()：一次"吸气"脉动，用在她看了一眼屏幕的瞬间。
 */
const Orb = (() => {
  const SIZE = 300
  const R = 76 // 尘环基准半径
  const COUNT = 240

  let canvas = null
  let ctx = null
  let state = 'disconnected'
  let level = 0
  let smooth = 0 // 平滑音量
  let push = 0 // 说话时的向外绽开量
  let t = 0
  let lastTs = 0
  let frameDt = 0.016

  // 插值状态参数（消灭硬切换）
  let vis = 0.35 // 整体可见度
  let energy = 0.06 // 流速/活跃度
  let tighten = 0 // 聆听时的收拢
  let warm = 0 // 0=离线暖灰 1=珊瑚暖色
  let pulseE = 0 // "吸气"脉动包络

  /** 预渲染柔光粒子贴图：近似高斯衰减，无硬边 */
  function makeSprite(h, s, l) {
    const px = 64
    const c = document.createElement('canvas')
    c.width = c.height = px
    const g = c.getContext('2d')
    const grad = g.createRadialGradient(px / 2, px / 2, 0, px / 2, px / 2, px / 2)
    grad.addColorStop(0, `hsla(${h}, ${s}%, ${l}%, 1)`)
    grad.addColorStop(0.25, `hsla(${h}, ${s}%, ${l}%, 0.55)`)
    grad.addColorStop(0.55, `hsla(${h}, ${s}%, ${l}%, 0.18)`)
    grad.addColorStop(1, `hsla(${h}, ${s}%, ${l}%, 0)`)
    g.fillStyle = grad
    g.fillRect(0, 0, px, px)
    return c
  }

  // 电影同款配色：珊瑚红为主，朱红压深，桃色做高光尘
  const SPRITES = {
    coral: makeSprite(8, 78, 55),
    vermilion: makeSprite(14, 74, 43),
    peach: makeSprite(26, 92, 68),
    ash: makeSprite(28, 12, 46) // 离线暖灰：压深一点才看得清
  }

  function pickTint(r) {
    if (r < 0.55) return SPRITES.coral
    if (r < 0.85) return SPRITES.vermilion
    return SPRITES.peach
  }

  // 粒子：轨道半径呈钟形散布在 R 附近，形成有厚度的尘环
  const PARTICLES = Array.from({ length: COUNT }, () => {
    const bell = (Math.random() + Math.random() + Math.random()) / 3 // 近似高斯
    return {
      ang: Math.random() * Math.PI * 2,
      sp: (0.05 + Math.random() * 0.22) * (Math.random() < 0.12 ? -0.7 : 1),
      r0: R * (0.72 + bell * 0.52),
      z: Math.random(), // 景深：越大越虚越大颗
      tint: pickTint(Math.random()),
      ph: Math.random() * Math.PI * 2,
      oscA: 2 + Math.random() * 5, // 径向漂移幅度
      oscF: 0.25 + Math.random() * 0.5,
      twF: 0.5 + Math.random() * 1.1, // 明暗闪烁频率
      baseA: 0.5 + Math.random() * 0.5
    }
  })

  function init(el) {
    canvas = el
    ctx = canvas.getContext('2d')
    const dpr = window.devicePixelRatio || 1
    canvas.width = SIZE * dpr
    canvas.height = SIZE * dpr
    canvas.style.width = `${SIZE}px`
    canvas.style.height = `${SIZE}px`
    ctx.scale(dpr, dpr)
    requestAnimationFrame(loop)
  }

  function setState(s) {
    state = s
  }

  function setLevel(v) {
    level = v
  }

  /** 一次轻轻的"吸气"：她刚看了一眼屏幕 */
  function pulse() {
    pulseE = 1
  }

  function loop(ts) {
    const dt = lastTs ? Math.min((ts - lastTs) / 1000, 0.05) : 0.016
    lastTs = ts
    frameDt = dt
    t += dt
    smooth += (level - smooth) * Math.min(1, dt * 14)

    // 状态目标值 + 缓动插值
    const target =
      state === 'speaking'
        ? { vis: 1, energy: 0.55 + smooth * 0.8, tighten: 0, warm: 1 }
        : state === 'listening'
          ? { vis: 1, energy: 0.32, tighten: 1, warm: 1 }
          : state === 'thinking'
            ? { vis: 1, energy: 0.4, tighten: 0.4, warm: 1 }
            : state === 'connecting'
              ? { vis: 0.8, energy: 0.6, tighten: 0.2, warm: 1 }
              : state === 'idle'
                ? { vis: 1, energy: 0.15, tighten: 0, warm: 1 }
                : { vis: 0.68, energy: 0.07, tighten: 0, warm: 0 }
    const k = Math.min(1, dt * 2.6)
    vis += (target.vis - vis) * k
    energy += (target.energy - energy) * k
    tighten += (target.tighten - tighten) * k
    warm += (target.warm - warm) * k
    const pushTarget = state === 'speaking' ? smooth : 0
    push += (pushTarget - push) * Math.min(1, dt * 8)
    pulseE -= pulseE * Math.min(1, dt * 1.7) // 吸气后缓缓吐出

    draw()
    requestAnimationFrame(loop)
  }

  function draw() {
    ctx.clearRect(0, 0, SIZE, SIZE)
    ctx.save()
    ctx.translate(SIZE / 2, SIZE / 2)

    const breath = 1 + 0.022 * Math.sin(t * 0.65)
    const pulse = state === 'connecting' ? 0.72 + 0.28 * Math.sin(t * 3.6) : 1

    // 底层：中心暖光，说话时随音量涨落；思考时缓慢明暗；看屏幕的瞬间亮一下
    const thinkGlow = state === 'thinking' ? 0.04 + 0.035 * Math.sin(t * 2.3) : 0
    const coreA =
      (0.08 + push * 0.16 + energy * 0.04 + thinkGlow + pulseE * 0.12) * vis * pulse
    const core = ctx.createRadialGradient(0, 0, 4, 0, 0, R * 1.05 * breath)
    core.addColorStop(0, `hsla(16, 80%, 62%, ${coreA * warm + coreA * 0.4 * (1 - warm)})`)
    core.addColorStop(1, 'hsla(16, 80%, 62%, 0)')
    ctx.beginPath()
    ctx.arc(0, 0, R * 1.05 * breath, 0, Math.PI * 2)
    ctx.fillStyle = core
    ctx.fill()

    const contract = 1 - tighten * 0.1 - pulseE * 0.05 // 聆听/吸气时轻轻收拢

    // 尘环体量：粒子下面垫一圈柔光环带，给星云"密度"（离线时用暖灰）
    {
      const bandR = R * breath * contract
      const bandA = (0.1 + push * 0.08 + energy * 0.03) * vis * pulse
      const h = warm > 0.5 ? 10 : 30
      const s = 75 * warm + 10 * (1 - warm)
      const l = 55 * warm + 48 * (1 - warm)
      const band = ctx.createRadialGradient(0, 0, bandR * 0.55, 0, 0, bandR * 1.45)
      band.addColorStop(0, `hsla(${h}, ${s}%, ${l}%, 0)`)
      band.addColorStop(0.5, `hsla(${h}, ${s}%, ${l}%, ${bandA})`)
      band.addColorStop(1, `hsla(${h}, ${s}%, ${l}%, 0)`)
      ctx.beginPath()
      ctx.arc(0, 0, bandR * 1.45, 0, Math.PI * 2)
      ctx.fillStyle = band
      ctx.fill()
    }

    // 尘环粒子
    const speedMul = 0.35 + energy * 2.3
    for (const p of PARTICLES) {
      p.ang += p.sp * speedMul * frameDt
      const r =
        (p.r0 + Math.sin(t * p.oscF + p.ph) * p.oscA) * breath * contract +
        push * 16 * (0.3 + p.z)
      const x = Math.cos(p.ang) * r
      const y = Math.sin(p.ang) * r
      const size = (3.0 + p.z * 12) * (1 + push * 0.3)
      const tw = 0.62 + 0.38 * Math.sin(t * p.twF + p.ph)
      const a =
        p.baseA * (0.92 - p.z * 0.42) * vis * tw * (0.8 + energy * 0.5) * pulse
      if (a < 0.01) continue
      // 暖色与离线灰交叉淡入淡出
      if (warm > 0.02) {
        ctx.globalAlpha = a * warm
        ctx.drawImage(p.tint, x - size / 2, y - size / 2, size, size)
      }
      if (warm < 0.98) {
        ctx.globalAlpha = a * (1 - warm)
        ctx.drawImage(SPRITES.ash, x - size / 2, y - size / 2, size, size)
      }
    }
    ctx.globalAlpha = 1

    // 一根几乎看不见的基准圆，让形体有"锚"
    ctx.beginPath()
    ctx.arc(0, 0, R * breath * contract, 0, Math.PI * 2)
    ctx.strokeStyle = `hsla(14, 60%, 50%, ${0.05 * vis * warm})`
    ctx.lineWidth = 1
    ctx.stroke()

    ctx.restore()
  }

  return { init, setState, setLevel, pulse }
})()
