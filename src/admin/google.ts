/** Google OAuth, login (authentication) ONLY.
 *
 *  Authorization-code flow with `openid email` scopes only. There are no Gmail scopes
 *  here and no offline access: this server never acts on a user's Google account.
 *  Google answers one question — which email is signing in — and OPERATOR_EMAILS
 *  decides whether that email may in.
 *
 *  ⚠️ The redirect URI (`https://<your-host>/oauth/google/callback`) must be listed in
 *  the OAuth client's authorised redirect URIs (append, never replace, if the client is
 *  shared with other apps), or Google answers redirect_uri_mismatch before this Worker
 *  is ever reached. */
const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";

const LOGIN_SCOPES = "openid email";

export interface GoogleTokensResponse {
  access_token: string;
  expires_in: number;
  scope: string;
}

/** Authentication-only consent: who are you? */
export function googleLoginUrl(clientId: string, redirectUri: string, state: string): string {
  const url = new URL(GOOGLE_AUTH_URL);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", LOGIN_SCOPES);
  url.searchParams.set("prompt", "select_account");
  url.searchParams.set("state", state);
  return url.toString();
}

export async function exchangeGoogleCode(
  clientId: string,
  clientSecret: string,
  redirectUri: string,
  code: string,
): Promise<GoogleTokensResponse> {
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    }),
  });
  if (!res.ok) {
    throw new Error(`Google code exchange failed: ${(await res.text()).slice(0, 300)}`);
  }
  return res.json();
}

export async function fetchGoogleEmail(accessToken: string): Promise<{ sub: string; email: string }> {
  const res = await fetch(GOOGLE_USERINFO_URL, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Google userinfo failed: ${res.status}`);
  const data = (await res.json()) as { sub?: string; id?: string; email?: string };
  if (!data.email || (!data.sub && !data.id)) throw new Error("Google userinfo missing email/sub");
  return { sub: data.sub ?? data.id!, email: data.email };
}

/** ⚠️ An empty OPERATOR_EMAILS denies everyone. Half-configured means unconfigured:
 *  an allowlist that silently admits the world is the failure worth preventing. */
export function isOperator(operatorEmails: string, email: string): boolean {
  const allowed = operatorEmails.split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
  return allowed.length > 0 && allowed.includes(email.trim().toLowerCase());
}
