import { describe, expect, it } from 'vitest'
// `?raw` rather than node:fs: tsconfig.app.json covers all of src with only
// vite/client types, and widening it to node types for one test would grow
// the app's type surface to check an asset.
import svg from '../public/cubestats-mark.svg?raw'
import html from '../index.html?raw'

// The tab icon is an SVG, which means it is XML, which means a malformed file
// does not fail loudly -- the browser silently renders nothing and keeps
// showing whatever favicon it had cached for the origin. That is exactly how
// a purple Vite lightning bolt survived a rewrite AND a rename of this file:
// the new art never parsed, so the old cached bolt was never replaced.
// Nothing else in the build validates this asset.

describe('the tab icon', () => {
  it('declares no comment containing a double hyphen', () => {
    // XML forbids `--` inside a comment. It is an easy rule to break here in
    // particular, because the honest way to describe this file's colours is
    // to name the CSS custom properties they came from, and spelling those
    // the CSS way inside a comment makes the icon unparseable.
    const comments = [...svg.matchAll(/<!--([\s\S]*?)-->/g)].map((m) => m[1])
    expect(comments.length).toBeGreaterThan(0)
    for (const body of comments) {
      expect(body, `illegal "--" inside an XML comment: ${body.trim()}`).not.toContain('--')
    }
  })

  it('has balanced, well-formed-looking markup', () => {
    // Not a full parser, but it catches the shapes that silently blank an
    // icon: an unterminated comment, or a stray `--` outside one.
    expect(svg.split('<!--').length).toBe(svg.split('-->').length)
    expect(svg.trimStart().startsWith('<svg')).toBe(true)
    expect(svg.trimEnd().endsWith('</svg>')).toBe(true)
  })

  it('is the file index.html actually points at', () => {
    // A rename is the only reliable way to bust a cached favicon, so the href
    // and the filename drift apart easily.
    const href = /<link\s+rel="icon"[^>]*href="([^"]+)"/.exec(html)?.[1]
    expect(href).toBe('/cubestats-mark.svg')
  })
})
