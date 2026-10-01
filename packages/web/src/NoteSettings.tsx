// Note settings of a person («Your note settings», from Preferences) or of a
// shared space («Space settings…», for its managers): daily-note series,
// templates folders, where new images go and the guide for agents. They add
// to the installation's (vihko.yaml); paths are inside the space, written as
// the person sees them there, never from the notes root. Saved into the
// space's hidden settings file, keeping what the file has around them.
import { useEffect, useState, type FormEvent } from 'react'
import { Button, Dialog, Heading } from 'react-aria-components'
import { ApiError, api, type NoteSettingsForm, type SettingsProblem, type SettingsView } from './api.ts'
import { errorText, useT, type MessageKey } from './i18n.tsx'
import { Icon } from './ui.tsx'
import './actions.css'
import './agents.css'

type Attachments = 'install' | 'next-to-note' | 'folder' | 'per-note'

/** A note's path as people write it here: without `.md`. */
const bare = (p: string) => p.replace(/\.md$/i, '')
/** The settings as the form shows them: the guide's note as it was written. */
const formOf = (s: NoteSettingsForm): NoteSettingsForm => ({ ...s, agents: s.agents === null ? null : bare(s.agents) })

/** A new series' id: unique among those of the form (the file keeps it). */
function newId(taken: readonly string[]): string {
  for (let n = 1; ; n++) {
    const id = `series-${n}`
    if (!taken.includes(id)) return id
  }
}

