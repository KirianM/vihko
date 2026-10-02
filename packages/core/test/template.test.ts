import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isTemplate, renderTemplate, templateMarked, withoutTemplateMark } from '@vihko/core'
import { mother } from '../../../test/mother.ts'

const m = mother(import.meta.url)
const USER = m.aUsername()
const TITLE = m.aTitle()
const TAG = m.aTag()

const vars = { now: { year: 2026, month: 9, day: 25, hour: 9, minute: 5 }, user: USER, title: TITLE }

test('templates: the fixed variables', () => {
  assert.equal(renderTemplate('# {{title}}\n\n{{date}} · {{user}}\n', vars), `# ${TITLE}\n\n2026-09-25 · ${USER}\n`)
  assert.equal(renderTemplate('{{date:DD/MM/YYYY HH:mm}}', vars), '25/09/2026 09:05')
  assert.equal(renderTemplate('{{ date }} {{ date:[W]WW }} {{ title }}', vars), `2026-09-25 W39 ${TITLE}`)
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
  const text = `---\ncreated: {{date}}\ntags: [${TAG}]\n# a comment\n---\n# {{title}}\n`
  assert.equal(renderTemplate(text, vars), `---\ncreated: 2026-09-25\ntags: [${TAG}]\n# a comment\n---\n# ${TITLE}\n`)
})

test('templates: the mark is template: true, a YAML true and nothing else', () => {
  assert.equal(isTemplate({ template: true }), true)
  // Literals: each is the case under test.
  for (const data of [{}, { template: 'true' }, { template: 'yes' }, { template: 1 }, { template: false }, { Template: true }]) assert.equal(isTemplate(data), false, JSON.stringify(data))
})

test('templates: a new note gets the template\'s frontmatter without the mark, every other byte as it is', () => {
  const [type, comment, other] = [m.aWord(), m.aSentence(), m.aWord()]
  // Key order, a comment of its own line and one after a value, quoting, a flow list, an unknown key, CRLF.
  for (const eol of ['\n', '\r\n']) {
    const lines = (...l: string[]) => l.join(eol) + eol
    const text = lines('---', `type: "${type}"   # ${comment}`, `# ${comment}`, 'template: true', `tags: [${TAG}, '${other}']`, `x-${other}: {a: 1}`, '---', '# {{title}}', '')
    assert.equal(withoutTemplateMark(text), lines('---', `type: "${type}"   # ${comment}`, `# ${comment}`, `tags: [${TAG}, '${other}']`, `x-${other}: {a: 1}`, '---', '# {{title}}', ''), JSON.stringify(eol))
  }
  // The mark with a comment on its line, first or last.
  assert.equal(withoutTemplateMark(`---\ntemplate: true # ${comment}\ntype: ${type}\n---\nbody\n`), `---\ntype: ${type}\n---\nbody\n`)
  assert.equal(withoutTemplateMark(`---\ntype: ${type}\ntemplate: true\n---\nbody\n`), `---\ntype: ${type}\n---\nbody\n`)
  // Nothing left: no block at all, unless the body would then read as one.
  assert.equal(withoutTemplateMark('---\ntemplate: true\n---\n# {{title}}\n'), '# {{title}}\n')
  assert.equal(withoutTemplateMark('﻿---\ntemplate: true\n---\nbody\n'), '﻿body\n')
  assert.equal(withoutTemplateMark(`---\ntemplate: true\n---\n---\n${other}: x\n---\n`), `---\n---\n---\n${other}: x\n---\n`)
  // Not marked, no frontmatter, or one that can't be read: as it is.
  for (const text of [`---\ntype: ${type}\n---\nbody\n`, '# {{title}}\n', '---\ntemplate: true\na: [\n---\n']) assert.equal(withoutTemplateMark(text), text)
})

test('templates: marking and unmarking a note touches only the mark', () => {
  const [type, comment] = [m.aWord(), m.aSentence()]
  const text = `---\n# ${comment}\ntype: ${type}   # ${comment}\n---\n# ${TITLE}\n`
  const marked = templateMarked(text, true)!
  assert.equal(marked, `---\n# ${comment}\ntype: ${type}   # ${comment}\ntemplate: true\n---\n# ${TITLE}\n`)
  assert.equal(templateMarked(marked, true), marked, 'already marked: the same text')
  assert.equal(templateMarked(marked, false), text)
  assert.equal(templateMarked(text, false), text, 'not marked: the same text')
  // No frontmatter: one is made; `template: false` becomes true, or goes.
  assert.equal(templateMarked(`# ${TITLE}\n`, true), `---\ntemplate: true\n---\n# ${TITLE}\n`)
  assert.equal(templateMarked('---\ntemplate: false\n---\n', true), '---\ntemplate: true\n---\n')
  assert.equal(templateMarked('---\ntemplate: false\n---\nx\n', false), 'x\n')
  // A frontmatter that can't be read is never written.
  assert.equal(templateMarked('---\na: [\n---\n', true), null)
})
