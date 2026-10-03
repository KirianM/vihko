import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extract, imageMarkdown, isImageRef, markdownDest, resolveImageRef } from '@vihko/core'

test('image references: by extension, ignoring query and anchor', () => {
  for (const r of ['a.png', 'b/C.JPG', 'x.webp?v=2', 'https://h/i.avif#f', 'd.svg']) assert.ok(isImageRef(r), r)
  for (const r of ['Plan', 'Plan.md', 'doc.pdf', 'png', 'a.png.md']) assert.ok(!isImageRef(r), r)
})

test('relative references resolve against the note folder and never leave the root', () => {
  assert.equal(resolveImageRef('proyectos/vihko/plan.md', 'plan-2026.png'), 'proyectos/vihko/plan-2026.png')
  assert.equal(resolveImageRef('proyectos/vihko/plan.md', './img/a%20b.png'), 'proyectos/vihko/img/a b.png')
  assert.equal(resolveImageRef('proyectos/vihko/plan.md', '../../x.png'), 'x.png')
  assert.equal(resolveImageRef('proyectos/vihko/plan.md', '/adjuntos/x.png'), 'adjuntos/x.png')
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

test('Markdown destinations: white space beyond ASCII is escaped as its UTF-8 bytes, and reads back', () => {
  // The literal names are the case under test: a macOS screenshot has a narrow
  // no-break space (U+202F) before AM/PM; others have a no-break space or an ideographic one.
  assert.equal(markdownDest('Screenshot 10.12.15 AM.png'), 'Screenshot%2010.12.15%E2%80%AFAM.png')
  assert.equal(markdownDest('a b.png'), 'a%C2%A0b.png')
  for (const name of ['Screenshot 2026-10-03 at 10.12.15 AM.png', 'Captura 10.12 p. m.png', 'a　b c.png', 'tab\there.png']) {
    assert.equal(resolveImageRef('a/n.md', markdownDest(name)), `a/${name}`, name)
    const x = extract(`![](${markdownDest(name)})\n`)
    assert.deepEqual(x.images.map((i) => resolveImageRef('a/n.md', i.dest)), [`a/${name}`], name)
  }
})

test('an image written for its note: the destination escaped, the alt text on one line with what would end it escaped', () => {
  assert.equal(imageMarkdown('Mi plan-2026.png'), '![](Mi%20plan-2026.png)')
  assert.equal(imageMarkdown('a.png', 'A [draft]\\ of\r\n  the\nplan '), '![A \\[draft\\]\\\\ of the plan](a.png)')
  // However odd the alt text, the note uses the image, whole.
  for (const alt of ['x](evil.png)', ']', 'a\n\n# heading', '\\', '[[Plan]]', '![](b.png)']) {
    const md = imageMarkdown('d i.png', alt)
    const x = extract(`${md}\n`)
    assert.deepEqual(x.images.map((i) => [i.raw, i.dest]), [[md, 'd%20i.png']], alt)
    assert.deepEqual(x.links, [], alt)
  }
})

test('links to images are not note links: not extracted, so never broken', () => {
  const x = extract('![](plan.png) ![[foto.jpg]] [[foto.webp]] [ver](diagrama.svg) ![[Plan]] [[Otra]] ![alt](https://h/i.png)')
  assert.deepEqual(x.links.map((l) => [l.kind, l.target]), [['embed', 'Plan'], ['wiki', 'Otra']])
})

test('image references are extracted apart, with the span of their destination', () => {
  const text = '---\nt: 1\n---\n![a](img/a%20b.png "t") ![[ foto.jpg |x]] [[plano.webp#y]] [ver](<d i.svg>) ![](https://h/i.png) ![](data:image/png;base64,AA) ![](no-extension)'
  const x = extract(text)
  assert.deepEqual(x.images.map((i) => [i.kind, i.dest, text.slice(i.destFrom, i.destTo)]), [
    ['image', 'img/a%20b.png', 'img/a%20b.png'],
    ['embed', 'foto.jpg', 'foto.jpg'],
    ['wiki', 'plano.webp', 'plano.webp'],
    ['markdown', '<d i.svg>', '<d i.svg>'],
    ['image', 'no-extension', 'no-extension'],
  ])
  assert.ok(x.images.every((i) => text.slice(i.from, i.to) === i.raw))
  assert.deepEqual(x.images.map((i) => i.raw), ['![a](img/a%20b.png "t")', '![[ foto.jpg |x]]', '[[plano.webp#y]]', '[ver](<d i.svg>)', '![](no-extension)'])
  assert.deepEqual(x.links, [])
})
