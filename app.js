// Allowance Tracker main JS
// Defensive, comments, role gates, PWA offline, Supabase, OneDrive optional export
const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));

const LOCALE = 'en-US';
const PT_TZ = 'America/Los_Angeles';
const USD = v => new Intl.NumberFormat(LOCALE, { style: 'currency', currency: 'USD' }).format(v);

const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
let user = null, profile = null, household = null, role = null, settings = null, txns = [], online = navigator.onLine, oneDriveToken = null;

window.addEventListener('online', () => { online = true; showMsg('main', 'Online'); });
window.addEventListener('offline', () => { online = false; showMsg('main', 'Offline. Some features are disabled.'); });

function showScreen(id) {
  $$('.screen').forEach(e => e.classList.remove('active'));
  $('#' + id).classList.add('active');
  $('#app').focus();
}

function showMsg(screen, msg) {
  const el = $('#' + (screen + '-msg'));
  if (el) { el.textContent = msg; }
}

function datePT(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleString(LOCALE, { timeZone: PT_TZ, year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function monday9PT(date) {
  // Returns Monday 09:00 PT after given UTC date
  // date: Date or ISO string
  let d = new Date(date);
  d.setUTCHours(9 + (16), 0, 0, 0); // 09:00 PT is 16:00 UTC
  let day = d.getUTCDay();
  let offset = (day === 1 && d.getUTCHours() >= 16) ? 0 : ((8 - day) % 7);
  d.setUTCDate(d.getUTCDate() + offset);
  d.setUTCHours(16, 0, 0, 0);
  return d.toISOString();
}

function countResetsSince(start, now) {
  // Count Mondays 09:00 PT between start and now
  let s = new Date(monday9PT(start));
  let n = new Date(now);
  let weeks = 0;
  while (s < n) {
    s.setUTCDate(s.getUTCDate() + 7);
    weeks++;
  }
  return weeks;
}

async function derive(hhId) {
  // Returns: resets, granted, allowanceRemaining, totalSpends, totalAdj, totalPay, savings
  const { data: s } = await supabase.from('ledger_settings').select('*').eq('household_id', hhId).single();
  const { data: t } = await supabase.from('transactions').select('*').eq('household_id', hhId).order('date', { ascending: false });
  if (!s || !t) return null;
  const resets = countResetsSince(s.tracking_start, new Date().toISOString());
  const granted = resets * parseFloat(s.weekly_allowance);
  let totalSpends = 0, totalAdj = 0, totalPay = 0;
  t.forEach(row => {
    if (row.type === 'spend') totalSpends += parseFloat(row.amount);
    if (row.type === 'adjust') totalAdj += parseFloat(row.amount);
    if (row.type === 'pay') totalPay += parseFloat(row.amount);
  });
  const allowanceRemaining = Math.max(granted + totalAdj - totalSpends, 0);
  const savings = parseFloat(s.initial_savings) + totalPay - totalSpends;
  return { resets, granted, allowanceRemaining, totalSpends, totalAdj, totalPay, savings, settings: s, txns: t };
}

// -- AUTH --

async function signIn(provider) {
  showScreen('loading');
  let r;
  if (provider === 'microsoft') {
    r = await supabase.auth.signInWithOAuth({ provider: 'azure', options: { redirectTo: location.href } });
  } else if (provider === 'email') {
    const email = $('#email').value;
    if (!email) return showMsg('auth', 'Email required.');
    r = await supabase.auth.signInWithOtp({ email, options: { redirectTo: location.href } });
    showMsg('auth', 'Check your email for the magic link.');
    return;
  }
  // OAuth redirects; magic link stays
}

async function handleAuth() {
  const { data, error } = await supabase.auth.getUser();
  if (!data?.user) {
    showScreen('auth');
    return;
  }
  user = data.user;
  // profile
  let { data: prof } = await supabase.from('profiles').select('*').eq('id', user.id).single();
  if (!prof) {
    // First login, create profile
    let { error: e } = await supabase.from('profiles').upsert({ id: user.id, email: user.email, display_name: user.user_metadata?.name || user.email });
    if (e) showMsg('auth', 'Error creating profile: ' + e.message);
    prof = { id: user.id, email: user.email, display_name: user.user_metadata?.name || user.email };
  }
  profile = prof;
  await checkHousehold();
}

async function checkHousehold() {
  // Membership
  const { data: mems } = await supabase.from('memberships').select('*').eq('user_id', user.id);
  if (!mems || !mems.length) {
    showScreen('setup');
    return;
  }
  const mem = mems[0];
  role = mem.role;
  // household
  const { data: hh } = await supabase.from('households').select('*').eq('id', mem.household_id).single();
  household = hh;
  await loadMain();
}

$('#signin-microsoft').onclick = () => signIn('microsoft');
$('#signin-email').onclick = () => { $('#email-form').classList.remove('hidden'); };
$('#cancel-email').onclick = () => { $('#email-form').classList.add('hidden'); };

$('#email-form').onsubmit = e => { e.preventDefault(); signIn('email'); };

$('#signout').onclick = async () => { await supabase.auth.signOut(); location.reload(); };

// -- SETUP --

$('#setup-form').onsubmit = async e => {
  e.preventDefault();
  const name = $('#hhname').value;
  const weekly = parseFloat($('#weekly').value);
  const start = $('#start').value;
  if (!name || !weekly || !start) return showMsg('setup', 'All fields required.');
  // Household
  const { data: hh, error } = await supabase.from('households').insert({ name, created_by: user.id }).select().single();
  if (error) return showMsg('setup', error.message);
  // Membership
  await supabase.from('memberships').insert({ user_id: user.id, household_id: hh.id, role: 'parent' });
  // Settings
  await supabase.from('ledger_settings').insert({ household_id: hh.id, tracking_start: monday9PT(start), weekly_allowance: weekly, initial_savings: 0 });
  await checkHousehold();
};

// -- MAIN LOAD --

async function loadMain() {
  showScreen('main');
  $('#household-name').textContent = household.name;
  $('#role-badge').textContent = role === 'parent' ? 'Parent' : 'Child';
  renderActions();
  await reloadKPIs();
  await loadTxns();
}

function renderActions() {
  if (role === 'parent') {
    $('#actions').classList.remove('hidden');
    $('#actions-child').classList.add('hidden');
  } else {
    $('#actions').classList.add('hidden');
    $('#actions-child').classList.remove('hidden');
  }
}

// -- KPIs --

async function reloadKPIs() {
  const d = await derive(household.id);
  if (!d) return;
  settings = d.settings; txns = d.txns;
  $('#allowance-remain').textContent = USD(d.allowanceRemaining);
  $('#savings').textContent = USD(d.savings);
  $('#granted').textContent = USD(d.granted);
}

// -- HISTORY --

async function loadTxns() {
  $('#txn-list').innerHTML = '';
  txns.forEach(row => {
    const li = document.createElement('li');
    li.innerHTML = `
      <span class="type-badge ${row.type}">${row.type[0].toUpperCase()}</span>
      <span>${USD(row.amount)}</span>
      <span>${row.note || ''}</span>
      <span>${datePT(row.date)}</span>
      ${role === 'parent' ? `<button class="delete-txn" data-id="${row.id}" aria-label="Delete">&times;</button>` : ''}
    `;
    $('#txn-list').appendChild(li);
  });
  $$('.delete-txn').forEach(btn => {
    btn.onclick = async e => {
      if (!confirm('Delete this transaction?')) return;
      await supabase.from('transactions').delete().eq('id', btn.dataset.id);
      await reloadKPIs(); await loadTxns();
    };
  });
}

// -- ADD SPEND --

function openSpendDialog() {
  $('#dialog-spend').showModal();
  $('#spend-amount').focus();
}

$('#add-spend').onclick = openSpendDialog;
$('#add-spend-child').onclick = openSpendDialog;
$('#cancel-spend').onclick = () => $('#dialog-spend').close();

$('#form-spend').onsubmit = async e => {
  e.preventDefault();
  const amount = parseFloat($('#spend-amount').value);
  const note = $('#spend-note').value;
  // Prevent overspend
  const d = await derive(household.id);
  if (amount > d.allowanceRemaining) {
    $('#spend-error').textContent = 'Cannot spend more than your remaining allowance.';
    return;
  }
  await supabase.from('transactions').insert({
    household_id: household.id,
    type: 'spend',
    date: new Date().toISOString(),
    amount, note, created_by: user.id
  });
  $('#dialog-spend').close();
  await reloadKPIs(); await loadTxns();
};

// -- ADD PAY --

$('#add-pay').onclick = () => $('#dialog-pay').showModal();
$('#cancel-pay').onclick = () => $('#dialog-pay').close();

$('#form-pay').onsubmit = async e => {
  e.preventDefault();
  const amount = parseFloat($('#pay-amount').value);
  const note = $('#pay-note').value;
  await supabase.from('transactions').insert({
    household_id: household.id,
    type: 'pay',
    date: new Date().toISOString(),
    amount, note, created_by: user.id
  });
  $('#dialog-pay').close();
  await reloadKPIs(); await loadTxns();
};

// -- ADJUST ALLOWANCE --

$('#adjust').onclick = () => $('#dialog-adjust').showModal();
$('#cancel-adjust').onclick = () => $('#dialog-adjust').close();

$('#form-adjust').onsubmit = async e => {
  e.preventDefault();
  const target = parseFloat($('#adj-target').value);
  const d = await derive(household.id);
  const diff = target - (d.granted + d.totalAdj - d.totalSpends);
  await supabase.from('transactions').insert({
    household_id: household.id,
    type: 'adjust',
    date: new Date().toISOString(),
    amount: diff, note: 'Adjustment', created_by: user.id
  });
  $('#dialog-adjust').close();
  await reloadKPIs(); await loadTxns();
};

// -- SETTINGS --

$('#settings').onclick = () => {
  $('#set-weekly').value = settings.weekly_allowance;
  $('#set-start').value = settings.tracking_start?.slice(0, 10);
  $('#dialog-settings').showModal();
};
$('#cancel-settings').onclick = () => $('#dialog-settings').close();

$('#form-settings').onsubmit = async e => {
  e.preventDefault();
  const weekly = parseFloat($('#set-weekly').value);
  const start = $('#set-start').value;
  await supabase.from('ledger_settings').update({
    weekly_allowance: weekly,
    tracking_start: monday9PT(start)
  }).eq('household_id', household.id);
  $('#dialog-settings').close();
  await reloadKPIs();
};

// -- INVITE CHILD --

$('#invite').onclick = () => $('#dialog-invite').showModal();
$('#cancel-invite').onclick = () => $('#dialog-invite').close();

$('#form-invite').onsubmit = async e => {
  e.preventDefault();
  const email = $('#invite-email').value;
  // Get user id for email or create membership (will work on join)
  let { data: u } = await supabase.from('profiles').select('id').eq('email', email).single();
  let uid = u?.id || null;
  await supabase.from('memberships').upsert({ user_id: uid || '', household_id: household.id, role: 'child' });
  $('#invite-msg').textContent = uid ? 'Child invited.' : 'Invitation saved. Child will join after sign-in.';
  setTimeout(() => $('#dialog-invite').close(), 1500);
};

// -- EXPORT --

$('#export').onclick = async () => {
  const d = await derive(household.id);
  const data = { settings: d.settings, transactions: d.txns };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = 'allowance-data.json';
  a.click();
};

// -- IMPORT --

$('#import').onclick = () => $('#dialog-import').showModal();
$('#cancel-import').onclick = () => $('#dialog-import').close();

$('#import-upload').onchange = e => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => { $('#import-file').value = ev.target.result; };
  reader.readAsText(file);
};

$('#form-import').onsubmit = async e => {
  e.preventDefault();
  let val = $('#import-file').value.trim();
  if (!val) return showMsg('import', 'Paste JSON or CSV.');
  let data;
  try {
    if (val[0] === '{' || val[0] === '[') {
      data = JSON.parse(val);
    } else {
      // CSV
      data = { transactions: [] };
      val.split('\n').forEach(line => {
        const [type, date, amount, note] = line.split(',');
        if (type && date && amount)
          data.transactions.push({ type, date, amount, note });
      });
    }
    // Normalize dates
    data.transactions.forEach(tx => {
      let d = new Date(tx.date);
      if (isNaN(d)) d = parseDate(tx.date);
      tx.date = d.toISOString();
    });
    for (const tx of data.transactions) {
      await supabase.from('transactions').insert({
        household_id: household.id,
        type: tx.type, date: tx.date, amount: tx.amount, note: tx.note, created_by: user.id
      });
    }
    $('#import-msg').textContent = 'Import complete.';
    setTimeout(() => $('#dialog-import').close(), 1200);
    await reloadKPIs(); await loadTxns();
  } catch (e) {
    showMsg('import', 'Import error: ' + e.message);
  }
};

function parseDate(s) {
  // Try ISO, US M/D/YYYY, etc.
  let d = new Date(s);
  if (!isNaN(d)) return d;
  const m = s.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})(?:\s+(\d{1,2}):(\d{2}))?/);
  if (m) {
    const [_, mo, da, yr, hr, min] = m;
    return new Date(`${yr}-${mo.padStart(2, '0')}-${da.padStart(2, '0')}T${(hr || '00').padStart(2, '0')}:${(min || '00').padStart(2, '0')}:00Z`);
  }
  throw new Error('Invalid date format');
}

