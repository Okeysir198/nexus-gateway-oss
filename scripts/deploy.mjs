#!/usr/bin/env node
// One-command deployment of nexus-gateway to your own Cloudflare account and domain.
//
//   export CLOUDFLARE_API_TOKEN=...            # see "Token" below
//   node scripts/deploy.mjs --domain gateway.example.com
//
// It is safe to run again: every step checks what exists first. It creates, under a name
// that is NOT the default `nexus-gateway` (so it cannot clobber another deployment):
//   - a D1 database (and loads schema.sql)
//   - an AI Gateway, plus the custom AI Gateway providers the bundled config uses
//   - the Worker, its custom domain, and its secrets
// then prints the console URL and password. Add your provider API keys in the console.
//
//   node scripts/deploy.mjs --domain gateway.example.com --name my-gateway
//   node scripts/deploy.mjs --workers-dev            # no custom domain
//   node scripts/deploy.mjs --name my-gateway --destroy   # remove what it created
//
// Options: --domain HOST   custom domain on a zone in your account
//          --workers-dev   serve on <name>.<subdomain>.workers.dev instead
//          --name NAME     Worker name (default nexus-gateway-oss); D1 and AI Gateway reuse it
//          --account-id ID needed only if the token sees several accounts
//          --destroy       delete what this script created for --name (asks first)
//          --yes           skip the confirmation prompt
//
// Token: create one at dash.cloudflare.com > My Profile > API Tokens with, on the account:
//   Workers Scripts: Edit, D1: Edit, AI Gateway: Edit; and on the zone of --domain:
//   Workers Routes: Edit (or "Workers: Edit"), DNS: Edit, Zone: Read.
//
// Optional: export AIG_API_TOKEN=... (a SEPARATE token with only "AI Gateway: Edit") before
// deploying, and it is stored as a Worker secret so the console can register custom
// providers for you. Do not reuse the broader deploy token for this.
//
// What it writes locally (all gitignored, in .deploy/): <name>.toml (the wrangler config it
// generated), <name>.json (what it created, so --destroy knows), <name>.secrets.env (the
// generated master key and console password, mode 600; Worker secrets cannot be read back).
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { b64url, hashPassword } from "./lib/password-hash.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEPLOY_DIR = join(ROOT, ".deploy");
const API = "https://api.cloudflare.com/client/v4";

// Custom AI Gateway providers the bundled src/config.default.json refers to as `custom-<slug>`.
const CUSTOM_PROVIDERS = [
  { name: "NVIDIA", slug: "nvidia", base_url: "https://integrate.api.nvidia.com" },
  { name: "Z.AI", slug: "zai", base_url: "https://api.z.ai" },
  { name: "Z.AI Anthropic", slug: "zai-anthropic", base_url: "https://api.z.ai" },
];

// ── small helpers ───────────────────────────────────────────────────────────────────
const args = parseArgs(process.argv.slice(2));
const say = (m) => console.log(m);
const step = (m) => console.log(`\n==> ${m}`);
function die(msg) {
  console.error(`\nERROR: ${msg}`);
  process.exit(1);
}

function parseArgs(argv) {
  const o = { yes: false, destroy: false, workersDev: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => argv[++i] ?? die(`${a} needs a value`);
    if (a === "--domain") o.domain = val();
    else if (a === "--name") o.name = val();
    else if (a === "--account-id") o.accountId = val();
    else if (a === "--workers-dev") o.workersDev = true;
    else if (a === "--destroy") o.destroy = true;
    else if (a === "--yes" || a === "-y") o.yes = true;
    else if (a === "--help" || a === "-h") {
      console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").filter((l) => l.startsWith("//")).map((l) => l.slice(3)).join("\n"));
      process.exit(0);
    } else die(`unknown option ${a} (try --help)`);
  }
  return o;
}

const token = process.env.CLOUDFLARE_API_TOKEN;

