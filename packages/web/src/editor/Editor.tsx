// Note editor: CodeMirror 6 on top of the co-editing session's Y.Text.
import { defaultKeymap, indentWithTab } from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { yamlFrontmatter } from '@codemirror/lang-yaml'
import { syntaxHighlighting } from '@codemirror/language'
import { searchKeymap } from '@codemirror/search'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { classHighlighter, tagHighlighter, tags } from '@lezer/highlight'
import { vihkoSyntax } from '@vihko/core/syntax'
import { useEffect, useRef } from 'react'
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next'
import * as Y from 'yjs'
import type { User } from '../api.ts'
import { spaceOf } from '@vihko/core/spaces'
import { useT } from '../i18n.tsx'
import { takeModK } from '../keys.ts'
import { usePathLabels, useSpaces } from '../spaces.tsx'
import type { Session } from './collab.ts'
import { commentMarks, commentUi, setCommentReach, type CommentReach } from './commentMarks.ts'
import { imageHost, images } from './images.ts'
import { linkAutocomplete } from './autocomplete.ts'
import { createLinkUi, type NewLinkedNote } from './createLink.ts'
import { SHORTCUTS, formatKeymap, insertLink, modKMakesLink, runFormat, undoBoundary } from './format.ts'
import { labels, livePreview, navigate, notePath, pickAmbiguous, setLinks, type LinkInfo, type PickAmbiguous } from './livePreview.ts'
import { frontmatterGuard } from './frontmatterGuard.ts'
import { announce } from './presence.ts'
import { agentLabel, agentMarks } from './agents.ts'
import { tables } from './tables.ts'
import { taskLabel, tasks } from './tasks.ts'
import { viewUpdates } from './viewUpdates.ts'
import './editor.css'

/** Classes `classHighlighter` has none for: struck-through text and inline code (editor.css styles them). */
const moreClasses = tagHighlighter([
  { tag: tags.strikethrough, class: 'tok-strikethrough' },
  { tag: tags.monospace, class: 'tok-monospace' },
])

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
  /** How the comments are reached from the text, as the side panel is (commentMarks.ts). */
  commentReach?: CommentReach
  /** Images linked from other sites: shown, shown when the reader asks, or blocked by the administrator. */
  externalImages: 'allow' | 'ask' | 'block'
  /** Image files pasted or dropped, for the range `from`–`to`. */
  onImageFiles?: (files: File[], from: number, to: number) => void
  /** A single image URL pasted over `from`–`to`. */
  onImageUrl?: (url: string, from: number, to: number) => void
  /** «Save a copy» of an external image already in the note, written over `from`–`to`. */
  onSaveImageCopy?: (url: string, alt: string, from: number, to: number) => void
  /** «create» on a broken link: the note to create and the button pressed (to anchor a menu). */
  onCreateLink?: (note: NewLinkedNote, anchor: HTMLElement) => void
  /** An ambiguous link was clicked: open the picker of its candidates. */
  onPickAmbiguous?: PickAmbiguous
  /**
   * The person may read (or comment) but not edit: nothing can be
   * typed, pasted or dropped, and nothing is offered that writes (creating a
   * note from a broken link). The text can still be selected, to comment on it.
   */
  readOnly?: boolean
}

