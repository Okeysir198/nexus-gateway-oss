import type { Env } from "../types";
import { invalidBody, json, readJsonObject } from "../errors";
import { clearCookie, csrfOk, mintSession, readCookie, sessionCookie, verifySession } from "./session";
import { exchangeGoogleCode, fetchGoogleEmail, googleLoginUrl, isOperator } from "./google";
import { BTN, BTN_SIZES, BTN_VARIANTS, CARD, CARD_CONTENT, CARD_DESCRIPTION, CARD_HEADER, CARD_TITLE, INPUT, LABEL, PW_TOGGLE_JS, pwWrap } from "./ui";
import { newNonce, securityHeaders, styleTag, themeAttr } from "./page";
import { PASSWORD_IDENTITY, clearFailures, lockedFor, recordFailure, verifyPassword } from "./password";

/** /admin sign-in and sign-out.
 *
 *  Two ways in, both ending in the same signed HttpOnly session cookie:
 *  - Google (when configured): OPERATOR_EMAILS (fail-closed) decides who is an operator.
 *  - Shared password (optional): only when ADMIN_PASSWORD_HASH is set. One password for
 *    the team, verified against a PBKDF2 hash, with a small per-isolate failure throttle.
 *    It does not consult OPERATOR_EMAILS.
 *  There are no per-user passwords and no user table. The master key is NOT a way into
 *  the console; it stays the credential for machine callers hitting /key/* directly. */

interface AdminIdentity {
  ok: boolean;
  email?: string;
  reason?: string;
}

/** The single console gate: the session cookie, nothing else. */
export async function requireAdmin(env: Env, request: Request): Promise<AdminIdentity> {
  const email = await verifySession(env, readCookie(request));
  if (!email) return { ok: false, reason: "not signed in" };
  return { ok: true, email };
}

/** GET /login/google — mint a state nonce, drop it as a short-lived cookie, 303 to
 *  Google. The cookie is SameSite=Lax (not Strict): it has to survive the top-level
 *  redirect BACK from accounts.google.com, which Strict would strip.
 *
 *  ⚠️ The redirect URI must be registered on your Google OAuth client, or Google
 *  answers redirect_uri_mismatch before this Worker is ever reached. */
