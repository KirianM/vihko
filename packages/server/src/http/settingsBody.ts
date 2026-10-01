// Note settings as a request gives them (PUT /api/settings, app.ts).
import { NOTE_SETTINGS_VERSION, type NoteSettings } from '@vihko/core'

/**
 * The shape GET /api/settings gives, each value of its type; null
 * otherwise. What the values say is checked after (core parseNoteSettings).
 */
export function settingsFromBody(raw: unknown): NoteSettings | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const b = raw as Record<string, unknown>
  const str = (v: unknown): v is string => typeof v === 'string'
  const optional = (v: unknown): v is string | null | undefined => v === null || v === undefined || typeof v === 'string'
  if (!Array.isArray(b.daily) || !Array.isArray(b.templates) || !b.templates.every(str) || !optional(b.agents)) return null
  const daily: NoteSettings['daily'] = []
  for (const d of b.daily) {
    if (typeof d !== 'object' || d === null) return null
    const s = d as Record<string, unknown>
    if (!str(s.id) || !str(s.folder) || !optional(s.label) || !optional(s.name) || !optional(s.template)) return null
    daily.push({ id: s.id, label: s.label || null, folder: s.folder, name: s.name || '{YYYY}-{MM}-{DD}', template: s.template || null })
  }
  let attachments: NoteSettings['attachments'] = null
  if (b.attachments !== null && b.attachments !== undefined) {
    if (typeof b.attachments !== 'object') return null
    const a = b.attachments as Record<string, unknown>
    if (a.mode === 'next-to-note') attachments = { mode: 'next-to-note' }
    else if (a.mode === 'folder' && str(a.folder)) attachments = { mode: 'folder', folder: a.folder }
    else if (a.mode === 'per-note' && str(a.suffix)) attachments = { mode: 'per-note', suffix: a.suffix }
    else return null
  }
  return { version: NOTE_SETTINGS_VERSION, daily, templates: b.templates, attachments, agents: b.agents || null }
}
