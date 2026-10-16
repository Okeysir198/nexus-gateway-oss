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
  NATIVE_SELECT,
  NATIVE_SELECT_ICON,
  NATIVE_SELECT_WRAPPER,
  TABLE,
  TABLE_BODY,
  TABLE_CELL,
  TABLE_CONTAINER,
  TABLE_HEAD,
  TABLE_HEADER,
  TABLE_ROW,
} from "./ui";
import { I } from "./icons";

/** Providers tab — the point of the D1 registry.
 *
 *  Adding a provider here needs no deploy: the row overlays the bundled config within
 *  60s (immediately in the isolate that served the write). Bundled entries are shown
 *  read-only-ish — they can be disabled or overridden, but not deleted, because they
 *  come back on the next deploy. */

const FIELD = "grid gap-2";
const FORM_GRID = "grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4 lg:items-end";

function field(id: string, label: string, placeholder: string): string {
  return (
    '<div class="' + FIELD + '"><label for="' + id + '" data-slot="label" class="' + LABEL + '">' + label + "</label>" +
    '<input id="' + id + '" data-slot="input" class="' + INPUT + '" placeholder="' + placeholder + '" autocomplete="off" /></div>'
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

export const PROVIDERS_HTML = `
  <section data-slot="card" class="${CARD}">
    <div data-slot="card-header" class="${CARD_HEADER}">
      <div data-slot="card-title" class="${CARD_TITLE}">Add or override a provider</div>
      <div data-slot="card-description" class="${CARD_DESCRIPTION}">
        Callers address a model as <code class="rounded-md bg-muted px-1.5 py-0.5 font-mono text-xs">provider:model</code>. Register the
        provider in AI Gateway first, then add it here — a row overlays the bundled config
        and takes effect within ~60s, no deploy.
        <b>Custom AI&nbsp;Gateway providers need the <code class="rounded-md bg-muted px-1.5 py-0.5 font-mono text-xs">custom-</code> prefix</b>
        in the slug (registered <code class="rounded-md bg-muted px-1.5 py-0.5 font-mono text-xs">my-provider</code> → use
        <code class="rounded-md bg-muted px-1.5 py-0.5 font-mono text-xs">custom-my-provider</code>).
      </div>
    </div>
    <div data-slot="card-content" class="${CARD_CONTENT}">
      <div class="${FORM_GRID}">
        ${field("pName", "Prefix callers type", "e.g. deepseek")}
        ${field("pSlug", "AI Gateway slug", "deepseek or custom-mine")}
        ${field("pSecret", "Secret env var", "DEEPSEEK_API_KEY")}
        <div class="lg:grid lg:grid-cols-1 lg:items-end">
          <button type="button" data-slot="button" data-variant="default" data-size="default" class="${BTN} ${BTN_VARIANTS.default} ${BTN_SIZES.default}" id="pAdd">Save</button>
        </div>
      </div>
      <details class="mt-3">
        <summary class="cursor-pointer text-sm text-muted-foreground">Advanced (path, dialect, upstream)</summary>
        <div class="mt-3 ${FORM_GRID}">
          ${field("pPath", "Path override", "/v1/chat/completions")}
          ${selectField("pReasoning", "Reasoning dialect",
            '<option value="">none</option><option value="openrouter">openrouter</option><option value="openai_effort">openai_effort</option><option value="zai_thinking">zai_thinking</option>')}
          ${selectField("pUpstream", "Upstream",
            '<option value="openai_chat">openai_chat</option><option value="anthropic_native">anthropic_native</option>')}
          <div>
            <label class="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
              <input type="checkbox" id="pDropTools" class="size-4 accent-primary" /> drop tools
            </label>
          </div>
        </div>
      </details>
      <div class="mt-2 text-sm text-destructive empty:mt-0" id="pErr"></div>
    </div>
  </section>

  <section data-slot="card" class="${CARD}">
    <div data-slot="card-header" class="${CARD_HEADER}">
      <div data-slot="card-title" class="${CARD_TITLE}">Providers <span class="font-normal text-muted-foreground" id="pCount"></span></div>
      <div data-slot="card-action" class="${CARD_ACTION}">
        <input id="pFilter" data-slot="input" class="${INPUT} h-8 w-44 px-2.5 text-xs" placeholder="Filter…" autocomplete="off" />
      </div>
    </div>
    <div data-slot="card-content" class="${CARD_CONTENT}">
      <div data-slot="table-container" class="${TABLE_CONTAINER}">
        <table data-slot="table" class="${TABLE}">
          <thead data-slot="table-header" class="${TABLE_HEADER}">
            <tr data-slot="table-row" class="${TABLE_ROW}">
              <th data-slot="table-head" class="${TABLE_HEAD}">Prefix</th>
              <th data-slot="table-head" class="${TABLE_HEAD}">AIG slug</th>
              <th data-slot="table-head" class="${TABLE_HEAD}">Upstream</th>
              <th data-slot="table-head" class="${TABLE_HEAD}">Secret</th>
              <th data-slot="table-head" class="${TABLE_HEAD}">Source</th>
              <th data-slot="table-head" class="${TABLE_HEAD}">Status</th>
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
`;

// NOTE: no backticks / ${} inside this string except the class-constant interpolations.
export const PROVIDERS_JS = `
var ALL_PROV = [], PROV_ALIASES = {}, PROV_CATCHALL = null;
var CELL = ${JSON.stringify(TABLE_CELL)};
var ROW = ${JSON.stringify(TABLE_ROW)};
var MONO = 'font-mono tabular-nums';

function renderProviders(d){
  if (d){ ALL_PROV = d.providers || []; PROV_ALIASES = d.aliases || {}; PROV_CATCHALL = d.catchAll; }
  var q = ($('pFilter').value || '').trim().toLowerCase();
  var list = ALL_PROV.filter(function(p){
    return !q || p.name.toLowerCase().indexOf(q) !== -1 || String(p.slug).toLowerCase().indexOf(q) !== -1;
  });
  var on = ALL_PROV.filter(function(p){ return p.enabled !== false; }).length;
  $('pCount').textContent = '· ' + on + ' enabled / ' + ALL_PROV.length + ' total';
  var tb = $('pRows'); tb.innerHTML = '';
  $('pEmpty').hidden = list.length > 0;

  list.forEach(function(p){
    var tr = document.createElement('tr');
    tr.setAttribute('data-slot','table-row');
    tr.className = ROW + (p.enabled === false ? ' opacity-50' : '');
    var isCatch = p.name === PROV_CATCHALL;
    tr.innerHTML =
      '<td data-slot="table-cell" class="' + CELL + ' font-medium">' + esc(p.name) + (isCatch ? ' ' + chip('success', 'catch-all', 'catch-all') : '') + '</td>' +
      '<td data-slot="table-cell" class="' + CELL + '"><code class="rounded-md bg-muted px-1.5 py-0.5 font-mono text-xs">' + esc(p.slug) + '</code></td>' +
      '<td data-slot="table-cell" class="' + CELL + ' ' + MONO + '">' + esc(p.upstream || 'openai_chat') + '</td>' +
      '<td data-slot="table-cell" class="' + CELL + ' ' + MONO + '">' + esc(p.secret || '—') + '</td>' +
      // A bundled provider is not a fault, so it gets the neutral tone — only the D1
      // overlay (the thing an operator can actually edit here) is highlighted.
      '<td data-slot="table-cell" class="' + CELL + '">' + chip(p.source === 'd1' ? 'success' : 'secondary', p.source === 'd1' ? 'd1' : 'bundled', p.source) + '</td>' +
      '<td data-slot="table-cell" class="' + CELL + '">' + chip(p.enabled === false ? 'secondary' : 'success', p.enabled === false ? 'disabled' : 'enabled',
        p.enabled === false ? 'disabled' : 'enabled') + '</td>' +
      '<td data-slot="table-cell" class="' + CELL + '">' +
        '<button type="button"' + btnAttrs('outline','xs') + ' data-toggle="' + esc(p.name) + '">' +
          (p.enabled === false ? 'Enable' : 'Disable') + '</button>' +
        (p.source === 'd1' ? ' <button type="button"' + btnAttrs('destructive','xs') + ' data-del="' + esc(p.name) + '">Delete</button>' : '') +
      '</td>';
    tb.appendChild(tr);
  });

  tb.querySelectorAll('button[data-toggle]').forEach(function(b){
    b.onclick = function(){ toggleProvider(b.dataset.toggle); };
  });
  tb.querySelectorAll('button[data-del]').forEach(function(b){
    b.onclick = function(){ deleteProvider(b.dataset.del); };
  });

  var al = Object.keys(PROV_ALIASES).map(function(k){ return k + ' → ' + PROV_ALIASES[k]; });
  $('pMeta').textContent = al.length ? 'Aliases: ' + al.join(' · ') : '';
}

async function refreshProviders(){
  try { renderProviders(await api('GET','/admin/api/providers')); }
  catch(e){ toast('could not load providers: ' + e.message, 'bad'); }
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
    '<p class="text-sm text-muted-foreground">Callers using <b>' + esc(name) + ':</b> will fall through to the ' +
    'catch-all provider. Type the name to confirm.</p>',
    name,
    async function(){
      try { await api('DELETE','/admin/api/providers/' + encodeURIComponent(name));
            await refreshProviders(); toast('provider deleted','ok'); }
      catch(e){ toast(e.message,'bad'); }
    });
}

async function addProvider(){
  $('pErr').textContent = '';
  var body = {
    name: $('pName').value.trim(),
    slug: $('pSlug').value.trim(),
    upstream: $('pUpstream').value,
    secret: $('pSecret').value.trim() || null,
    path: $('pPath').value.trim() || null,
    reasoning: $('pReasoning').value || null,
    dropTools: $('pDropTools').checked,
    enabled: true
  };
  if (!body.name || !body.slug){ $('pErr').textContent = 'Prefix and slug are required.'; return; }
  var btn = $('pAdd'); btn.disabled = true; btn.textContent = 'Saving…';
  try {
    await api('POST','/admin/api/providers', body);
    $('pName').value=''; $('pSlug').value=''; $('pSecret').value=''; $('pPath').value='';
    $('pReasoning').value=''; $('pDropTools').checked=false;
    await refreshProviders();
    toast('provider saved — live within ~60s','ok');
  } catch(e){ $('pErr').textContent = e.message; }
  finally { btn.disabled = false; btn.textContent = 'Save'; }
}

$('pFilter').addEventListener('input', function(){ renderProviders(); });
$('pAdd').onclick = addProvider;
`;
