/** Accumulate ~100ms of mic audio (2400 samples @24kHz) before posting it to the main thread */
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
