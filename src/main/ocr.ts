import { execFile } from 'child_process'
import { app } from 'electron'
import * as fs from 'fs'
import * as path from 'path'

/**
 * Verbatim screen text via the OCR engine built into Windows 10/11 (Windows.Media.Ocr),
 * reached through PowerShell — local, free, no dependencies, and it reads rendered text
 * (tweets, articles, chats) far more faithfully than any vision-model summary.
 *
 * Returns '' on any failure (non-Windows, no language pack, timeout), so callers can
 * fall back to a vision caption for text-poor scenes.
 */

/** The classic WinRT-from-PowerShell dance: project the types, await the IAsyncOperations */
function psScript(imgPath: string, outPath: string): string {
  return `
$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
  $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime]
  $null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
  $asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
  function Await($op, $type) {
    $t = $asTask.MakeGenericMethod($type).Invoke($null, @($op))
    $t.Wait() | Out-Null
    $t.Result
  }
  $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync('${imgPath}')) ([Windows.Storage.StorageFile])
  $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
  if ($null -eq $engine) { throw 'no OCR engine for profile languages' }
  $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
  $lines = @($result.Lines | ForEach-Object { $_.Text })
  [IO.File]::WriteAllLines('${outPath}', $lines, (New-Object System.Text.UTF8Encoding $false))
} catch {
  [IO.File]::WriteAllText('${outPath}', '', (New-Object System.Text.UTF8Encoding $false))
}
`
}

export function ocrImage(dataUrl: string): Promise<string> {
  return new Promise(resolve => {
    if (process.platform !== 'win32') {
      resolve('')
      return
    }
    const m = /^data:image\/\w+;base64,(.+)$/.exec(dataUrl)
    if (!m) {
      resolve('')
      return
    }
    const dir = app.getPath('temp')
    const img = path.join(dir, 'aria-ocr.jpg')
    const out = path.join(dir, 'aria-ocr.txt')
    try {
      fs.writeFileSync(img, Buffer.from(m[1], 'base64'))
      fs.rmSync(out, { force: true })
    } catch {
      resolve('')
      return
    }
    // -EncodedCommand sidesteps quoting entirely; results come back via a UTF-8 file
    // because PowerShell's stdout codepage mangles CJK
    const encoded = Buffer.from(psScript(img, out), 'utf16le').toString('base64')
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { timeout: 15_000, windowsHide: true },
      err => {
        if (err) {
          resolve('')
          return
        }
        try {
          resolve(fs.readFileSync(out, 'utf8').trim())
        } catch {
          resolve('')
        }
      }
    )
  })
}
