// The formatting bar: fixed above the note on a computer; on a phone, at the
// bottom (over the keyboard), in one row that scrolls sideways, with the
// daily-note arrows and the save state at its end. Its buttons never take the
// focus from the editor (on a phone the keyboard would close), and each press
// is one undo step, written as typing is (format.ts). Below `edit` it offers
// nothing that writes: commenting only, with `comment`.
import { startCompletion } from '@codemirror/autocomplete'
import type { EditorState, TransactionSpec } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { Fragment, useEffect, useRef, type ReactNode } from 'react'
import { Button, Menu, MenuItem, MenuTrigger, Popover, Separator, Toolbar, Tooltip, TooltipTrigger } from 'react-aria-components'
import { canEdit, type Level } from '../api.ts'
import { useT } from '../i18n.tsx'
import { MAC } from '../keys.ts'
import { Icon } from '../ui.tsx'
import { NOTHING_ACTIVE, SHORTCUTS, activeFormats, insertLink, insertTable, runFormat, toggleCodeBlock, toggleHeading, toggleInline, toggleList, toggleQuote, type Active } from './format.ts'
import { tag, wikilink, type Edit } from './insert.ts'
import { insertionRange } from './insertAt.ts'
import { useViewState } from './viewUpdates.ts'
import './format.css'

/** `Mod-Alt-k` as shown: Ctrl+Alt+K, or ⌥⌘K on a Mac. */
function keys(binding: string): string {
  const parts = binding.split('-')
  const key = parts.pop()!.toUpperCase()
  const mods = parts.map((p) => (p === 'Mod' ? (MAC ? 'Meta' : 'Ctrl') : p))
  const mac: Record<string, string> = { Ctrl: '⌃', Alt: '⌥', Shift: '⇧', Meta: '⌘' }
  return MAC ? ['Ctrl', 'Alt', 'Shift', 'Meta'].filter((m) => mods.includes(m)).map((m) => mac[m]).join('') + key : [...mods, key].join('+')
}

interface Props {
  view: EditorView | null
  level: Level
  onComment: () => void
  onImage: () => void
  /** On a phone: at the bottom, sideways, with `end` after the buttons. */
  mobile?: boolean
  end?: ReactNode
}