async function cf(method, path, body, { allow404 = false } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    // non-JSON error body
  }
  if (res.status === 404 && allow404) return null;
  if (!res.ok || json?.success === false) {
    const why = (json?.errors ?? []).map((e) => `${e.code}: ${e.message}`).join("; ") || `HTTP ${res.status}`;
    throw new Error(`${method} ${path} failed: ${why}`);
  }
  return json?.result;
}

function wrangler(wargs, input) {
  const r = spawnSync("npx", ["wrangler", ...wargs], {
    cwd: ROOT,
    encoding: "utf8",
    input,
    env: { ...process.env, CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: state.accountId ?? process.env.CLOUDFLARE_ACCOUNT_ID, WRANGLER_SEND_METRICS: "false" },
  });
  if (r.status !== 0) {
    die(`wrangler ${wargs[0]} failed:\n${(r.stderr || r.stdout || "").trim().split("\n").slice(-12).join("\n")}`);
  }
}

async function confirm(question) {
  if (args.yes) return true;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const a = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
  rl.close();
  return a === "y" || a === "yes";
}

const randomSecret = (bytes = 32) => b64url(randomBytes(bytes));

// ── state ───────────────────────────────────────────────────────────────────────────
const name = args.name ?? "nexus-gateway-oss";
if (!/^[a-z0-9][a-z0-9-]{1,50}$/.test(name)) die("--name must be lowercase letters, digits and dashes");
const statePath = join(DEPLOY_DIR, `${name}.json`);
const secretsPath = join(DEPLOY_DIR, `${name}.secrets.env`);
const configPath = join(DEPLOY_DIR, `${name}.toml`);
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : { created: {} };
const saveState = () => {
  mkdirSync(DEPLOY_DIR, { recursive: true });
  writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");
};

// ── main ────────────────────────────────────────────────────────────────────────────
if (!token) {
  die("set CLOUDFLARE_API_TOKEN (see the 'Token' notes at the top of scripts/deploy.mjs or run with --help)");
}
if (Number(process.versions.node.split(".")[0]) < 20) die("Node 20 or newer is required");
if (!existsSync(join(ROOT, "node_modules"))) die("run `npm install` first");

await (args.destroy ? destroy() : deploy());

async function resolveAccount() {
  step("Checking the API token");
  await cf("GET", "/user/tokens/verify");
  const accounts = await cf("GET", "/accounts");
  if (args.accountId) {
    const a = accounts.find((x) => x.id === args.accountId);
    if (!a) die(`--account-id ${args.accountId} is not visible to this token`);
    state.accountId = a.id;
  } else if (accounts.length === 1) {
    state.accountId = accounts[0].id;
  } else {
    die(`the token sees ${accounts.length} accounts; pass --account-id (${accounts.map((a) => `${a.id} ${a.name}`).join(", ")})`);
  }
  say(`    account ${state.accountId}`);
}

