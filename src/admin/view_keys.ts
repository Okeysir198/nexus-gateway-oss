import {
  BTN_SIZES,
  BTN_VARIANTS,
  BTN,
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
  TABLE_CONTAINER,
  TABLE_HEAD,
  TABLE_HEADER,
  TABLE_ROW,
} from "./ui";
import { I } from "./icons";

/** API-keys tab.
 *
 *  Talks to the session-gated /admin/api/keys endpoints, NOT /key/* — those stay
 *  master-key-only as the machine surface and the lock-out recovery path.
 *
 *  Revocation is by `key_id`, sent as `key_ids[]`. This matters: the older console sent
 *  the id inside `keys[]`, which the API now (correctly) treats as a list of RAW tokens
 *  and hashes before matching — so an id sent that way silently matches nothing.
 *
 *  Styling is the stock shadcn/ui component vocabulary (Card/Input/Table/Empty/Button).
 *  The JS row builder below interpolates
 *  the SAME class constants, so script-built cells cannot drift from the static ones. */

const FIELD = "grid gap-2";
const FORM_GRID = "grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4 lg:items-end";

export const KEYS_HTML = `
  <section data-slot="card" class="${CARD}">
    <div data-slot="card-header" class="${CARD_HEADER}">
      <div data-slot="card-title" class="${CARD_TITLE}">Generate a key</div>
      <div data-slot="card-description" class="${CARD_DESCRIPTION}">
        Budget and rate limits are saved with the key but not enforced yet.
      </div>
      <div data-slot="card-action" class="${CARD_ACTION}">
        <button type="button" data-slot="button" data-variant="default" data-size="default" class="${BTN} ${BTN_VARIANTS.default} ${BTN_SIZES.default}" id="genBtn">Generate</button>
      </div>
    </div>
    <div data-slot="card-content" class="${CARD_CONTENT}">
      <div class="${FORM_GRID}">
        <div class="${FIELD}">
          <label for="alias" data-slot="label" class="${LABEL}">Alias</label>
          <input id="alias" data-slot="input" class="${INPUT}" placeholder="e.g. mobile-app" autocomplete="off" />
        </div>
        <div class="${FIELD}">
          <label for="ttl" data-slot="label" class="${LABEL}">Expires</label>
          <div data-slot="native-select-wrapper" class="${NATIVE_SELECT_WRAPPER} w-full">
            <select id="ttl" data-slot="native-select" data-size="default" class="${NATIVE_SELECT}">
              <option value="">Never</option>
              <option value="24h">24 hours</option>
              <option value="7d">7 days</option>
              <option value="30d" selected>30 days</option>
              <option value="90d">90 days</option>
              <option value="365d">1 year</option>
            </select>
            <span class="${NATIVE_SELECT_ICON}" data-slot="native-select-icon" aria-hidden="true">${I.chevronDown}</span>
          </div>
        </div>
        <div class="${FIELD}">
          <label for="budget" data-slot="label" class="${LABEL}">Max budget ($)</label>
          <input id="budget" data-slot="input" class="${INPUT}" type="number" min="0" step="0.01" placeholder="unlimited" />
        </div>
      </div>
      <div class="mt-2 text-sm text-destructive empty:mt-0" id="genErr"></div>
      <div id="onceBox"></div>
    </div>
  </section>
  <section data-slot="card" class="${CARD}">
    <div data-slot="card-header" class="${CARD_HEADER}">
      <div data-slot="card-title" class="${CARD_TITLE}">Keys <span class="font-normal text-muted-foreground" id="keyCount"></span></div>
      <div data-slot="card-action" class="${CARD_ACTION} flex items-center gap-3">
        <input id="keyFilter" data-slot="input" class="${INPUT} h-8 w-44 px-2.5 text-xs" placeholder="Filter…" autocomplete="off" />
        <label class="flex cursor-pointer items-center gap-2 text-xs whitespace-nowrap text-muted-foreground">
          <input type="checkbox" id="showRevoked" class="size-4 accent-primary" /> Show revoked
        </label>
      </div>
    </div>
    <div data-slot="card-content" class="${CARD_CONTENT}">
      <div data-slot="table-container" class="${TABLE_CONTAINER}">
        <table data-slot="table" class="${TABLE}">
          <thead data-slot="table-header" class="${TABLE_HEADER}">
            <tr data-slot="table-row" class="${TABLE_ROW}">
              <th data-slot="table-head" class="${TABLE_HEAD}">Alias</th>
              <th data-slot="table-head" class="${TABLE_HEAD}">Token</th>
              <th data-slot="table-head" class="${TABLE_HEAD}">Created</th>
              <th data-slot="table-head" class="${TABLE_HEAD}">Expires</th>
              <th data-slot="table-head" class="${TABLE_HEAD}">Status</th>
              <th data-slot="table-head" class="${TABLE_HEAD}">Budget</th>
              <th data-slot="table-head" class="${TABLE_HEAD}">RPM / TPM</th>
              <th data-slot="table-head" class="${TABLE_HEAD}"></th>
            </tr>
          </thead>
          <tbody data-slot="table-body" class="${TABLE_BODY}" id="rows"></tbody>
        </table>
      </div>
      <div class="${EMPTY}" id="empty" hidden>No keys yet.</div>
    </div>
  </section>
`;

