import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderTemplate } from '@thoth/core'
import { mother } from '../../../test/mother.ts'

const m = mother(import.meta.url)
const USER = m.aUsername()

const vars = { now: { year: 2026, month: 9, day: 25, hour: 9, minute: 5 }, user: USER, title: 'Plan de viaje' }

test('templates: the fixed variables', () => {
  assert.equal(renderTemplate('# {{title}}\n\n{{date}} · {{user}}\n', vars), `# Plan de viaje\n\n2026-09-25 · ${USER}\n`)
  assert.equal(renderTemplate('{{date:DD/MM/YYYY HH:mm}}', vars), '25/09/2026 09:05')
  assert.equal(renderTemplate('{{ date }} {{ date:[W]WW }} {{ title }}', vars), '2026-09-25 W39 Plan de viaje')
})

test('templates: anything else is left exactly as is', () => {
  const text = '{{time}} {{tp.date.now()}} {{ }} {user} {{user:upper}} {{date}'
  assert.equal(renderTemplate(text, vars), text)
  assert.equal(renderTemplate('<% tp.file.title %> ${title}', vars), '<% tp.file.title %> ${title}')
})

test('templates: values are never expanded again', () => {
  assert.equal(renderTemplate('{{title}}', { ...vars, title: 'Notes on {{date}}' }), 'Notes on {{date}}')
  assert.equal(renderTemplate('{{user}}', { ...vars, user: '{{title}}' }), '{{title}}')
})

test('templates: frontmatter is text like the rest', () => {
  const text = '---\ncreated: {{date}}\ntags: [diario]\n# a comment\n---\n# {{title}}\n'
  assert.equal(renderTemplate(text, vars), '---\ncreated: 2026-09-25\ntags: [diario]\n# a comment\n---\n# Plan de viaje\n')
})
