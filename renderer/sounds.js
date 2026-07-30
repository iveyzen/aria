/**
 * 全部音效由 Web Audio 现场合成，无音频文件。
 * 基调：柔和的正弦/三角波 + 指数衰减，克制、温暖。
 */
const Sfx = (() => {
  let ctx = null
  let master = null

  function ensure() {
    if (!ctx) {
      ctx = new AudioContext()
      master = ctx.createGain()
      master.gain.value = 0.22
      master.connect(ctx.destination)
    }
    if (ctx.state === 'suspended') void ctx.resume()
    return ctx
  }

  function tone({ freq = 440, to = null, dur = 0.2, type = 'sine', gain = 0.5, when = 0, attack = 0.008 }) {
    const c = ensure()
    const t0 = c.currentTime + when
    const osc = c.createOscillator()
    const g = c.createGain()
    osc.type = type
    osc.frequency.setValueAtTime(freq, t0)
    if (to) osc.frequency.exponentialRampToValueAtTime(to, t0 + dur)
    g.gain.setValueAtTime(0, t0)
    g.gain.linearRampToValueAtTime(gain, t0 + attack)
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur)
    osc.connect(g)
    g.connect(master)
    osc.start(t0)
    osc.stop(t0 + dur + 0.05)
  }

  return {
    /** 输入 API Key 时的玻璃风铃，音高带一点随机 */
    key() {
      tone({ freq: 1560 + Math.random() * 240, dur: 0.09, gain: 0.15 })
      tone({ freq: 2350 + Math.random() * 320, dur: 0.05, gain: 0.05, when: 0.012 })
    },
    /** 按钮轻触 */
    tap() {
      tone({ freq: 540, dur: 0.06, type: 'triangle', gain: 0.18 })
    },
    /** 连接成功：温暖的三音上行（G4-C5-E5） */
    on() {
      tone({ freq: 392.0, dur: 0.5, gain: 0.22 })
      tone({ freq: 523.25, dur: 0.6, gain: 0.18, when: 0.11 })
      tone({ freq: 659.25, dur: 0.85, gain: 0.14, when: 0.24 })
    },
    /** 断开：下行两音 */
    off() {
      tone({ freq: 523.25, dur: 0.4, gain: 0.18 })
      tone({ freq: 349.23, dur: 0.65, gain: 0.14, when: 0.13 })
    },
    /** 出错：低沉的软鼓点 */
    err() {
      tone({ freq: 196, to: 130, dur: 0.4, gain: 0.22 })
    }
  }
})()
