/**
 * Aria — a coral dust-nebula ring (the visual language of "Her").
 *
 * No stroked circle anymore: pre-rendered soft-glow particles form a dust
 * ring with depth of field — near grains are small and sharp, far ones are
 * large and blurry (bokeh) — and the whole thing slowly drifts and breathes.
 * Every state change transitions via parameter interpolation; there are no
 * hard jumps.
 *
 * States: disconnected | connecting | idle | listening | thinking | speaking
 *  - speaking: the ring blooms outward with volume, speeds up, brightens
 *  - listening: the ring gently tightens and slows, like holding a breath
 *  - thinking: slight tighten + speed-up, core slowly dims and glows (composing / looking things up)
 *  - connecting: the whole ring slowly pulses light and dark
 *  - offline: fades to warm gray, almost still
 * Also pulse(): a single "inhale" pulse, used the moment she glances at the screen.
 */
const Orb = (() => {
  const SIZE = 300
  const R = 76 // base radius of the dust ring
  const COUNT = 240

  let canvas = null
  let ctx = null
  let state = 'disconnected'
  let level = 0
  let smooth = 0 // smoothed volume
  let push = 0 // outward bloom while speaking
  let t = 0
  let lastTs = 0
  let frameDt = 0.016

  // Interpolated state parameters (no hard switches)
  let vis = 0.35 // overall visibility
  let energy = 0.06 // flow speed / liveliness
  let tighten = 0 // tightening while listening
  let warm = 0 // 0 = offline warm gray, 1 = warm coral
  let pulseE = 0 // "inhale" pulse envelope

  /** Pre-rendered soft-glow particle sprite: approximate Gaussian falloff, no hard edges */
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

  // Movie-matched palette: coral as the base, vermilion for depth, peach for highlight dust
  const SPRITES = {
    coral: makeSprite(8, 78, 55),
    vermilion: makeSprite(14, 74, 43),
    peach: makeSprite(26, 92, 68),
    ash: makeSprite(28, 12, 46) // offline warm gray: darkened a bit so it stays visible
  }

  function pickTint(r) {
    if (r < 0.55) return SPRITES.coral
    if (r < 0.85) return SPRITES.vermilion
    return SPRITES.peach
  }

  // Particles: orbit radii bell-curve around R, forming a dust ring with thickness
  const PARTICLES = Array.from({ length: COUNT }, () => {
    const bell = (Math.random() + Math.random() + Math.random()) / 3 // approximate Gaussian
    return {
      ang: Math.random() * Math.PI * 2,
      sp: (0.05 + Math.random() * 0.22) * (Math.random() < 0.12 ? -0.7 : 1),
      r0: R * (0.72 + bell * 0.52),
      z: Math.random(), // depth of field: the larger, the blurrier and bigger the grain
      tint: pickTint(Math.random()),
      ph: Math.random() * Math.PI * 2,
      oscA: 2 + Math.random() * 5, // radial drift amplitude
      oscF: 0.25 + Math.random() * 0.5,
      twF: 0.5 + Math.random() * 1.1, // twinkle frequency
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

  /** One gentle "inhale": she just glanced at the screen */
  function pulse() {
    pulseE = 1
  }

  function loop(ts) {
    const dt = lastTs ? Math.min((ts - lastTs) / 1000, 0.05) : 0.016
    lastTs = ts
    frameDt = dt
    t += dt
    smooth += (level - smooth) * Math.min(1, dt * 14)

    // Per-state targets + eased interpolation
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
    pulseE -= pulseE * Math.min(1, dt * 1.7) // slowly exhale after the inhale

    draw()
    requestAnimationFrame(loop)
  }

  function draw() {
    ctx.clearRect(0, 0, SIZE, SIZE)
    ctx.save()
    ctx.translate(SIZE / 2, SIZE / 2)

    const breath = 1 + 0.022 * Math.sin(t * 0.65)
    const pulse = state === 'connecting' ? 0.72 + 0.28 * Math.sin(t * 3.6) : 1

    // Base layer: central warm glow — swells with volume while speaking, slowly dims and glows while thinking, flares the moment she looks at the screen
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

    const contract = 1 - tighten * 0.1 - pulseE * 0.05 // gently tighten while listening / inhaling

    // Ring body: a soft glow band under the particles gives the nebula "density" (warm gray when offline)
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

    // Dust-ring particles
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
      // Cross-fade between warm color and offline gray
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

    // A nearly invisible reference circle to anchor the shape
    ctx.beginPath()
    ctx.arc(0, 0, R * breath * contract, 0, Math.PI * 2)
    ctx.strokeStyle = `hsla(14, 60%, 50%, ${0.05 * vis * warm})`
    ctx.lineWidth = 1
    ctx.stroke()

    ctx.restore()
  }

  return { init, setState, setLevel, pulse }
})()
