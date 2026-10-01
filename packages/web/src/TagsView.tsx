// Tags in the sidebar: every tag with how many notes carry it (nested ones
// included), nested tags (`hogar/red`) as a tree under their parent. Picking one lists its notes
// (the same `tag:` filter as the search: the tag and those nested under it).
import { useEffect, useMemo, useState } from 'react'
import { Button, Collection, ListBox, ListBoxItem, Tree, TreeItem, TreeItemContent, type Key } from 'react-aria-components'
import { api, type SearchResult, type TagCount } from './api.ts'
import { errorText, useT } from './i18n.tsx'
import { Icon } from './ui.tsx'
import { usePathLabels } from './spaces.tsx'

/** `total` is null for a parent nobody writes on its own (`hogar` when only `hogar/red` exists). */
interface TagNode { id: string; name: string; tag: string; total: number | null; children: TagNode[] }

/** `hogar`, `hogar/red`… → a tree by `/`, alphabetical; missing parents are added as plain groups. */
export function buildTagTree(tags: TagCount[]): TagNode[] {
  const root: TagNode[] = []
  const byTag = new Map<string, TagNode>()
  const node = (tag: string): TagNode => {
    let n = byTag.get(tag)
    if (n) return n
    const i = tag.lastIndexOf('/')
    n = { id: tag, name: tag.slice(i + 1), tag, total: null, children: [] }
    byTag.set(tag, n)
    ;(i === -1 ? root : node(tag.slice(0, i)).children).push(n)
    return n
  }
  for (const t of tags) node(t.tag).total = t.total
  const sort = (list: TagNode[]) => { list.sort((a, b) => a.name.localeCompare(b.name)); for (const n of list) sort(n.children) }
  sort(root)
  return root
}

const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/i, '')

export function TagsView({ selected, onSelect, openPath, onOpen, refresh }: {
  /** The tag whose notes are listed, or null for the list of tags. */
  selected: string | null
  onSelect: (tag: string | null) => void
  openPath: string | null
  onOpen: (path: string) => void
  /** Changes when the notes may have changed (the tree was reloaded): the counts are asked again. */
  refresh: unknown
}) {
  const t = useT()
  const labels = usePathLabels()
  const [tags, setTags] = useState<TagCount[] | null>(null)
  const [notes, setNotes] = useState<{ tag: string; results: SearchResult[] } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<Key>>(new Set())

  useEffect(() => {
    let live = true
    api.tags().then((r) => { if (live) setTags(r) }).catch((e) => { if (live) setError(errorText(t, e)) })
    return () => { live = false }
  }, [refresh, t])

  useEffect(() => {
    if (!selected) return setNotes(null)
    let live = true
    api.search(`tag:"${selected}"`).then((r) => { if (live) setNotes({ tag: selected, results: r.results }) }).catch((e) => { if (live) setError(errorText(t, e)) })
    return () => { live = false }
  }, [selected, refresh, t])

  const tree = useMemo(() => buildTagTree(tags ?? []), [tags])

  if (error) return <p className="error-text tags-error" role="alert">{error}</p>

  if (selected) {
    const list = notes?.tag === selected ? notes.results : null
    return (
      <div className="tag-notes">
        <div className="tag-notes-head">
          <Button className="btn btn-icon btn-quiet" aria-label={t('tags.back')} onPress={() => onSelect(null)}>{Icon.prev}</Button>
          <span className="tag-notes-title">#{selected}</span>
          {list && <span className="tag-count">{list.length}</span>}
        </div>
        {list === null
          ? <div className="empty">{t('common.loading')}</div>
          : (
            <ListBox
              className="tag-note-list"
              aria-label={t('tags.notesOf', { tag: selected })}
              items={list}
              selectionMode="single"
              selectedKeys={openPath ? [openPath] : []}
              onAction={(k) => onOpen(String(k))}
              // With the open note selected, a press on another is a selection change.
              onSelectionChange={(keys) => { if (keys !== 'all') { const [k] = keys; if (k !== undefined) onOpen(String(k)) } }}
              renderEmptyState={() => <div className="empty">{t('tags.noNotes')}</div>}
            >
              {(r) => (
                <ListBoxItem id={r.path} textValue={r.title || baseName(r.path)} className="tree-item tag-note">
                  <span className="tag-note-title">{r.title || baseName(r.path)}</span>
                  <span className="tag-note-path">{labels.where(r.path, true)}</span>
                </ListBoxItem>
              )}
            </ListBox>
          )}
      </div>
    )
  }

  if (tags === null) return <div className="empty">{t('common.loading')}</div>
  return (
    <Tree
      className="tree"
      aria-label={t('tags.label')}
      items={tree}
      expandedKeys={expanded}
      onExpandedChange={setExpanded}
      onAction={(k) => onSelect(String(k))}
      renderEmptyState={() => <div className="empty">{t('tags.empty')}</div>}
    >
      {function render(node: TagNode) {
        return (
          <TreeItem id={node.id} textValue={node.name} className="tree-item">
            <TreeItemContent>
              {({ level, hasChildItems }) => (
                <div className="tree-row" style={{ paddingLeft: 8 + (level - 1) * 18 }}>
                  {hasChildItems
                    ? <Button slot="chevron" className="tree-chevron">{Icon.chevron}</Button>
                    : <span className="tree-chevron-space" />}
                  <span className="tree-label"><span className="tag-hash">#</span>{node.name}</span>
                  {node.total !== null && <span className="tag-count" aria-label={t(node.total === 1 ? 'tags.countOne' : 'tags.count', { n: node.total })}>{node.total}</span>}
                </div>
              )}
            </TreeItemContent>
            <Collection items={node.children}>{render}</Collection>
          </TreeItem>
        )
      }}
    </Tree>
  )
}
