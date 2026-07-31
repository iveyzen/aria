/** Streaming playback queue: plays incoming Float32 chunks in order; goes silent immediately on clear (for barge-in) */
class PlayerProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.queue = []
    this.offset = 0
    this.blocksSincePost = 0
    this.port.onmessage = e => {
      const msg = e.data
      if (msg.type === 'chunk') this.queue.push(msg.data)
      else if (msg.type === 'clear') {
        this.queue = []
        this.offset = 0
      }
    }
  }

  process(_inputs, outputs) {
    const out = outputs[0][0]
    let written = 0
    let energy = 0
    while (written < out.length && this.queue.length) {
      const head = this.queue[0]
      const n = Math.min(out.length - written, head.length - this.offset)
      out.set(head.subarray(this.offset, this.offset + n), written)
      written += n
      this.offset += n
      if (this.offset >= head.length) {
        this.queue.shift()
        this.offset = 0
      }
    }
    for (let i = 0; i < written; i++) energy += out[i] * out[i]

    // Report volume every ~10 blocks (~27ms x 10) to drive Aria's mouth animation
    this.blocksSincePost++
    if (this.blocksSincePost >= 10) {
      this.blocksSincePost = 0
      this.port.postMessage({
        type: 'level',
        level: written ? Math.sqrt(energy / written) : 0,
        playing: written > 0
      })
    }
    return true
  }
}

registerProcessor('player', PlayerProcessor)
