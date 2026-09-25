// Editor de una nota: CodeMirror 6 sobre el Y.Text de la sesión de coedición.
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
import { useT } from '../i18n.tsx'
import type { Session } from './collab.ts'
import { labels, livePreview, navigate, setLinks, type LinkInfo } from './livePreview.ts'
import { announce } from './presence.ts'
import './editor.css'

interface Props {
  session: Session
  username: string
  links: Map<string, LinkInfo>
  onNavigate: (path: string) => void
}

export function Editor({ session, username, links, onNavigate }: Props) {
  const t = useT()
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const nav = useRef(onNavigate)
  nav.current = onNavigate

  useEffect(() => {
    const { text, provider } = session
    const unannounce = provider.awareness ? announce(provider.awareness, username) : () => {}
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
        keymap.of([...yUndoManagerKeymap, ...defaultKeymap, ...searchKeymap, indentWithTab]),
        yCollab(text, provider.awareness, { undoManager }),
        EditorView.contentAttributes.of({ 'aria-label': t('editor.label'), spellcheck: 'true' }),
      ],
    })
    const v = new EditorView({ state, parent: host.current! })
    view.current = v
    return () => {
      unannounce()
      v.destroy()
      undoManager.destroy()
      view.current = null
    }
    // t cambia solo con el idioma; recrear el editor entonces es aceptable.
  }, [session, username, t])

  useEffect(() => {
    view.current?.dispatch({ effects: setLinks.of(links) })
  }, [links, session])

  return <div className="editor" ref={host} />
}
