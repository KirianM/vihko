// Tags, inline and from the frontmatter.
import type { TagRef } from '@vihko/core'
import type { Extension } from '../extension.ts'

export const tags: Extension<readonly TagRef[]> = {
  name: 'tags',
  // 2: tags with full Unicode case folding.
  version: 2,
  tables: {
    tags: `create table tags (
      path   text not null,
      tag    text not null,
      source text not null check (source in ('inline', 'frontmatter')),
      primary key (path, tag, source)
    );
    create index tags_tag on tags(tag);`,
  },
  extract: (note) => note.parsed.tags,
  open(db) {
    const del = db.prepare('delete from tags where path = ?')
    const ins = db.prepare('insert or ignore into tags (path, tag, source) values (?, ?, ?)')
    return {
      store(path, list) {
        del.run(path)
        for (const t of list) ins.run(path, t.name, t.source)
      },
      remove: (path) => { del.run(path) },
    }
  },
}
