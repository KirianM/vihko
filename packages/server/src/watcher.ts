// Watcher + rescan periódico. El watcher es solo una pista: el rescan es
// obligatorio (sistemas de archivos de red, eventos perdidos, cambios con el
// servicio parado).
import { watch, statSync, type FSWatcher } from 'node:fs'
import { join, sep } from 'node:path'
import { classifyPath } from '@thoth/core'
import type { Indexer, ScanReport } from './indexer.ts'
import type { Db } from './db.ts'

export interface WatcherOptions {
  notesDir: string
  indexer: Indexer
  db: Db
  debounceMs?: number
  /** Intervalo del rescan completo. */
  rescanMs?: number
  onReport?: (kind: 'events' | 'rescan', report: ScanReport) => void
  onError?: (err: unknown) => void
}

export class Watcher {
  private fsw: FSWatcher | null = null
  private pending = new Set<string>()
  private timer: NodeJS.Timeout | null = null
  private rescanTimer: NodeJS.Timeout | null = null
  private needScan = false
  private opts: WatcherOptions

  constructor(opts: WatcherOptions) {
    this.opts = opts
  }

  start() {
    this.fsw = watch(this.opts.notesDir, { recursive: true }, (_ev, filename) => {
      if (!filename) { this.needScan = true } else this.pending.add(filename.split(sep).join('/'))
      this.schedule()
    })
    this.fsw.on('error', (err) => {
      // Se perdió el watcher (desmontaje, límite de inotify…): el rescan lo cubre.
      this.opts.onError?.(err)
      this.needScan = true
      this.schedule()
    })
    this.rescanTimer = setInterval(() => this.rescan(), this.opts.rescanMs ?? 60_000)
  }

  stop() {
    this.fsw?.close()
    if (this.timer) clearTimeout(this.timer)
    if (this.rescanTimer) clearInterval(this.rescanTimer)
    this.fsw = this.timer = this.rescanTimer = null
  }

  private schedule() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => this.flush(), this.opts.debounceMs ?? 150)
  }

  private flush() {
    this.timer = null
    const paths = [...this.pending]
    this.pending.clear()
    try {
      // Un evento sobre un directorio (p. ej. renombrar una carpeta) no dice qué notas cambiaron.
      if (this.needScan || paths.some((p) => this.isDirectoryChange(p))) {
        this.needScan = false
        this.rescan()
        return
      }
      const report = this.opts.indexer.indexPaths(paths.filter((p) => classifyPath(p) !== 'ignored'))
      this.opts.onReport?.('events', report)
    } catch (err) {
      this.opts.onError?.(err)
    }
  }

  private isDirectoryChange(rel: string): boolean {
    if (classifyPath(rel) !== 'other') return false
    try {
      if (statSync(join(this.opts.notesDir, rel)).isDirectory()) return true
    } catch { /* ya no existe: puede ser una carpeta renombrada o borrada */ }
    return !!this.opts.db.prepare('select 1 from notes where path like ? escape \'\\\' limit 1').get(likePrefix(rel))
  }

  rescan() {
    try {
      // Ojo: con onReport?.(…, scan()) el escaneo no se ejecutaría si no hay onReport.
      const report = this.opts.indexer.scan()
      this.opts.onReport?.('rescan', report)
    } catch (err) {
      this.opts.onError?.(err)
    }
  }
}

const likePrefix = (dir: string) => dir.replace(/[\\%_]/g, (c) => '\\' + c) + '/%'
