import { STYLE_BODY } from "./styles";
import { randomB64url } from "./session";
import { FAVICON } from "./brand";
import { SHELL_TOP, SHELL_BOTTOM } from "./view_shell";
import { KEYS_HTML, KEYS_JS } from "./view_keys";
import { PROVIDERS_HTML, PROVIDERS_JS } from "./view_providers";
import { CORE_JS } from "./client_core";

/** Assembles the console. Split into string constants (not one giant literal) so each
 *  view diffs independently; esbuild concatenates them at deploy, so there's no runtime
 *  cost and the "no build step" property holds.
 *
 *  Order matters: markup before the scripts, and CORE_JS last because its bootstrap
 *  calls into the view functions defined above it. */

/** The operator's light/dark choice, stamped on <html> before any CSS is parsed — doing
 *  it server-side is what removes the flash a client script would cause. The
 *  mechanism is the `.dark` CLASS (theme.css's @custom-variant), so the cookie puts
 *  `class="dark"` on the element; no cookie ⇒ light, the default — theme.css
 *  carries no prefers-color-scheme block for the system preference.
 *
 *  A preference, not a credential: the toggle writes it from JS, and nothing trusts the
 *  value beyond the light|dark match below. */
export function themeAttr(request: Request): string {
  const cookie = request.headers.get("cookie") ?? "";
  const m = cookie.match(/(?:^|;\s*)nexus-theme=(light|dark)(?:;|$)/);
  return m && m[1] === "dark" ? ' class="dark"' : "";
}

function headOpen(theme: string): string {
  return (
    `<!DOCTYPE html>\n<html lang="en"${theme}>\n<head>\n` +
    '<meta charset="utf-8" />\n<meta name="viewport" content="width=device-width, initial-scale=1" />\n' +
    "<title>nexus · console</title>\n" +
    // Inline so it costs no request and needs no route; img-src already allows data:.
    // Without it the browser requests /favicon.ico, which this Worker answers with a 404
    // on every console load. (The %-encoded brand hex lives in brand.ts.)
    '<link rel="icon" href="' + FAVICON + '" />\n'
  );
}

/** The panels, one per tab. Each is a DIRECT child of .shell (the sibling proof
 *  in page_render.test.ts walks the div balance) wrapping that view's markup. */
const BODY =
  "\n</head>\n<body class=\"no-js\">\n" +
  SHELL_TOP + "\n" +
  '<section class="tabpanel space-y-4" id="panel-keys" aria-labelledby="lab-keys">\n' + KEYS_HTML + "\n</section>\n" +
  '<section class="tabpanel space-y-4" id="panel-providers" aria-labelledby="lab-providers">\n' + PROVIDERS_HTML + "\n</section>\n" +
  SHELL_BOTTOM;

/** The assembled inline script, in view order — the ONE list of what ships. The
 *  compile guard in page_render.test.ts walks exactly this, so a new view's JS
 *  cannot skip it. */
export const VIEW_SCRIPTS = [KEYS_JS, PROVIDERS_JS, CORE_JS] as const;

const SCRIPT = VIEW_SCRIPTS.join("");

/** Security headers for every console response.
 *
 *  The CSP is nonce-based rather than 'unsafe-inline'. The console's JS and CSS are
 *  inline by design (no build step, no CDN), and 'unsafe-inline' would mean any HTML
 *  injection becomes script execution. A fresh nonce per response keeps the inline
 *  blocks working while still refusing anything an attacker manages to inject.
 *
 *  - default-src 'none'  : nothing loads unless explicitly allowed below.
 *  - connect-src 'self'  : the console only ever calls its own origin.
 *  - frame-ancestors 'none' + X-Frame-Options: no clickjacking the service controls.
 *  - form-action 'none'  : every mutation goes through fetch(); a real <form> POST out
 *                          of this page would be an injection.
 *  - no-store            : the page reflects live state and rides an auth cookie.
 *
 *  Only the two nonce'd directives vary per response, so the policy is stored split
 *  around them rather than rebuilt from an array each time. */
const CSP_HEAD = "default-src 'none'; script-src 'nonce-";
const CSP_TAIL =
  [
    "connect-src 'self'",
    "img-src 'self' data:",
    // The Geist faces are inlined as data: URIs. `data:` still needs its own directive —
    // browsers do NOT exempt it from font-src, and with default-src 'none' the faces are
    // otherwise blocked and the page silently falls back to a system font. `data:` alone
    // (no 'self', no https:) means a font can never be fetched over the network.
    "font-src data:",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");

function securityHeaders(nonce: string): Record<string, string> {
  return {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store, no-cache, must-revalidate",
    "content-security-policy": `${CSP_HEAD}${nonce}'; style-src 'nonce-${nonce}'; ${CSP_TAIL}`,
    "x-frame-options": "DENY",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "permissions-policy": "geolocation=(), microphone=(), camera=(), payment=()",
  };
}

/** 128 bits, base64url. The CSP guarantee rests on this being unguessable, so both pages
 *  that mint one call the same function rather than keeping their own copy. */
export function newNonce(): string {
  return randomB64url(16);
}

/** The nonce'd <style> element. Takes STYLE_BODY (~140 KB: base64 fonts + theme tokens +
 *  console rules) and concatenates rather than `STYLES.replace(...)`: replace cannot
 *  alias, so it flattened and re-allocated the whole 140 KB on every console render and
 *  every sign-in page. `+` builds a rope and copies nothing. */
export function styleTag(nonce: string): string {
  return `<style nonce="${nonce}">` + STYLE_BODY + "</style>";
}

export function adminPage(request: Request): Response {
  const nonce = newNonce();

  const html =
    headOpen(themeAttr(request)) +
    styleTag(nonce) +
    BODY +
    `\n<script nonce="${nonce}">\n` +
    SCRIPT +
    "\n</script>\n</body>\n</html>";

  return new Response(html, { status: 200, headers: securityHeaders(nonce) });
}

/** Exported so the login page can reuse the identical header set — it is the one page
 *  that handles a password, so it must not be the one page with a weaker policy. */
export { securityHeaders };
