import {
  BTN,
  BTN_SIZES,
  BTN_VARIANTS,
  CARD,
  CARD_ACTION,
  CARD_CONTENT,
  CARD_DESCRIPTION,
  CARD_HEADER,
  CARD_TITLE,
  EMPTY,
  INPUT,
  LABEL,
  pwWrap,
  NATIVE_SELECT,
  NATIVE_SELECT_ICON,
  NATIVE_SELECT_WRAPPER,
  TABLE,
  TABLE_BODY,
  TABLE_CONTAINER,
  TABLE_HEAD,
  TABLE_HEADER,
  TABLE_ROW,
} from "./ui";
import { I } from "./icons";

/** Providers tab: one list, one row per provider, with its API key inline.
 *
 *  A row says whether the provider is ready (enabled and has a key), takes the key right
 *  there, and offers Disable/Delete. The secret name, slug and upstream are details, not the
 *  headline. Adding a provider needs no deploy: the row overlays the bundled config within
 *  60s. Bundled providers can be disabled but not deleted (they return on the next deploy).
 *  Keys come from /admin/api/provider-keys; which secrets a provider uses is read from
 *  each key's `providers` list. */

const FIELD = "grid gap-2";
const FORM_GRID = "grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 lg:items-start";

function hintHtml(hint?: string): string {
  return hint ? '<p class="text-xs text-muted-foreground">' + hint + "</p>" : "";
}

function field(id: string, label: string, placeholder: string, hint?: string): string {
  return (
    '<div class="' + FIELD + '"><label for="' + id + '" data-slot="label" class="' + LABEL + '">' + label + "</label>" +
    '<input id="' + id + '" data-slot="input" class="' + INPUT + '" placeholder="' + placeholder + '" autocomplete="off" />' +
    hintHtml(hint) + "</div>"
  );
}

function selectField(id: string, label: string, options: string): string {
  return (
    '<div class="' + FIELD + '"><label for="' + id + '" data-slot="label" class="' + LABEL + '">' + label + "</label>" +
    '<div data-slot="native-select-wrapper" class="' + NATIVE_SELECT_WRAPPER + ' w-full">' +
    '<select id="' + id + '" data-slot="native-select" data-size="default" class="' + NATIVE_SELECT + '">' + options + "</select>" +
    '<span class="' + NATIVE_SELECT_ICON + '" data-slot="native-select-icon" aria-hidden="true">' + I.chevronDown + "</span></div></div>"
  );
}

function secretField(id: string, label: string, placeholder: string, hint?: string): string {
  return (
    '<div class="' + FIELD + '"><label for="' + id + '" data-slot="label" class="' + LABEL + '">' + label + "</label>" +
    pwWrap('<input id="' + id + '" type="password" data-slot="input" class="' + INPUT + ' pr-10" placeholder="' + placeholder + '" autocomplete="off" />') +
    hintHtml(hint) + "</div>"
  );
}

