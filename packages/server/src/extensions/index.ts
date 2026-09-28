// The extensions vihko ships. Order is only the tie-break of the topological sort.
import type { Extension } from '../extension.ts'
import { commentAnchors } from './comments.ts'
import { fts } from './fts.ts'
import { headings } from './headings.ts'
import { images } from './images.ts'
import { linksExtension, type LinksExtension } from './links.ts'
import { tags } from './tags.ts'

export function builtinExtensions(opts: { linkAliases?: boolean } = {}): { all: Extension[]; links: LinksExtension } {
  const links = linksExtension({ aliases: opts.linkAliases })
  return { all: [fts, links, images, tags, headings, commentAnchors] as Extension[], links }
}

export type { LinksExtension }