async function deploy() {
  if (!args.domain && !args.workersDev) die("pass --domain HOST (custom domain) or --workers-dev");
  await resolveAccount();
  const acc = state.accountId;

  // 1. Never touch a Worker or database this script did not create.
  step("Checking for name collisions");
  const scripts = await cf("GET", `/accounts/${acc}/workers/scripts`);
  const workerExists = scripts.some((s) => s.id === name);
  if (workerExists && !state.created.worker) {
    die(`a Worker named "${name}" already exists in this account and was not created by this script.\n` +
      `Pick another name with --name, so an existing deployment is not overwritten.`);
  }
  say(workerExists ? `    "${name}" is ours (re-deploying)` : `    "${name}" is free`);

  // 2. Zone for the custom domain.
  let zone = null;
  if (args.domain) {
    step(`Finding the zone for ${args.domain}`);
    zone = await findZone(args.domain);
    const domains = await cf("GET", `/accounts/${acc}/workers/domains`);
    const attached = domains.find((d) => d.hostname === args.domain);
    if (attached && attached.service !== name) {
      die(`${args.domain} is already attached to the Worker "${attached.service}". Choose another --domain.`);
    }
    if (!attached) {
      const recs = await cf("GET", `/zones/${zone.id}/dns_records?name=${encodeURIComponent(args.domain)}`);
      if (recs.length) die(`${args.domain} already has a DNS record (${recs[0].type}). Remove it or choose another --domain.`);
    }
    say(`    zone ${zone.name}`);
  }

  // 3. D1.
  step("D1 database");
  const dbName = `${name}-keys`;
  const dbs = await cf("GET", `/accounts/${acc}/d1/database?name=${encodeURIComponent(dbName)}`);
  let db = dbs.find((d) => d.name === dbName);
  if (db && !state.created.d1) die(`a D1 database "${dbName}" already exists and was not created by this script. Use another --name.`);
  if (!db) {
    db = await cf("POST", `/accounts/${acc}/d1/database`, { name: dbName });
    state.created.d1 = { id: db.uuid, name: dbName };
    saveState();
    say(`    created ${dbName}`);
  } else {
    say(`    reusing ${dbName}`);
  }

  // 4. AI Gateway + custom providers.
  step("AI Gateway");
  const gwId = name;
  const gw = await cf("GET", `/accounts/${acc}/ai-gateway/gateways/${gwId}`, undefined, { allow404: true });
  if (!gw) {
    await cf("POST", `/accounts/${acc}/ai-gateway/gateways`, {
      id: gwId,
      collect_logs: true,
      cache_ttl: 0,
      cache_invalidate_on_update: false,
      rate_limiting_interval: 0,
      rate_limiting_limit: 0,
      rate_limiting_technique: "sliding",
    });
    state.created.gateway = gwId;
    saveState();
    say(`    created gateway ${gwId}`);
  } else {
    if (!state.created.gateway) die(`an AI Gateway "${gwId}" already exists and was not created by this script. Use another --name.`);
    say(`    reusing gateway ${gwId}`);
  }

  step("Custom AI Gateway providers");
  const existing = await cf("GET", `/accounts/${acc}/ai-gateway/custom-providers`);
  state.created.customProviders ??= [];
  for (const p of CUSTOM_PROVIDERS) {
    const found = existing.find((e) => e.slug === p.slug);
    if (found) {
      say(`    ${p.slug}: already registered (left untouched)`);
      continue;
    }
    const made = await cf("POST", `/accounts/${acc}/ai-gateway/custom-providers`, { name: p.name, slug: p.slug, base_url: p.base_url, enable: true });
    state.created.customProviders.push({ slug: p.slug, id: made.id ?? made.slug });
    saveState();
    say(`    ${p.slug}: registered`);
  }

  // 5. Generated wrangler config (the repo's wrangler.toml stays a clean template).
  step("Writing the wrangler config");
  writeConfig(db.uuid, dbName, gwId, acc);
  say(`    ${configPath}`);

  // 6. Schema.
  step("Loading the database schema");
  wrangler(["d1", "execute", dbName, "--remote", "--config", configPath, "--file", join(ROOT, "schema.sql")]);

  // 7. Secrets (generated once; kept locally because Worker secrets cannot be read back).
  const secrets = loadSecrets();
  if (!secrets.NEXUS_MASTER_KEY) {
    secrets.NEXUS_MASTER_KEY = randomSecret();
    secrets.ADMIN_SESSION_SECRET = randomSecret();
    secrets.CONSOLE_PASSWORD = randomSecret(18);
    saveSecrets(secrets);
    say("    generated new secrets");
  } else {
    say("    reusing the secrets saved in .deploy/");
  }

  // 8. Deploy, then set secrets (a secret needs the Worker to exist).
  step("Deploying the Worker");
  wrangler(["deploy", "--config", configPath]);
  state.created.worker = name;
  if (args.domain) state.created.domain = args.domain;
  saveState();

  step("Setting the Worker secrets");
  wrangler(
    ["secret", "bulk", "--config", configPath],
    JSON.stringify({
      NEXUS_MASTER_KEY: secrets.NEXUS_MASTER_KEY,
      ADMIN_SESSION_SECRET: secrets.ADMIN_SESSION_SECRET,
      ADMIN_PASSWORD_HASH: hashPassword(secrets.CONSOLE_PASSWORD),
      // Optional: lets the console register custom providers in AI Gateway.
      ...(process.env.AIG_API_TOKEN ? { AIG_API_TOKEN: process.env.AIG_API_TOKEN } : {}),
    }),
  );

  // 9. Verify against the live URL.
  const base = args.domain ? `https://${args.domain}` : await workersDevUrl(acc);
  step(`Verifying ${base}`);
  await verify(base, secrets);

  say(`\nDone.\n`);
  say(`  Console        ${base}/admin`);
  say(`  Password       ${secrets.CONSOLE_PASSWORD}`);
  say(`  Master key     saved in ${secretsPath}`);
  say(`\nNext: sign in, open Providers > Provider keys, paste your API keys, then API keys > Generate.`);
  say(`Remove everything this script created with: node scripts/deploy.mjs --name ${name} --destroy`);
}

