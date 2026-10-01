// What a rename or a move does, in a person's words (the rename and folder
// dialogs): which links are updated and where, the images that go with it,
// the links it leaves broken when it goes to another space (a link never
// leads to another space). Never
// raw Markdown nor a path as it is on disk: notes and places by the names
// people see (spaces.tsx), as «In My notes / Home, the link to Trip will be
// broken (it now lives in Family)».
import type { BrokenLink, MoveReport } from './api.ts'
import { useT } from './i18n.tsx'
import { usePathLabels } from './spaces.tsx'
import { Icon, noteName } from './ui.tsx'
import { spaceRootOf } from '@vihko/core/spaces'

/** A file's name, without the folders (an image keeps its extension). */
const fileName = (path: string) => path.slice(path.lastIndexOf('/') + 1)

/**
 * The name a link shows in the editor: a wikilink's visible text, or the
 * last part of what it names (without `#heading`); a Markdown link's text.
 * `[[trips/Rome#Day 1|the trip]]` → `the trip`; `[[trips/Rome]]` → `Rome`.
 */
export function shownName(raw: string): string {
  const md = /^!?\[([^\]]*)\]\(/.exec(raw)
  if (md && !raw.startsWith('[[') && !raw.startsWith('![[')) return md[1]!.trim() || raw
  const inner = raw.replace(/^!?\[\[/, '').replace(/\]\]$/, '')
  const bar = inner.search(/\\?\|/)
  if (bar !== -1) {
    const text = inner.slice(inner[bar] === '\\' ? bar + 2 : bar + 1).trim()
    if (text) return text
  }
  const target = (bar === -1 ? inner : inner.slice(0, bar)).replace(/#.*$/, '').replace(/\.md$/i, '').trim()
  return target.slice(target.lastIndexOf('/') + 1) || target
}

/**
 * The rewrites, one line per note and what its links lead to: «In My notes /
 * Home, the link to Trip is updated so it keeps working», «…, 3 links to
 * Trip are updated…».
 */
export function RelinkRows({ relinked }: { relinked: MoveReport['relinked'] }) {
  const t = useT()
  const { label } = usePathLabels()
  const rows: { path: string; kind: 'link' | 'image'; to: string; n: number }[] = []
  for (const r of relinked) {
    for (const c of r.changes) {
      const row = rows.find((x) => x.path === r.path && x.kind === c.kind && x.to === c.to)
      if (row) row.n++
      else rows.push({ path: r.path, kind: c.kind, to: c.to, n: 1 })
    }
  }
  const key = (row: (typeof rows)[number]) => row.kind === 'image'
    ? (row.n === 1 ? 'preview.imageUpdated' : 'preview.imageUpdatedMany')
    : (row.n === 1 ? 'preview.linkUpdated' : 'preview.linkUpdatedMany')
  return (
    <>
      {rows.map((row) => (
        <p className="preview-line" key={`${row.path}\u0000${row.kind}\u0000${row.to}`}>
          {t(key(row), { where: label(row.path), name: row.kind === 'image' ? fileName(row.to) : noteName(row.to), n: row.n })}
        </p>
      ))}
    </>
  )
}

/** What happens to a note's images, in words. */
export function ImageRows({ images }: { images: MoveReport['images'] }) {
  const t = useT()
  const { label, where } = usePathLabels()
  return (
    <>
      {images.copied?.map((img) => (
        <p className="preview-line" key={`c:${img.from}`}>{t('preview.imageCopied', { name: fileName(img.from), where: where(img.to, true) })}</p>
      ))}
      {images.moved.map((img) => (
        <p className="preview-line" key={`m:${img.from}`}>{t('preview.imageMoves', { name: fileName(img.from), where: where(img.to, true) })}</p>
      ))}
      {images.folder && (
        <p className="preview-line">{t(images.folder.files === 1 ? 'preview.folderMovesOne' : 'preview.folderMoves', { n: images.folder.files, where: label(images.folder.to) })}</p>
      )}
      {images.failed.map((f) => (
        <p className="preview-line preview-kept" key={`f:${f.path}`}>
          {t(f.error === 'not_empty' ? 'preview.folderHasNotes' : 'preview.imageTaken', { name: fileName(f.path), where: where(f.path, true) })}
        </p>
      ))}
      {images.stayed.map((img) => (
        <p className="preview-line preview-kept" key={`s:${img.path}`}>
          {t(img.reason === 'shared' ? 'preview.imageShared' : 'preview.imageElsewhere', { name: fileName(img.path), where: where(img.path, true) })}
        </p>
      ))}
    </>
  )
}

/** Links to the note that keep working untouched. */
export function KeptRows({ kept, to }: { kept: MoveReport['kept']; to: string }) {
  const t = useT()
  const { label } = usePathLabels()
  return (
    <>
      {kept.map((k, i) => (
        <p className="preview-line preview-kept" key={`k:${k.path}#${i}`}>
          {t(k.via === 'alias' ? 'preview.keptAlias' : 'preview.keptPath', { where: label(k.path), name: noteName(to) })}
        </p>
      ))}
    </>
  )
}

/**
 * The links a move to another space leaves broken, each in
 * words: where the link is, the note it led to, and the space that note is
 * in now. `dest`: where what moves goes (a note or a folder), to tell a
 * note that moved from one that stays.
 */
export function BrokenRows({ broken, dest }: { broken: BrokenLink[]; dest: string }) {
  const t = useT()
  const { label, space } = usePathLabels()
  if (broken.length === 0) return null
  const there = spaceRootOf(dest)
  return (
    <div className="preview-broken" role="group" aria-label={t(broken.length === 1 ? 'preview.brokenTitleOne' : 'preview.brokenTitle', { n: broken.length })}>
      <p className="audience-row preview-broken-head">
        <span className="shifts-icon">{Icon.alert}</span>
        <span>
          <strong>{t(broken.length === 1 ? 'preview.brokenTitleOne' : 'preview.brokenTitle', { n: broken.length })}</strong>
          <span className="audience-hint">{t('preview.brokenHint')}</span>
        </span>
      </p>
      <ul className="preview-broken-list">
        {broken.map((b) => (
          <li key={`${b.path}\u0000${b.to}`}>
            {t(spaceRootOf(b.to) === there ? 'preview.brokenMoved' : 'preview.brokenStays', { where: label(b.path), name: noteName(b.to), space: space(b.to) })}
          </li>
        ))}
      </ul>
    </div>
  )
}