export function FormatBar({ view, level, onComment, onImage, mobile = false, end }: Props) {
  const t = useT()
  const active = useViewState<Active>(view, activeFormats, NOTHING_ACTIVE)
  const editable = canEdit(level)

  // The keyboard shrinks the visible area: keep the cursor in sight.
  useEffect(() => {
    const vv = window.visualViewport
    if (!mobile || !vv || !view) return
    const on = () => { if (view.hasFocus) view.dispatch({ effects: EditorView.scrollIntoView(view.state.selection.main.head, { y: 'nearest' }) }) }
    vv.addEventListener('resize', on)
    return () => vv.removeEventListener('resize', on)
  }, [view, mobile])

  // On a phone, the edges of the row with more buttons beyond them fade (format.css).
  const row = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = row.current
    if (!el) return
    const mark = () => {
      el.toggleAttribute('data-more-start', el.scrollLeft > 1)
      el.toggleAttribute('data-more-end', el.scrollLeft + el.clientWidth < el.scrollWidth - 1)
    }
    mark()
    el.addEventListener('scroll', mark, { passive: true })
    // Its width changes with the save state beside it; its content with the person's level.
    const resize = new ResizeObserver(mark)
    resize.observe(el)
    const content = new MutationObserver(mark)
    content.observe(el, { childList: true, subtree: true })
    return () => {
      el.removeEventListener('scroll', mark)
      resize.disconnect()
      content.disconnect()
    }
  }, [mobile])

  const apply =(make: (s: EditorState) => TransactionSpec | null) => {
    if (!view) return
    runFormat(view, make(view.state))
    view.focus()
  }
  /** `[[` and `#`: never inside a link's (or an image's, a comment's…) hidden syntax, but after it. */
  const insert = (make: (doc: string, from: number, to: number) => Edit) => {
    if (!view) return
    const { from, to } = insertionRange(view.state, view.state.selection.main.from, view.state.selection.main.to)
    const e = make(view.state.doc.toString(), from, to)
    runFormat(view, { changes: { from: e.from, to: e.to, insert: e.insert }, selection: { anchor: e.cursor } })
    view.focus()
    // An empty `[[]]` or `#` opens the suggestions, as typing them would.
    if (e.from === e.to) startCompletion(view)
  }

  const tip = mobile ? 'top' : 'bottom'
  const tool = (id: string, label: string, icon: ReactNode, onPress: () => void, opts: { pressed?: boolean; shortcut?: string; tip?: string; className?: string } = {}) => {
    const k = opts.shortcut ? keys(opts.shortcut) : null
    return (
      <TooltipTrigger key={id} delay={500} closeDelay={0}>
        <Button className={`fmt-btn${opts.className ? ` ${opts.className}` : ''}`} preventFocusOnPress aria-label={label}
          aria-pressed={opts.pressed} onPress={onPress}>{icon}</Button>
        <Tooltip className="fmt-tip" placement={tip} offset={6}>{opts.tip ?? (k ? t('format.withKeys', { label, keys: k }) : label)}</Tooltip>
      </TooltipTrigger>
    )
  }

  const groups: ReactNode[][] = []
  if (editable) {
    const heading = (
      <MenuTrigger key="heading">
        <TooltipTrigger delay={500} closeDelay={0}>
          <Button className="fmt-btn fmt-heading" preventFocusOnPress aria-label={t('format.textStyle')} aria-pressed={active.heading > 0}>
            {active.heading ? <span className="fmt-level">H{active.heading}</span> : Icon.heading}{Icon.chevronDown}
          </Button>
          <Tooltip className="fmt-tip" placement={tip} offset={6}>{t('format.textStyle')}</Tooltip>
        </TooltipTrigger>
        <Popover className="menu-popover fmt-menu" placement={mobile ? 'top start' : 'bottom start'}>
          <Menu className="menu" aria-label={t('format.textStyle')} selectionMode="single" selectedKeys={[String(active.heading)]}
            onAction={(key) => {
              apply((s) => toggleHeading(s, Number(key)))
              // After the menu has put the focus back on its button.
              requestAnimationFrame(() => view?.focus())
            }}>
            {[0, 1, 2, 3].map((n) => (
              <MenuItem key={n} id={String(n)} className={`menu-item fmt-style fmt-style-${n}`} textValue={n ? t('format.heading', { n }) : t('format.normal')}>
                {({ isSelected }) => (
                  <>
                    <span className="fmt-check">{isSelected && Icon.check}</span>
                    {n ? t('format.heading', { n }) : t('format.normal')}
                  </>
                )}
              </MenuItem>
            ))}
          </Menu>
        </Popover>
      </MenuTrigger>
    )
    groups.push([heading])
    groups.push([
      tool('bold', t('format.bold'), Icon.bold, () => apply((s) => toggleInline(s, 'strong')), { pressed: active.strong, shortcut: SHORTCUTS.strong }),
      tool('italic', t('format.italic'), Icon.italic, () => apply((s) => toggleInline(s, 'em')), { pressed: active.em, shortcut: SHORTCUTS.em }),
      tool('strike', t('format.strike'), Icon.strike, () => apply((s) => toggleInline(s, 'strike')), { pressed: active.strike, shortcut: SHORTCUTS.strike }),
      tool('code', t('format.code'), Icon.code, () => apply((s) => toggleInline(s, 'code')), { pressed: active.code, shortcut: SHORTCUTS.code }),
    ])
    groups.push([
      tool('link', t('format.link'), Icon.link, () => apply(insertLink), {
        tip: t('format.linkWithKeys', { label: t('format.link'), selection: keys(SHORTCUTS.linkSelection), keys: keys(SHORTCUTS.link) }),
      }),
      tool('wikilink', t('editor.insertLink'), '[[', () => insert(wikilink), { className: 'fmt-text' }),
      tool('tag', t('editor.insertTag'), '#', () => insert(tag), { className: 'fmt-text fmt-hash' }),
    ])
    groups.push([
      tool('bullet', t('format.bullet'), Icon.list, () => apply((s) => toggleList(s, 'bullet')), { pressed: active.bullet }),
      tool('ordered', t('format.ordered'), Icon.listOrdered, () => apply((s) => toggleList(s, 'ordered')), { pressed: active.ordered }),
      tool('task', t('format.task'), Icon.listTask, () => apply((s) => toggleList(s, 'task')), { pressed: active.task }),
      tool('quote', t('format.quote'), Icon.quote, () => apply(toggleQuote), { pressed: active.quote }),
    ])
    groups.push([
      tool('codeBlock', t('format.codeBlock'), Icon.codeBlock, () => apply(toggleCodeBlock), { pressed: active.codeBlock }),
      tool('table', t('format.table'), Icon.table, () => apply((s) => insertTable(s, (n) => t('format.column', { n })))),
      tool('image', t('image.insertTitle'), Icon.image, onImage),
    ])
  }
  if (level !== 'read') groups.push([tool('comment', t('editor.comment'), Icon.comment, onComment, { shortcut: SHORTCUTS.comment })])
  if (!mobile && groups.length === 0) return null

  // On a computer a narrow note wraps the bar between groups, never inside one.
  const tools = groups.map((g, i) => (
    <Fragment key={i}>
      {i > 0 && <Separator className="fmt-sep" />}
      <span className="fmt-group">{g}</span>
    </Fragment>
  ))
  return (
    <Toolbar className={mobile ? 'editor-bar' : 'format-bar'} aria-label={t('editor.bar')}>
      {mobile ? <div className="fmt-scroll" ref={row}>{tools}</div> : tools}
      {end}
    </Toolbar>
  )
}