// -- ONEDRIVE EXPORT (Optional) --

$('#onedrive').onclick = () => $('#dialog-onedrive').showModal();
$('#cancel-onedrive').onclick = () => $('#dialog-onedrive').close();

$('#form-onedrive').onsubmit = async e => {
  e.preventDefault();
  // Load MSAL.js dynamically if needed
  if (!window.msal) {
    const script = document.createElement('script');
    script.src = 'https://alcdn.msauth.net/browser/2.31.0/js/msal-browser.min.js';
    script.onload = exportToOneDrive;
    document.body.appendChild(script);
  } else {
    exportToOneDrive();
  }
};

async function exportToOneDrive() {
  // Requires registering an Azure App for OneDrive access
  const clientId = 'YOUR_ONEDRIVE_CLIENT_ID';
  const msalConfig = {
    auth: { clientId, authority: 'https://login.microsoftonline.com/common', redirectUri: location.origin }
  };
  const msalInstance = new window.msal.PublicClientApplication(msalConfig);
  try {
    const loginResp = await msalInstance.loginPopup({ scopes: ['Files.ReadWrite.AppFolder'] });
    oneDriveToken = loginResp.accessToken;
    // Upload file
    const d = await derive(household.id);
    const blob = new Blob([JSON.stringify(d, null, 2)], { type: 'application/json' });
    const resp = await fetch('https://graph.microsoft.com/v1.0/me/drive/special/approot:/allowance-data.json:/content', {
      method: 'PUT',
      headers: { 'Authorization': 'Bearer ' + oneDriveToken, 'Content-Type': 'application/json' },
      body: blob
    });
    if (resp.ok) $('#onedrive-msg').textContent = 'Exported to OneDrive App Folder.';
    else $('#onedrive-msg').textContent = 'Error: ' + await resp.text();
  } catch (e) {
    $('#onedrive-msg').textContent = 'OneDrive export error: ' + e.message;
  }
}

// -- INIT --

supabase.auth.onAuthStateChange(async (_event, sess) => {
  if (sess) { await handleAuth(); }
  else { showScreen('auth'); }
});

document.addEventListener('DOMContentLoaded', async () => {
  await handleAuth();
});