export const PROVIDERS_HTML = `
  <section data-slot="card" class="${CARD}">
    <div data-slot="card-header" class="${CARD_HEADER}">
      <div data-slot="card-title" class="${CARD_TITLE}">Providers <span class="font-normal text-muted-foreground" id="pCount"></span></div>
      <div data-slot="card-description" class="${CARD_DESCRIPTION}">
        Add an API key to a provider to start using it. Callers reach a provider as
        <code class="rounded-md bg-muted px-1.5 py-0.5 font-mono text-xs">prefix/model</code>, for example
        <code class="rounded-md bg-muted px-1.5 py-0.5 font-mono text-xs">groq/llama-3.3-70b-versatile</code>.
      </div>
      <div data-slot="card-action" class="${CARD_ACTION} flex items-center gap-2">
        <input id="pFilter" data-slot="input" class="${INPUT} h-8 w-40 px-2.5 text-xs" placeholder="Filter…" autocomplete="off" />
        <button type="button" data-slot="button" data-variant="default" data-size="sm" class="${BTN} ${BTN_VARIANTS.default} ${BTN_SIZES.sm}" id="pNew">Add provider</button>
      </div>
    </div>
    <div data-slot="card-content" class="${CARD_CONTENT}">
      <div data-slot="table-container" class="${TABLE_CONTAINER}">
        <table data-slot="table" class="${TABLE}">
          <thead data-slot="table-header" class="${TABLE_HEADER}">
            <tr data-slot="table-row" class="${TABLE_ROW}">
              <th data-slot="table-head" class="${TABLE_HEAD}">Provider</th>
              <th data-slot="table-head" class="${TABLE_HEAD}">Status</th>
              <th data-slot="table-head" class="${TABLE_HEAD}">API key</th>
              <th data-slot="table-head" class="${TABLE_HEAD}"></th>
            </tr>
          </thead>
          <tbody data-slot="table-body" class="${TABLE_BODY}" id="pRows"></tbody>
        </table>
      </div>
      <div class="${EMPTY}" id="pEmpty" hidden>No providers.</div>
      <p class="mt-3 text-sm text-muted-foreground" id="pMeta"></p>
    </div>
  </section>

  <section data-slot="card" class="${CARD}" id="pAddCard" hidden>
    <div data-slot="card-header" class="${CARD_HEADER}">
      <div data-slot="card-title" class="${CARD_TITLE}">Add a provider</div>
      <div data-slot="card-description" class="${CARD_DESCRIPTION}" id="pAddHint">
        Register it in AI Gateway first. Live within a minute.
      </div>
    </div>
    <div data-slot="card-content" class="${CARD_CONTENT}">
      <div class="${FORM_GRID}">
        ${field("pName", "Prefix", "e.g. deepseek", "What callers type before the model.")}
        <div id="pBaseWrap" hidden>
          ${field("pBase", "Base URL", "https://api.example.com", "Registers it in AI Gateway for you. Leave empty for a native provider.")}
        </div>
        ${field("pSlug", "AI Gateway slug", "e.g. deepseek or custom-mine", "A custom provider's slug starts with custom-.")}
        ${secretField("pKey", "API key", "paste key", "Stored encrypted. You can add it later.")}
      </div>
      <details class="mt-4">
        <summary class="cursor-pointer text-sm text-muted-foreground">Advanced</summary>
        <div class="mt-3 ${FORM_GRID}">
          ${field("pSecret", "Secret name", "DEEPSEEK_API_KEY", "Filled in from the prefix.")}
          ${field("pPath", "Path override", "/v1/chat/completions", "Only if the API path differs.")}
          ${selectField("pReasoning", "Reasoning dialect",
            '<option value="">none</option><option value="openrouter">openrouter</option><option value="openai_effort">openai_effort</option><option value="zai_thinking">zai_thinking</option>')}
          ${selectField("pUpstream", "Format",
            '<option value="openai_chat">OpenAI</option><option value="anthropic_native">Anthropic (no translation)</option>')}
          <div>
            <label class="flex cursor-pointer items-center gap-2 text-sm">
              <input type="checkbox" id="pDropTools" class="size-4 accent-primary" /> Remove tools from requests
            </label>
          </div>
        </div>
      </details>
      <div class="mt-3 text-sm text-destructive empty:mt-0" id="pErr"></div>
      <div class="mt-4 flex gap-2">
        <button type="button" data-slot="button" data-variant="default" data-size="default" class="${BTN} ${BTN_VARIANTS.default} ${BTN_SIZES.default}" id="pAdd">Save provider</button>
        <button type="button" data-slot="button" data-variant="outline" data-size="default" class="${BTN} ${BTN_VARIANTS.outline} ${BTN_SIZES.default}" id="pCancel">Cancel</button>
      </div>
    </div>
  </section>
`;

