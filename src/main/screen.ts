import { desktopCapturer, screen as electronScreen, NativeImage } from 'electron'

export interface Frame {
  /** JPEG dataURL, longest side 1024px */
  dataUrl: string
  /** Difference from the previous frame, 0–1 (1 for the first frame) */
  diff: number
  capturedAt: number
}

export interface CaptureTarget {
  kind: 'screen' | 'window'
  id: string
  name: string
}

export interface SourceInfo {
  kind: 'screen' | 'window'
  id: string
  name: string
  thumbnail: string
  appIcon?: string
}

/** Capture a given screen/window and compute frame-to-frame diff; captures the primary display when no target is set */
export class ScreenWatcher {
  private prevSample: Buffer | null = null
  private capturing = false
  private target: CaptureTarget | null = null
  /** The locked window could no longer be found during the last capture */
  targetLost = false

  get currentTarget(): CaptureTarget | null {
    return this.target
  }

  setTarget(target: CaptureTarget | null): void {
    this.target = target
    this.targetLost = false
    this.reset()
  }

  reset(): void {
    this.prevSample = null
  }

  /** Enumerate the screens and windows Aria can "watch" (for the picker UI) */
  async listSources(excludeTitle: string): Promise<SourceInfo[]> {
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 320, height: 200 },
      fetchWindowIcons: true
    })
    return sources
      .filter(s => s.name !== excludeTitle)
      .map(s => ({
        kind: s.id.startsWith('screen') ? ('screen' as const) : ('window' as const),
        id: s.id,
        name: s.name,
        thumbnail: s.thumbnail.isEmpty() ? '' : s.thumbnail.toDataURL(),
        appIcon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : undefined
      }))
      .filter(s => s.thumbnail)
  }

  /** Capture one frame; returns null if the previous capture is still in flight */
  async captureNow(): Promise<Frame | null> {
    if (this.capturing) return null
    this.capturing = true
    try {
      const kind = this.target?.kind ?? 'screen'
      const sources = await desktopCapturer.getSources({
        types: [kind],
        // 1536px is needed to make out small in-game text, health bars and minimaps
        thumbnailSize: { width: 1536, height: 1536 }
      })
      if (!sources.length) return null

      let source = null
      if (this.target) {
        source = sources.find(s => s.id === this.target!.id) ?? null
        // A reopened window gets a new id; retry the lookup by title
        if (!source && kind === 'window') {
          source = sources.find(s => s.name === this.target!.name) ?? null
          if (source) this.target.id = source.id
        }
        if (!source) {
          this.targetLost = true
          return null
        }
      } else {
        const primary = electronScreen.getPrimaryDisplay()
        source = sources.find(s => s.display_id === String(primary.id)) ?? sources[0]
      }

      const image = source.thumbnail
      if (image.isEmpty()) return null
      return {
        dataUrl: `data:image/jpeg;base64,${image.toJPEG(78).toString('base64')}`,
        diff: this.diffAgainstPrev(image),
        capturedAt: Date.now()
      }
    } catch {
      return null
    } finally {
      this.capturing = false
    }
  }

  /** Downscale to 32x18 and compute mean absolute RGB diff — cheap enough, sensitive enough */
  private diffAgainstPrev(image: NativeImage): number {
    const sample = image.resize({ width: 32, height: 18 }).toBitmap()
    const prev = this.prevSample
    this.prevSample = sample
    if (!prev || prev.length !== sample.length) return 1
    let total = 0
    for (let i = 0; i < sample.length; i += 4) {
      total +=
        Math.abs(sample[i] - prev[i]) +
        Math.abs(sample[i + 1] - prev[i + 1]) +
        Math.abs(sample[i + 2] - prev[i + 2])
    }
    return total / ((sample.length / 4) * 3 * 255)
  }
}
