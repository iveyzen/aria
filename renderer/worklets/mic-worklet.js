/** 攒够约 100ms（2400 样本 @24kHz）的麦克风音频就发给主线程 */
class MicProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.chunks = []
    this.length = 0
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0]
    if (channel && channel.length) {
      this.chunks.push(new Float32Array(channel))
      this.length += channel.length
      if (this.length >= 2400) {
        const out = new Float32Array(this.length)
        let offset = 0
        for (const c of this.chunks) {
          out.set(c, offset)
          offset += c.length
        }
        this.port.postMessage(out, [out.buffer])
        this.chunks = []
        this.length = 0
      }
    }
    return true
  }
}

registerProcessor('mic', MicProcessor)