// NOTE: no backticks / ${} inside this string except the class-constant interpolations.
export const PROVIDERS_JS = `
var ALL_PROV = [], PROV_ALIASES = {}, PROV_CATCHALL = null, PKEYS = [];
var OPEN_POOLS = {}, EDITING = {};
/* The env-var-style name suggested for a provider's key, e.g. deepseek -> DEEPSEEK_API_KEY. */
function secretFromPrefix(prefix){
  var n = String(prefix || '').trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return n ? n + '_API_KEY' : '';
}

/* The secrets (and their stored/worker/missing state) a provider reads. */
function secretsFor(p){
  return PKEYS.filter(function(k){ return (k.providers || []).indexOf(p.name) !== -1; });
}

/* ready = enabled, and (no key needed, or at least one key is set). */
function providerState(p){
  if (p.enabled === false) return 'disabled';
  var ks = secretsFor(p);
  if (!ks.length) return 'ready';
  return ks.some(function(k){ return k.source !== 'missing'; }) ? 'ready' : 'needs';
}

/* One key control: an input (missing / replacing), or the saved state with Replace/Remove. */
function keyControl(k){
  if (k.source === 'worker')
    return '<span class="text-sm text-muted-foreground">Set in wrangler</span>';
  if (k.source === 'console' && !EDITING[k.secret])
    return '<span class="font-mono text-sm text-muted-foreground">····' + esc(k.hint || '') + '</span> ' +
      '<button type="button"' + btnAttrs('ghost','xs') + ' data-kedit="' + esc(k.secret) + '">Replace</button> ' +
      '<button type="button"' + btnAttrs('ghost','xs') + ' data-kdel="' + esc(k.secret) + '">Remove</button>';
  return '<span class="relative inline-block align-middle"><input type="password" autocomplete="off" placeholder="' +
      (k.source === 'console' ? 'New key' : 'Paste API key') + '" class="' + INPUT_CLS +
      ' h-8 w-52 px-2.5 pr-9 text-xs" data-kin="' + esc(k.secret) + '" />' + PW_BTN + '</span> ' +
    '<button type="button"' + btnAttrs('default','xs') + ' data-kset="' + esc(k.secret) + '">Save</button>' +
    (EDITING[k.secret] ? ' <button type="button"' + btnAttrs('ghost','xs') + ' data-kcancel="' + esc(k.secret) + '">Cancel</button>' : '');
}

function keyCell(p){
  var ks = secretsFor(p);
  if (!ks.length) return '<span class="text-sm text-muted-foreground">Not needed</span>';
  if (ks.length === 1) return keyControl(ks[0]);
  var set = ks.filter(function(k){ return k.source !== 'missing'; }).length;
  return '<span class="text-sm">' + set + ' of ' + ks.length + ' keys set</span> ' +
    '<button type="button"' + btnAttrs('outline','xs') + ' data-pool="' + esc(p.name) + '">' + (OPEN_POOLS[p.name] ? 'Hide keys' : 'Manage keys') + '</button>';
}

function statusChip(st){
  return st === 'ready' ? chip('success','ready','Ready')
    : st === 'needs' ? chip('warning','needs-key','Needs key')
    : chip('secondary','disabled','Disabled');
}

function addCell(tr, html, extra){
  var td = document.createElement('td');
  td.setAttribute('data-slot','table-cell');
  td.className = CELL + (extra ? ' ' + extra : '');
  td.innerHTML = html;
  tr.appendChild(td);
}

function renderProviders(d){
  if (d){ ALL_PROV = d.providers || []; PROV_ALIASES = d.aliases || {}; PROV_CATCHALL = d.catchAll; }
  var q = ($('pFilter').value || '').trim().toLowerCase();
  var order = { needs: 0, ready: 1, disabled: 2 };
  var state = {};
  ALL_PROV.forEach(function(p){ state[p.name] = providerState(p); });
  var list = ALL_PROV.filter(function(p){
    return !q || p.name.toLowerCase().indexOf(q) !== -1 || String(p.slug).toLowerCase().indexOf(q) !== -1;
  }).sort(function(a, b){
    return (order[state[a.name]] - order[state[b.name]]) || a.name.localeCompare(b.name);
  });
  var ready = ALL_PROV.filter(function(p){ return state[p.name] === 'ready'; }).length;
  var needs = ALL_PROV.filter(function(p){ return state[p.name] === 'needs'; }).length;
  $('pCount').textContent = ALL_PROV.length ? '· ' + ready + ' ready' + (needs ? ', ' + needs + ' need a key' : '') : '';
  var tb = $('pRows'); tb.innerHTML = '';
  $('pEmpty').hidden = list.length > 0;

  list.forEach(function(p){
    var tr = document.createElement('tr');
    tr.setAttribute('data-slot','table-row');
    tr.className = ROW + (p.enabled === false ? ' opacity-60' : '');
    var isCatch = p.name === PROV_CATCHALL;
    addCell(tr,
      '<div class="font-medium">' + esc(p.name) + (isCatch ? ' ' + chip('secondary', 'catch-all', 'Default') : '') + '</div>' +
      '<div class="text-xs text-muted-foreground">' + esc(p.slug) + (p.source === 'd1' ? ' · added by you' : '') + '</div>');
    addCell(tr, statusChip(state[p.name]));
    addCell(tr, keyCell(p));
    addCell(tr,
      '<button type="button"' + btnAttrs('outline','xs') + ' data-toggle="' + esc(p.name) + '">' + (p.enabled === false ? 'Enable' : 'Disable') + '</button>' +
      (p.source === 'd1' ? ' <button type="button"' + btnAttrs('ghost','xs') + ' data-del="' + esc(p.name) + '">Delete</button>' : ''),
      'text-right whitespace-nowrap');
    tb.appendChild(tr);

    if (OPEN_POOLS[p.name]){
      secretsFor(p).forEach(function(k){
        var sub = document.createElement('tr');
        sub.setAttribute('data-slot','table-row');
        sub.className = ROW + ' bg-muted/30';
        addCell(sub, '<span class="pl-4 font-mono text-xs text-muted-foreground">' + esc(k.secret) + '</span>');
        addCell(sub, '');
        addCell(sub, keyControl(k));
        addCell(sub, '');
        tb.appendChild(sub);
      });
    }
  });

  var al = Object.keys(PROV_ALIASES).map(function(k){ return k + ' → ' + PROV_ALIASES[k]; });
  $('pMeta').textContent = al.length ? 'Aliases: ' + al.join(' · ') : '';

  tb.querySelectorAll('button[data-toggle]').forEach(function(b){ b.onclick = function(){ toggleProvider(b.dataset.toggle); }; });
  tb.querySelectorAll('button[data-del]').forEach(function(b){ b.onclick = function(){ deleteProvider(b.dataset.del); }; });
  tb.querySelectorAll('button[data-pool]').forEach(function(b){
    b.onclick = function(){ OPEN_POOLS[b.dataset.pool] = !OPEN_POOLS[b.dataset.pool]; renderProviders(); };
  });
  tb.querySelectorAll('button[data-kset]').forEach(function(b){
    b.onclick = function(){
      var inp = tb.querySelector('input[data-kin="' + b.dataset.kset + '"]');
      saveProviderKey(b.dataset.kset, inp ? inp.value : '', b);
    };
  });
  tb.querySelectorAll('input[data-kin]').forEach(function(inp){
    inp.addEventListener('keydown', function(e){
      if (e.key === 'Enter'){ var b = tb.querySelector('button[data-kset="' + inp.dataset.kin + '"]'); if (b) b.click(); }
    });
  });
  tb.querySelectorAll('button[data-kedit]').forEach(function(b){
    b.onclick = function(){ EDITING[b.dataset.kedit] = true; renderProviders(); };
  });
  tb.querySelectorAll('button[data-kcancel]').forEach(function(b){
    b.onclick = function(){ delete EDITING[b.dataset.kcancel]; renderProviders(); };
  });
  tb.querySelectorAll('button[data-kdel]').forEach(function(b){ b.onclick = function(){ removeProviderKey(b.dataset.kdel); }; });
}

function setCanRegister(can){
  $('pBaseWrap').hidden = !can;
  $('pAddHint').textContent = can
    ? 'Enter the base URL and the gateway registers it in AI Gateway for you. Live within a minute.'
    : 'Register it in AI Gateway first. Live within a minute.';
}

async function refreshProviders(){
  try {
    var r = await Promise.all([api('GET','/admin/api/providers'), api('GET','/admin/api/provider-keys')]);
    setCanRegister(!!r[0].canRegister);
    PKEYS = r[1].keys || [];
    renderProviders(r[0]);
  } catch(e){ toast('Could not load providers: ' + e.message, 'bad'); }
}

async function saveProviderKey(secret, value, btn){
  value = String(value || '').trim();
  if (!value){ toast('Paste the key first', 'bad'); return; }
  if (btn) btn.disabled = true;
  try {
    await api('POST','/admin/api/provider-keys', { secret: secret, value: value });
    delete EDITING[secret];
    toast('Key saved', 'ok');
    await refreshProviders();
  } catch(e){ toast(e.message, 'bad'); }
  finally { if (btn) btn.disabled = false; }
}

function removeProviderKey(secret){
  showModal('Remove API key',
    '<p class="text-sm text-muted-foreground">Providers that use <b>' + esc(secret) + '</b> will stop working ' +
    'until you add a key again. Type the name to confirm.</p>',
    secret,
    async function(){
      try { await api('DELETE','/admin/api/provider-keys/' + encodeURIComponent(secret));
            await refreshProviders(); toast('Key removed','ok'); }
      catch(e){ toast(e.message,'bad'); }
    });
}

async function toggleProvider(name){
  var p = ALL_PROV.filter(function(x){ return x.name === name; })[0];
  if (!p) return;
  // Send the whole entry back: a bundled provider has no D1 row yet, so disabling it
  // must CREATE one carrying the same settings, not just a flag.
  var body = { name: p.name, slug: p.slug, upstream: p.upstream, secret: p.secret,
               keyPool: p.keyPool, path: p.path, reasoning: p.reasoning,
               dropTools: !!p.dropTools, translate: p.translate,
               enabled: p.enabled === false, note: p.note };
  try { await api('POST','/admin/api/providers', body); await refreshProviders();
        toast(name + (body.enabled ? ' enabled' : ' disabled'), 'ok'); }
  catch(e){ toast(e.message, 'bad'); }
}

function deleteProvider(name){
  showModal('Delete provider',
    '<p class="text-sm text-muted-foreground">Models starting with <b>' + esc(name) + '/</b> will use the ' +
    'default provider instead. Type the name to confirm.</p>',
    name,
    async function(){
      try { await api('DELETE','/admin/api/providers/' + encodeURIComponent(name));
            await refreshProviders(); toast('Provider deleted','ok'); }
      catch(e){ toast(e.message,'bad'); }
    });
}

function showAddForm(show){
  $('pAddCard').hidden = !show;
  if (show){ $('pName').focus(); $('pAddCard').scrollIntoView({ block: 'nearest' }); }
}

function clearAddForm(){
  ['pName','pBase','pSlug','pSecret','pPath','pKey'].forEach(function(id){ $(id).value = ''; });
  $('pReasoning').value = ''; $('pDropTools').checked = false; $('pErr').textContent = '';
  secretTouched = false;
}

async function addProvider(){
  $('pErr').textContent = '';
  var name = $('pName').value.trim();
  var secret = $('pSecret').value.trim() || null;
  var keyValue = $('pKey').value.trim();
  // A key needs a secret name; derive one from the prefix when the operator left it empty.
  if (keyValue && !secret && name) secret = secretFromPrefix(name);
  var baseUrl = $('pBase').value.trim();
  var slug = $('pSlug').value.trim();
  // A custom provider is named after its prefix unless the operator chose a slug.
  if (baseUrl && !slug && name) slug = 'custom-' + name.toLowerCase();
  var body = {
    name: name,
    slug: slug,
    baseUrl: baseUrl || undefined,
    upstream: $('pUpstream').value,
    secret: secret,
    path: $('pPath').value.trim() || null,
    reasoning: $('pReasoning').value || null,
    dropTools: $('pDropTools').checked,
    enabled: true
  };
  if (!body.name || !body.slug){ $('pErr').textContent = 'Prefix and slug (or a base URL) are required.'; return; }
  var btn = $('pAdd'); btn.disabled = true; btn.textContent = 'Saving…';
  try {
    await api('POST','/admin/api/providers', body);
    // The provider row must exist first: a key may only be stored under a name some
    // provider references.
    if (keyValue) await api('POST','/admin/api/provider-keys', { secret: body.secret, value: keyValue });
    clearAddForm();
    showAddForm(false);
    await refreshProviders();
    toast(body.baseUrl ? 'Provider saved and registered in AI Gateway' : 'Provider saved','ok');
  } catch(e){ $('pErr').textContent = e.message; }
  finally { btn.disabled = false; btn.textContent = 'Save provider'; }
}

// Suggest the secret name from the prefix until the operator types their own.
var secretTouched = false;
$('pSecret').addEventListener('input', function(){ secretTouched = true; });
$('pName').addEventListener('input', function(){
  if (secretTouched) return;
  $('pSecret').value = secretFromPrefix($('pName').value);
});

$('pFilter').addEventListener('input', function(){ renderProviders(); });
$('pNew').onclick = function(){ showAddForm($('pAddCard').hidden); };
$('pCancel').onclick = function(){ clearAddForm(); showAddForm(false); };
$('pAdd').onclick = addProvider;
`;
