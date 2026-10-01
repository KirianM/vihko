// The sidebar's spaces: «My notes» (the person's own
// space, without its `people/<me>` prefix), one section per shared space,
// the folders shared with them they pinned, «+ New space» where they may,
// and «Shared with me», folded: the other folders others share with them
// (a pinned one is listed once, in its own section), each with its owner or
// its space. Each section is the tree of that space or
// folder, with a menu of what the person may do there.
import { useState, type ReactNode } from 'react'
import { Button, Menu, MenuItem, MenuTrigger, Popover, type Key } from 'react-aria-components'
import { atLeast, type Level, type SharedEntry, type SpacesInfo } from './api.ts'
import { FolderTree, childrenOf, type FolderInfoOf, type Node, type TreeAction } from './FolderTree.tsx'
import { useT, type MessageKey } from './i18n.tsx'
import { Icon } from './ui.tsx'

/** What a section's menu offers. */
export type SectionAction = 'newNote' | 'newFolder' | 'members' | 'access' | 'share' | 'agents' | 'settings' | 'rename' | 'leave' | 'delete' | 'pin' | 'unpin'

/** A section of the sidebar: a space, or a folder shared with the person. */
export interface Section {
  /** Its root: `people/<me>`, `spaces/<folder>`, or the shared folder. */
  root: string
  kind: 'mine' | 'shared' | 'received'
  /** Its name as the sidebar shows it. */
  name: string
  /** Beside the name: a received folder's owner or space. */
  detail: string | null
  level: Level
  /** A received folder: shown in the sidebar besides «Shared with me». */
  pinned?: boolean
}

const ACTION_LABEL: Record<SectionAction, MessageKey> = {
  newNote: 'folder.newNote',
  newFolder: 'folder.newSub',
  members: 'spaces.members',
  access: 'spaces.access',
  share: 'folder.permissions',
  agents: 'spaces.agents',
  settings: 'settings.menu',
  rename: 'spaces.rename',
  leave: 'spaces.leave',
  delete: 'spaces.delete',
  pin: 'spaces.pin',
  unpin: 'spaces.unpin',
}

/** What a section's menu offers the person, by its kind and their level there. */
export function sectionActions(s: Section): SectionAction[] {
  const out: SectionAction[] = []
  if (atLeast(s.level, 'edit')) out.push('newNote', 'newFolder')
  if (s.kind === 'mine') return [...out, 'agents', 'settings']
  if (s.kind === 'shared') {
    // Every member sees who the others are (they already see their edits and presence); only managers change it.
    out.push('members')
    if (s.level === 'manage') out.push('settings', 'rename')
    out.push('leave')
    if (s.level === 'manage') out.push('delete')
    return out
  }
  // Whoever manages it shares it further; everyone else sees who has access.
  out.push(s.level === 'manage' ? 'share' : 'access')
  out.push(s.pinned ? 'unpin' : 'pin', 'leave')
  return out
}

/**
 * The sections of the sidebar, in order: «My notes», the shared spaces by
 * name, then the pinned folders (`top`); and the folders shared with the
 * person they haven't pinned, for «Shared with me» (`received`).
 */
export function sectionsOf(info: SpacesInfo, t: ReturnType<typeof useT>): { top: Section[]; received: Section[] } {
  const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true })
  const top: Section[] = []
  if (info.personal) top.push({ root: info.personal.path, kind: 'mine', name: t('spaces.mine'), detail: null, level: 'manage' })
  for (const s of [...info.spaces].sort((a, b) => collator.compare(a.name, b.name))) top.push({ root: s.path, kind: 'shared', name: s.name, detail: null, level: s.level })
  const all = [...info.shared].sort((a, b) => collator.compare(baseName(a.path), baseName(b.path))).map((s) => receivedSection(s, t))
  for (const r of all) if (r.pinned) top.push(r)
  return { top, received: all.filter((r) => !r.pinned) }
}

const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1)

function receivedSection(s: SharedEntry, t: ReturnType<typeof useT>): Section {
  const detail = s.owner ? t('spaces.of', { owner: s.owner }) : s.space?.name ?? null
  return { root: s.path, kind: 'received', name: baseName(s.path), detail, level: s.level, pinned: s.pinned }
}

