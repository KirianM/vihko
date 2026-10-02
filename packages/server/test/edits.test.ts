// Edits by operation (edits.ts): the section operations and the frontmatter
// one, as exact splices over the current text.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyEdits, planEdits, NoteError } from '@vihko/server'

const NOTE = `---
title: Plan
tags: [a]
---
# Plan

Intro.

## Tasks

- one
- two

### Later

- someday

## Notes

Last line.
`

const mismatch = (fn: () => unknown, re: RegExp) => assert.throws(fn, (e: unknown) => e instanceof NoteError && e.code === 'edit_mismatch' && re.test(e.message))

test('append_under_heading: after the section\'s own last line, before its subheadings and blank lines', () => {
  const out = applyEdits(NOTE, [{ op: 'append_under_heading', heading: 'Tasks', text: '- three' }])
  assert.equal(out, NOTE.replace('- two\n', '- two\n- three\n'))
  // The heading is found by its text whatever the case and spacing, or with its level.
  assert.equal(applyEdits(NOTE, [{ op: 'append_under_heading', heading: '##  tasks', text: '- three\n' }]), out)
  // A section that is last in the note, without a final newline.
  assert.equal(applyEdits('# A\n\ntext', [{ op: 'append_under_heading', heading: 'A', text: 'more' }]), '# A\n\ntext\nmore\n')
  // A heading with nothing under it, as the last line.
  assert.equal(applyEdits('# A', [{ op: 'append_under_heading', heading: 'A', text: 'first' }]), '# A\nfirst\n')
  // A subsection counts as a section too.
  assert.equal(applyEdits(NOTE, [{ op: 'append_under_heading', heading: 'Later', text: '- maybe' }]), NOTE.replace('- someday\n', '- someday\n- maybe\n'))
})

test('replace_section: what is under the heading, subsections included; the heading stays', () => {
  const out = applyEdits(NOTE, [{ op: 'replace_section', heading: 'Tasks', text: '- done' }])
  assert.equal(out, NOTE.replace(/## Tasks\n[\s\S]*?## Notes/, '## Tasks\n- done\n\n## Notes'))
  // The last section: up to the end of the note.
  assert.equal(applyEdits(NOTE, [{ op: 'replace_section', heading: 'Notes', text: 'Only this.\n' }]), NOTE.replace('\nLast line.\n', 'Only this.\n'))
  // Emptied.
  assert.equal(applyEdits('# A\nx\n# B\ny\n', [{ op: 'replace_section', heading: 'A', text: '' }]), '# A\n# B\ny\n')
  // Only what changed is spliced: the text kept at either end keeps its identity.
  const [s] = planEdits(NOTE, [{ op: 'replace_section', heading: 'Notes', text: '\nLast line, changed.\n' }])
  assert.deepEqual(s, { at: NOTE.indexOf('Last line.') + 'Last line'.length, remove: 0, insert: ', changed' })
})

test('setext headings and headings that look alike', () => {
  const setext = 'Title\n=====\nbody\n\nSub\n---\nsub body\n\nOther\n=====\nmore\n'
  assert.equal(applyEdits(setext, [{ op: 'replace_section', heading: 'Title', text: 'new body' }]), 'Title\n=====\nnew body\n\nOther\n=====\nmore\n')
  assert.equal(applyEdits(setext, [{ op: 'append_under_heading', heading: 'Title', text: 'added' }]), setext.replace('body\n\nSub', 'body\nadded\n\nSub'))
  const twice = '# Notes\na\n## Notes\nb\n'
  mismatch(() => planEdits(twice, [{ op: 'append_under_heading', heading: 'Notes', text: 'x' }]), /found 2/)
  assert.equal(applyEdits(twice, [{ op: 'append_under_heading', heading: '## Notes', text: 'c' }]), '# Notes\na\n## Notes\nb\nc\n')
  mismatch(() => planEdits(NOTE, [{ op: 'replace_section', heading: 'Nowhere', text: 'x' }]), /found 0/)
  // A `#` inside a code block is not a heading.
  mismatch(() => planEdits('```\n# Code\n```\n', [{ op: 'replace_section', heading: 'Code', text: 'x' }]), /found 0/)
  mismatch(() => planEdits(NOTE, [{ op: 'replace_section', heading: '', text: 'x' }]), /empty heading/)
})

test('set_frontmatter: only that value changes; lists, new keys and a new block', () => {
  assert.equal(applyEdits(NOTE, [{ op: 'set_frontmatter', key: 'title', value: 'Plan B' }]), NOTE.replace('title: Plan\n', 'title: Plan B\n'))
  assert.equal(applyEdits(NOTE, [{ op: 'set_frontmatter', key: 'tags', value: ['a', 'b c'] }]), NOTE.replace('tags: [a]', 'tags: [a, b c]'))
  assert.equal(applyEdits(NOTE, [{ op: 'set_frontmatter', key: 'status', value: 'draft' }]), NOTE.replace('tags: [a]\n', 'tags: [a]\nstatus: draft\n'))
  assert.equal(applyEdits('body\n', [{ op: 'set_frontmatter', key: 'done', value: true }]), '---\ndone: true\n---\nbody\n')
  mismatch(() => planEdits('---\nbad: [\n---\n', [{ op: 'set_frontmatter', key: 'a', value: 1 }]), /invalid frontmatter/)
  mismatch(() => planEdits(NOTE, [{ op: 'set_frontmatter', key: 'a', value: { b: 1 } as never }]), /value must be/)
  mismatch(() => planEdits(NOTE, [{ op: 'set_frontmatter', key: 'a', value: 'two\nlines' }]), /single-line/)
})

test('operations apply in order, each on the text the previous one left', () => {
  const out = applyEdits(NOTE, [
    { op: 'find_replace', find: 'Intro.', replace: 'Introduction.' },
    { op: 'append_under_heading', heading: 'Notes', text: 'After.' },
    { op: 'set_frontmatter', key: 'title', value: 'Plan 2' },
  ])
  assert.equal(out, NOTE.replace('Intro.', 'Introduction.').replace('Last line.\n', 'Last line.\nAfter.\n').replace('title: Plan\n', 'title: Plan 2\n'))
  mismatch(() => planEdits(NOTE, [{ op: 'replace_section', heading: 'Tasks', text: 3 as never }]), /text must be text/)
})

test('find_replace of every occurrence in a long note takes time in proportion to the text', () => {
  // One copy of the whole text per occurrence kept the server's only thread busy for seconds; the values are the case.
  const n = 250_000
  const text = 'a'.repeat(n)
  const start = performance.now()
  const splices = planEdits(text, [{ op: 'find_replace', find: 'a', replace: 'bc', expectedCount: n }])
  const out = applyEdits(text, [{ op: 'find_replace', find: 'a', replace: 'bc', expectedCount: n }])
  const ms = performance.now() - start
  assert.ok(ms < 1500, `${Math.round(ms)} ms`)
  assert.equal(splices.length, n)
  assert.equal(out, 'bc'.repeat(n))
  // Mixed with other operations, in order, each on the text the previous one left.
  const ops = [{ op: 'find_replace', find: 'a', replace: 'bb', expectedCount: 2 }, { op: 'find_replace', find: 'x', replace: '', expectedCount: 3 }, { op: 'append', text: 'end' }] as const
  assert.equal(applyEdits('x a x a x\n', [...ops]), ' bb  bb \nend')
})