export function googleStart(env: Env, request: Request): Response {
  const clientId = env.GOOGLE_CLIENT_ID ?? "";
  if (!clientId || !env.GOOGLE_CLIENT_SECRET) {
    return json(503, { error: { message: "google sign-in is not configured" } });
  }
  // CSRF: a signed-nonce cookie the callback must echo. Without it, an attacker can
  // complete someone else's flow by feeding them a callback URL.
  const state = crypto.randomUUID();
  const redirectUri = `${new URL(request.url).origin}/oauth/google/callback`;
  return new Response(null, {
    status: 303,
    headers: {
      location: googleLoginUrl(clientId, redirectUri, state),
      "set-cookie": `g_state=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
    },
  });
}

/** The Google "G" glyph, monochrome via currentColor. */
const GOOGLE_G =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" class="size-4 shrink-0" aria-hidden="true" focusable="false">' +
  '<path fill="currentColor" d="M12.48 10.92v3.28h7.84c-.24 1.84-.853 3.187-1.787 4.133-1.147 1.147-2.933 2.4-6.053 2.4-4.827 0-8.6-3.893-8.6-8.72s3.773-8.72 8.6-8.72c2.6 0 4.507 1.027 5.907 2.347l2.307-2.307C18.747 1.44 16.133 0 12.48 0 5.867 0 .307 5.387.307 12s5.56 12 12.173 12c3.573 0 6.267-1.173 8.373-3.36 2.16-2.16 2.84-5.213 2.84-7.667 0-.76-.053-1.467-.173-2.053H12.48z"/></svg>';

/** The sign-in card: centered bg-muted ground, the brand lockup on top, one Card with the
 *  doors that are configured (a Google link, a password form, or both). The callback's
 *  error paths reuse the same markup with the error slot filled, so a failed sign-in
 *  cannot look like a different app. `form-action 'none'` holds: Google is a link and the
 *  password form submits with fetch(), never a form POST. */
function signCard(errorMessage: string, { password: withPassword, google: withGoogle }: SignInOptions): string {
  const btnAttrs = ' data-slot="button" data-variant="outline" data-size="default"';
  const outlineBtn = BTN + " " + BTN_VARIANTS.outline + " " + BTN_SIZES.default;
  const err = errorMessage
    ? '<p class="text-sm text-destructive" role="alert" aria-live="assertive">' +
      errorMessage.replace(/[<>&]/g, "") +
      "</p>"
    : "";
  return (
    '<div class="flex min-h-svh flex-col items-center justify-center gap-6 bg-muted p-6 md:p-10">' +
    '<div class="flex w-full max-w-sm flex-col gap-6">' +
    '<a href="/admin" class="flex items-center gap-2 self-center font-medium">' +
    '<div class="flex size-6 items-center justify-center rounded-md bg-primary text-primary-foreground font-mono text-xs font-bold" aria-hidden="true">n</div>' +
    '<span>nexus<span class="font-normal text-muted-foreground">-gateway</span></span></a>' +
    '<div class="flex flex-col gap-6">' +
    '<div data-slot="card" class="' + CARD + '">' +
    '<div data-slot="card-header" class="' + CARD_HEADER + ' text-center">' +
    '<h1 data-slot="card-title" class="' + CARD_TITLE + ' text-xl">Operator console</h1>' +
    '<p data-slot="card-description" class="' + CARD_DESCRIPTION + '">Sign in to continue</p>' +
    "</div>" +
    '<div data-slot="card-content" class="' + CARD_CONTENT + '">' +
    err +
    (withGoogle
      ? '<a href="/login/google"' + btnAttrs + ' class="' + outlineBtn + ' w-full">' + GOOGLE_G + "Sign in with Google</a>"
      : "") +
    (withPassword ? (withGoogle ? PASSWORD_DIVIDER : "") + PASSWORD_FORM : "") +
    "</div></div>" +
    "</div></div>"
  );
}

/** The optional shared-password block: a divider, one field, one button. The submit is a
 *  fetch() from a nonce'd script, not a form POST, so `form-action 'none'` still holds. */
const PASSWORD_DIVIDER =
  '<div class="my-4 flex items-center gap-3 text-xs text-muted-foreground" aria-hidden="true">' +
  '<span class="h-px flex-1 bg-border"></span>or<span class="h-px flex-1 bg-border"></span></div>';
const PASSWORD_FORM =
  '<form id="pwForm" class="flex flex-col gap-3">' +
  '<label for="pw" data-slot="label" class="' + LABEL + '">Password</label>' +
  pwWrap('<input id="pw" name="password" type="password" autocomplete="current-password" required maxlength="256" data-slot="input" class="' + INPUT + ' pr-10">') +
  '<p id="pwErr" class="text-sm text-destructive" role="alert" aria-live="assertive" hidden></p>' +
  '<button type="submit" data-slot="button" data-variant="default" data-size="default" class="' + BTN + " " + BTN_VARIANTS.default + " " + BTN_SIZES.default + ' w-full">Sign in</button>' +
  "</form>";

const PASSWORD_SCRIPT =
  PW_TOGGLE_JS +
  "(function(){var f=document.getElementById('pwForm');if(!f)return;" +
  "f.addEventListener('submit',async function(e){e.preventDefault();" +
  "var err=document.getElementById('pwErr');var b=f.querySelector('button');err.hidden=true;b.disabled=true;" +
  "try{var r=await fetch('/login/password',{method:'POST',credentials:'same-origin'," +
  "headers:{'content-type':'application/json','x-nexus-console':'1'}," +
  "body:JSON.stringify({password:document.getElementById('pw').value})});" +
  "if(r.ok){location.href='/admin';return;}" +
  "var j={};try{j=await r.json();}catch(x){}" +
  "err.textContent=(j.error&&j.error.message)||'Sign-in failed.';" +
  "}catch(x){err.textContent='Network error. Try again.';}" +
  "err.hidden=false;b.disabled=false;});})();";

function signInResponse(request: Request, errorMessage: string, status: number, options: SignInOptions): Response {
  const nonce = newNonce();
  const scriptTag = options.password ? '<script nonce="' + nonce + '">' + PASSWORD_SCRIPT + "</script>" : "";
  return new Response(
    `<!DOCTYPE html>
<html lang="en"${themeAttr(request)}><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>nexus · sign in</title>
${styleTag(nonce)}
</head><body>
${signCard(errorMessage, options)}
${scriptTag}
</body></html>`,
    { status, headers: securityHeaders(nonce) },
  );
}

/** The callback's error paths reuse the sign-in page with the message slot filled. */
function messagePage(env: Env, request: Request, message: string, status: number): Response {
  return signInResponse(request, message, status, signInOptions(env));
}

/** GET /oauth/google/callback — verify state, exchange the code, ask Google who it was,
 *  and only then decide from OPERATOR_EMAILS whether that email may in. */
export async function googleCallback(env: Env, request: Request): Promise<Response> {
  const clientId = env.GOOGLE_CLIENT_ID ?? "";
  const clientSecret = env.GOOGLE_CLIENT_SECRET ?? "";
  const operators = env.OPERATOR_EMAILS ?? "";
  if (!clientId || !clientSecret) {
    return json(503, { error: { message: "google sign-in is not configured" } });
  }
  if (!env.ADMIN_SESSION_SECRET) return json(503, { error: { message: "ADMIN_SESSION_SECRET is not set" } });

  const url = new URL(request.url);
  const code = url.searchParams.get("code") ?? "";
  const state = url.searchParams.get("state") ?? "";
  const cookieState = readCookie(request, "g_state") ?? "";
  if (!code || !state || state !== cookieState) {
    return messagePage(env, request, "Sign-in could not be verified. Please try again.", 400);
  }

  let email = "";
  try {
    const redirectUri = `${url.origin}/oauth/google/callback`;
    const tokens = await exchangeGoogleCode(clientId, clientSecret, redirectUri, code);
    ({ email } = await fetchGoogleEmail(tokens.access_token));
  } catch (e) {
    // The Google error body is the diagnosis (invalid_client = stale secret,
    // redirect mismatch = wrong origin) — surface it to `wrangler tail`, keep
    // the page generic.
    console.error("google callback failed:", e instanceof Error ? e.message : e);
    return messagePage(env, request, "Google sign-in failed. Please try again.", 502);
  }

  // ⚠️ An empty OPERATOR_EMAILS denies everyone, deliberately. An allowlist that
  // silently admits the world is worse than one that locks the owner out.
  if (!isOperator(operators, email)) {
    return messagePage(env, request, "That account is not an operator of this gateway.", 403);
  }

  // Two cookies, TWO set-cookie headers — Set-Cookie must never be comma-merged into
  // one header (Expires=… carries a comma and would split wrong downstream).
  const headers = new Headers({ location: "/admin" });
  headers.append("set-cookie", sessionCookie(await mintSession(env, email)));
  headers.append("set-cookie", clearCookie("g_state"));
  return new Response(null, { status: 303, headers });
}

/** POST /admin/logout */
export function adminLogout(): Response {
  return json(200, { ok: true }, { "set-cookie": clearCookie() });
}

/** The sign-in page, offering the doors passed in.
 *
 *  It shares the console's stylesheet (STYLE_BODY = fonts + compiled theme + generated
 *  tab rules) and its nonce-based CSP rather than carrying a private copy of either. */
export function loginPage(env: Env, request: Request): Response {
  return signInResponse(request, "", 200, signInOptions(env));
}

/** Which doors the sign-in page shows. Google is hidden only when the password is on and
 *  Google is not configured; with neither configured it still shows Google, whose 503
 *  says what is missing. */
export interface SignInOptions {
  password: boolean;
  google: boolean;
}

export function signInOptions(env: Env): SignInOptions {
  const password = passwordEnabled(env);
  const googleConfigured = Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
  return { password, google: googleConfigured || !password };
}

/** True when the optional shared-password sign-in is configured. */
export function passwordEnabled(env: Env): boolean {
  return Boolean((env.ADMIN_PASSWORD_HASH ?? "").trim());
}

/** POST /login/password — body `{"password": "..."}`.
 *
 *  Gated like every console mutation by the `x-nexus-console` header (a non-simple header,
 *  so a cross-site page cannot send it without a CORS preflight this Worker never grants).
 *  Wrong and unknown answers are the same generic 401; five failures per client in 15
 *  minutes earn a 429 (per isolate only; see password.ts). */
export async function passwordLogin(env: Env, request: Request): Promise<Response> {
  if (!passwordEnabled(env)) return json(404, { error: { message: "password sign-in is not enabled" } });
  if (!env.ADMIN_SESSION_SECRET) return json(503, { error: { message: "ADMIN_SESSION_SECRET is not set" } });
  if (!csrfOk(request)) return json(403, { error: { message: "missing console header" } });

  const client = request.headers.get("cf-connecting-ip") ?? "unknown";
  const wait = lockedFor(client);
  if (wait > 0) {
    return json(429, { error: { message: "Too many attempts. Try again later." } }, { "retry-after": String(wait) });
  }

  const body = await readJsonObject<{ password?: unknown }>(request);
  if (!body) return invalidBody();
  const password = typeof body.password === "string" ? body.password : "";

  if (!(await verifyPassword(env.ADMIN_PASSWORD_HASH, password))) {
    recordFailure(client);
    return json(401, { error: { message: "Incorrect password." } });
  }
  clearFailures(client);
  return json(200, { ok: true }, { "set-cookie": sessionCookie(await mintSession(env, PASSWORD_IDENTITY)) });
}
