import {
  CARD,
  CARD_CONTENT,
  CARD_DESCRIPTION,
  CARD_HEADER,
  CARD_TITLE,
  EMPTY,
  TABLE,
  TABLE_BODY,
  TABLE_CELL,
  TABLE_CONTAINER,
  TABLE_HEAD,
  TABLE_HEADER,
  TABLE_ROW,
} from "./ui";

/** Operators tab — the allowlist, READ-ONLY since sign-in is Google-only.
 *
 *  Operators are the OPERATOR_EMAILS var: adding or removing one is a wrangler.toml
 *  edit and a deploy, not an API call, so this tab only SHOWS who may sign in and who
 *  is signed in now. The old create/reset/delete console (D1 admin_users, PBKDF2,
 *  handover passwords) went with password login. Enforcement is isOperator() at login
 *  time — this view renders the same var it reads. */

export const USERS_HTML = `
  <section data-slot="card" class="${CARD}">
    <div data-slot="card-header" class="${CARD_HEADER}">
      <div data-slot="card-title" class="${CARD_TITLE}">Operators <span class="font-normal text-muted-foreground" id="uCount"></span></div>
      <div data-slot="card-description" class="${CARD_DESCRIPTION}">
        Sign-in is Google-only and this list is the whole gate: an address may sign in
        only if it appears here. Edit OPERATOR_EMAILS in wrangler.toml and deploy to
        change it — the empty list denies everyone, by design.
      </div>
    </div>
    <div data-slot="card-content" class="${CARD_CONTENT}">
      <div data-slot="table-container" class="${TABLE_CONTAINER}">
        <table data-slot="table" class="${TABLE}">
          <thead data-slot="table-header" class="${TABLE_HEADER}">
            <tr data-slot="table-row" class="${TABLE_ROW}">
              <th data-slot="table-head" class="${TABLE_HEAD}">Email</th>
              <th data-slot="table-head" class="${TABLE_HEAD}">Status</th>
            </tr>
          </thead>
          <tbody data-slot="table-body" class="${TABLE_BODY}" id="uRows"></tbody>
        </table>
      </div>
      <div class="${EMPTY}" id="uEmpty" hidden>No operator addresses configured — sign-in is denied for everyone.</div>
    </div>
  </section>
`;

// NOTE: no backticks / ${} inside this string except the class-constant interpolations.
export const USERS_JS = `
var CELL = ${JSON.stringify(TABLE_CELL)};
var ROW = ${JSON.stringify(TABLE_ROW)};

function renderUsers(d){
  var ops = (d && d.operators) || [];
  var session = (d && d.session) || '';
  $('uCount').textContent = '· ' + ops.length + (ops.length === 1 ? ' address' : ' addresses');
  var tb = $('uRows'); tb.innerHTML = '';
  $('uEmpty').hidden = ops.length > 0;

  ops.forEach(function(email){
    var isMe = session && email.toLowerCase() === String(session).toLowerCase();
    var tr = document.createElement('tr');
    tr.setAttribute('data-slot','table-row');
    tr.className = ROW;
    tr.innerHTML =
      '<td data-slot="table-cell" class="' + CELL + ' font-mono font-medium">' + esc(email) + '</td>' +
      '<td data-slot="table-cell" class="' + CELL + '">' + (isMe ? chip('success', 'active', 'you · signed in')
                     : chip('secondary', 'accent', 'allowed')) + '</td>';
    tb.appendChild(tr);
  });
}

async function refreshUsers(){
  try { renderUsers(await api('GET','/admin/api/users')); }
  catch(e){ toast('could not load operators: ' + e.message, 'bad'); }
}
`;
