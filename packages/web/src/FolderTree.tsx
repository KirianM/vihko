// Folder tree: notes and folders (empty ones too), a context menu on every
// row (right click, long press on a phone, the ⋯ button or the context-menu
// key) and, with a pointer, drag and drop of notes and folders onto folders.
// Each row offers only what the person may do there, folders with
// permissions of their own or closed to agents carry a lock, and a folder
// shown only as the way to something shared is muted, with no actions.
import { useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'
import { Button, Collection, Menu, MenuItem, MenuTrigger, Popover, Tree, TreeItem, TreeItemContent, useDragAndDrop, type Key } from 'react-aria-components'
import { atLeast, type Level, type TreeNote } from './api.ts'
import { useT } from './i18n.tsx'
import { LockBadges } from './Permissions.tsx'
import { Icon } from './ui.tsx'

/** A row of the tree: a folder (`children`) or a note (`children` null; `template`, it is one). */
export interface Node { id: string; name: string; path: string; children: Node[] | null; template?: boolean }

/** Converts the flat lists of notes and folders into a tree: folders first, then notes, alphabetically. */
export function buildTree(notes: TreeNote[], folderPaths: string[] = []): Node[] {
  const root: Node = { id: 'd:', name: '', path: '', children: [] }
  const folders = new Map<string, Node>([['', root]])
  const folder = (path: string): Node => {
    let f = folders.get(path)
    if (f) return f
    const i = path.lastIndexOf('/')
    const parent = folder(i === -1 ? '' : path.slice(0, i))
    f = { id: `d:${path}`, name: path.slice(i + 1), path, children: [] }
    parent.children!.push(f)
    folders.set(path, f)
    return f
  }
  for (const p of folderPaths) folder(p)
  for (const n of notes) {
    const i = n.path.lastIndexOf('/')
    const parent = folder(i === -1 ? '' : n.path.slice(0, i))
    parent.children!.push({ id: `n:${n.path}`, name: n.path.slice(i + 1).replace(/\.md$/i, ''), path: n.path, children: null, ...(n.template ? { template: true } : {}) })
  }
  const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true })
  const sort = (list: Node[]) => {
    list.sort((a, b) => (a.children === null) === (b.children === null) ? collator.compare(a.name, b.name) : a.children === null ? 1 : -1)
    for (const x of list) if (x.children) sort(x.children)
  }
  sort(root.children!)
  return root.children!
}

/** What is inside `folder` in a tree of `buildTree` (a space's root: its folders and notes); empty if it isn't there. */
export function childrenOf(tree: Node[], folder: string): Node[] {
  let list = tree
  let at = ''
  for (const seg of folder.split('/')) {
    at = at ? `${at}/${seg}` : seg
    const next = list.find((n) => n.children !== null && n.path === at)
    if (!next) return []
    list = next.children!
  }
  return list
}

/** Folder keys above a path, so it shows in the tree. */
export const ancestors = (path: string) => path.split('/').slice(0, -1).map((_, i, a) => `d:${a.slice(0, i + 1).join('/')}`)

export const parentOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '')

export type TreeAction = 'newNote' | 'newFolder' | 'moveFolder' | 'toNewSpace' | 'toMine' | 'deleteFolder' | 'permissions' | 'markTemplates' | 'moveNote' | 'makeTemplate' | 'stopTemplate' | 'trashNote'

/**
 * Where a folder of this tree's space may move out to: a new
 * space of its own (`newSpace`, if the person may create spaces) and, from
 * a shared space, their own (`mine`).
 */
export interface SpaceMoves { newSpace: boolean; mine: boolean }

/**
 * What the person may do in a folder, and its marks. `level` null: no access
 * of their own (a folder shown only as the way, or one the admin only names).
 */
export interface FolderInfo { level: Level | null; canEdit: boolean; own: boolean; ai: boolean; pathOnly: boolean }
/** Without it (not loaded yet), the tree offers everything and the server answers. */
export type FolderInfoOf = (path: string) => FolderInfo | undefined

const noInfo: FolderInfoOf = () => undefined