/** One section: its head (fold, name, menu) and its tree. */
function SpaceSection({ section, open, onToggle, onAction, children }: {
  section: Section
  open: boolean
  onToggle: () => void
  onAction: (a: SectionAction) => void
  children: ReactNode
}) {
  const t = useT()
  const actions = sectionActions(section)
  const title = section.detail ? `${section.name} · ${section.detail}` : section.name
  const headId = `space-${section.root}`
  return (
    <section className={`space-section space-section-${section.kind}`} aria-labelledby={headId}>
      <div className="space-head">
        <Button className="space-toggle" aria-expanded={open} onPress={onToggle}>
          <span className="space-chevron" aria-hidden="true">{Icon.chevron}</span>
          <span className="space-name" id={headId}>{section.name}</span>
          {section.detail && <span className="space-detail">{section.detail}</span>}
        </Button>
        {actions.length > 0 && (
          <MenuTrigger>
            <Button className="space-more" aria-label={t('spaces.actions', { name: title })}>{Icon.more}</Button>
            <Popover className="menu-popover" placement="bottom end">
              <Menu className="menu" onAction={(k: Key) => onAction(k as SectionAction)}>
                {actions.map((a) => (
                  <MenuItem key={a} id={a} className={a === 'delete' || a === 'leave' ? 'menu-item menu-item-danger' : 'menu-item'}>
                    {a === 'newNote' ? Icon.plus : a === 'newFolder' ? Icon.folderPlus : a === 'rename' ? Icon.rename : a === 'delete' ? Icon.trash : a === 'members' || a === 'share' || a === 'access' ? Icon.people : a === 'agents' ? Icon.eyeOff : null}
                    {t(ACTION_LABEL[a])}
                  </MenuItem>
                ))}
              </Menu>
            </Popover>
          </MenuTrigger>
        )}
      </div>
      {open && children}
    </section>
  )
}

export interface SpaceSectionsProps {
  info: SpacesInfo
  tree: Node[]
  selected: string | null
  expanded: Set<Key>
  onExpanded: (keys: Set<Key>) => void
  onOpen: (path: string) => void
  onAction: (action: TreeAction, node: Node) => void
  onDrop: (key: string, folder: string) => void
  draggable: boolean
  folderInfo: FolderInfoOf
  /** A section's menu. */
  onSection: (action: SectionAction, section: Section) => void
  /** «+ New space». */
  onNewSpace: () => void
  /** «Create your first note» in an empty «My notes». */
  onFirstNote: () => void
}

/** The sections of the sidebar. Folded ones are remembered while the page is open. */
export function SpaceSections(p: SpaceSectionsProps) {
  const t = useT()
  const { top, received } = sectionsOf(p.info, t)
  /** Sections folded (top) and received folders unfolded (in «Shared with me»). */
  const [folded, setFolded] = useState<Set<string>>(() => new Set())
  const [unfolded, setUnfolded] = useState<Set<string>>(() => new Set())
  const [sharedOpen, setSharedOpen] = useState(false)
  const flip = (set: Set<string>, key: string) => { const n = new Set(set); if (!n.delete(key)) n.add(key); return n }

  const treeOf = (s: Section) => (
    <FolderTree
      nodes={childrenOf(p.tree, s.root)}
      root={s.root}
      label={s.detail ? `${s.name} · ${s.detail}` : s.name}
      selected={p.selected}
      expanded={p.expanded}
      onExpanded={p.onExpanded}
      onOpen={p.onOpen}
      onAction={p.onAction}
      onDrop={p.onDrop}
      draggable={p.draggable}
      folderInfo={p.folderInfo}
      // Out of one's own space or a shared one, to a new space; from a shared one, to one's own too.
      spaceMoves={s.kind === 'mine' || s.kind === 'shared' ? { newSpace: p.info.canCreate, mine: s.kind === 'shared' } : undefined}
      emptyText={s.kind === 'mine' ? (
        <span className="space-empty">
          <span>{t('spaces.mineEmpty')}</span>
          <Button className="btn space-first" onPress={p.onFirstNote}>{Icon.plus}{t('spaces.firstNote')}</Button>
        </span>
      ) : t('spaces.empty')}
    />
  )

  return (
    <div className="spaces">
      {top.map((s) => (
        <SpaceSection key={`${s.kind}:${s.root}`} section={s} open={!folded.has(s.root)} onToggle={() => setFolded((f) => flip(f, s.root))} onAction={(a) => p.onSection(a, s)}>
          {treeOf(s)}
        </SpaceSection>
      ))}
      {p.info.canCreate && (
        <Button className="space-new" onPress={p.onNewSpace}>{Icon.plus}<span>{t('spaces.new')}</span></Button>
      )}
      {received.length > 0 && (
        <section className="space-shared" aria-labelledby="space-shared-head">
          <Button className="space-toggle space-shared-toggle" aria-expanded={sharedOpen} onPress={() => setSharedOpen((o) => !o)}>
            <span className="space-chevron" aria-hidden="true">{Icon.chevron}</span>
            <span className="space-name" id="space-shared-head">{t('spaces.sharedWithMe')}</span>
            <span className="space-count">{received.length}</span>
          </Button>
          {sharedOpen && received.map((s) => (
            <SpaceSection key={`received:${s.root}`} section={s} open={unfolded.has(s.root)} onToggle={() => setUnfolded((f) => flip(f, s.root))} onAction={(a) => p.onSection(a, s)}>
              {treeOf(s)}
            </SpaceSection>
          ))}
        </section>
      )}
    </div>
  )
}
