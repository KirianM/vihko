// The «create» action of a broken link: creates the note where the link will find it and
// opens it. With templates configured (D-030), a small menu asks which one
// first. Never overwrites: if the note appeared meanwhile and the link now
// leads there, it's simply opened.
import { useState } from 'react'
import { Header, Menu, MenuItem, MenuSection, Popover, Text } from 'react-aria-components'
import { ApiError, api } from '../api.ts'
import { errorText, useT } from '../i18n.tsx'
import { Icon } from '../ui.tsx'
import { forgetSuggestions } from './autocomplete.ts'
import type { NewLinkedNote } from './createLink.ts'

const baseName = (p: string) => p.slice(p.lastIndexOf('/') + 1).replace(/\.md$/i, '')
const templateIcon = <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" /><path d="M14 3v6h6" /></svg>
const folderLabel = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')).split('/').join(' / ') : null)

export function useCreateLink(source: string, templates: readonly string[], onCreated: (path: string) => void) {
  const t = useT()
  const [menu, setMenu] = useState<{ note: NewLinkedNote; anchor: { current: HTMLElement } } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function create(note: NewLinkedNote, template?: string) {
    setMenu(null)
    setError(null)
    setBusy(true)
    try {
      const r = template ? await api.createFromTemplate(note.path, template) : await api.createNote(note.path, `# ${note.title}\n`)
      forgetSuggestions()
      onCreated(r.path)
    } catch (e) {
      if (e instanceof ApiError && e.code === 'exists') {
        // Someone (or another tab) created it first: open it if this link leads there now.
        const links = await api.links(source).catch(() => null)
        const link = links?.outgoing.find((l) => l.raw === note.raw)
        if (link?.status === 'resolved' && link.dstPath === note.path) return onCreated(note.path)
      }
      setError(errorText(t, e))
    } finally {
      setBusy(false)
    }
  }

  return {
    menu,
    error,
    dismissError: () => setError(null),
    onCreateLink: (note: NewLinkedNote, anchor: HTMLElement) => {
      if (busy) return
      if (templates.length === 0) void create(note)
      else setMenu({ note, anchor: { current: anchor } })
    },
    closeMenu: () => setMenu(null),
    create,
    templates,
  }
}

export type CreateLinkState = ReturnType<typeof useCreateLink>

export function CreateLinkUi({ state }: { state: CreateLinkState }) {
  const t = useT()
  const { menu, error, templates } = state
  return (
    <>
      {error && (
        <div className="banner create-link-error" role="alert">
          <div className="banner-text"><span className="error-text">{error}</span></div>
          <button type="button" className="btn btn-icon" aria-label={t('common.dismiss')} onClick={state.dismissError}>{Icon.close}</button>
        </div>
      )}
      {menu && (
        <Popover className="menu-popover create-link-popover" triggerRef={menu.anchor} isOpen placement="bottom start"
          onOpenChange={(open) => { if (!open) state.closeMenu() }}>
          <Menu className="menu" autoFocus="first" aria-label={t('palette.createIn', { name: menu.note.title, folder: folderLabel(menu.note.path) ?? t('palette.root') })}
            onAction={(key) => void state.create(menu.note, key === 'blank' ? undefined : String(key).slice(2))}>
            <MenuSection>
              <Header className="menu-header">
                {t('palette.createIn', { name: menu.note.title, folder: folderLabel(menu.note.path) ?? t('palette.root') })}
              </Header>
              <MenuItem id="blank" className="menu-item" textValue={t('editor.linkCreateBlank')}>
                {Icon.plus}<Text slot="label">{t('editor.linkCreateBlank')}</Text>
              </MenuItem>
            </MenuSection>
            <MenuSection>
              <Header className="menu-header">{t('palette.fromTemplate')}</Header>
              {templates.map((tpl) => (
                <MenuItem key={tpl} id={`t:${tpl}`} className="menu-item" textValue={baseName(tpl)}>
                  {templateIcon}<Text slot="label">{baseName(tpl)}</Text>
                </MenuItem>
              ))}
            </MenuSection>
          </Menu>
        </Popover>
      )}
    </>
  )
}
