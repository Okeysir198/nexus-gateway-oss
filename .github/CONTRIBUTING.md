# Contributing

Issues and pull requests are welcome.

## Setup

```bash
npm install
cp .dev.vars.example .dev.vars   # then `npx wrangler dev`; sign in with the password in that file
```

To try a real deployment, use `node scripts/deploy.mjs` (see the README) with a throwaway
`--name`, and remove it with `--destroy`.

## Before you push

There is no CI; run the whole gate locally:

```bash
npm run check:css && npm run typecheck && npx vitest run
```

`npm test` runs `check:css` first via `pretest`. Tests run inside workerd
(`@cloudflare/vitest-pool-workers`), so `crypto.subtle` and `TransformStream` behave as in
production.

## Rules that bite

- Every outbound request goes through Cloudflare AI Gateway. Do not add a bare `fetch()` to
  an upstream.
- No backticks or `${}` inside the console's view, CSS or JS template literals: `tsc` does
  not catch it and the Worker fails to boot.
- Console styles are compiled from `styles/app.css`. After changing classes used in
  `src/admin/`, run `npm run css`; `check:css` fails on a stale
  `src/admin/theme/app.css.gen.ts`.
- Lockfile: do not run a bare `npm install` on an arm64 machine to change it. Use
  `npm install --package-lock-only` so optional x64 packages stay in the tree, then verify
  with `npm ci --dry-run --os=linux --cpu=x64`.
- Read `docs/invariants.md` before touching auth, routing or the translate layer.

By contributing you agree your work is released under the MIT license.
