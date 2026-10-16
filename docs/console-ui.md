# Console UI (`/admin`)

Two tabs: **API keys** and **Providers** (providers and their API keys in one list). Server-rendered HTML, no runtime
dependencies, nonce-based CSP. Styling is Tailwind v4 compiled at build time.

## CSS pipeline

- `styles/app.css` is the ONE stylesheet source. It imports Tailwind, the theme tokens
  (`styles/theme.css`) and the hand-written mechanism rules (`styles/chrome.css`), scans
  every HTML template literal under `src/` with `@source "../src"`, and force-emits a list
  of sentinel utilities with `@source inline(...)`.
- `npm run css` (`scripts/build-css.mjs`) compiles it with `@tailwindcss/cli` into the
  GENERATED `src/admin/theme/app.css.gen.ts` (`export const COMPILED_CSS = "..."`). Never
  edit that file; it is not minified, because readability is worth the bytes.
- `npm run check:css` (`scripts/check-css.mjs`) byte-gates the result: the artifact is
  fresh (rebuilt into a temp dir and compared), the sentinel utilities are present
  (Tailwind v4 emits NOTHING for an unresolvable utility, so absence proves nothing, which
  is why presence is asserted), and the artifact contains only `data:` URLs. The sentinel
  list exists twice, in `styles/app.css` and in `check-css.mjs`; keep them in sync.
- `npm test` runs `check:css` first via `pretest`, so a stale generated file fails the
  suite.

## Style layers

`styles.ts` stitches `STYLE_BODY = FONTS + COMPILED_CSS + GENERATED_CSS` into the one
nonce'd `<style>` element. The CSP is `default-src 'none'`, so an external stylesheet or
font file is blocked outright.

- `FONTS` is `theme/fonts.ts`, a committed static file: Geist and Geist Mono, latin and
  vietnamese subsets as base64 `data:` faces (see `NOTICE`). Keep the Vietnamese subsets if
  your operators read Vietnamese.
- `COMPILED_CSS` is Tailwind plus theme plus `chrome.css`.
- `GENERATED_CSS` holds the radio-tab reveal, sidebar current-page and bottom-nav rules,
  generated in `styles.ts` from the single `TABS` list in `view_shell.ts`, so a tab cannot
  exist with no way to be shown.

## Page structure

- The frame is a sidebar layout rendered by hand in `view_shell.ts`: a wrapper holding the
  hidden `.tab-radio` inputs as its FIRST children, the sidebar, then the inset `<main>`
  containing one `.tabpanel` section per tab, then the bottom navigation for narrow screens.
- **Structure is load-bearing.** The reveal rules are `#tab-x:checked ~ [data-slot=
  "sidebar-inset"] #panel-x`, so the inset must be a SIBLING of the radios and the panels
  descendants of the inset, or a tab silently never displays while every string test stays
  green. `test/page_render.test.ts` walks the sibling balance.
- Tabs are hidden radios with labels in both navs, so switching works with JavaScript
  disabled. The script adds hash deep links (`/admin#providers`), the breadcrumb sync and
  per-tab data refresh.
- Theme is a class: no cookie means light, and the toggle flips `.dark` on the document
  element. The server stamps the class from the cookie, so there is no flash.
- `src/admin/ui.ts` holds the shared class strings for buttons, badges, cards, inputs,
  tables and the sidebar. The JS row builders in `client_core.ts` get the SAME constants
  interpolated at module evaluation, so script-built markup cannot drift from
  server-rendered markup.
- `chrome.css` is the only unlayered hand-written CSS: mechanism rules only (the
  hidden-radio recipe, tab panel base, `[hidden] !important`, the toast fade hook, the
  `.no-js` fallbacks, sidebar width knobs).

## Rules that bite

- **No backticks or `${}` in any view, CSS or JS template literal.** A stray backtick in a
  CSS comment silently ends the literal and the rest parses as JavaScript. `tsc` does not
  catch it; the failure is a Worker that will not boot (`X is not defined`), a total outage.
  Deliberate `${JSON.stringify(const)}` interpolations at module evaluation are fine.
- **`data:` fonts still need `font-src data:`.** Browsers do not exempt `data:` from
  `font-src`; with `default-src 'none'` the faces are blocked silently.
- **A nonce does not cover inline `style=` attributes.** Every layout tweak is a class, and
  the toast toggles a `.fade` class instead of assigning `el.style.opacity`.
- Mutating admin API routes require the `x-nexus-console` header (CSRF defence on top of
  the SameSite=Strict session cookie).

## Console and machine routes

| Path | Auth | Notes |
|---|---|---|
| `GET /admin` | session | the console (sign-in page when signed out) |
| `GET /login/google`, `GET /oauth/google/callback` | none | Google sign-in handshake |
| `POST /login/password` | console header | password sign-in; 404 unless `ADMIN_PASSWORD_HASH` is set |
| `POST /admin/logout` | none | clears the session cookie |
| `GET /admin/whoami` | session | signed-in identity |
| `GET/POST /admin/api/keys`, `POST /admin/api/keys/revoke` | session | virtual keys |
| `GET/POST /admin/api/providers`, `DELETE /admin/api/providers/:name` | session | provider registry |
| `POST /admin/api/providers/alias`, `DELETE /admin/api/providers/alias/:alias` | session | provider aliases |
| `GET/POST /admin/api/provider-keys`, `DELETE /admin/api/provider-keys/:secret` | session | provider API keys (values are never returned) |
| `POST /key/generate`, `/key/delete`, `GET /key/list` | master key | machine surface and recovery |