// NOTE: no backticks / ${} inside this string except the class-constant interpolations.
export const KEYS_JS = `
var ALL_KEYS = [];

/* Badge vocabulary: the tone utilities carry the visuals, the badge-* marker is the
   word the tests key on (never styled itself). */
var PILL = { live:['success','ok'], expired:['warning','expired'], revoked:['danger','revoked'] };

/* fmtDate, esc, api, toast, showModal and revealOnce come from CORE_JS. */
function fmtExpiry(k){
  if (!k.expires_at) return 'never';
  var left = k.expires_at - Date.now()/1000;
  if (left <= 0) return 'expired';
  var d = Math.floor(left/86400);
  if (d >= 1) return 'in ' + d + 'd';
  var h = Math.floor(left/3600);
  if (h >= 1) return 'in ' + h + 'h';
  return 'in ' + Math.max(1, Math.floor(left/60)) + 'm';
}
function keyStatus(k){
  if (k.revoked_at) return 'revoked';
  if (k.expires_at && k.expires_at < Date.now()/1000) return 'expired';
  return 'live';
}
function visibleKeys(){
  var q = ($('keyFilter').value || '').trim().toLowerCase();
  var showRevoked = $('showRevoked').checked;
  return ALL_KEYS.filter(function(k){
    if (!showRevoked && k.revoked_at) return false;
    if (q && String(k.key_alias || '').toLowerCase().indexOf(q) === -1) return false;
    return true;
  });
}
function renderKeys(keys){
  if (keys) ALL_KEYS = keys;
  var list = visibleKeys();
  var live = ALL_KEYS.filter(function(k){ return keyStatus(k) === 'live'; }).length;
  $('keyCount').textContent = '· ' + live + ' live / ' + ALL_KEYS.length + ' total';
  var tb = $('rows'); tb.innerHTML = '';
  $('empty').hidden = list.length > 0;
  if (!list.length && ALL_KEYS.length) $('empty').textContent = 'No keys match this filter.';
  else $('empty').textContent = 'No keys yet.';

  list.forEach(function(k){
    var st = keyStatus(k);
    var tr = document.createElement('tr');
    tr.setAttribute('data-slot','table-row');
    tr.className = ROW + (st !== 'live' ? ' opacity-50' : '');
    tr.innerHTML =
      '<td data-slot="table-cell" class="' + CELL + ' font-medium">' + esc(k.key_alias || '(no alias)') + '</td>' +
      '<td data-slot="table-cell" class="' + CELL + '"><code class="rounded-md bg-muted px-1.5 py-0.5 font-mono text-xs">' + esc(k.token_prefix || '') + '…</code></td>' +
      '<td data-slot="table-cell" class="' + CELL + ' ' + MONO + '">' + fmtDate(k.created_at) + '</td>' +
      '<td data-slot="table-cell" class="' + CELL + ' ' + MONO + '">' + (st === 'revoked' ? '—' : esc(fmtExpiry(k))) + '</td>' +
      '<td data-slot="table-cell" class="' + CELL + '">' + chip(PILL[st][0], PILL[st][1], st) + '</td>' +
      '<td data-slot="table-cell" class="' + CELL + ' ' + MONO + '">' + (k.max_budget != null ? '$' + esc(k.max_budget) : '—') + '</td>' +
      '<td data-slot="table-cell" class="' + CELL + ' ' + MONO + '">' + (k.rpm_limit != null || k.tpm_limit != null
        ? esc((k.rpm_limit != null ? k.rpm_limit : '—') + ' / ' + (k.tpm_limit != null ? k.tpm_limit : '—'))
        : '—') + '</td>' +
      '<td data-slot="table-cell" class="' + CELL + '">' + (k.revoked_at ? '' :
        '<button type="button"' + btnAttrs('destructive','xs') + ' data-id="' + esc(k.key_id) + '" data-alias="' +
        esc(k.key_alias || '(no alias)') + '">Revoke</button>') + '</td>';
    tb.appendChild(tr);
  });
  tb.querySelectorAll('button[data-id]').forEach(function(b){
    b.onclick = function(){ revokeKey(b.dataset.id, b.dataset.alias); };
  });
}
async function refreshKeys(){
  try { var j = await api('GET','/admin/api/keys'); renderKeys(j.keys || []); }
  catch(e){ toast('Could not load keys: ' + e.message, 'bad'); }
}
function revokeKey(id, alias){
  // Typed confirmation: revocation is irreversible and takes effect for every caller
  // using that key. A one-click confirm is too easy to fire by accident.
  showModal('Revoke key',
    '<p class="text-sm text-muted-foreground"><b>' + esc(alias) + '</b> stops working for every caller within about a minute. ' +
    'This cannot be undone.</p>' +
    '<p class="text-sm text-muted-foreground">Type the alias to confirm.</p>',
    alias,
    async function(){
      try { await api('POST','/admin/api/keys/revoke', { key_ids:[id] }); await refreshKeys(); toast('Key revoked','ok'); }
      catch(e){ toast(e.message,'bad'); }
    });
}
async function generateKey(){
  $('genErr').textContent = ''; $('onceBox').innerHTML = '';
  var body = {};
  var a = $('alias').value.trim(); if (a) body.key_alias = a;
  var t = $('ttl').value; if (t) body.duration = t;
  var b = $('budget').value; if (b) body.max_budget = Number(b);
  var btn = $('genBtn'); btn.disabled = true; btn.textContent = 'Generating…';
  try {
    var j = await api('POST','/admin/api/keys', body);
    revealOnce('onceBox', 'New key — copy it now.', j.key || '');
    $('alias').value = ''; $('budget').value = '';
    refreshKeys();
  } catch(err){ $('genErr').textContent = err.message; }
  finally { btn.disabled = false; btn.textContent = 'Generate'; }
}
$('keyFilter').addEventListener('input', function(){ renderKeys(); });
$('showRevoked').addEventListener('change', function(){ renderKeys(); });
`;
