import { FONTS } from "./theme/fonts";
import { COMPILED_CSS } from "./theme/app.css.gen";
import { TABS } from "./view_shell";

/** Console styling, THREE concatenated layers in ONE nonce'd <style> (the CSP is
 *  `default-src 'none'`, so a second stylesheet would need a second nonce and buys
 *  nothing):
 *
 *    FONTS         — self-hosted Geist / Geist Mono as base64 data: faces. Committed
 *                    as a static file (see NOTICE for the font license).
 *    COMPILED_CSS  — Tailwind v4 + styles/theme.css + chrome.css, COMPILED by
 *                    `npm run css` (scripts/build-css.mjs) from styles/app.css, which
 *                    @source-scans src/ so every utility the markup strings use is
 *                    emitted. Byte-gated by `npm run check:css` (header, freshness,
 *                    sentinels, hygiene). The layers own the shadcn component looks
 *                    (theme.css roles) and the sidebar skeleton utilities.
 *    GENERATED_CSS — the rules below: the radio-tab reveal / sidebar fusion / bottom-nav
 *                    rules, GENERATED from view_shell.ts's ONE declared tab list so a
 *                    tab cannot exist with no way to be shown. Written ONLY against
 *                    theme roles (var(--sidebar-accent)…), never a raw hex.
 *
 *  ⚠️ After changing any class used in src/, run `npm run css`; check:css proves it.
 *  ⚠️ NOTE: no backticks / ${} INSIDE the GENERATED_CSS string —
 *  a stray backtick in a CSS comment silently ends the literal and the rest parses as
 *  JavaScript. tsc does not catch it; the failure surfaces at Worker startup as a
 *  total outage. test/page_render.test.ts pins it. */

/** Mechanism ids: tab-<id> / panel-<id> over view_shell.ts's ONE declared tab list.
 *  Three rule groups per tab, GENERATED: the panel reveal (through the inset — the
 *  panels live INSIDE [data-slot="sidebar-inset"], so the general-sibling must reach
 *  the inset first and descend), the sidebar's current-page fusion (the stock tint),
 *  and the bottom-nav's active + focus
 *  treatments. */
const MAIN_TAB_IDS: readonly string[] = TABS;

const panelShown = MAIN_TAB_IDS.map(
  (t) => '#tab-' + t + ':checked ~ [data-slot="sidebar-inset"] #panel-' + t,
).join(",\n");
const railActive = MAIN_TAB_IDS.map(
  (t) => '#tab-' + t + ':checked ~ [data-slot="sidebar"] [data-sidebar="menu-button"][for="tab-' + t + '"]',
).join(",\n");
const bnActive = MAIN_TAB_IDS.map(
  (t) => '#tab-' + t + ':checked ~ .bottom-nav [for="tab-' + t + '"]',
).join(",\n");
const railFocus = MAIN_TAB_IDS.map(
  (t) => '#tab-' + t + ':focus-visible ~ [data-slot="sidebar"] [for="tab-' + t + '"]',
).join(",\n");
const bnFocus = MAIN_TAB_IDS.map(
  (t) => '#tab-' + t + ':focus-visible ~ .bottom-nav [for="tab-' + t + '"]',
).join(",\n");

export const GENERATED_CSS = `
${railActive} {
  background: var(--sidebar-accent);
  color: var(--sidebar-accent-foreground);
  font-weight: 500;
}
${railFocus} {
  outline: none;
  border-radius: var(--radius-md);
  box-shadow: 0 0 0 2px var(--background), 0 0 0 4px var(--ring);
}
${bnActive} {
  color: var(--sidebar-primary);
  font-weight: 500;
}
${bnFocus} {
  outline: 2px solid var(--ring);
  outline-offset: -2px;
  border-radius: var(--radius-sm);
}
${panelShown} { display: block; }
`;

/** The stylesheet's CONTENT, without the wrapping tag. `page.ts:styleTag()`
 *  concatenates a nonce'd `<style>` around it per response; keeping the tag out of the
 *  constant is what lets that be a rope instead of a full-sheet copy. */
export const STYLE_BODY = FONTS + COMPILED_CSS + GENERATED_CSS;

/** The tagless form is what ships; this exists for tests that assert on the whole sheet. */
export const STYLES = "<style>" + STYLE_BODY + "</style>";
