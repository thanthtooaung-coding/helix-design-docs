# Helix Platform Design — documentation site

The master technical design for a multi-tenant application deployment platform built on OCI
images, Firecracker microVMs and WebAssembly, published as a searchable documentation site.

Built with [Astro](https://astro.build) + [Starlight](https://starlight.astro.build), re-themed
with the project's own palette and type pairing. 45 pages, 43 Mermaid diagrams, full-text search,
light and dark themes.

---

## Get it running in five minutes

```bash
git clone https://github.com/<you>/<repo>.git
cd <repo>
npm install
npm run dev          # http://localhost:4321/<repo>/
```

Then open `astro.config.mjs` and change the two constants at the top:

```js
const GITHUB_USER = 'your-username';   // ← your GitHub username
const REPO_NAME   = 'helix-design';    // ← this repository's name
```

Those two values drive the site URL, the `base` path, the GitHub link in the header and the
"Edit this page" links. Nothing else needs to change.

## Publish to GitHub Pages

1. Push this repository to GitHub.
2. **Settings → Pages → Build and deployment → Source:** choose **GitHub Actions**.
3. Push to `main`.

`.github/workflows/deploy.yml` builds the site and deploys it. Your docs land at:

```
https://<your-username>.github.io/<repo-name>/
```

The first run takes about two minutes. Subsequent pushes are faster.

### Using a custom domain instead

If you want `docs.yourdomain.com` or a user/org site at the root:

1. Set `base: '/'` in `astro.config.mjs` and `site` to your domain.
2. Add a `public/CNAME` file containing just the domain.
3. Point a `CNAME` DNS record at `<your-username>.github.io`.
4. **Settings → Pages → Custom domain**, and tick *Enforce HTTPS*.

### Using Cloudflare Pages or Netlify instead

Both work without changes beyond `base`. Build command `npm run build`, output directory `dist`,
Node 20. Delete `.github/workflows/deploy.yml` if you are not also deploying to GitHub Pages.

---

## Commands

| Command | What it does |
|---|---|
| `npm install` | Install dependencies |
| `npm run dev` | Dev server with hot reload at `localhost:4321` |
| `npm run build` | Production build into `dist/`, including the search index |
| `npm run preview` | Serve the production build locally |
| `npm run content` | Regenerate the page files from `scripts/source.md` (see below) |

---

## How the content is generated

The document exists in two forms. **`scripts/source.md` is the source of truth** — one file,
the whole design. `src/content/docs/*.md` are generated from it by a three-pass pipeline:

```
scripts/source.md
      │
      ▼  scripts/split.py       split on H2 into 45 pages, demote headings,
      │                          write frontmatter, emit the sidebar groups
      ▼  scripts/xrefs.mjs      turn every §N / §N.M reference into a relative
      │                          link, using the same slugger Starlight uses
      ▼  scripts/transform.py   ```mermaid fences → <pre class="mermaid">,
      │                          [MVP]/[V1]/[SCALE] → styled chips
      ▼
src/content/docs/*.md
```

Run the whole thing with:

```bash
npm run content
```

### Which file should I edit?

**Either works — pick one and stay with it.**

- **Editing `scripts/source.md`** keeps the single-file document authoritative and regenerates
  everything. Good while the design is still moving as a whole. Re-run `npm run content` after
  editing; it overwrites `src/content/docs/`.
- **Editing `src/content/docs/*.md` directly** is the normal docs-site workflow and works fine
  once the structure has settled. If you go this way, delete `scripts/source.md` and the
  `content` script so nobody overwrites your edits later.

The second option is probably what you want after the first week.

### Adding a new section

Create `src/content/docs/45-my-section.md`:

```markdown
---
title: "45. My Section"
description: One sentence for the sidebar card and search results.
sidebar:
  order: 45
---

## 45.1 First subsection
```

Then add `'45-my-section'` to the appropriate group in the `sidebar` array in `astro.config.mjs`.

---

## How the theme works

`src/styles/helix.css` overrides Starlight's CSS custom properties. Nothing is forked, so
Starlight upgrades apply cleanly.

**Palette — "oxide on slate":** bare-metal rust as the accent against cool blue-grey neutrals.

| Token | Light | Dark |
|---|---|---|
| Accent | `#AC4225` | `#E0764F` |
| Page background | `#EFF1F4` | `#0E1116` |
| Surface | `#FFFFFF` | `#151A21` |
| Body text | `#39414E` | `#BFC7D2` |
| Steel (cross-references) | `#3C5A78` | `#7FA6C9` |

To change the accent, edit `--helix-oxide` and `--sl-color-accent*` in both the `:root` and
`:root[data-theme='light']` blocks, and the matching values in `src/mermaid.js` so diagrams stay
in step.

**Type:** IBM Plex Sans for UI and headings, Source Serif 4 for running prose, IBM Plex Mono for
code and labels. Loaded from Google Fonts via the `head` array in `astro.config.mjs`. To
self-host instead, drop the WOFF2 files in `public/fonts/`, remove those `head` entries and add
`@font-face` rules to `helix.css`.

**Maturity chips.** `[MVP]`, `[V1]` and `[SCALE]` render as chips in a deliberate progression —
filled, outlined, then quiet — because they encode the build sequence rather than decorating it.

---

## Diagrams

Diagrams are written as ordinary Mermaid in the source and rendered in the browser by
`src/mermaid.js`, which is injected on every page by a small integration in `astro.config.mjs`.

- Mermaid (~170 kB gzipped) is imported **lazily**, only on pages that actually contain a
  diagram. Text-only pages pay nothing.
- Theme variables are derived from the Helix palette, and diagrams re-render when the reader
  flips the theme switch.
- `useMaxWidth: false`, so large diagrams keep their natural size and the figure scrolls
  horizontally. Shrinking the 29-table ER diagram to fit the column makes it unreadable; a
  scrollbar does not.

If you prefer build-time rendering (no client JS, faster first paint), swap in
[`rehype-mermaid`](https://github.com/remcohaszing/rehype-mermaid) — it needs Playwright in CI,
which is the trade.

---

## Project layout

```
.
├── astro.config.mjs              # site config, sidebar, fonts, mermaid integration
├── src/
│   ├── content.config.ts         # Starlight docs collection
│   ├── content/docs/
│   │   ├── index.mdx             # landing page
│   │   ├── 404.md
│   │   └── NN-*.md               # 45 generated section pages
│   ├── styles/helix.css          # the entire theme
│   └── mermaid.js                # client-side diagram renderer
├── scripts/
│   ├── source.md                 # single-file source of truth
│   ├── split.py                  # pass 1
│   ├── xrefs.mjs                 # pass 2
│   └── transform.py              # pass 3
├── public/                       # static assets (favicon, CNAME, images)
└── .github/workflows/deploy.yml  # GitHub Pages
```

---

## Troubleshooting

**Links and styles break after deploying.** `base` in `astro.config.mjs` does not match the
repository name. It must be `/<repo-name>` with a leading slash and no trailing slash.

**"Last updated" shows the wrong date.** The Actions checkout needs full history. The workflow
already sets `fetch-depth: 0`; if you replace it, keep that.

**Diagrams show as monospace text.** JavaScript failed to load. Check the browser console — most
often a `base` mismatch, occasionally a content-security-policy header added by a proxy.

**Search finds nothing.** Search is built by Pagefind at build time, so it only works on the
production build (`npm run build && npm run preview`), never in `npm run dev`.

**A Mermaid diagram fails to render.** Its source is left visible in the page and the error is
logged to the console. Mermaid's sequence diagrams treat `;` as a statement separator — use a
comma in message text.

---

## Licence

Choose one before making the repository public. `CC BY 4.0` or `CC BY-SA 4.0` suit a design
document; `MIT` suits the site code. Add a `LICENSE` file at the root.
