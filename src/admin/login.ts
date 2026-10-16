import type { Env } from "../types";
import { json } from "../errors";
import { clearCookie, mintSession, readCookie, sessionCookie, verifySession } from "./session";
import { exchangeGoogleCode, fetchGoogleEmail, googleLoginUrl, isOperator } from "./google";
import { BTN, BTN_VARIANTS, CARD, CARD_CONTENT, CARD_DESCRIPTION, CARD_HEADER, CARD_TITLE } from "./ui";
import { newNonce, securityHeaders, styleTag, themeAttr } from "./page";

/** /admin login (Google-only) and logout.
 *
 *  One way in: Google signs in, OPERATOR_EMAILS (fail-closed) decides
 *  who is an operator, and a successful consent is exchanged for a signed HttpOnly
 *  session cookie. The username+password console (D1 admin_users, PBKDF2, the login
 *  throttle, POST /admin/bootstrap and the session_epoch) was deleted with it — Google
 *  now owns credential abuse, so there is no password to throttle and no bootstrap to
 *  gate. The master key is NOT a way into the console; it stays the credential for
 *  machine callers hitting /key/* directly. */

export interface AdminIdentity {
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

/** The Google "G" glyph, monochrome via currentColor — the login block's own inline
 *  SVG, carried over from login-04. */
const GOOGLE_G =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" class="size-4 shrink-0" aria-hidden="true" focusable="false">' +
  '<path fill="currentColor" d="M12.48 10.92v3.28h7.84c-.24 1.84-.853 3.187-1.787 4.133-1.147 1.147-2.933 2.4-6.053 2.4-4.827 0-8.6-3.893-8.6-8.72s3.773-8.72 8.6-8.72c2.6 0 4.507 1.027 5.907 2.347l2.307-2.307C18.747 1.44 16.133 0 12.48 0 5.867 0 .307 5.387.307 12s5.56 12 12.173 12c3.573 0 6.267-1.173 8.373-3.36 2.16-2.16 2.84-5.213 2.84-7.667 0-.76-.053-1.467-.173-2.053H12.48z"/></svg>';

/** The sign-in card, stock shadcn login-03's shape: centered
 *  bg-muted ground, the brand lockup as a link on top, ONE Card with a centered
 *  header and a single outline button. No Apple, no divider, no email/password
 *  fields — no fake doors: ONE door, and the callback's error paths reuse the same
 *  markup with the error slot filled, so a failed sign-in cannot look like a
 *  different app. `form-action 'none'` holds: the door is a link, not a POST. */
function signCard(errorMessage: string): string {
  const btnAttrs = ' data-slot="button" data-variant="outline" data-size="default"';
  const outlineBtn = BTN + " " + BTN_VARIANTS.outline;
  const err = errorMessage
    ? '<p class="text-sm text-destructive" role="alert" aria-live="assertive">' +
      errorMessage.replace(/[<>&]/g, "") +
      "</p>"
    : "";
  return (
    '<div class="flex min-h-svh flex-col items-center justify-center gap-6 bg-muted p-6 md:p-10">' +
    '<div class="flex w-full max-w-sm flex-col gap-6">' +
    // The stock login-03 lockup, re-pointed from "#" at the console root.
    '<a href="/admin" class="flex items-center gap-2 self-center font-medium">' +
    '<div class="flex size-6 items-center justify-center rounded-md bg-primary text-primary-foreground font-mono text-xs font-bold" aria-hidden="true">n</div>' +
    'nexus<span class="font-normal text-muted-foreground">-gateway</span></a>' +
    '<div class="flex flex-col gap-6">' +
    '<div data-slot="card" class="' + CARD + '">' +
    '<div data-slot="card-header" class="' + CARD_HEADER + ' text-center">' +
    '<h1 data-slot="card-title" class="' + CARD_TITLE + ' text-xl">Operator console</h1>' +
    '<p data-slot="card-description" class="' + CARD_DESCRIPTION + '">Manage keys and providers — sign in with your Google account</p>' +
    "</div>" +
    '<div data-slot="card-content" class="' + CARD_CONTENT + '">' +
    err +
    '<a href="/login/google"' + btnAttrs + ' class="' + outlineBtn + ' w-full">' +
    GOOGLE_G +
    "Sign in with Google</a>" +
    "</div></div>" +
    '<p class="px-6 text-center text-sm text-muted-foreground">Access is limited to the listed operator addresses. Sign-in is Google &mdash; this console never sees a password.</p>' +
    "</div></div>"
  );
}

function signInResponse(request: Request, errorMessage: string, status: number): Response {
  const nonce = newNonce();
  return new Response(
    `<!DOCTYPE html>
<html lang="en"${themeAttr(request)}><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>nexus · sign in</title>
${styleTag(nonce)}
</head><body>
${signCard(errorMessage)}
</body></html>`,
    { status, headers: securityHeaders(nonce) },
  );
}

/** The callback's error paths reuse the sign-in page with the message slot filled. */
function messagePage(request: Request, message: string, status: number): Response {
  return signInResponse(request, message, status);
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

  const url = new URL(request.url);
  const code = url.searchParams.get("code") ?? "";
  const state = url.searchParams.get("state") ?? "";
  const cookieState = readCookie(request, "g_state") ?? "";
  if (!code || !state || state !== cookieState) {
    return messagePage(request, "Sign-in could not be verified. Please try again.", 400);
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
    return messagePage(request, "Google sign-in failed. Please try again.", 502);
  }

  // ⚠️ An empty OPERATOR_EMAILS denies everyone, deliberately. An allowlist that
  // silently admits the world is worse than one that locks the owner out.
  if (!isOperator(operators, email)) {
    return messagePage(request, "That account is not an operator of this gateway.", 403);
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
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "content-type": "application/json", "set-cookie": clearCookie() },
  });
}

/** The sign-in page. One door: Google.
 *
 *  It shares the console's stylesheet (STYLE_BODY = fonts + compiled theme + generated
 *  tab rules) and its nonce-based CSP rather than carrying a private copy of either. */
export function loginPage(request: Request): Response {
  return signInResponse(request, "", 200);
}
