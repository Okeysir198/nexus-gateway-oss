import { BADGE, BADGE_TONES, BTN, BTN_SIZES, BTN_VARIANTS, INPUT, PW_BUTTON, PW_TOGGLE_JS, TABLE_CELL, TABLE_ROW } from "./ui";
import { TABS } from "./view_shell";

/** Shared client runtime: DOM helper, escaping, the fetch wrapper, tabs, toasts,
 *  the typed-confirmation modal, the theme + collapse toggles, and sign out.
 *
 *  No credential is held here. Auth rides on the HttpOnly session cookie, which JS
 *  cannot read — so an XSS in this console cannot steal the operator's session the way
 *  it could when the master key sat in sessionStorage. Every request carries
 *  `x-nexus-console: 1`; a cross-origin page cannot set that header without a CORS
 *  preflight we never answer, which is the CSRF backstop behind SameSite=Strict.
 *
 *  The class vocabulary (buttons, badges, fields) is interpolated from ui.ts at
 *  module-eval, the SAME constants the server-rendered markup uses, so JS-built rows
 *  cannot drift from the static ones. Every server value interpolated into HTML by the
 *  view scripts must go through esc(). */
export const CORE_JS = `
/* Progressive enhancement's first act: the page ships as .no-js (every panel visible,
   navs hidden); with scripting on, the radio+CSS tab mechanism takes over. */
document.body.classList.remove('no-js');
/* The class vocabulary, from ui.ts — one copy for markup and script alike. */
var BADGE_BASE = ${JSON.stringify(BADGE)};
var BADGE_TONES = ${JSON.stringify(BADGE_TONES)};
var BTN_CLS = ${JSON.stringify(BTN)};
var PW_BTN = ${JSON.stringify(PW_BUTTON)};
var CELL = ${JSON.stringify(TABLE_CELL)};
var ROW = ${JSON.stringify(TABLE_ROW)};
var MONO = 'font-mono tabular-nums';
${PW_TOGGLE_JS}
var BTN_VARS = ${JSON.stringify(BTN_VARIANTS)};
var BTN_SIZES = ${JSON.stringify(BTN_SIZES)};
var INPUT_CLS = ${JSON.stringify(INPUT)};
function btnAttrs(variant, size){
  return ' data-slot="button" data-variant="' + variant + '" data-size="' + size + '" class="' +
    BTN_CLS + ' ' + BTN_VARS[variant] + ' ' + BTN_SIZES[size] + '"';
}
function $(id){ return document.getElementById(id); }
function esc(s){
  return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
  });
}
async function api(method, path, body){
  var r = await fetch(path, {
    method: method,
    credentials: 'same-origin',
    headers: { 'content-type':'application/json', 'x-nexus-console':'1' },
    body: body ? JSON.stringify(body) : undefined
  });
  if (r.status === 401){ location.href = '/admin'; throw new Error('session expired'); }
  var j = null; try { j = await r.json(); } catch(e){}
  if (!r.ok) throw new Error((j && j.error && (j.error.message || j.error)) || ('HTTP ' + r.status));
  return j;
}
function toast(msg, kind){
  var el = document.createElement('div');
  el.className = 'toast relative flex w-72 items-start gap-2 rounded-md border bg-background p-3 text-sm shadow-md' +
    (kind === 'ok' ? ' border-l-2 border-l-primary' : kind === 'bad' ? ' border-l-2 border-l-destructive' : '');
  el.textContent = msg;
  $('toasts').appendChild(el);
  // A class, not el.style.* — assigning to the style property is an inline style, which
  // the page's CSP nonce does not cover (that needs style-src-attr 'unsafe-inline').
  setTimeout(function(){ el.classList.add('fade'); setTimeout(function(){ el.remove(); }, 320); }, 5200);
}
function showModal(title, html, confirmWord, onConfirm){
  var m = document.createElement('div');
  m.className = 'fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-5';
  m.innerHTML = '<div class="w-full max-w-md rounded-xl border bg-background p-6 shadow-lg"><h3 class="mb-3 text-lg font-semibold tracking-tight">' + esc(title) + '</h3>' + html +
    '<label for="confirmInput" class="mb-1 mt-3 block text-sm font-medium">Confirm</label>' +
    '<input id="confirmInput" class="' + INPUT_CLS + '" placeholder="type to confirm" autocomplete="off"/>' +
    '<div class="mt-4 flex justify-end gap-2">' +
      '<button type="button"' + btnAttrs('ghost','sm') + ' id="mCancel">Cancel</button>' +
      '<button type="button"' + btnAttrs('destructive','sm') + ' id="mOk" disabled>Confirm</button>' +
    '</div></div>';
  $('modalMount').appendChild(m);
  var input = m.querySelector('#confirmInput'), ok = m.querySelector('#mOk');
  input.oninput = function(){ ok.disabled = input.value.trim() !== confirmWord; };
  input.focus();
  m.querySelector('#mCancel').onclick = function(){ m.remove(); };
  ok.onclick = function(){ m.remove(); onConfirm(); };
  m.onclick = function(e){ if (e.target === m) m.remove(); };
}

/* Epoch seconds → "YYYY-MM-DD HH:MM". Shared helpers live here, not in a view, because
   page.ts concatenates the view scripts and a cross-view call would break silently if
   that order ever changed. */
function fmtDate(s){
  if (!s) return '—';
  var d = new Date(s * 1000);
  if (isNaN(d.getTime())) return '—';
  return d.toISOString().slice(0,16).replace('T',' ');
}

/* The status badge, ONE builder for the two-vocabulary shape: the tone carries the
   visuals (data-variant + tone utilities), the unstyled badge-* marker is what the word
   tests key on, and .badge-text is the truncation hook. Tones: success = ok,
   danger = destructive, warning = elevated-or-caveated, secondary = neutral. */
function chip(tone, marker, word){
  var t = BADGE_TONES[tone] || BADGE_TONES.secondary;
  return '<span data-slot="badge" data-variant="' + t.variant + '" class="' + BADGE_BASE + ' ' + t.classes +
    ' badge badge-' + marker + '"><span class="badge-text">' + word + '</span></span>';
}

/* The one-time secret reveal: shows a value the server will never show again. */
function revealOnce(mountId, intro, secret){
  var box = $(mountId);
  box.innerHTML =
    '<div class="mt-4 rounded-lg border bg-card p-4 text-sm"><b>' + esc(intro) + '</b> Copy it now; it will not be shown again.<code class="my-2 block break-all rounded-md bg-muted p-2.5 font-mono text-sm">' + esc(secret) + '</code>' +
    '<button type="button"' + btnAttrs('secondary','sm') + ' data-copy="1">Copy</button></div>';
  var btn = box.querySelector('button[data-copy]');
  btn.onclick = function(){
    navigator.clipboard.writeText(secret).then(function(){
      btn.textContent = 'Copied';
      setTimeout(function(){ btn.textContent = 'Copy'; }, 2000);
    });
  };
}

/* ---- account ---------------------------------------------------------------- */
/* Signing out is the only account action: sign-in happens on the login page. */
async function signOut(){
  try { await fetch('/admin/logout', { method:'POST', credentials:'same-origin', headers:{'x-nexus-console':'1'} }); }
  catch(e){}
  location.href = '/admin';
}

/* ---- theme ------------------------------------------------------------------ */
/* The server stamps class="dark" on <html> from the nexus-theme cookie, so the page never
   flashes the wrong palette. This script is the ONE writer of that preference (class +
   cookie); with no cookie we leave the class off — theme.css's default is light. One
   glyph shows at a time — the mode a click would BRING: sun while dark, moon while
   light. */
function themeIsDark(){
  return document.documentElement.classList.contains('dark');
}
function paintTheme(){
  $('theme-toggle').classList.toggle('is-dark', themeIsDark());
}
function setTheme(dark){
  document.documentElement.classList.toggle('dark', dark);
  document.cookie = 'nexus-theme=' + (dark ? 'dark' : 'light') + '; Path=/; Max-Age=31536000; SameSite=Lax';
  paintTheme();
}

/* ---- tabs ------------------------------------------------------------------- */
/* Tabs are hidden radios; both navs are labels over the same radios. Checking a radio is
   the whole switch — CSS does the reveal (styles.ts) — so this only has to keep the
   hash, the breadcrumb and the view's data in step. The list is INTERPOLATED from
   view_shell.ts's TABS: one declared list, and page_render's tripwire fails if
   someone hand-edits this. */
var TABS = ${JSON.stringify(TABS)};

function syncCrumb(which){
  var lab = $('lab-' + which);
  var text = lab ? lab.querySelector('span') : null;
  $('crumb-here').textContent = text ? text.textContent : '';
}

/* Deep links: /admin#providers raises Providers. Guarded typeof — every refresh is
   defined by its own view's script, concatenated before this one. */
function selectTab(which){
  var radio = $('tab-' + which);
  if (!radio) return false;
  radio.checked = true;
  syncCrumb(which);
  if (which === 'keys' && typeof refreshKeys === 'function') refreshKeys();
  if (which === 'providers' && typeof refreshProviders === 'function') refreshProviders();
  return true;
}

function currentTab(){
  var h = (location.hash || '').slice(1);
  return TABS.indexOf(h) !== -1 ? h : 'keys';
}

/* Sidebar collapse: the script flips data-state/data-collapsible on the peer,
   and the group-data-[collapsible=icon] utilities do the shrinking. The choice
   rides the cookie jar like the theme. No-JS keeps the default (expanded). */
function paintSidebar(){
  var collapsed = document.cookie.indexOf('nexus-rail=collapsed') !== -1;
  var sb = document.querySelector('[data-slot="sidebar"]');
  if (sb){
    sb.setAttribute('data-state', collapsed ? 'collapsed' : 'expanded');
    sb.setAttribute('data-collapsible', collapsed ? 'icon' : '');
    var t = $('sidebar-toggle');
    if (t) t.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  }
}

/* ---- boot ------------------------------------------------------------------- */
$('sidebar-toggle').onclick = function(){
  var collapsed = document.cookie.indexOf('nexus-rail=collapsed') !== -1;
  document.cookie = 'nexus-rail=' + (collapsed ? 'open' : 'collapsed') +
    '; Path=/; Max-Age=31536000; SameSite=Lax';
  paintSidebar();
};
$('theme-toggle').onclick = function(){ setTheme(!themeIsDark()); };
$('outBtn').onclick = signOut;
$('genBtn').onclick = generateKey;
paintTheme();
paintSidebar();

TABS.forEach(function(t){
  var r = $('tab-' + t);
  if (r) r.addEventListener('change', function(){
    if (r.checked){ location.hash = t; selectTab(t); }
  });
});
/* Deep links only: a click already ran selectTab in the change handler, and setting
   the hash above fires this — re-selecting here would fetch every view twice. */
window.addEventListener('hashchange', function(){
  var w = currentTab();
  var r = $('tab-' + w);
  if (r && !r.checked) selectTab(w);
});

(async function boot(){
  try {
    var me = await api('GET','/admin/whoami');
    $('who').textContent = me.email || '';
  } catch(e){ return; }

  selectTab(currentTab());
})();
`;
