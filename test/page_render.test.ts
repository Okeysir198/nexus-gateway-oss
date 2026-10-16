import { describe, expect, it } from "vitest";
import { adminPage, VIEW_SCRIPTS } from "../src/admin/page";
import { GENERATED_CSS, STYLES } from "../src/admin/styles";
import { COMPILED_CSS } from "../src/admin/theme/app.css.gen";
import { CORE_JS } from "../src/admin/client_core";
import { KEYS_HTML } from "../src/admin/view_keys";
import { PROVIDERS_HTML } from "../src/admin/view_providers";
import { USERS_HTML } from "../src/admin/view_users";
import { I } from "../src/admin/icons";
import { SHELL_TOP, TABS } from "../src/admin/view_shell";
import { SIDEBAR_MENU_BUTTON_LG } from "../src/admin/ui";
import { loginPage } from "../src/admin/login";

/** Structural guards on the server-rendered console.
 *
 *  These exist because the page is assembled from TS TEMPLATE LITERALS, which fail in a
 *  way tsc cannot see: a stray backtick inside a CSS or JS string silently ENDS the
 *  literal, and everything after it is parsed as JavaScript. The file still typechecks;
 *  the Worker then refuses to boot with "X is not defined" — a total outage. That
 *  happened once during this rewrite (a backtick in a CSS comment in styles.ts).
 *
 *  Rendering the page and asserting on its shape is the cheapest thing that catches it,
 *  and it doubles as a check that the CSP still carries every directive the page needs.
 *  The tab tests exist because the tab mechanism is a GENERAL SIBLING combinator: the
 *  three radios, the sidebar peer, the inset and the bottom nav must be DIRECT children
 *  of [data-slot="sidebar-wrapper"], in that order, or a panel stays display:none for
 *  everyone with JS on while the markup still contains every word these tests look for.
 *  (Broken exactly that way once in the previous shell: nesting the panels one div
 *  deeper left the suite green.) */

const req = (cookie?: string) => new Request("https://x/admin", cookie ? { headers: { cookie } } : undefined);
const render = (cookie?: string) => adminPage(req(cookie));

describe("template-literal integrity", () => {
  // Every one of these is embedded in a template literal at assembly time.
  const literals: [string, string][] = [
    // GENERATED_CSS, not STYLES: the compiled sheet legitimately contains escaped
    // content of its own. Only hand-authored/generated strings apply.
    ["GENERATED_CSS", GENERATED_CSS],
    // The view scripts come from page.ts's OWN assembly list, in order.
    ...VIEW_SCRIPTS.map((js, i) => ["view script " + i, js] as [string, string]),
    ["KEYS_HTML", KEYS_HTML],
    ["PROVIDERS_HTML", PROVIDERS_HTML],
    ["USERS_HTML", USERS_HTML],
    // The icons are interpolated into the shell/nav markup at assembly time.
    ...Object.values(I).map((glyph, i) => ["icon " + i, glyph] as [string, string]),
  ];

  it.each(literals)("%s contains no backtick or ${} that would truncate it", (_name, s) => {
    expect(s).not.toContain("`");
    expect(s).not.toContain("${");
  });

  it("every view script is VALID JavaScript once assembled — the browser runs it as one blob", () => {
    // The integrity test above can't see a SYNTAX error: an apostrophe in a
    // comment survives as content, but one inside a single-quoted JS string
    // ends the string and the script dies at parse time — every handler on the
    // page dies with it, the no-js class never comes off, and the console
    // renders as one long stack of panels. This actually shipped that way.
    // new Function() compiles without running — exactly the browser's parse.
    // VIEW_SCRIPTS is page.ts's OWN assembly list, so a view added there is
    // guarded here for free.
    expect(() => new Function(VIEW_SCRIPTS.join(""))).not.toThrow();
    for (const js of VIEW_SCRIPTS) {
      expect(() => new Function(js)).not.toThrow();
    }
  });

  it("the script's tab list is the declared one — deep links die when it drifts", () => {
    // CORE_JS cannot import TABS (it is a string), so its copy is interpolated
    // from the same constant; this tripwire keeps that true against hand-edits.
    expect(CORE_JS).toContain("var TABS = " + JSON.stringify([...TABS]) + ";");
  });

  it("the stylesheet survived assembly intact — opening rule to closing tag", () => {
    expect(STYLES.startsWith("<style>")).toBe(true);
    expect(STYLES.endsWith("</style>")).toBe(true);
    // The compiled sheet carries the theme: the .dark palette block (theme.css
    // v5 switches on the CLASS, so a missing block means the theme did not embed),
    // and the sidebar roles the shell's fusion rules point at.
    expect(COMPILED_CSS).toContain(".dark");
    expect(COMPILED_CSS).toContain("--sidebar-primary");
    expect(COMPILED_CSS).toContain(".no-js .tabpanel"); // chrome.css mechanisms rode along
    expect(COMPILED_CSS).toContain(".tab-radio");
    // ...the fonts: base64 faces, still ahead of everything else.
    expect(STYLES).toContain("data:font/woff2;base64,");
    // ...the sidebar skeleton utilities the shell markup uses (the compiled side
    // carries Tailwind's output; the generated side the tab rules).
    expect(COMPILED_CSS).toContain(".z-10");
    expect(COMPILED_CSS).toContain(".h-svh");
    expect(STYLES).toContain(".bottom-nav");
    // ...and the generated tab rules close the sheet.
    expect(STYLES).toContain('#tab-keys:checked ~ [data-slot="sidebar-inset"] #panel-keys');
  });
});

