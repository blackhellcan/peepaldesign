# Fonts

Two-typeface system (client spec, 2026-08-14): **Inter** primary, for body copy
and general reading content; **Red Hat Display** secondary, for headings,
subheadings and visual accent.

| File | Role | Status |
|---|---|---|
| `Archivo-var.woff2` | fallback for body text | on disk |
| `Archivo-Italic-var.woff2` | fallback for body italics | on disk |
| `Inter-var.woff2` | **primary** — body copy, sitewide | on disk (2026-11-18: official Inter variable, weight + slant axes, 319 KB, from the WordPress Twenty Twenty-Four theme's bundled copy, OFL) |
| `Caveat-500.woff2` | the handwritten note on `info/index.html` only | on disk (2026-11-18: Google Fonts latin subset, 50 KB) |
| `Inter-Italic-var.woff2` | primary italics | **NOT ON DISK** |
| `RedHatDisplay-var.woff2` | **secondary** — h1–h4, and a few title spans | on disk |
| `RedHatDisplay-Italic-var.woff2` | secondary italics (the accent tokens in headings) | on disk |

## Red Hat Display — live now

Unlike the two Inter files below, both Red Hat Display files are real and
already in this folder — fetched directly from Google Fonts
(`fonts.gstatic.com`, the `latin` subset, variable weight 300–900) and
self-hosted the same way Archivo always has been, so the page still makes no
runtime request to Google. Nothing to do here; it is active for every reader
today, covering `h1`–`h4` plus three title-role spans that aren't heading tags
(`.qa__t`, `.vtab__t`, `.fac__name`) — see the comment above the rule in
`contact-sheet.css` for exactly which components that reaches.

## Inter — waiting on two files

The primary/body face. The `@font-face` blocks list `local()` first, so:

- a reader who already has Inter installed sees it immediately, no network
  request, no code change;
- everyone else currently falls through to Archivo — which is why body copy
  still looks like Archivo today for most readers, not broken, just waiting;
- **the moment `Inter-var.woff2` lands at this path, body text sitewide
  switches with no code change.** Add `Inter-Italic-var.woff2` alongside it
  for the two paragraph-level italics on the research-debt post to switch too.

Get the variable build — `InterVariable.woff2` and `InterVariable-Italic.woff2`
from <https://github.com/rsms/inter/releases> — and rename them to
`Inter-var.woff2` / `Inter-Italic-var.woff2`.

A static (non-variable) build works too for either family; change
`format('woff2-variations')` to `format('woff2')` and drop the
`font-weight:300 900` (or `100 900`) range on the affected `@font-face` blocks.

## One thing dropping in the Inter files will not fix

**Condensed labels go normal-width.** Dozens of components on this site —
edge stamps, tags, `.csnav` tabs, fact labels, the client-logo captions — set
`font-stretch` (usually `66%`) to get their tracked, condensed look. That
relies on Archivo's width axis. **Neither Inter nor Red Hat Display's
variable fonts carry a width axis at all**, so every `font-stretch`
declaration on text set in either face is a no-op — not a missing-asset
problem, a real difference between the typefaces, permanent once either file
is supplied. If the condensed look matters more than the new typeface for a
given component, that component needs Archivo pinned explicitly
(`font-family:'Archivo'`) rather than inheriting the page default.