async function findZone(host) {
  const parts = host.split(".");
  for (let i = 0; i < parts.length - 1; i++) {
    const candidate = parts.slice(i).join(".");
    const zones = await cf("GET", `/zones?name=${encodeURIComponent(candidate)}`);
    if (zones.length) return zones[0];
  }
  die(`no zone for ${host} in this account. Add the domain to Cloudflare first, or use --workers-dev.`);
}

function writeConfig(dbId, dbName, gwId, acc) {
  let t = readFileSync(join(ROOT, "wrangler.toml"), "utf8");
  const sub = (re, to, label) => {
    if (!re.test(t)) die(`wrangler.toml no longer matches what deploy.mjs expects (${label}). Update the script.`);
    t = t.replace(re, to);
  };
  sub(/^name = ".*"$/m, `name = "${name}"`, "name");
  sub(/^main = ".*"$/m, 'main = "../src/index.ts"', "main");
  sub(/^database_name = ".*"$/m, `database_name = "${dbName}"`, "database_name");
  sub(/^database_id = ".*"$/m, `database_id = "${dbId}"`, "database_id");
  sub(/^CF_ACCOUNT_ID = ".*"$/m, `CF_ACCOUNT_ID = "${acc}"`, "CF_ACCOUNT_ID");
  sub(/^AIG_GATEWAY_ID = ".*"$/m, `AIG_GATEWAY_ID = "${gwId}"`, "AIG_GATEWAY_ID");
  if (args.domain) {
    sub(/^# routes = \[\n#   \{[^\n]*\}\n# \]$/m, `routes = [\n  { pattern = "${args.domain}", custom_domain = true }\n]`, "routes block");
  }
  mkdirSync(DEPLOY_DIR, { recursive: true });
  writeFileSync(configPath, `# GENERATED by scripts/deploy.mjs for "${name}". Do not commit; safe to delete.\n${t}`);
}

function loadSecrets() {
  const out = {};
  if (!existsSync(secretsPath)) return out;
  for (const line of readFileSync(secretsPath, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function saveSecrets(s) {
  mkdirSync(DEPLOY_DIR, { recursive: true });
  writeFileSync(
    secretsPath,
    `# Generated by scripts/deploy.mjs for "${name}". Keep private; never commit.\n` +
      Object.entries(s).map(([k, v]) => `${k}=${v}`).join("\n") + "\n",
    { mode: 0o600 },
  );
  chmodSync(secretsPath, 0o600);
}

async function workersDevUrl(acc) {
  const sub = await cf("GET", `/accounts/${acc}/workers/subdomain`);
  return `https://${name}.${sub.subdomain}.workers.dev`;
}

// Fresh custom domains take a little while for DNS and the certificate, so retry.
async function verify(base, secrets) {
  const deadline = Date.now() + 4 * 60_000;
  let lastErr = "";
  for (;;) {
    try {
      const h = await fetch(`${base}/health`);
      if (h.ok) break;
      lastErr = `/health returned ${h.status}`;
    } catch (e) {
      lastErr = String(e.cause?.code ?? e.message);
    }
    if (Date.now() > deadline) die(`${base} is not healthy yet (${lastErr}). Wait a minute and re-run the script.`);
    process.stdout.write(".");
    await new Promise((r) => setTimeout(r, 5000));
  }
  say("\n    /health ok");

  // Secrets can take a few seconds to become live after the upload.
  let cookie = "";
  for (let i = 0; i < 6 && !cookie; i++) {
    const r = await fetch(`${base}/login/password`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-nexus-console": "1" },
      body: JSON.stringify({ password: secrets.CONSOLE_PASSWORD }),
    });
    if (r.ok) cookie = (r.headers.get("set-cookie") ?? "").split(";")[0];
    else await new Promise((res) => setTimeout(res, 3000));
  }
  if (!cookie) die("console password sign-in failed after deploy; check `npx wrangler tail`");
  say("    console sign-in ok");

  const key = await fetch(`${base}/key/generate`, {
    method: "POST",
    headers: { authorization: `Bearer ${secrets.NEXUS_MASTER_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ key_alias: "deploy-check", duration: "1h" }),
  });
  if (!key.ok) die(`minting a virtual key failed (${key.status}); the D1 schema may not be loaded`);
  const minted = await key.json();
  const raw = minted.key ?? minted.token;
  if (raw) {
    await fetch(`${base}/key/delete`, {
      method: "POST",
      headers: { authorization: `Bearer ${secrets.NEXUS_MASTER_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ keys: [raw] }),
    });
  }
  say("    virtual keys (D1) ok");
}

async function destroy() {
  if (!existsSync(statePath)) die(`nothing to remove: no ${statePath}. Only deployments made by this script can be destroyed.`);
  await resolveAccount();
  const acc = state.accountId;
  const c = state.created;
  say("\nThis will delete, from the account:");
  if (c.domain) say(`  custom domain  ${c.domain}`);
  if (c.worker) say(`  Worker         ${c.worker}`);
  if (c.d1) say(`  D1 database    ${c.d1.name} (all virtual keys and stored provider keys)`);
  if (c.gateway) say(`  AI Gateway     ${c.gateway} (and its logs)`);
  for (const p of c.customProviders ?? []) say(`  custom provider ${p.slug}`);
  say("Nothing else is touched.");
  if (!(await confirm("Delete these?"))) die("aborted");

  if (c.domain) {
    const domains = await cf("GET", `/accounts/${acc}/workers/domains`);
    const d = domains.find((x) => x.hostname === c.domain && x.service === c.worker);
    if (d) {
      await cf("DELETE", `/accounts/${acc}/workers/domains/${d.id}`);
      say(`removed domain ${c.domain}`);
    }
  }
  if (c.worker) {
    await cf("DELETE", `/accounts/${acc}/workers/scripts/${c.worker}?force=true`, undefined, { allow404: true });
    say(`deleted Worker ${c.worker}`);
  }
  if (c.d1) {
    await cf("DELETE", `/accounts/${acc}/d1/database/${c.d1.id}`, undefined, { allow404: true });
    say(`deleted D1 ${c.d1.name}`);
  }
  if (c.gateway) {
    await cf("DELETE", `/accounts/${acc}/ai-gateway/gateways/${c.gateway}`, undefined, { allow404: true });
    say(`deleted AI Gateway ${c.gateway}`);
  }
  for (const p of c.customProviders ?? []) {
    await cf("DELETE", `/accounts/${acc}/ai-gateway/custom-providers/${p.id}`, undefined, { allow404: true });
    say(`deleted custom provider ${p.slug}`);
  }
  for (const f of [statePath, secretsPath, configPath]) rmSync(f, { force: true });
  say("\nDone. Local files in .deploy/ for this name were removed too.");
}