export function Editor({ path, session, user, links, onNavigate, onView, onComments, commentReach, externalImages, onImageFiles, onImageUrl, onSaveImageCopy, onCreateLink, onPickAmbiguous, readOnly = false }: Props) {
  const t = useT()
  const pathLabels = usePathLabels()
  const spaces = useSpaces()
  const space = spaceOf(path)
  const othersPersonal = space?.kind === 'personal' && space.owner !== spaces.me.normalize('NFC')
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
  const saveCopy = useRef(onSaveImageCopy)
  saveCopy.current = onSaveImageCopy
  const createLink = useRef(onCreateLink)
  createLink.current = onCreateLink
  const pick = useRef(onPickAmbiguous)
  pick.current = onPickAmbiguous

  useEffect(() => {
    const { text, provider } = session
    const unannounce = provider.awareness ? announce(provider.awareness, user) : () => {}
    const undoManager = new Y.UndoManager(text)
    const state = EditorState.create({
      doc: text.toString(),
      extensions: [
        yamlFrontmatter({ content: markdown({ base: markdownLanguage, extensions: vihkoSyntax, addKeymap: false }) }),
        syntaxHighlighting(classHighlighter),
        syntaxHighlighting(moreClasses),
        EditorView.lineWrapping,
        livePreview,
        // Before the keymaps: select all takes the body, and nothing done in the body reaches the frontmatter (losing it by accident would drop `uid`, tags and `ai: false`).
        frontmatterGuard,
        navigate.of((p) => nav.current(p)),
        pickAmbiguous.of((link, anchor) => pick.current?.(link, anchor)),
        notePath.of(path),
        EditorState.readOnly.of(readOnly),
        // Never from a link in a note of someone else's personal space: there a link that
        // looks broken may lead to one of the owner's notes this person can't read.
        readOnly || othersPersonal ? [] : createLinkUi.of({
          label: t('editor.linkCreate'),
          where: (note) => t('palette.createIn', { name: note.title, folder: pathLabels.where(note.path, true) }),
          create: (note, anchor) => createLink.current?.(note, anchor),
        }),
        linkAutocomplete(path, {
          tagCount: (n) => t(n === 1 ? 'editor.tagCountOne' : 'editor.tagCount', { n }),
          where: (p) => {
            const space = pathLabels.spaceTag(p)
            const folders = pathLabels.folders(p)
            return [space, folders].filter(Boolean).join(' · ')
          },
        }),
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
            ask: (domain) => t('editor.imageAsk', { domain }),
            show: t('editor.imageShow'),
            saveCopy: t('image.copy'),
          },
          onFiles: (files, from, to) => imageFiles.current?.(files, from, to),
          onUrl: (url, from, to) => imageUrl.current?.(url, from, to),
          onSaveCopy: readOnly ? null : (url, alt, from, to) => saveCopy.current?.(url, alt, from, to),
        }),
        commentMarks,
        commentUi.of({
          count: (n) => t(n === 1 ? 'comments.inParagraphOne' : 'comments.inParagraph', { n }),
          show: t('comments.view'),
          hint: t('comments.hint'),
          open: (id) => comments.current?.(id),
        }),
        viewUpdates,
        keymap.of([{ key: SHORTCUTS.comment, run: () => { comments.current?.(null); return true } }]),
        // Before the default keymap, where Mod-i selects the parent syntax: here it's italic.
        readOnly ? [] : keymap.of(formatKeymap),
        undoBoundary.of(() => undoManager.stopCapturing()),
        keymap.of([...yUndoManagerKeymap, ...defaultKeymap, ...searchKeymap, indentWithTab]),
        yCollab(text, provider.awareness, { undoManager }),
        agentMarks(text, provider.awareness, (a) => t('presence.agentWrote', { agent: agentLabel(t, a) })),
        EditorView.contentAttributes.of({ 'aria-label': t('editor.label'), spellcheck: 'true' }),
      ],
    })
    const v = new EditorView({ state, parent: host.current! })
    view.current = v
    viewCb.current?.(v)
    // ⌘K / Ctrl+K over the selection: the link, as the toolbar's button makes it, instead of the palette.
    const untake = readOnly ? () => {} : takeModK((e) => {
      if (!(e.target instanceof Node && v.contentDOM.contains(e.target)) || !modKMakesLink(v.state)) return false
      runFormat(v, insertLink(v.state))
      return true
    })
    return () => {
      untake()
      viewCb.current?.(null)
      unannounce()
      v.destroy()
      undoManager.destroy()
      view.current = null
    }
    // t only changes with the language; recreating the editor then is acceptable.
  }, [session, user, t, path, externalImages, readOnly])

  useEffect(() => {
    view.current?.dispatch({ effects: setLinks.of(links) })
  }, [links, session])

  const notices = commentReach?.notices ?? false
  const click = commentReach?.click ?? false
  useEffect(() => {
    view.current?.dispatch({ effects: setCommentReach.of({ notices, click }) })
  }, [notices, click, session, user, t, path, externalImages, readOnly])

  return <div className="editor" ref={host} />
}
