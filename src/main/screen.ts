import { desktopCapturer, screen as electronScreen, NativeImage } from 'electron'

export interface Frame {
  /** JPEG dataURL，最长边 1024px */
  dataUrl: string
  /** 与上一帧的差异度 0~1（首帧为 1） */
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

/** 截取指定屏幕/窗口并计算帧间差异；不指定目标时截主屏 */
export class ScreenWatcher {
  private prevSample: Buffer | null = null
  private capturing = false
  private target: CaptureTarget | null = null
  /** 锁定的窗口在上次捕获时已经找不到了 */
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

  /** 枚举可供 Aria "看"的屏幕和窗口（给选择器 UI 用） */
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

  /** 截一帧；上一帧还没截完时返回 null */
  async captureNow(): Promise<Frame | null> {
    if (this.capturing) return null
    this.capturing = true
    try {
      const kind = this.target?.kind ?? 'screen'
      const sources = await desktopCapturer.getSources({
        types: [kind],
        // 1536px 才认得清游戏里的小字、血条和小地图
        thumbnailSize: { width: 1536, height: 1536 }
      })
      if (!sources.length) return null

      let source = null
      if (this.target) {
        source = sources.find(s => s.id === this.target!.id) ?? null
        // 窗口重开后 id 会变，按标题再找一次
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

  /** 缩到 32x18 后算 RGB 平均绝对差，够便宜也够灵敏 */
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