/** The menu's actions a row offers: those the person's level allows. */
function rowActions(node: Node, info: FolderInfoOf, moves: SpaceMoves | undefined): TreeAction[] {
  if (node.children !== null) {
    const f = info(node.path)
    if (!f) return ['newNote', 'newFolder', 'markTemplates', 'moveFolder', 'deleteFolder']
    const out: TreeAction[] = []
    if (atLeast(f.level, 'edit')) out.push('newNote', 'newFolder', 'markTemplates')
    if (f.canEdit) out.push('permissions')
    if (f.level === 'manage') {
      out.push('moveFolder')
      if (moves?.newSpace) out.push('toNewSpace')
      if (moves?.mine) out.push('toMine')
      out.push('deleteFolder')
    }
    return out
  }
  const f = info(parentOf(node.path))
  return !f || atLeast(f.level, 'edit') ? ['moveNote', node.template ? 'stopTemplate' : 'makeTemplate', 'trashNote'] : []
}

/** The node with this key (`n:path` or `d:path`), anywhere in the tree. */
function find(list: Node[], key: string): Node | null {
  for (const n of list) {
    if (n.id === key) return n
    if (n.children) { const f = find(n.children, key); if (f) return f }
  }
  return null
}

/** What is dragged: a tree key (`n:path` or `d:path`), never a file from outside. */
const DRAG_TYPE = 'application/x-vihko-tree-key'
const LONG_PRESS_MS = 500

/** The folder a drop lands in: on a folder, into it; on or next to a note, into that note's folder. */
function dropFolder(target: { type: 'root' } | { type: 'item'; key: Key; dropPosition: 'on' | 'before' | 'after' }, root: string): string {
  if (target.type === 'root') return root
  const key = String(target.key)
  const path = key.slice(2)
  return target.dropPosition === 'on' && key.startsWith('d:') ? path : parentOf(path)
}

/** Whether moving `key` into `folder` changes anything and is possible (a folder never goes into itself). */
function canDrop(key: string, folder: string): boolean {
  const path = key.slice(2)
  if (parentOf(path) === folder) return false
  return !(key.startsWith('d:') && (folder === path || folder.startsWith(path + '/')))
}

function RowMenu({ node, actions, open, onOpenChange, onAction }: { node: Node; actions: TreeAction[]; open: boolean; onOpenChange: (open: boolean) => void; onAction: (a: TreeAction) => void }) {
  const t = useT()
  const folder = node.children !== null
  const has = (a: TreeAction) => actions.includes(a)
  return (
    <MenuTrigger isOpen={open} onOpenChange={onOpenChange}>
      <Button className="tree-more" aria-label={t(folder ? 'folder.actions' : 'note.actions', { name: node.name })}>{Icon.more}</Button>
      <Popover className="menu-popover" placement="bottom end">
        <Menu className="menu" onAction={(k) => onAction(k as TreeAction)}>
          {folder ? (
            <>
              {has('newNote') && <MenuItem id="newNote" className="menu-item">{Icon.plus}{t('folder.newNote')}</MenuItem>}
              {has('newFolder') && <MenuItem id="newFolder" className="menu-item">{Icon.folderPlus}{t('folder.newSub')}</MenuItem>}
              {has('markTemplates') && <MenuItem id="markTemplates" className="menu-item">{Icon.template}{t('folder.markTemplates')}</MenuItem>}
              {has('permissions') && <MenuItem id="permissions" className="menu-item">{Icon.people}{t('folder.permissions')}</MenuItem>}
              {has('moveFolder') && <MenuItem id="moveFolder" className="menu-item">{Icon.rename}{t('folder.renameMenu')}</MenuItem>}
              {has('toNewSpace') && <MenuItem id="toNewSpace" className="menu-item">{Icon.people}{t('folder.toNewSpace')}</MenuItem>}
              {has('toMine') && <MenuItem id="toMine" className="menu-item">{Icon.rename}{t('folder.toMine')}</MenuItem>}
              {has('deleteFolder') && <MenuItem id="deleteFolder" className="menu-item menu-item-danger">{Icon.trash}{t('folder.delete')}</MenuItem>}
            </>
          ) : (
            <>
              {has('moveNote') && <MenuItem id="moveNote" className="menu-item">{Icon.rename}{t('note.rename')}</MenuItem>}
              {has('makeTemplate') && <MenuItem id="makeTemplate" className="menu-item">{Icon.template}{t('note.makeTemplate')}</MenuItem>}
              {has('stopTemplate') && <MenuItem id="stopTemplate" className="menu-item">{Icon.template}{t('note.stopTemplate')}</MenuItem>}
              {has('trashNote') && <MenuItem id="trashNote" className="menu-item menu-item-danger">{Icon.trash}{t('note.trash')}</MenuItem>}
            </>
          )}
        </Menu>
      </Popover>
    </MenuTrigger>
  )
}

