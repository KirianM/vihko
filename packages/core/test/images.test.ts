import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extract, isImageRef, markdownDest, resolveImageRef } from '@thoth/core'

test('image references: by extension, ignoring query and anchor', () => {
  for (const r of ['a.png', 'b/C.JPG', 'x.webp?v=2', 'https://h/i.avif#f', 'd.svg']) assert.ok(isImageRef(r), r)
  for (const r of ['Plan', 'Plan.md', 'doc.pdf', 'png', 'a.png.md']) assert.ok(!isImageRef(r), r)
})

test('relative references resolve against the note folder and never leave the root', () => {
  assert.equal(resolveImageRef('proyectos/thoth/plan.md', 'plan-2026.png'), 'proyectos/thoth/plan-2026.png')
  assert.equal(resolveImageRef('proyectos/thoth/plan.md', './img/a%20b.png'), 'proyectos/thoth/img/a b.png')
  assert.equal(resolveImageRef('proyectos/thoth/plan.md', '../../x.png'), 'x.png')
  assert.equal(resolveImageRef('proyectos/thoth/plan.md', '/adjuntos/x.png'), 'adjuntos/x.png')
  assert.equal(resolveImageRef('plan.md', '<mi imagen.png>'), 'mi imagen.png')
  assert.equal(resolveImageRef('a/plan.md', 'a%20b.png', { embed: true }), 'a/a%20b.png', 'embeds are not URL-decoded')
  for (const bad of ['../../x.png', '../../../x.png', 'https://h/x.png', '//h/x.png', 'data:image/png;base64,AA', '']) {
    assert.equal(resolveImageRef('a/plan.md', bad), null, bad)
  }
})

test('Markdown destinations escape only what breaks the link', () => {
  assert.equal(markdownDest('plan-2026-09-25-1012.png'), 'plan-2026-09-25-1012.png')
  assert.equal(markdownDest('Mi plan (v2)#1.png'), 'Mi%20plan%20%28v2%29%231.png')
  assert.equal(markdownDest('café.png'), 'café.png')
  assert.equal(resolveImageRef('n.md', markdownDest('Mi plan (v2)%.png')), 'Mi plan (v2)%.png', 'round trip')
})

test('links to images are not note links: not extracted, so never broken', () => {
  const x = extract('![](plan.png) ![[foto.jpg]] [[foto.webp]] [ver](diagrama.svg) ![[Plan]] [[Otra]] ![alt](https://h/i.png)')
  assert.deepEqual(x.links.map((l) => [l.kind, l.target]), [['embed', 'Plan'], ['wiki', 'Otra']])
})
