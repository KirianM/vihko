// React's subscription to editor state: the side panel reads from the EditorView
// (threads, headings, selection) and hears about every change through here.
import { syntaxTree } from '@codemirror/language'
import type { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { useEffect, useState } from 'react'

const subscribers = new WeakMap<EditorView, Set<() => void>>()

export const viewUpdates = EditorView.updateListener.of((u) => {
  if (u.docChanged || u.selectionSet || u.focusChanged || syntaxTree(u.state) !== syntaxTree(u.startState)) {
    for (const fn of subscribers.get(u.view) ?? []) fn()
  }
})

/** Value derived from editor state; recalculated at most once per frame. */
export function useViewState<T>(view: EditorView | null, read: (s: EditorState) => T, initial: T): T {
  const [value, setValue] = useState<T>(() => (view ? read(view.state) : initial))
  useEffect(() => {
    if (!view) return setValue(initial)
    let frame = 0
    const refresh = () => {
      if (frame) return
      frame = requestAnimationFrame(() => { frame = 0; setValue(read(view.state)) })
    }
    setValue(read(view.state))
    let set = subscribers.get(view)
    if (!set) subscribers.set(view, (set = new Set()))
    set.add(refresh)
    return () => {
      set.delete(refresh)
      cancelAnimationFrame(frame)
    }
    // `read` and `initial` are treated as constants from the call site.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view])
  return value
}
