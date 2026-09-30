// Links between notes and their resolution (D-019). Each link records the
// key it looks up; the in-memory LinkIndex says which keys a batch touched,
// so `finalize` re-resolves only the links that may have changed state.
//
// Whether aliases resolve links comes from vihko.yaml (`links.aliases`,
// D-031.1). The tables record the setting they were resolved with: when it
// changes (live, or while vihko was stopped) every link is resolved again,
// without reindexing a single note.
import { LinkIndex, linkSpace, normKey, pathKeys, type Heading, type LinkRef } from '@vihko/core'
import type { Extension } from '../extension.ts'

interface LinkFacts {
  links: readonly (LinkRef & { key: string | null })[]
  aliases: readonly string[]
  headings: string[]
}

export interface LinksExtension extends Extension<LinkFacts> {
  /** Resolution keys of every indexed note. Replaced whenever the extension's tables are (re)opened. */
  readonly index: LinkIndex
  /** Whether aliases resolve links. */
  readonly aliases: boolean
  /**
   * Changes whether aliases resolve links. true if it changed: the next
   * `finalize` resolves every link again.
   */
  setAliases(on: boolean): boolean
}

interface Row { src_path: string; ord: number; kind: LinkRef['kind']; target: string; anchor: string | null }

export function linksExtension(opts: { aliases?: boolean } = {}): LinksExtension {
  let aliases = opts.aliases ?? true
  let index = new LinkIndex({ aliases })
  /** Set when every link must be resolved again at the next `finalize`. */
  let resolveAll = false
  return {
    name: 'links',
    // 2: keys with full Unicode case folding. 3: the alias setting links were resolved with.
    // 4: spaces (D-056): each key with the space its note is in, names resolved within it.
    version: 4,
    // Anchors are checked against the headings, and the index is loaded from them.
    requires: ['headings'],
    get index() { return index },
    get aliases() { return aliases },
    setAliases(on) {
      if (on === aliases) return false
      aliases = on
      index.aliases = on
      resolveAll = true
      return true
    },
    tables: {
      // Settings the links were resolved with (`aliases`: '1' or '0'), derived from vihko.yaml.
      link_settings: `create table link_settings (
        key   text primary key,
        value text not null
      )`,
      // Resolution keys: path suffixes and normalised aliases, with the root of the
      // note's space ('' for none), where a name or an alias resolves (core/resolve.ts).
      link_keys: `create table link_keys (
        key   text not null,
        path  text not null,
        kind  text not null check (kind in ('path', 'alias')),
        space text not null,
        primary key (key, path, kind)
      );
      create index link_keys_space on link_keys(space, key);`,
      links: `create table links (
        src_path   text not null,
        ord        integer not null,
        kind       text not null check (kind in ('wiki', 'embed', 'markdown')),
        raw        text not null,
        target     text not null,
        anchor     text,
        display    text,
        pos_from   integer not null,
        pos_to     integer not null,
        key        text,            -- search key; null = the note itself
        status     text not null check (status in ('resolved', 'ambiguous', 'missing')),
        dst_path   text,
        via        text,
        anchor_ok  integer,         -- null no anchor; 1 exists; 0 broken
        candidates text,            -- JSON if ambiguous
        primary key (src_path, ord)
      );
      create index links_key on links(key);
      create index links_dst on links(dst_path);`,
    },
    extract: (note, inputs) => ({
      links: note.parsed.links.map((l) => ({ ...l, key: LinkIndex.keyOf(note.path, l) })),
      aliases: note.aliases,
      headings: inputs.get<readonly Heading[]>('headings').map((h) => h.text),
    }),
    open(db) {
      index = new LinkIndex({ aliases })
      const headings = new Map<string, string[]>()
      for (const h of db.prepare('select path, text from headings order by path, ord').all() as { path: string; text: string }[]) {
        let list = headings.get(h.path)
        if (!list) headings.set(h.path, (list = []))
        list.push(h.text)
      }
      for (const n of db.prepare('select path, aliases from notes').all() as { path: string; aliases: string }[]) {
        index.set({ path: n.path, aliases: JSON.parse(n.aliases), headings: headings.get(n.path) ?? [] })
      }

      const delKeys = db.prepare('delete from link_keys where path = ?')
      const delLinks = db.prepare('delete from links where src_path = ?')
      const insKey = db.prepare('insert or ignore into link_keys (key, path, kind, space) values (?, ?, ?, ?)')
      const insLink = db.prepare(`insert into links (src_path, ord, kind, raw, target, anchor, display, pos_from, pos_to, key, status)
                                  values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'missing')`)
      const update = db.prepare('update links set status = ?, dst_path = ?, via = ?, anchor_ok = ?, candidates = ? where src_path = ? and ord = ?')
      const allLinks = db.prepare('select src_path, ord, kind, target, anchor from links')
      const putSetting = db.prepare('insert or replace into link_settings (key, value) values (?, ?)')
      const setting = () => (aliases ? '1' : '0')
      // Resolved with another setting (or never): everything again at the next finalize.
      let resolvedWith = (db.prepare("select value from link_settings where key = 'aliases'").get() as { value: string } | undefined)?.value ?? null
      if (resolvedWith !== setting()) resolveAll = true
      const statements = new Map<number, ReturnType<typeof db.prepare>[]>()
      /** The three lookups of `finalize`, for a chunk of `n` values. */
      const lookups = (n: number) => {
        let s = statements.get(n)
        if (!s) {
          const marks = Array.from({ length: n }, () => '?').join(',')
          const cols = 'select src_path, ord, kind, target, anchor from links'
          s = [`${cols} where src_path in (${marks})`, `${cols} where key in (${marks})`, `${cols} where dst_path in (${marks})`].map((q) => db.prepare(q))
          statements.set(n, s)
        }
        return s
      }
      // Keys whose set of candidate notes changed during the batch.
      const affected = new Set<string>()

      return {
        store(path, f) {
          delKeys.run(path)
          delLinks.run(path)
          const space = linkSpace(path)
          for (const k of pathKeys(path)) insKey.run(k, path, 'path', space)
          for (const a of f.aliases) insKey.run(normKey(a), path, 'alias', space)
          f.links.forEach((l, i) => insLink.run(path, i, l.kind, l.raw, l.target, l.anchor, l.display, l.from, l.to, l.key))
          for (const k of index.set({ path, aliases: [...f.aliases], headings: f.headings })) affected.add(k)
        },
        remove(path) {
          delKeys.run(path)
          delLinks.run(path)
          for (const k of index.delete(path)) affected.add(k)
        },
        // Re-resolves the links in changed notes, those that look up an affected key, and those that pointed to a changed note.
        finalize(changes) {
          const changed = [...changes.indexed, ...changes.removed]
          const keys = [...affected]
          affected.clear()
          const all = resolveAll
          resolveAll = false
          if (!all && changed.length === 0 && keys.length === 0) return
          if (resolvedWith !== setting()) putSetting.run('aliases', (resolvedWith = setting()))
          const rows: Row[] = all ? allLinks.all() as Row[] : []
          const seen = new Set<string>()
          const collect = (which: 0 | 1 | 2, values: string[]) => {
            for (let i = 0; i < values.length; i += 500) {
              const chunk = values.slice(i, i + 500)
              for (const r of lookups(chunk.length)[which]!.all(...chunk) as Row[]) {
                const id = r.src_path + '\u0000' + r.ord
                if (!seen.has(id)) { seen.add(id); rows.push(r) }
              }
            }
          }
          if (!all) {
            collect(0, changed)
            collect(1, keys)
            collect(2, changed)
          }
          for (const r of rows) {
            if (!index.has(r.src_path)) continue // source note deleted
            const res = index.resolve(r.src_path, r)
            if (res.status === 'resolved') {
              update.run('resolved', res.path, res.via, res.anchor === null ? null : res.anchor === 'ok' ? 1 : 0, null, r.src_path, r.ord)
            } else if (res.status === 'ambiguous') {
              update.run('ambiguous', null, null, null, JSON.stringify(res.candidates), r.src_path, r.ord)
            } else {
              update.run('missing', null, null, null, null, r.src_path, r.ord)
            }
          }
        },
      }
    },
  }
}