export function FolderTree({ nodes, root = '', label, selected, expanded, onExpanded, onOpen, onAction, onDrop, draggable, emptyText, folderInfo = noInfo, spaceMoves }: {
  nodes: Node[]
  /** The folder the tree shows the inside of (a space's root): what's dropped on its empty space goes there. */
  root?: string
  /** The tree's accessible name (the space's). */
  label?: string
  selected: string | null
  expanded: Set<Key>
  onExpanded: (keys: Set<Key>) => void
  onOpen: (path: string) => void
  /** A context-menu action on a row. */
  onAction: (action: TreeAction, node: Node) => void
  /** A note (`n:path`) or folder (`d:path`) dropped into `folder` ('' = the root). */
  onDrop: (key: string, folder: string) => void
  /** Drag and drop with a pointer (off on a phone: a long press opens the menu there). */
  draggable: boolean
  emptyText: ReactNode
  /** The person's level and the marks of each folder (`/api/permissions/folders` and the tree's `pathOnly`). */
  folderInfo?: FolderInfoOf
  /** Where its folders may move out to (none by default). */
  spaceMoves?: SpaceMoves
}) {
  const t = useT()
  const [menu, setMenu] = useState<string | null>(null)
  const dragged = useRef<string | null>(null)
  const longPress = useRef<{ timer: ReturnType<typeof setTimeout>; x: number; y: number } | null>(null)
  /** The press that ends a long press must not also open the note. */
  const swallow = useRef(false)

  const { dragAndDropHooks } = useDragAndDrop<Node>({
    isDisabled: !draggable,
    getItems: (keys) => [...keys].map((k) => ({ [DRAG_TYPE]: String(k), 'text/plain': String(k).slice(2) })),
    onDragStart: (e) => { dragged.current = String([...e.keys][0] ?? '') },
    onDragEnd: () => { dragged.current = null },
    acceptedDragTypes: [DRAG_TYPE],
    // Only "on" a row: the tree is sorted, so a line between rows would promise a place it can't keep.
    getDropOperation: (target, types) => {
      if (!types.has(DRAG_TYPE) || !dragged.current) return 'cancel'
      if (target.type === 'item' && target.dropPosition !== 'on') return 'cancel'
      // Only into a folder where the person edits (the server answers the rest: moving a folder needs `manage` in it).
      const into = folderInfo(dropFolder(target, root))
      if (into && !atLeast(into.level, 'edit')) return 'cancel'
      return canDrop(dragged.current, dropFolder(target, root)) ? 'move' : 'cancel'
    },
    onDrop: async (e) => {
      const item = e.items.find((i) => i.kind === 'text' && i.types.has(DRAG_TYPE))
      if (!item || item.kind !== 'text') return
      const key = await item.getText(DRAG_TYPE)
      const folder = dropFolder(e.target, root)
      if (canDrop(key, folder)) onDrop(key, folder)
    },
  })

  /** A press on a row: a note opens; a folder opens or closes (on a phone the chevron alone is too small a target). */
  const activate = (key: Key) => {
    if (swallow.current) { swallow.current = false; return }
    const k = String(key)
    if (k.startsWith('n:')) return onOpen(k.slice(2))
    const next = new Set(expanded)
    if (!next.delete(key)) next.add(key)
    onExpanded(next)
  }

  const cancelLongPress = () => { if (longPress.current) clearTimeout(longPress.current.timer); longPress.current = null }
  const rowHandlers = (node: Node, menuable: boolean) => ({
    onContextMenu: (e: { preventDefault(): void }) => { e.preventDefault(); cancelLongPress(); if (menuable) setMenu(node.id) },
    onPointerDown: (e: PointerEvent) => {
      if (e.pointerType !== 'touch' || !menuable) return
      cancelLongPress()
      longPress.current = { x: e.clientX, y: e.clientY, timer: setTimeout(() => { longPress.current = null; swallow.current = true; setMenu(node.id) }, LONG_PRESS_MS) }
    },
    onPointerMove: (e: PointerEvent) => {
      const lp = longPress.current
      if (lp && Math.hypot(e.clientX - lp.x, e.clientY - lp.y) > 8) cancelLongPress()
    },
    onPointerUp: cancelLongPress,
    onPointerCancel: cancelLongPress,
  })
  // The context-menu key and Shift+F10 open the focused row's menu.
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'ContextMenu' && !(e.shiftKey && e.key === 'F10')) return
    const row = (e.target as HTMLElement).closest<HTMLElement>('[data-key]')
    if (!row) return
    e.preventDefault()
    const node = find(nodes, row.dataset.key!)
    if (node && rowActions(node, folderInfo, spaceMoves).length) setMenu(node.id)
  }

  return (
    <div onKeyDown={onKeyDown} className="tree-wrap">
      <Tree
        className="tree"
        aria-label={label ?? t('shell.folders')}
        items={nodes}
        // Rows are cached per item: the open menu lives outside them.
        dependencies={[menu, folderInfo, nodes]}
        selectionMode="single"
        selectedKeys={selected ? [`n:${selected}`] : []}
        expandedKeys={expanded}
        onExpandedChange={onExpanded}
        dragAndDropHooks={dragAndDropHooks}
        onAction={activate}
        // With a row selected (the open note), React Aria turns a press on another
        // row into a selection change instead of an action: both mean the same here.
        onSelectionChange={(keys) => { if (keys !== 'all') { const [k] = keys; if (k !== undefined) activate(k) } }}
        renderEmptyState={() => <div className="empty">{emptyText}</div>}
      >
        {function render(node: Node) {
          const info = node.children !== null ? folderInfo(node.path) : undefined
          const actions = rowActions(node, folderInfo, spaceMoves)
          return (
            <TreeItem id={node.id} textValue={node.name} className="tree-item">
              <TreeItemContent>
                {({ level, hasChildItems }) => (
                  <div className={`tree-row${menu === node.id ? ' tree-row-menu' : ''}${info?.pathOnly ? ' tree-row-path' : ''}`} style={{ paddingLeft: 8 + (level - 1) * 18 }}
                    title={info?.pathOnly ? t('tree.pathOnly') : undefined} {...rowHandlers(node, actions.length > 0)}>
                    {hasChildItems
                      ? <Button slot="chevron" className="tree-chevron">{Icon.chevron}</Button>
                      : <span className="tree-chevron-space" />}
                    {node.children !== null && <span className="tree-icon">{Icon.folder}</span>}
                    <span className="tree-label">{node.name}</span>
                    {node.template && <span className="tree-template" title={t('note.isTemplate')}>{Icon.template}<span className="visually-hidden">{t('note.isTemplate')}</span></span>}
                    {info?.pathOnly && <span className="visually-hidden">{t('tree.pathOnly')}</span>}
                    {info && <LockBadges own={info.own} ai={info.ai} />}
                    {actions.length > 0 && <RowMenu node={node} actions={actions} open={menu === node.id} onOpenChange={(o) => setMenu(o ? node.id : null)} onAction={(a) => { setMenu(null); onAction(a, node) }} />}
                  </div>
                )}
              </TreeItemContent>
              {node.children && <Collection items={node.children}>{render}</Collection>}
            </TreeItem>
          )
        }}
      </Tree>
    </div>
  )
}
