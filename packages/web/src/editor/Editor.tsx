// Note editor: CodeMirror 6 on top of the co-editing session's Y.Text.
import { defaultKeymap, indentWithTab } from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { yamlFrontmatter } from '@codemirror/lang-yaml'
import { syntaxHighlighting } from '@codemirror/language'
import { searchKeymap } from '@codemirror/search'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { classHighlighter } from '@lezer/highlight'
import { thothSyntax } from '@thoth/core/syntax'
import { useEffect, useRef } from 'react'
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next'
import * as Y from 'yjs'
import type { User } from '../api.ts'
import { useT } from '../i18n.tsx'
import type { Session } from './collab.ts'
import { commentMarks, commentUi } from './commentMarks.ts'
import { imageHost, images } from './images.ts'
import { linkAutocomplete } from './autocomplete.ts'
import { createLinkUi, type NewLinkedNote } from './createLink.ts'
import { labels, livePreview, navigate, notePath, setLinks, type LinkInfo } from './livePreview.ts'
import { announce } from './presence.ts'
import { tables } from './tables.ts'
import { taskLabel, tasks } from './tasks.ts'
import { viewUpdates } from './viewUpdates.ts'
import './editor.css'

interface Props {
  /** Path of the note: relative image references resolve against its folder. */
  path: string
  session: Session
  user: User
  links: Map<string, LinkInfo>
  onNavigate: (path: string) => void
  /** The EditorView, for the side panel (null when destroyed). */
  onView?: (view: EditorView | null) => void
  /** Open comments: a specific thread or, with null, comment on the selection. */
  onComments?: (threadId: string | null) => void
  /** Images linked from other sites: shown, or blocked by the administrator. */
  externalImages: 'allow' | 'block'
  /** Image files pasted or dropped, for the range `from`–`to`. */
  onImageFiles?: (files: File[], from: number, to: number) => void
  /** A single image URL pasted over `from`–`to`. */
  onImageUrl?: (url: string, from: number, to: number) => void
  /** «create» on a broken link: the note to create and the button pressed (to anchor a menu). */
  onCreateLink?: (note: NewLinkedNote, anchor: HTMLElement) => void
}

export function Editor({ path, session, user, links, onNavigate, onView, onComments, externalImages, onImageFiles, onImageUrl, onCreateLink }: Props) {
  const t = useT()
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const nav = useRef(onNavigate)
  nav.current = onNavigate
  const comments = useRef(onComments)
  comments.current = onComments
  const viewCb = useRef(onView)
  viewCb.current = onView
  const imageFiles = useRef(onImageFiles)
  imageFiles.current = onImageFiles
  const imageUrl = useRef(onImageUrl)
  imageUrl.current = onImageUrl
  const createLink = useRef(onCreateLink)
  createLink.current = onCreateLink

  useEffect(() => {
    const { text, provider } = session
    const unannounce = provider.awareness ? announce(provider.awareness, user) : () => {}
    const undoManager = new Y.UndoManager(text)
    const state = EditorState.create({
      doc: text.toString(),
      extensions: [
        yamlFrontmatter({ content: markdown({ base: markdownLanguage, extensions: thothSyntax, addKeymap: false }) }),
        syntaxHighlighting(classHighlighter),
        EditorView.lineWrapping,
        livePreview,
        navigate.of((p) => nav.current(p)),
        notePath.of(path),
        createLinkUi.of({
          label: t('editor.linkCreate'),
          where: (note) => {
            const folder = note.path.includes('/') ? note.path.slice(0, note.path.lastIndexOf('/')).split('/').join(' / ') : t('palette.root')
            return t('palette.createIn', { name: note.title, folder })
          },
          create: (note, anchor) => createLink.current?.(note, anchor),
        }),
        linkAutocomplete(path, { tagCount: (n) => t(n === 1 ? 'editor.tagCountOne' : 'editor.tagCount', { n }) }),
        labels.of({
          ambiguous: (n) => t('editor.linkAmbiguous', { n }),
          missing: t('editor.linkMissing'),
          frontmatter: (n) => t(n === 1 ? 'editor.frontmatterOne' : 'editor.frontmatter', { n }),
        }),
        // tasks brings lang-markdown's keymap (Enter continues a task as a task).
        tasks,
        taskLabel.of(t('editor.task')),
        tables,
        images,
        imageHost.of({
          note: path,
          external: externalImages,
          text: {
            external: t('editor.imageExternal'),
            missing: t('editor.imageMissing'),
            blocked: (domain) => t('editor.imageBlocked', { domain }),
          },
          onFiles: (files, from, to) => imageFiles.current?.(files, from, to),
          onUrl: (url, from, to) => imageUrl.current?.(url, from, to),
        }),
        commentMarks,
        commentUi.of({
          count: (n) => t(n === 1 ? 'comments.inParagraphOne' : 'comments.inParagraph', { n }),
          show: t('comments.view'),
          open: (id) => comments.current?.(id),
        }),
        viewUpdates,
        keymap.of([{ key: 'Mod-Alt-m', run: () => { comments.current?.(null); return true } }]),
        keymap.of([...yUndoManagerKeymap, ...defaultKeymap, ...searchKeymap, indentWithTab]),
        yCollab(text, provider.awareness, { undoManager }),
        EditorView.contentAttributes.of({ 'aria-label': t('editor.label'), spellcheck: 'true' }),
      ],
    })
    const v = new EditorView({ state, parent: host.current! })
    view.current = v
    viewCb.current?.(v)
    return () => {
      viewCb.current?.(null)
      unannounce()
      v.destroy()
      undoManager.destroy()
      view.current = null
    }
    // t only changes with the language; recreating the editor then is acceptable.
  }, [session, user, t, path, externalImages])

  useEffect(() => {
    view.current?.dispatch({ effects: setLinks.of(links) })
  }, [links, session])

  return <div className="editor" ref={host} />
}
