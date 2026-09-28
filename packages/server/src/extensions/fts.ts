// Full-text search over title, aliases and body (comments and frontmatter left out).
import { withoutRanges } from '@vihko/core'
import type { Extension } from '../extension.ts'

interface FtsRow { title: string; aliases: string; body: string }

export const fts: Extension<FtsRow> = {
  name: 'fts',
  version: 1,
  tables: {
    notes_fts: `create virtual table notes_fts using fts5(
      path unindexed, title, aliases, body,
      tokenize = 'unicode61 remove_diacritics 2'
    )`,
  },
  extract: (note) => ({
    title: note.title,
    aliases: note.aliases.join('\n'),
    body: withoutRanges(note.text, note.parsed.comments, note.parsed.frontmatter.bodyStart),
  }),
  open(db) {
    const del = db.prepare('delete from notes_fts where path = ?')
    const ins = db.prepare('insert into notes_fts (path, title, aliases, body) values (?, ?, ?, ?)')
    return {
      store(path, f) {
        del.run(path)
        ins.run(path, f.title, f.aliases, f.body)
      },
      remove: (path) => { del.run(path) },
    }
  },
}
