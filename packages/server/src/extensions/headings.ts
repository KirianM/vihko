// Headings: the outline, and what link anchors are checked against.
import type { Heading } from '@vihko/core'
import type { Extension } from '../extension.ts'

export const headings: Extension<readonly Heading[]> = {
  name: 'headings',
  version: 1,
  tables: {
    headings: `create table headings (
      path  text not null,
      ord   integer not null,
      level integer not null,
      text  text not null,
      pos   integer not null,
      primary key (path, ord)
    )`,
  },
  extract: (note) => note.parsed.headings,
  open(db) {
    const del = db.prepare('delete from headings where path = ?')
    const ins = db.prepare('insert into headings (path, ord, level, text, pos) values (?, ?, ?, ?, ?)')
    return {
      store(path, list) {
        del.run(path)
        list.forEach((h, i) => ins.run(path, i, h.level, h.text, h.from))
      },
      remove: (path) => { del.run(path) },
    }
  },
}