export function NoteSettingsDialog({ space, name, onClose, onSaved }: {
  /** A shared space's root, or null for the person's own settings. */
  space: string | null
  /** The shared space's name (null for one's own). */
  name: string | null
  onClose: () => void
  onSaved: () => void
}) {
  const t = useT()
  const [view, setView] = useState<SettingsView | null>(null)
  const [form, setForm] = useState<NoteSettingsForm | null>(null)
  const [templates, setTemplates] = useState('')
  const [attachments, setAttachments] = useState<Attachments>('install')
  const [attachFolder, setAttachFolder] = useState('')
  const [attachSuffix, setAttachSuffix] = useState('.assets')
  const [problems, setProblems] = useState<SettingsProblem[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  /** Saved, but the guide for agents names a note that doesn't exist: said, and the dialog stays until closed. */
  const [savedMissing, setSavedMissing] = useState<string | null>(null)

  useEffect(() => {
    api.settings(space ?? undefined).then((v) => {
      setView(v)
      setForm(formOf(v.settings))
      setTemplates(v.settings.templates.join('\n'))
      const a = v.settings.attachments
      setAttachments(a === null ? 'install' : a.mode)
      if (a?.mode === 'folder') setAttachFolder(a.folder)
      if (a?.mode === 'per-note') setAttachSuffix(a.suffix)
      setProblems(v.errors)
    }).catch((err) => setError(errorText(t, err)))
  }, [space, t])

  const series = form?.daily ?? []
  const setSeries = (i: number, patch: Partial<NoteSettingsForm['daily'][number]>) =>
    setForm((f) => (f ? { ...f, daily: f.daily.map((s, j) => (j === i ? { ...s, ...patch } : s)) } : f))

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!form || !view) return
    setBusy(true)
    setError(null)
    setProblems([])
    const next: NoteSettingsForm = {
      ...form,
      templates: templates.split('\n').map((l) => l.trim()).filter(Boolean),
      attachments: attachments === 'install' ? null : attachments === 'folder' ? { mode: 'folder', folder: attachFolder.trim() } : attachments === 'per-note' ? { mode: 'per-note', suffix: attachSuffix.trim() } : { mode: 'next-to-note' },
      agents: form.agents?.trim() || null,
      daily: form.daily.map((s) => ({ ...s, label: s.label?.trim() || null, folder: s.folder.trim(), name: s.name.trim() || '{YYYY}-{MM}-{DD}', template: s.template?.trim() || null })),
    }
    try {
      const saved = await api.saveSettings(space, next, view.etag)
      if (!saved.guideMissing || !next.agents) return onSaved()
      setView(saved)
      setForm(formOf(saved.settings))
      setSavedMissing(bare(next.agents))
      setBusy(false)
    } catch (err) {
      if (err instanceof ApiError && Array.isArray(err.data?.errors)) setProblems(err.data.errors as SettingsProblem[])
      else setError(errorText(t, err))
      setBusy(false)
    }
  }

  const problemText = (p: SettingsProblem) => {
    const key = `config.${p.code}` as MessageKey
    return `${p.at ? `${p.at}: ` : ''}${t(key, { detail: p.detail ?? '' })}`
  }

  return (
    <Dialog className="dialog settings-dialog">
      <form onSubmit={submit}>
        <div className="dialog-fields">
          <Heading slot="title" className="dialog-title">{name ? t('settings.spaceTitle', { name }) : t('settings.title')}</Heading>
          <p className="dialog-text">{t(name ? 'settings.spaceIntro' : 'settings.intro')}</p>
          {!form && !error && <p className="hint">{t('common.loading')}</p>}
          {form && (<>
            <fieldset className="settings-group">
              <legend>{t('settings.daily')}</legend>
              <span className="hint">{t('settings.dailyHint')}</span>
              {series.map((s, i) => (
                <div key={s.id} className="settings-series" role="group" aria-label={t('settings.seriesN', { n: i + 1 })}>
                  <label className="field"><span>{t('settings.seriesLabel')}</span>
                    <input value={s.label ?? ''} onChange={(e) => setSeries(i, { label: e.target.value })} />
                  </label>
                  <label className="field"><span>{t('settings.seriesFolder')}</span>
                    <input value={s.folder} onChange={(e) => setSeries(i, { folder: e.target.value })} placeholder="journal/{YYYY}" />
                  </label>
                  <label className="field"><span>{t('settings.seriesName')}</span>
                    <input value={s.name} onChange={(e) => setSeries(i, { name: e.target.value })} />
                  </label>
                  <label className="field"><span>{t('settings.seriesTemplate')}</span>
                    <input value={s.template ?? ''} onChange={(e) => setSeries(i, { template: e.target.value })} />
                  </label>
                  <Button className="btn btn-quiet settings-remove" aria-label={t('settings.seriesRemove', { n: i + 1 })} onPress={() => setForm((f) => (f ? { ...f, daily: f.daily.filter((_, j) => j !== i) } : f))}>{Icon.close}</Button>
                </div>
              ))}
              <Button className="btn settings-add" onPress={() => setForm((f) => (f ? { ...f, daily: [...f.daily, { id: newId(f.daily.map((x) => x.id)), label: null, folder: '', name: '{YYYY}-{MM}-{DD}', template: null }] } : f))}>{Icon.plus}{t('settings.seriesAdd')}</Button>
            </fieldset>
            <label className="field">
              <span>{t('settings.templates')}</span>
              <textarea className="settings-textarea" rows={2} value={templates} onChange={(e) => setTemplates(e.target.value)} />
              <span className="hint">{t('settings.templatesHint')}</span>
            </label>
            <label className="field">
              <span>{t('settings.attachments')}</span>
              <select className="select" value={attachments} onChange={(e) => setAttachments(e.target.value as Attachments)}>
                <option value="install">{t('settings.attachmentsInstall')}</option>
                <option value="next-to-note">{t('settings.attachmentsNext')}</option>
                <option value="folder">{t('settings.attachmentsFolder')}</option>
                <option value="per-note">{t('settings.attachmentsPerNote')}</option>
              </select>
            </label>
            {attachments === 'folder' && (
              <label className="field"><span>{t('settings.attachmentsFolderName')}</span><input value={attachFolder} onChange={(e) => setAttachFolder(e.target.value)} /></label>
            )}
            {attachments === 'per-note' && (
              <label className="field"><span>{t('settings.attachmentsSuffix')}</span><input value={attachSuffix} onChange={(e) => setAttachSuffix(e.target.value)} /></label>
            )}
            <label className="field">
              <span>{t('settings.agents')}</span>
              <input value={form.agents ?? ''} onChange={(e) => { setSavedMissing(null); setForm({ ...form, agents: e.target.value }) }} />
              <span className="hint">{t(name ? 'settings.agentsSpaceHint' : 'settings.agentsHint')}</span>
            </label>
            {/* The note named as the guide isn't there: agents would get nothing from it. */}
            {!savedMissing && view?.guideMissing && view.settings.agents !== null && bare((form.agents ?? '').trim()) === bare(view.settings.agents) && (
              <p className="key-once" role="note">{Icon.alert}<span>{t('settings.guideMissing', { note: bare(view.settings.agents) })}</span></p>
            )}
            {savedMissing && <p className="key-once" role="status">{Icon.alert}<span>{t('settings.savedGuideMissing', { note: savedMissing })}</span></p>}
          </>)}
        </div>
        {problems.length > 0 && (
          <div className="error-text dialog-error" role="alert">
            <p>{t('settings.problems')}</p>
            <ul className="settings-problems">{problems.map((p, i) => <li key={i}>{problemText(p)}</li>)}</ul>
          </div>
        )}
        {error && <p className="error-text dialog-error" role="alert">{error}</p>}
        <div className="dialog-actions">
          {savedMissing ? <Button className="btn" onPress={onSaved} autoFocus>{t('perm.close')}</Button> : <Button className="btn" onPress={onClose}>{t('common.cancel')}</Button>}
          <Button type="submit" className="btn btn-primary" isDisabled={busy || !form || view?.canEdit === false}>{t('prefs.save')}</Button>
        </div>
      </form>
    </Dialog>
  )
}
