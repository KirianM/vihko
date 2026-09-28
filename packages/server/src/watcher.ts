// Watcher + periodic rescan. The watcher is only a hint: the rescan is
// mandatory (network filesystems, lost events, changes made while the
// service was stopped).
import { watch, statSync, type FSWatcher } from 'node:fs'
import { join, sep } from 'node:path'
import { classifyPath } from '@vihko/core'
import type { Indexer, ScanReport } from './indexer.ts'
import type { Db } from './db.ts'

export interface WatcherOptions {
  notesDir: string
  indexer: Indexer
  db: Db
  debounceMs?: number
  /** Interval for the full rescan. */
  rescanMs?: number
  onReport?: (kind: 'events' | 'rescan', report: ScanReport) => void
  /** Paths with events, before indexing them (the hub uses them to integrate external changes). */
  onChange?: (paths: string[]) => void
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
      // The watcher was lost (unmount, inotify limit…): the rescan covers it.
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
      this.opts.onChange?.(paths)
      // An event on a directory (e.g. renaming a folder) doesn't say which notes changed.
      if (this.needScan || paths.some((p) => this.isDirectoryChange(p))) {
        this.needScan = false
        this.rescan()
        return
      }
      const report = this.opts.indexer.indexPaths(paths.filter((p) => classifyPath(p) !== 'ignored'), { detectMoves: true })
      this.opts.onReport?.('events', report)
    } catch (err) {
      this.opts.onError?.(err)
    }
  }

  private isDirectoryChange(rel: string): boolean {
    if (classifyPath(rel) !== 'other') return false
    try {
      if (statSync(join(this.opts.notesDir, rel)).isDirectory()) return true
    } catch { /* no longer exists: may be a renamed or deleted folder */ }
    return !!this.opts.db.prepare('select 1 from notes where path like ? escape \'\\\' limit 1').get(likePrefix(rel))
  }

  rescan() {
    try {
      // Careful: with onReport?.(…, scan()) the scan wouldn't run if there's no onReport.
      const report = this.opts.indexer.scan()
      this.opts.onReport?.('rescan', report)
    } catch (err) {
      this.opts.onError?.(err)
    }
  }
}

const likePrefix = (dir: string) => dir.replace(/[\\%_]/g, (c) => '\\' + c) + '/%'
