// References to image files in the notes folder, to know which notes use
// each image (an image moves with a note only if no other note uses it).
// `path` is where the reference points, from the notes root, whether the file
// exists or not; external URLs are not recorded.
import { resolveImageRef, type ImageLink } from '@vihko/core'
import type { Extension } from '../extension.ts'

interface ImageRow { ord: number; kind: ImageLink['kind']; raw: string; path: string }

export const images: Extension<ImageRow[]> = {
  name: 'images',
  // 2: a leading `/` is the root of the note's space, not of the notes folder.
  version: 2,
  tables: {
    images: `create table images (
      src_path  text not null,
      ord       integer not null,
      kind      text not null check (kind in ('image', 'embed', 'markdown', 'wiki')),
      raw       text not null,
      path      text not null,
      primary key (src_path, ord)
    );
    create index images_path on images(path);`,
  },
  extract(note) {
    const rows: ImageRow[] = []
    note.parsed.images.forEach((img, ord) => {
      const path = resolveImageRef(note.path, img.dest, { embed: img.kind === 'embed' || img.kind === 'wiki' })
      if (path !== null) rows.push({ ord, kind: img.kind, raw: img.raw, path })
    })
    return rows
  },
  open(db) {
    const del = db.prepare('delete from images where src_path = ?')
    const ins = db.prepare('insert into images (src_path, ord, kind, raw, path) values (?, ?, ?, ?, ?)')
    return {
      store(src, rows) {
        del.run(src)
        for (const r of rows) ins.run(src, r.ord, r.kind, r.raw, r.path)
      },
      remove: (src) => { del.run(src) },
    }
  },
}
