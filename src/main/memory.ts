import { app } from 'electron'
import * as fs from 'fs'
import * as path from 'path'

/**
 * Aria's long-term memory: one dated fact per line, plain text file.
 * The most recent entries are injected into the instructions at session
 * start so she "remembers you".
 */

function memoryPath(): string {
  return path.join(app.getPath('userData'), 'aria-memory.md')
}

export function loadMemory(maxLines = 40): string {
  try {
    const lines = fs
      .readFileSync(memoryPath(), 'utf8')
      .split('\n')
      .filter(l => l.trim())
    return lines.slice(-maxLines).join('\n')
  } catch {
    return ''
  }
}

export function appendMemory(fact: string): void {
  const clean = fact.replace(/\s+/g, ' ').trim()
  if (!clean) return
  const d = new Date()
  const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  fs.appendFileSync(memoryPath(), `- [${stamp}] ${clean}\n`, 'utf8')
}
