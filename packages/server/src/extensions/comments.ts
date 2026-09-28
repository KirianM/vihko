// The commented text as it was (D-031.6): for each comment thread, the text
// it was anchored to when the indexer first saw the thread, so the panel can
// mark «the text has changed» when someone rewrites the sentence.
//
// This is the one piece of index.db that is a memory and not a pure function
// of the files: rebuilding the index (deleting index.db, or a new version of
// this extension) forgets it, and the text at that moment becomes the new
// baseline. That loss is accepted (D-031.6): nothing of the note lives here,
// the note file is never touched, and all that is lost is a hint. For the
// same reason it is left out of `dumpIndex`, which compares rebuilds.
//
// A thread is known by its id (first comment's author, date and text, and
// occurrence; see @vihko/core/comments). Moving a note within one batch
// (vihko's own moves index the old and new path together) keeps its baselines:
// rows removed with the old path wait until the end of the batch for a note
// that has the same thread. A move seen as two batches (another tool renaming
// while vihko is off) starts over, like a rebuild.
import { parseThreads } from '@vihko/core'
import type { Extension } from '../extension.ts'

interface ThreadAnchor { thread: string; anchor: string }

export const commentAnchors: Extension<ThreadAnchor[]> = {
  name: 'comment_anchors',
  version: 1,
  tables: {
    comment_anchors: `create table comment_anchors (
      src_path  text not null,
      thread    text not null,
      original  text not null,
      orphaned  integer not null default 0
    );
    create index comment_anchors_path on comment_anchors(src_path);
    create index comment_anchors_thread on comment_anchors(thread);`,
  },
  extract(note) {
    return parseThreads(note.text).map((t) => ({ thread: t.id, anchor: note.text.slice(t.anchorFrom, t.anchorTo) }))
  },
  open(db) {
    const current = db.prepare('select thread, original from comment_anchors where src_path = ? and orphaned = 0')
    const del = db.prepare('delete from comment_anchors where src_path = ? and orphaned = 0')
    const ins = db.prepare('insert into comment_anchors (src_path, thread, original) values (?, ?, ?)')
    const orphan = db.prepare('select rowid, original from comment_anchors where orphaned = 1 and thread = ? order by rowid limit 1')
    const adopt = db.prepare('delete from comment_anchors where rowid = ?')
    const release = db.prepare('update comment_anchors set orphaned = 1 where src_path = ? and orphaned = 0')
    const forget = db.prepare('delete from comment_anchors where orphaned = 1')
    return {
      store(src, threads) {
        const known = new Map((current.all(src) as { thread: string; original: string }[]).map((r) => [r.thread, r.original]))
        del.run(src)
        for (const t of threads) {
          let original = known.get(t.thread)
          if (original === undefined) {
            const o = orphan.get(t.thread) as { rowid: number; original: string } | undefined
            if (o) { adopt.run(o.rowid); original = o.original }
          }
          ins.run(src, t.thread, original ?? t.anchor)
        }
      },
      remove: (src) => { release.run(src) },
      // What no note took in this batch is gone.
      finalize: () => { forget.run() },
    }
  },
}
