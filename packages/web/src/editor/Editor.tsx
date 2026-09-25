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
import { labels, livePreview, navigate, setLinks, type LinkInfo } from './livePreview.ts'
import { announce } from './presence.ts'
import { viewUpdates } from './viewUpdates.ts'
import './editor.css'

interface Props {
  session: Session
  user: User
  links: Map<string, LinkInfo>
  onNavigate: (path: string) => void
  /** The EditorView, for the side panel (null when destroyed). */
  onView?: (view: EditorView | null) => void
  /** Open comments: a specific thread or, with null, comment on the selection. */
  onComments?: (threadId: string | null) => void
}

export function Editor({ session, user, links, onNavigate, onView, onComments }: Props) {
  const t = useT()
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const nav = useRef(onNavigate)
  nav.current = onNavigate
  const comments = useRef(onComments)
  comments.current = onComments
  const viewCb = useRef(onView)
  viewCb.current = onView

  useEffect(() => {
    const { text, provider } = session
    const unannounce = provider.awareness ? announce(provider.awareness, user) : () => {}
    const undoManager = new Y.UndoManager(text)
    const state = EditorState.create({
      doc: text.toString(),
      extensions: [
        yamlFrontmatter({ content: markdown({ base: markdownLanguage, extensions: thothSyntax }) }),
        syntaxHighlighting(classHighlighter),
        EditorView.lineWrapping,
        livePreview,
        navigate.of((p) => nav.current(p)),
        labels.of({
          ambiguous: (n) => t('editor.linkAmbiguous', { n }),
          missing: t('editor.linkMissing'),
          frontmatter: (n) => t(n === 1 ? 'editor.frontmatterOne' : 'editor.frontmatter', { n }),
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
  }, [session, user, t])

  useEffect(() => {
    view.current?.dispatch({ effects: setLinks.of(links) })
  }, [links, session])

  return <div className="editor" ref={host} />
}