describe("the tab structure holds together", () => {
  it("renders every radio, rail label, bottom-nav label and panel exactly once", async () => {
    const html = await render().text();
    for (const t of TABS) {
      expect(html.split('id="tab-' + t + '"').length - 1).toBe(1);
      expect(html.split('id="lab-' + t + '"').length - 1).toBe(1);
      expect(html.split('id="panel-' + t + '"').length - 1).toBe(1);
      // Count over MARKUP: the generated CSS also names [for="tab-x"], so a raw
      // count would count the sheet against itself. Rail + bottom nav = 2 labels.
      const markup = html.replace(/<style[\s\S]*?<\/style>/, "").replace(/<script[\s\S]*?<\/script>/, "");
      expect(markup.split('<label for="tab-' + t + '"').length - 1).toBe(2);
    }
    // The GPU service panel is gone; nothing may resurrect its ids.
    expect(html).not.toContain("panel-services");
    expect(html).not.toContain("tab-services");
    expect(html).not.toContain('id="view-');
  });

  it("lands on keys: exactly one radio is checked", async () => {
    const html = await render().text();
    expect(html).toContain('id="tab-keys" class="tab-radio" checked>');
    for (const t of TABS.slice(1)) {
      expect(html.split('id="tab-' + t + '" class="tab-radio" checked').length - 1).toBe(0);
    }
  });

  it("has the generated rules for every tab: reveal, sidebar fusion, bottom-nav ink", () => {
    for (const t of TABS) {
      expect(GENERATED_CSS).toContain('#tab-' + t + ':checked ~ [data-slot="sidebar-inset"] #panel-' + t);
      expect(GENERATED_CSS).toContain('#tab-' + t + ':checked ~ [data-slot="sidebar"] [data-sidebar="menu-button"][for="tab-' + t + '"]');
      expect(GENERATED_CSS).toContain('#tab-' + t + ':checked ~ .bottom-nav [for="tab-' + t + '"]');
    }
    // The current-page treatments the generated block promises: the stock sidebar
    // tint (theme.css has no brand bar, so no box-shadow here) and the
    // bottom bar's brand ink.
    expect(GENERATED_CSS).toContain("var(--sidebar-accent)");
    expect(GENERATED_CSS).toContain("var(--sidebar-primary)");
  });

  it("the lg menu-button hand-merges the collapsed padding (tw-merge equivalence)", () => {
    // React's tw-merge drops the base's collapsed p-2! when size.lg adds p-0!.
    // Emitted raw, both compile and Tailwind sorts p-0 before p-2, so p-2! wins
    // and the collapsed rail keeps 8px padding — the 32px brand/avatar tiles
    // clip or vanish (observed live).
    expect(SIDEBAR_MENU_BUTTON_LG).toContain("group-data-[collapsible=icon]:p-0!");
    expect(SIDEBAR_MENU_BUTTON_LG).not.toContain("group-data-[collapsible=icon]:p-2!");
    // …and the shell really uses it for the lg rows (brand, footer account,
    // footer sign-out): the constant merging correctly is worthless unused.
    const lgRows = SHELL_TOP.split('class="' + SIDEBAR_MENU_BUTTON_LG + '"').length - 1;
    expect(lgRows).toBeGreaterThanOrEqual(3);
  });

  it("keeps the radios, sidebar, inset and bottom-nav DIRECT children of the wrapper — the sibling proof", async () => {
    // The reveal rules are `#tab-x:checked ~ [data-slot="sidebar-inset"] #panel-x`:
    // the inset must be a SIBLING of the radios (direct child of the wrapper), or a
    // panel silently never displays, with JS on, for everyone. Walk the markup between
    // the wrapper open and the inset open: every tag opened must be closed again
    // before the inset (the radios are <input> — void, never counted).
    const html = await render().text();
    const wrapperAt = html.indexOf('<div data-slot="sidebar-wrapper"');
    expect(wrapperAt).toBeGreaterThan(-1);
    const radiosAt = html.indexOf('class="tab-radio"');
    expect(radiosAt).toBeGreaterThan(wrapperAt); // radios come FIRST — the "~" needs it
    const insetAt = html.indexOf('<main data-slot="sidebar-inset"');
    expect(insetAt).toBeGreaterThan(radiosAt);
    const between = html.slice(wrapperAt + '<div data-slot="sidebar-wrapper"'.length, insetAt);
    let depth = 0;
    for (const [open, close] of [
      [/<div\b[^>]*>/g, /<\/div>/g],
      [/<section\b[^>]*>/g, /<\/section>/g],
      [/<nav\b[^>]*>/g, /<\/nav>/g],
      [/<header\b[^>]*>/g, /<\/header>/g],
      [/<main\b[^>]*>/g, /<\/main>/g],
    ] as [RegExp, RegExp][]) {
      depth += (between.match(open) ?? []).length - (between.match(close) ?? []).length;
    }
    expect(depth).toBe(0);
    // ...and the panels live INSIDE the inset, so the reveal's descendant leg reaches them.
    for (const t of TABS) {
      expect(html.indexOf('id="panel-' + t + '"')).toBeGreaterThan(insetAt);
    }
  });

  it("ships as .no-js and reveals every panel when scripting is off", async () => {
    const html = await render().text();
    expect(html).toContain('<body class="no-js">');
    // The compiled sheet keeps chrome.css's formatted (unminified) shape.
    expect(COMPILED_CSS).toContain(".no-js .tabpanel {\n  display: block;\n}");
    expect(COMPILED_CSS).toContain(".no-js #sidebar-toggle");
  });
});

