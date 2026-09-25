// A move whose link rewrites go on in the background: the note (or folder)
// is already in place. A dialog shows the progress; «Continue in the
// background» turns it into a notice and the UI stays usable. At the end the
// report goes to whoever started it, as for a quick move.
import { useEffect, useRef, useState } from 'react'
import { Button, Dialog, Heading, Modal, ModalOverlay } from 'react-aria-components'
import { ApiError, api, type FolderMoveReport, type MoveJob, type MoveReport, type MovedRelinkReport } from './api.ts'
import { errorText, useT } from './i18n.tsx'
import { Icon } from './ui.tsx'
import './actions.css'

export type JobEnd =
  | { kind: 'done'; report: MoveReport | FolderMoveReport | MovedRelinkReport }
  | { kind: 'failed'; message: string }
  /** The server no longer knows the job (it restarted). */
  | { kind: 'lost' }

const POLL_MS = 400
const nameOf = (path: string) => path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/i, '')

export function MoveProgress({ job: first, onFinished }: { job: MoveJob; onFinished: (end: JobEnd) => void }) {
  const t = useT()
  const [job, setJob] = useState(first)
  const [minimized, setMinimized] = useState(false)
  const finished = useRef(onFinished)
  finished.current = onFinished

  useEffect(() => {
    let live = true
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const j = await api.moveJob(first.id)
        if (!live) return
        setJob(j)
        if (j.state === 'done') return finished.current({ kind: 'done', report: j.report })
        if (j.state === 'failed') return finished.current({ kind: 'failed', message: errorText(t, new ApiError(500, j.error, j.message)) })
      } catch (err) {
        if (!live) return
        if (err instanceof ApiError && err.status === 404) return finished.current({ kind: 'lost' })
        // A network hiccup: try again.
      }
      timer = setTimeout(poll, POLL_MS)
    }
    timer = setTimeout(poll, POLL_MS)
    return () => { live = false; clearTimeout(timer) }
  }, [first.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const name = nameOf(job.to)
  const pct = job.total === 0 ? 0 : Math.round((job.done / job.total) * 100)
  const bar = (
    <div className="job-progress">
      <div className="job-bar" role="progressbar" aria-label={t('job.title')} aria-valuemin={0} aria-valuemax={job.total} aria-valuenow={job.done} aria-valuetext={t('job.progress', { done: job.done, total: job.total })}>
        <div className="job-fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  )

  if (minimized) {
    return (
      <div className="toast" role="status">
        <span className="toast-icon">{Icon.rename}</span>
        <span className="toast-text">
          {t('job.toast', { name, done: job.done, total: job.total })}
          {bar}
        </span>
      </div>
    )
  }
  return (
    <ModalOverlay className="modal-overlay" isOpen onOpenChange={(open) => { if (!open) setMinimized(true) }} isDismissable>
      <Modal className="modal">
        <Dialog className="dialog dialog-narrow">
          <div className="dialog-fields">
            <Heading slot="title" className="dialog-title">{t('job.title')}</Heading>
            <p className="dialog-text">{t('job.body', { name })}</p>
            {bar}
            <span className="job-progress">{t('job.progress', { done: job.done, total: job.total })}</span>
          </div>
          <div className="dialog-actions">
            <Button className="btn btn-primary" onPress={() => setMinimized(true)} autoFocus>{t('job.background')}</Button>
          </div>
        </Dialog>
      </Modal>
    </ModalOverlay>
  )
}
