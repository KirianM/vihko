// A note larger than vihko.yaml's `notes.maxSize`: never opened in the live
// editor (it would make the browser, and everyone's server, slow), shown as
// plain text instead (its beginning, so the page stays light) with a
// download of the whole file. Its frontmatter and text are as they are on
// the disk: nothing is rendered or run.
import { Button } from 'react-aria-components'
import type { Note } from './api.ts'
import { useT } from './i18n.tsx'
import { Icon, noteName } from './ui.tsx'
import './agents.css'

/** How much of it is shown: enough to recognise it, little enough for any browser. */
const SHOWN = 200_000

/** A size as people read it: KB under a megabyte, MB with one decimal over. */
function size(bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function TooLargeNote({ note }: { note: Note }) {
  const t = useT()
  const bytes = new Blob([note.text]).size
  const download = () => {
    const url = URL.createObjectURL(new Blob([note.text], { type: 'text/markdown;charset=utf-8' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `${noteName(note.path)}.md`
    document.body.append(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  return (
    <div className="note note-too-large">
      <div className="too-large-head" role="note">
        <p className="key-once">{Icon.alert}<span>{t('note.tooLargeNoLimit', { size: size(bytes) })}</span></p>
        <Button className="btn" onPress={download}>{t('note.download')}</Button>
      </div>
      {note.text.length > SHOWN && <p className="hint">{t('note.tooLargePart', { n: SHOWN.toLocaleString() })}</p>}
      <pre className="too-large-text" tabIndex={0} aria-label={noteName(note.path)}>{note.text.slice(0, SHOWN)}</pre>
    </div>
  )
}
