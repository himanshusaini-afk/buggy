# Buggy — project site

The public landing page for Buggy. Plain HTML, CSS and JavaScript with **no build step
and no dependencies**, so there is nothing to install, nothing to compile, and nothing
that can break on a toolchain upgrade.

```
site/
├── index.html              single page
├── assets/
│   ├── css/styles.css      tokens, layout, animations
│   └── js/main.js          canvas, typewriter, tabs, counters, copy buttons
├── .nojekyll               serve files as-is
├── robots.txt
└── sitemap.xml
```

## Previewing locally

Any static server works. From the repository root:

```bash
npx serve site          # then open the printed URL
# or
python -m http.server 8080 --directory site
```

Opening `index.html` straight from the filesystem mostly works too, but clipboard
writes fall back to the legacy path because `file://` is not a secure context.

## Publishing

Deployment is handled by `.github/workflows/deploy-site.yml`. It uploads `site/`
as a Pages artifact on every push to `main` that touches the folder, and can also be
triggered manually from the Actions tab.

**One-time repository setup:** go to **Settings → Pages** and set *Source* to
**GitHub Actions**. Without that the workflow builds the artifact but has nowhere to
publish it.

Live URL once enabled: `https://himanshusaini-afk.github.io/buggy/`

All asset paths are relative (`./assets/...`), so the site works correctly from that
subpath as well as from a custom domain.

## Editing

- **Copy** lives entirely in `index.html`. No templating, no front matter.
- **Colours, spacing and type scale** are CSS custom properties at the top of
  `styles.css`. Changing `--mint`, `--cyan` and `--violet` re-themes the whole page.
- **The terminal transcript** is the `script` array in `main.js`. Each entry is a
  string plus an optional colour class. The `sr-only` block in `index.html` holds the
  same content as plain text for screen readers — update both together.
- **Stat numbers** come from `data-to` attributes on `.count` elements.

## Accessibility notes

- Skip link, semantic landmarks, and a visible focus ring on every interactive element.
- Both tab groups implement the ARIA tabs pattern with arrow, Home and End key support.
- The animated terminal is `aria-hidden`; an equivalent full transcript sits beside it
  in an `sr-only` block.
- `prefers-reduced-motion: reduce` disables the canvas loop, the typewriter, the
  autoplaying pipeline, counters and tilt, and renders every final state immediately.
- The canvas animation also pauses when the tab is hidden or the hero scrolls out of view.
