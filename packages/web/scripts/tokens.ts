// Genera src/theme/tokens.css a partir de src/theme/tokens.json, copia del
// sistema de diseño de Claude Design (https://claude.ai/artifact/RaWutTmAdYUCikhz3M2BaV),
// que es la fuente de verdad. Si el sistema cambia, se vuelve a copiar su
// tokens.json aquí y se ejecuta `npm run build`.
//
// Temas: claro en :root; oscuro si el sistema operativo lo pide y la persona no
// ha elegido claro, o si ha elegido oscuro (data-theme en <html>).
import { readFileSync, writeFileSync } from 'node:fs'

type ThemeValue = string | Record<string, string>
interface Token { name: string; value: ThemeValue }
interface Tokens {
  color: { themes: { id: string }[]; tokens: Token[] }
  type: { families: Record<string, string> }
  shadow?: { tokens: Token[] }
  [family: string]: unknown
}

const dir = new URL('../src/theme/', import.meta.url)
const t = JSON.parse(readFileSync(new URL('tokens.json', dir), 'utf8')) as Tokens
const [light, dark] = t.color.themes.map((x) => x.id)
const pick = (v: ThemeValue, theme: string) => (typeof v === 'string' ? v : (v[theme] ?? v[light!]!))

const themed = [...t.color.tokens, ...(t.shadow?.tokens ?? [])]
const decl = (theme: string) => themed.map((k) => `  --${k.name}: ${pick(k.value, theme)};`).join('\n')

const plain: string[] = []
for (const [family, body] of Object.entries(t)) {
  if (['name', 'version', 'color', 'type', 'shadow'].includes(family)) continue
  for (const k of (body as { tokens: Token[] }).tokens) plain.push(`  --${k.name}: ${k.value as string};`)
}
for (const [key, stack] of Object.entries(t.type.families)) plain.push(`  --font-${key}: ${stack};`)

const css = `/* Generado por scripts/tokens.ts desde tokens.json. No editar a mano. */
:root {
  color-scheme: light;
${decl(light!)}
${plain.join('\n')}
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    color-scheme: dark;
${decl(dark!).replace(/^/gm, '  ')}
  }
}
:root[data-theme="dark"] {
  color-scheme: dark;
${decl(dark!)}
}
`
writeFileSync(new URL('tokens.css', dir), css)
console.log(`tokens.css: ${themed.length} tokens por tema, ${plain.length} comunes`)