describe("adminPage", () => {
  it("carries no inline style attribute — a nonce does not cover style-src-attr", async () => {
    // Strip the <style> and <script> blocks first — CSS/JS text is not markup, and
    // theme.css's comments contain prose that looks like an attribute.
    const markup = (await render().text())
      .replace(/<style[\s\S]*?<\/style>/g, "")
      .replace(/<script[\s\S]*?<\/script>/g, "");
    expect(markup).not.toMatch(/<[^>]+\sstyle="/);
  });

  it("uses one fresh nonce per response, on both the style and the script block", async () => {
    const html = await render().text();
    const nonces = [...html.matchAll(/nonce="([^"]+)"/g)].map((m) => m[1]);
    expect(nonces).toHaveLength(2);
    expect(nonces[0]).toBe(nonces[1]);
    expect(nonces[0]!.length).toBeGreaterThanOrEqual(16);

    const second = [...(await render().text()).matchAll(/nonce="([^"]+)"/g)].map((m) => m[1]);
    expect(second[0]).not.toBe(nonces[0]);
  });

  it("sends a CSP that allows the inlined fonts and nothing off-origin", async () => {
    const csp = render().headers.get("content-security-policy") ?? "";
    // data: fonts are NOT exempt from font-src — without this directive the faces are
    // blocked and the console silently falls back to a system font.
    expect(csp).toContain("font-src data:");
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(csp).not.toContain("unsafe-inline");
  });

  it("stamps the operator's theme choice on <html> so the page cannot flash", async () => {
    expect(await render("lw-theme=dark").text()).toContain('<html lang="en" class="dark">');
    // No cookie ⇒ light: theme.css has no prefers-color-scheme block, the
    // default is the light palette, and the toggle writes the cookie from JS.
    expect(await render().text()).toContain('<html lang="en">');
    expect(await render("lw-theme=light").text()).toContain('<html lang="en">');
  });

  it("carries the skeleton slots — trigger, breadcrumb, footer account controls", async () => {
    const html = await render().text();
    expect(html).toContain('id="sidebar-toggle"');
    expect(html).toContain('data-sidebar="trigger"');
    expect(html).toContain('data-slot="breadcrumb"');
    expect(html).toContain('id="crumb-here"');
    expect(html).toContain('id="who"');
    expect(html).toContain('id="outBtn"');
    // The password console is gone — no button may resurrect it.
    expect(html).not.toContain('id="pwBtn"');
    expect(html).not.toContain("admin/password");
    expect(html).not.toContain('type="password"');
  });
});

describe("the sign-in page (Google-only)", () => {
  const renderLogin = (cookie?: string) =>
    loginPage(new Request("https://x/admin", cookie ? { headers: { cookie } } : undefined));

  it("offers exactly one door — Google — and no password field anywhere", async () => {
    const html = await renderLogin().text();
    expect(html).toContain('href="/login/google"');
    expect(html).not.toContain('type="password"');
    expect(html).not.toContain("<form");
    expect(html).not.toContain("/admin/login"); // the retired POST endpoint is not referenced
  });

  it("rides the same nonce CSP and stylesheet as the console", async () => {
    const res = renderLogin("lw-theme=dark");
    const html = await res.text();
    expect(html).toContain('class="dark"');
    const nonces = [...html.matchAll(/nonce="([^"]+)"/g)].map((m) => m[1]);
    expect(nonces).toHaveLength(1);
    expect(nonces[0]!.length).toBeGreaterThanOrEqual(16);
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("font-src data:");
    expect(csp).toContain("form-action 'none'");
    expect(csp).not.toContain("unsafe-inline");
  });

  it("is the stock login-03 shape — centered lockup and the operator note", async () => {
    const html = await renderLogin().text();
    // The lockup link rides self-center inside the max-w-sm frame...
    expect(html).toContain('class="flex items-center gap-2 self-center font-medium"');
    // ...and the note sits outside the Card, centred under it.
    expect(html).toContain('class="px-6 text-center text-sm text-muted-foreground"');
    // No two-column brand panel, no fake doors from the stock block's siblings —
    // over MARKUP only: the shared stylesheet may legitimately carry these
    // utilities for the console's own views.
    const markup = html.replace(/<style[\s\S]*?<\/style>/, "");
    expect(markup).not.toContain("md:grid-cols-2");
    expect(markup).not.toContain("max-w-4xl");
  });
});
