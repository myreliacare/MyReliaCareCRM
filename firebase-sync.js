/* =============================================================
   MyReliaCare — Cloud Sync Layer
   ============================================================
   Architecture:
   - Firestore is the single source of truth.
   - localStorage is a passive cache that mirrors Firestore for
     instant first-paint and offline reads — NEVER the other way
     around (this is what broke last time).
   - All saves go to Firestore. The Firestore listener echoes
     back into localStorage and the in-memory _state.
   - The Store API stays synchronous so the existing page code
     (which expects Store.getVisits() to return immediately) works
     unchanged. Reads return from _state; writes do an optimistic
     update of _state then async-push to Firestore.
============================================================= */

const firebaseConfig = {
    apiKey: "AIzaSyB0woIciG-MMUjdqLMCSegF5LiqQSv-7Wo",
    authDomain: "myreliacare-crm.firebaseapp.com",
    projectId: "myreliacare-crm",
    storageBucket: "myreliacare-crm.firebasestorage.app",
    messagingSenderId: "679984841970",
    appId: "1:679984841970:web:d43930b3170ad091777c6b"
};

const SHARED_EMAIL = 'team@myreliacare.com';

// One-time cleanup: remove the legacy "remember me" base64-encoded password if it exists.
// Earlier versions of this file stored the raw password in localStorage; this purges it
// for any users upgrading. Firebase Auth's session token (in IndexedDB) keeps them signed
// in without needing the password.
try { localStorage.removeItem('myreliacare_session_token'); } catch {}

// Inactivity auto-logout: signs out after a period of no user input.
// Resets on any mouse/keyboard/touch/scroll activity.
const INACTIVITY_LIMIT_MS = 60 * 60 * 1000;   // 60 minutes
let _lastActivity = Date.now();
let _inactivityTimerId = null;

function _markActivity() { _lastActivity = Date.now(); }

function _startInactivityTimer() {
    // Reset timer on user activity
    ['mousedown', 'keydown', 'touchstart', 'scroll'].forEach(ev =>
        window.addEventListener(ev, _markActivity, { passive: true })
    );
    // Check every minute
    if (_inactivityTimerId) clearInterval(_inactivityTimerId);
    _inactivityTimerId = setInterval(() => {
        if (!auth.currentUser) return;
        const idle = Date.now() - _lastActivity;
        if (idle >= INACTIVITY_LIMIT_MS) {
            console.log('[sync] auto sign-out after inactivity');
            _signOutAndShowExpired();
        }
    }, 60 * 1000);
}

function _stopInactivityTimer() {
    if (_inactivityTimerId) { clearInterval(_inactivityTimerId); _inactivityTimerId = null; }
}

async function _signOutAndShowExpired() {
    try { await auth.signOut(); } catch (e) { console.warn('[sync] signOut error:', e); }
    _showSessionExpired();
}

function _showSessionExpired() {
    // Banner-style modal that takes over the viewport
    let el = document.getElementById('sessionExpiredOverlay');
    if (el) {
        // Already exists — clear any stale value before re-showing so the user
        // doesn't have to delete leftover text from a previous timeout this session
        const existingInput = el.querySelector('#sessionExpiredPw');
        if (existingInput) existingInput.value = '';
        const existingErr = el.querySelector('#sessionExpiredError');
        if (existingErr) existingErr.style.display = 'none';
        el.style.display = 'flex';
        setTimeout(() => existingInput && existingInput.focus(), 100);
        return;
    }
    el = document.createElement('div');
    el.id = 'sessionExpiredOverlay';
    el.style.cssText = `
        position: fixed; inset: 0; background: rgba(0,0,0,0.85);
        z-index: 99999; display: flex; align-items: center; justify-content: center;
        padding: 20px;
    `;
    el.innerHTML = `
        <div style="background: #2A2220; border: 1px solid #4A413E; border-radius: 12px; padding: 28px 32px; max-width: 380px; width: 100%; color: #F0E6E8; font-family: inherit;">
            <h2 style="margin: 0 0 8px; font-family: 'Cormorant Unicase', serif; font-weight: 500;">Session expired</h2>
            <p style="margin: 0 0 20px; color: #C0B0B4; font-size: 0.95em; line-height: 1.5;">
                You were signed out after 60 minutes of inactivity. Sign back in to continue.
            </p>
            <input type="password" id="sessionExpiredPw" placeholder="Password" autocomplete="new-password" style="width: 100%; padding: 10px 12px; background: #1A1614; border: 1px solid #4A413E; border-radius: 6px; color: #F0E6E8; font-family: inherit; font-size: 1em; box-sizing: border-box; margin-bottom: 10px;">
            <div id="sessionExpiredError" style="color: #A85A66; font-size: 0.88em; margin-bottom: 10px; display: none;"></div>
            <button id="sessionExpiredBtn" style="width: 100%; padding: 10px; background: #B59197; color: white; border: none; border-radius: 6px; cursor: pointer; font-family: inherit; font-size: 1em; font-weight: 500;">Sign back in</button>
        </div>
    `;
    document.body.appendChild(el);
    const input = el.querySelector('#sessionExpiredPw');
    const btn = el.querySelector('#sessionExpiredBtn');
    const errEl = el.querySelector('#sessionExpiredError');
    const submit = async () => {
        const pw = input.value;
        if (!pw) return;
        btn.disabled = true;
        btn.textContent = 'Signing in…';
        errEl.style.display = 'none';
        try {
            await auth.signInWithEmailAndPassword(SHARED_EMAIL, pw);
            el.style.display = 'none';
            _markActivity();
        } catch (e) {
            errEl.textContent = 'Incorrect password';
            errEl.style.display = 'block';
            btn.disabled = false;
            btn.textContent = 'Sign back in';
        }
    };
    btn.addEventListener('click', submit);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    setTimeout(() => input.focus(), 100);
}

// Public sign-out function for the visible button
window.signOutCRM = async function() {
    if (!confirm('Sign out of MyReliaCare?')) return;
    try {
        await auth.signOut();
    } catch (e) {
        console.error('[sync] sign out error:', e);
    }
};

// JSON backup: dump every Store collection into a downloadable file.
// Triggered from the account dropdown. Works on whichever page (index/clients/invoices)
// the user happens to be on — they all share the same Firestore data via the Store API.
window.downloadBackupCRM = function() {
    try {
        const S = window.Store;
        if (!S) { alert('Store not available on this page'); return; }
        const safeCall = (fn) => { try { return (typeof fn === 'function') ? fn() : null; } catch (e) { return null; } };
        const data = {
            _meta: {
                version: 1,
                exportedAt: new Date().toISOString(),
                exportedFrom: location.pathname,
                userAgent: navigator.userAgent,
            },
            clients:      safeCall(S.getClients),
            visits:       safeCall(S.getVisits),
            invoices:     safeCall(S.getInvoices),
            mileage:      safeCall(S.getMileage),
            settings:     safeCall(S.getSettings),
            subscribers:  safeCall(S.getSubscribers),
            quickNotes:   safeCall(S.getQuickNotes),
            services:     safeCall(S.getServices),
            giveaway:     safeCall(S.getGiveaway),
            wizzysFinds:  safeCall(S.getWizzysFinds),
        };
        // Strip nulls so the file only contains collections the page exposes
        Object.keys(data).forEach(k => { if (k !== '_meta' && data[k] == null) delete data[k]; });
        const json = JSON.stringify(data, null, 2);
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        // Filename: myreliacare-backup-YYYY-MM-DD-HHMM.json
        const d = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        const stamp = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
        a.download = `myreliacare-backup-${stamp}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
        console.error('[backup] download error:', e);
        alert('Backup failed — check console for details');
    }
};

// ============================================================
//   GLOBAL SEARCH MODAL
// ============================================================
// Cross-page search across clients, visits, and invoices. Triggered by the
// header search button or Cmd/Ctrl+K. Lazy-injects on first open. Click a
// result to navigate to the right page with a query param.
let _searchModalState = { lastQuery: '' };

window.openGlobalSearch = function() {
    let modal = document.getElementById('globalSearchModal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'globalSearchModal';
        modal.style.cssText = `
            position: fixed; inset: 0; z-index: 10000;
            background: rgba(0,0,0,0.5); backdrop-filter: blur(2px);
            display: flex; align-items: flex-start; justify-content: center;
            padding-top: 10vh; font-family: inherit;
        `;
        modal.innerHTML = `
            <div id="gsmInner" style="background: #2A2220; border: 1px solid #4A413E; border-radius: 10px; width: min(640px, calc(100vw - 24px)); max-height: 80vh; display: flex; flex-direction: column; box-shadow: 0 12px 32px rgba(0,0,0,0.5); overflow: hidden;">
                <div style="padding: 14px 16px; border-bottom: 1px solid #4A413E; display: flex; gap: 10px; align-items: center;">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#8B7378" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><line x1="20" y1="20" x2="16.65" y2="16.65"/></svg>
                    <input type="text" id="gsmInput" placeholder="Search clients, visits, invoices…" style="flex: 1; background: transparent; border: none; outline: none; color: #F5E8EB; font-family: inherit; font-size: 1.05em; padding: 4px 0;" autocomplete="off">
                    <button id="gsmClose" style="background: transparent; border: none; color: #8B7378; cursor: pointer; font-size: 1.4em; padding: 0 4px; font-family: inherit;" aria-label="Close search">×</button>
                </div>
                <div id="gsmResults" style="overflow-y: auto; flex: 1; padding: 8px 0;"></div>
                <div style="padding: 8px 14px; border-top: 1px solid #4A413E; color: #8B7378; font-size: 0.78em; display: flex; justify-content: space-between; gap: 10px;">
                    <span>Type to search · Click result to open</span>
                    <span>Esc to close</span>
                </div>
            </div>
        `;
        document.body.appendChild(modal);

        const input = modal.querySelector('#gsmInput');
        const closeBtn = modal.querySelector('#gsmClose');

        const close = () => { modal.style.display = 'none'; };
        closeBtn.addEventListener('click', close);
        modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && modal.style.display !== 'none') close();
        });
        input.addEventListener('input', () => {
            _searchModalState.lastQuery = input.value;
            _renderGlobalSearchResults(input.value);
        });
    }
    modal.style.display = 'flex';
    const input = modal.querySelector('#gsmInput');
    input.value = _searchModalState.lastQuery || '';
    _renderGlobalSearchResults(input.value);
    setTimeout(() => input.focus(), 30);
};

function _renderGlobalSearchResults(query) {
    const resultsEl = document.getElementById('gsmResults');
    if (!resultsEl) return;
    const S = window.Store;
    if (!S) {
        resultsEl.innerHTML = `<div style="padding: 30px; text-align: center; color: #8B7378;">Store not available on this page</div>`;
        return;
    }
    const q = (query || '').trim().toLowerCase();
    if (q.length === 0) {
        resultsEl.innerHTML = `<div style="padding: 30px; text-align: center; color: #8B7378;">Start typing to search across clients, visits, and invoices</div>`;
        return;
    }

    // Build index from current data
    const clients = (S.getClients && S.getClients()) || [];
    const visits = (S.getVisits && S.getVisits()) || [];
    const invoices = (S.getInvoices && S.getInvoices()) || [];

    const clientsById = {};
    clients.forEach(c => { clientsById[c.id] = c; });

    // Score helper: exact match > startsWith > contains
    const score = (text, q) => {
        const t = (text || '').toLowerCase();
        if (!t) return 0;
        if (t === q) return 100;
        if (t.startsWith(q)) return 50;
        if (t.includes(q)) return 25;
        return 0;
    };

    // CLIENTS: match name, pet names, phone, email, address
    const clientMatches = clients.map(c => {
        let s = score(c.name, q);
        if (Array.isArray(c.pets)) {
            c.pets.forEach(p => { s = Math.max(s, score(p.name, q) * 0.9); });
        }
        s = Math.max(s, score(c.phone, q) * 0.7, score(c.email, q) * 0.7);
        s = Math.max(s, score([c.address, c.city].filter(Boolean).join(' '), q) * 0.5);
        return { score: s, client: c };
    }).filter(r => r.score > 0).sort((a, b) => b.score - a.score).slice(0, 8);

    // VISITS: match client name, date (YYYY-MM-DD), visit type, notes
    const visitMatches = visits.map(v => {
        const c = clientsById[v.clientId];
        const clientName = c?.name || v.clientName || '';
        let s = score(clientName, q) * 0.8;
        s = Math.max(s, score(v.date, q) * 0.6);
        s = Math.max(s, score(v.notes, q) * 0.4);
        s = Math.max(s, score(v.visitType, q) * 0.3);
        return { score: s, visit: v, clientName };
    }).filter(r => r.score > 0).sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return (b.visit.date || '').localeCompare(a.visit.date || '');
    }).slice(0, 8);

    // INVOICES: match invoice number, client name, total
    const invoiceMatches = invoices.map(inv => {
        const c = clientsById[inv.clientId];
        const clientName = c?.name || inv.clientName || '';
        let s = score(inv.invoiceNumber, q);
        s = Math.max(s, score(clientName, q) * 0.7);
        s = Math.max(s, score(String(inv.total), q) * 0.4);
        s = Math.max(s, score(inv.date, q) * 0.5);
        return { score: s, invoice: inv, clientName };
    }).filter(r => r.score > 0).sort((a, b) => b.score - a.score).slice(0, 6);

    const total = clientMatches.length + visitMatches.length + invoiceMatches.length;
    if (total === 0) {
        resultsEl.innerHTML = `<div style="padding: 30px; text-align: center; color: #8B7378;">No matches for "${_gsmEsc(query)}"</div>`;
        return;
    }

    const rowStyle = `padding: 10px 16px; cursor: pointer; border-bottom: 1px solid rgba(74,65,62,0.4); display: flex; gap: 10px; align-items: center; transition: background 0.1s;`;
    const tagStyle = `font-size: 0.7em; text-transform: uppercase; letter-spacing: 1px; padding: 2px 7px; border-radius: 3px; font-weight: 600; flex-shrink: 0;`;
    const sectionStyle = `padding: 8px 16px 4px; color: #8B7378; font-size: 0.72em; text-transform: uppercase; letter-spacing: 1.5px; font-weight: 600;`;

    let html = '';

    if (clientMatches.length > 0) {
        html += `<div style="${sectionStyle}">Clients · ${clientMatches.length}</div>`;
        html += clientMatches.map(r => {
            const c = r.client;
            const petsStr = Array.isArray(c.pets) && c.pets.length > 0
                ? c.pets.map(p => p.name).filter(Boolean).join(', ')
                : '';
            return `
                <div class="gsm-row" data-go="client" data-id="${c.id}" style="${rowStyle}">
                    <span style="${tagStyle} background: rgba(181,145,151,0.18); color: #B59197;">Client</span>
                    <div style="flex: 1; min-width: 0;">
                        <div style="color: #F5E8EB; font-weight: 500;">${_gsmEsc(c.name || 'Unnamed')}</div>
                        ${petsStr ? `<div style="color: #8B7378; font-size: 0.82em; margin-top: 2px;">${_gsmEsc(petsStr)}</div>` : ''}
                    </div>
                </div>
            `;
        }).join('');
    }

    if (visitMatches.length > 0) {
        html += `<div style="${sectionStyle}">Visits · ${visitMatches.length}</div>`;
        html += visitMatches.map(r => {
            const v = r.visit;
            const typeLabel = v.visitType === 'meet-greet' ? 'Meet & Greet'
                : v.visitType === '60min' ? '60 min'
                : v.visitType === '30min' ? '30 min'
                : (v.visitType || 'Visit');
            return `
                <div class="gsm-row" data-go="visit" data-id="${v.id}" data-date="${v.date}" style="${rowStyle}">
                    <span style="${tagStyle} background: rgba(201,166,107,0.16); color: #C9A66B;">Visit</span>
                    <div style="flex: 1; min-width: 0;">
                        <div style="color: #F5E8EB; font-weight: 500;">${_gsmEsc(r.clientName || 'Client')} · ${_gsmEsc(typeLabel)}</div>
                        <div style="color: #8B7378; font-size: 0.82em; margin-top: 2px;">${_gsmEsc(v.date)}${v.time ? ' at ' + _gsmEsc(v.time) : ''}${v.status === 'completed' ? ' · completed' : ''}${v.paid ? ' · paid' : ''}</div>
                    </div>
                </div>
            `;
        }).join('');
    }

    if (invoiceMatches.length > 0) {
        html += `<div style="${sectionStyle}">Invoices · ${invoiceMatches.length}</div>`;
        html += invoiceMatches.map(r => {
            const inv = r.invoice;
            const statusColor = inv.status === 'paid' ? '#C9A66B' : inv.status === 'overdue' ? '#A85A66' : '#C4825C';
            return `
                <div class="gsm-row" data-go="invoice" data-id="${inv.id}" style="${rowStyle}">
                    <span style="${tagStyle} background: rgba(196,130,92,0.16); color: #C4825C;">Invoice</span>
                    <div style="flex: 1; min-width: 0;">
                        <div style="color: #F5E8EB; font-weight: 500;">${_gsmEsc(inv.invoiceNumber || inv.id)} · ${_gsmEsc(r.clientName || 'Client')}</div>
                        <div style="color: #8B7378; font-size: 0.82em; margin-top: 2px;">$${(parseFloat(inv.total) || 0).toFixed(2)} · <span style="color: ${statusColor};">${_gsmEsc(inv.status || 'open')}</span>${inv.date ? ' · ' + _gsmEsc(inv.date) : ''}</div>
                    </div>
                </div>
            `;
        }).join('');
    }

    resultsEl.innerHTML = html;

    // Wire result clicks → navigate
    resultsEl.querySelectorAll('.gsm-row').forEach(row => {
        row.addEventListener('mouseenter', () => { row.style.background = 'rgba(74,65,62,0.4)'; });
        row.addEventListener('mouseleave', () => { row.style.background = 'transparent'; });
        row.addEventListener('click', () => {
            const go = row.dataset.go;
            const id = row.dataset.id;
            const date = row.dataset.date;
            const modal = document.getElementById('globalSearchModal');
            if (modal) modal.style.display = 'none';
            if (go === 'client') {
                window.location.href = 'clients.html?id=' + encodeURIComponent(id);
            } else if (go === 'visit') {
                window.location.href = 'index.html?openVisit=' + encodeURIComponent(id) + (date ? '&date=' + encodeURIComponent(date) : '');
            } else if (go === 'invoice') {
                window.location.href = 'invoices.html?openInvoice=' + encodeURIComponent(id);
            }
        });
    });
}

function _gsmEsc(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Inject visible "signed in" status pill + sign-out into every page
function _injectSignedInIndicator() {
    if (document.getElementById('signedInIndicator')) return;

    // Global search button — sits just to the LEFT of the signed-in pill.
    // Opens a modal that searches clients, visits, invoices, tips across the app.
    const searchBtn = document.createElement('button');
    searchBtn.id = 'globalSearchBtn';
    searchBtn.title = 'Search (Ctrl+K)';
    searchBtn.setAttribute('aria-label', 'Open global search');
    searchBtn.style.cssText = `
        position: fixed; top: calc(env(safe-area-inset-top, 0px) + 16px); right: 130px; z-index: 9500;
        background: rgba(42, 34, 32, 0.92); border: 1px solid #4A413E;
        color: #C0B0B4; width: 32px; height: 32px; border-radius: 50%;
        cursor: pointer; display: none; align-items: center; justify-content: center;
        backdrop-filter: blur(4px); font-family: inherit;
    `;
    searchBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><line x1="20" y1="20" x2="16.65" y2="16.65"/></svg>`;
    searchBtn.addEventListener('click', () => window.openGlobalSearch());
    document.body.appendChild(searchBtn);

    // REFRESH BUTTON — essential in PWA standalone mode where pull-to-refresh
    // doesn't work. Sits to the left of the search button. Reloads current page.
    const refreshBtn = document.createElement('button');
    refreshBtn.id = 'globalRefreshBtn';
    refreshBtn.title = 'Refresh page';
    refreshBtn.setAttribute('aria-label', 'Refresh page');
    refreshBtn.style.cssText = `
        position: fixed; top: calc(env(safe-area-inset-top, 0px) + 16px); right: 170px; z-index: 9500;
        background: rgba(42, 34, 32, 0.92); border: 1px solid #4A413E;
        color: #C0B0B4; width: 32px; height: 32px; border-radius: 50%;
        cursor: pointer; display: none; align-items: center; justify-content: center;
        backdrop-filter: blur(4px); font-family: inherit;
    `;
    refreshBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><polyline points="23 20 23 14 17 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>`;
    refreshBtn.addEventListener('click', () => {
        // Brief visual feedback before reload
        refreshBtn.style.color = '#B59197';
        refreshBtn.style.transform = 'rotate(180deg)';
        refreshBtn.style.transition = 'transform 0.25s, color 0.15s';
        setTimeout(() => location.reload(), 180);
    });
    document.body.appendChild(refreshBtn);

    // Cmd/Ctrl+K shortcut to open search anywhere
    document.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
            e.preventDefault();
            window.openGlobalSearch();
        }
    });

    const el = document.createElement('div');
    el.id = 'signedInIndicator';
    el.style.cssText = `
        position: fixed; top: calc(env(safe-area-inset-top, 0px) + 16px); right: 12px; z-index: 9500;
        background: rgba(42, 34, 32, 0.92); border: 1px solid #4A413E;
        color: #C0B0B4; padding: 6px 10px; border-radius: 20px;
        font-family: inherit; font-size: 0.78em;
        display: none; align-items: center; gap: 8px;
        backdrop-filter: blur(4px);
    `;
    el.innerHTML = `
        <span style="width: 8px; height: 8px; border-radius: 50%; background: #C9A66B; display: inline-block;"></span>
        <span>Signed in</span>
        <button id="indicatorMenuBtn" style="background: transparent; color: #B59197; border: none; cursor: pointer; font-family: inherit; font-size: 1em; padding: 0 0 0 8px; border-left: 1px solid #4A413E;">Account ▾</button>
    `;
    document.body.appendChild(el);

    // Popover menu
    const menu = document.createElement('div');
    menu.id = 'indicatorMenu';
    menu.style.cssText = `
        position: fixed; top: calc(env(safe-area-inset-top, 0px) + 52px); right: 12px; z-index: 9501;
        background: #2A2220; border: 1px solid #4A413E; border-radius: 8px;
        padding: 6px 0; min-width: 180px; display: none;
        box-shadow: 0 4px 14px rgba(0,0,0,0.45);
        font-family: inherit; font-size: 0.88em;
    `;
    menu.innerHTML = `
        <button data-action="changePin" style="display: block; width: 100%; text-align: left; padding: 10px 14px; background: transparent; color: #F0E6E8; border: none; cursor: pointer; font-family: inherit; font-size: 1em;">Change PIN</button>
        <button data-action="changePassword" style="display: block; width: 100%; text-align: left; padding: 10px 14px; background: transparent; color: #F0E6E8; border: none; cursor: pointer; font-family: inherit; font-size: 1em;">Change password</button>
        <div style="height: 1px; background: #4A413E; margin: 4px 0;"></div>
        <button data-action="downloadBackup" style="display: block; width: 100%; text-align: left; padding: 10px 14px; background: transparent; color: #F0E6E8; border: none; cursor: pointer; font-family: inherit; font-size: 1em;">Download backup (JSON)</button>
        <div style="height: 1px; background: #4A413E; margin: 4px 0;"></div>
        <button data-action="signOut" style="display: block; width: 100%; text-align: left; padding: 10px 14px; background: transparent; color: #A85A66; border: none; cursor: pointer; font-family: inherit; font-size: 1em;">Sign out</button>
    `;
    document.body.appendChild(menu);

    const toggleBtn = el.querySelector('#indicatorMenuBtn');
    toggleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        menu.style.display = menu.style.display === 'block' ? 'none' : 'block';
    });
    menu.querySelectorAll('button[data-action]').forEach(b => {
        b.addEventListener('click', (e) => {
            e.stopPropagation();
            menu.style.display = 'none';
            const action = b.dataset.action;
            if (action === 'changePin') window.changePin();
            else if (action === 'changePassword') window.changePassword();
            else if (action === 'downloadBackup') window.downloadBackupCRM();
            else if (action === 'signOut') window.signOutCRM();
        });
        // hover effect
        b.addEventListener('mouseenter', () => { b.style.background = '#3A302E'; });
        b.addEventListener('mouseleave', () => { b.style.background = 'transparent'; });
    });
    // Click outside to close
    document.addEventListener('click', () => { menu.style.display = 'none'; });
}

firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();

// Stay logged in across browser sessions
auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL).catch(e => {
    console.warn('Auth persistence warning:', e);
});

// Offline support — Firestore caches in IndexedDB, queues writes when offline
db.enablePersistence({ synchronizeTabs: true }).catch(err => {
    // failed-precondition = multiple tabs open; unimplemented = browser doesn't support
    console.warn('Firestore persistence:', err.code || err.message);
});

// --- Storage keys (used as the localStorage cache mirror) ---
window.STORAGE_KEYS = {
    clients: 'myreliacare_clients',
    visits: 'myreliacare_visits',
    personalEvents: 'myreliacare_personal_events',
    invoices: 'myreliacare_invoices',
    quickNotes: 'myreliacare_quick_notes',
    mileage: 'myreliacare_mileage',
    logo: 'myreliacare_logo'  // logo stays per-device; not synced (large base64)
};

// --- Collections that sync to Firestore ---
const COLLECTIONS = [
    { name: 'clients',        stateKey: 'clients',        storageKey: STORAGE_KEYS.clients },
    { name: 'visits',         stateKey: 'visits',         storageKey: STORAGE_KEYS.visits },
    { name: 'personalEvents', stateKey: 'personalEvents', storageKey: STORAGE_KEYS.personalEvents },
    { name: 'invoices',       stateKey: 'invoices',       storageKey: STORAGE_KEYS.invoices },
    { name: 'quickNotes',     stateKey: 'quickNotes',     storageKey: STORAGE_KEYS.quickNotes },
    { name: 'mileage',        stateKey: 'mileage',        storageKey: STORAGE_KEYS.mileage },
    { name: 'settings',       stateKey: 'settings',       storageKey: 'myreliacare_settings' }
];

// --- In-memory state ---
const _state = {
    clients: [], visits: [], personalEvents: [], invoices: [], quickNotes: [], mileage: [], settings: []
};

// Hydrate _state from localStorage cache for instant first paint
COLLECTIONS.forEach(c => {
    try {
        const raw = localStorage.getItem(c.storageKey);
        _state[c.stateKey] = raw ? JSON.parse(raw) : [];
    } catch { _state[c.stateKey] = []; }
});

// CRITICAL: capture pre-migration cache snapshot at module load.
// Listeners CAN overwrite localStorage; this snapshot CANNOT be overwritten.
// Migration uses this to find local-only records to push up.
const _preMigrationCache = {};
COLLECTIONS.forEach(c => {
    _preMigrationCache[c.stateKey] = JSON.parse(JSON.stringify(_state[c.stateKey] || []));
});

// --- Firestore listeners ---
let _listenersAttached = false;
const _unsubscribers = [];
// Track locally-saved items not yet echoed back from cloud, so a stale snapshot
// from before our write doesn't wipe out the optimistic update.
const _pendingWrites = new Set();
const _pendingDeletes = new Set();

/* ============================================================
   PERSISTENT PENDING-OPS LOG
   Protects against the silent save-failure pattern:
     1. User saves → optimistic update (_state + localStorage) succeeds instantly
     2. Async Firestore write starts
     3. Tab closes / laptop sleeps / connection drops BEFORE write completes
     4. Next session: localStorage has user's changes, Firestore doesn't.
        Without protection, the listener would overwrite localStorage with the
        stale cloud state and the user's changes silently vanish.
   The fix: every save also writes the operation (with full item data) to
   localStorage BEFORE the async Firestore call. On next login, before
   listeners attach, we replay any ops still in the log. Items still pending
   after replay get added to _pendingWrites/_pendingDeletes so the listener
   protects them.
   ============================================================ */
const PENDING_OPS_KEY = 'myreliacare_pending_ops_v1';
let _pendingOpsLog = []; // [{ opId, coll, type: 'write'|'delete', item, ts }]

function _loadPendingOpsLog() {
    try {
        const raw = localStorage.getItem(PENDING_OPS_KEY);
        const parsed = raw ? JSON.parse(raw) : [];
        _pendingOpsLog = Array.isArray(parsed) ? parsed : [];
    } catch {
        _pendingOpsLog = [];
    }
}

function _savePendingOpsLog() {
    try {
        localStorage.setItem(PENDING_OPS_KEY, JSON.stringify(_pendingOpsLog));
    } catch (e) {
        console.error('[sync] pending ops log save failed:', e);
        // Quota error: try to drop the oldest half and retry once.
        if (e && e.name === 'QuotaExceededError' && _pendingOpsLog.length > 1) {
            _pendingOpsLog = _pendingOpsLog.slice(Math.floor(_pendingOpsLog.length / 2));
            try { localStorage.setItem(PENDING_OPS_KEY, JSON.stringify(_pendingOpsLog)); } catch {}
        }
    }
}

// Enqueue an op. Dedupes by (collection, item.id): if there's already a pending
// op for this item, drop the older one. This way rapid successive edits to the
// same item collapse to one final state in the log.
function _enqueueOp(collName, opType, item) {
    if (!item || !item.id) return null;
    _pendingOpsLog = _pendingOpsLog.filter(op =>
        !(op && op.coll === collName && op.item && op.item.id === item.id)
    );
    const opId = `op_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    _pendingOpsLog.push({
        opId,
        coll: collName,
        type: opType,
        item: JSON.parse(JSON.stringify(item)),
        ts: Date.now()
    });
    _savePendingOpsLog();
    return opId;
}

function _completeOps(opIds) {
    if (!opIds || opIds.length === 0) return;
    const set = new Set(opIds.filter(Boolean));
    if (set.size === 0) return;
    const before = _pendingOpsLog.length;
    _pendingOpsLog = _pendingOpsLog.filter(op => !set.has(op.opId));
    if (_pendingOpsLog.length !== before) _savePendingOpsLog();
}

async function _replayPendingOps() {
    _loadPendingOpsLog();
    if (_pendingOpsLog.length === 0) return;

    const total = _pendingOpsLog.length;
    console.log(`[sync] replaying ${total} pending op(s) from previous session`);
    if (typeof showToast === 'function') {
        showToast(`Restoring ${total} unsaved change${total === 1 ? '' : 's'} from last session…`);
    }

    const succeeded = [];
    // Iterate over a copy so we can safely complete ops as we go.
    for (const op of _pendingOpsLog.slice()) {
        if (!op || !op.coll || !op.item || !op.item.id) {
            succeeded.push(op && op.opId); // malformed op, drop it
            continue;
        }
        try {
            if (op.type === 'write') {
                const { id, ...data } = op.item;
                const cleaned = JSON.parse(JSON.stringify(data));
                await db.collection(op.coll).doc(id).set(cleaned);
                _pendingWrites.add(id);
                succeeded.push(op.opId);
            } else if (op.type === 'delete') {
                await db.collection(op.coll).doc(op.item.id).delete();
                _pendingDeletes.add(op.item.id);
                succeeded.push(op.opId);
            } else {
                // Unknown op type — drop it rather than loop forever.
                succeeded.push(op.opId);
            }
        } catch (e) {
            console.error(`[sync] replay failed for ${op.opId} (${op.coll}/${op.item.id}):`, e);
            // Leave in queue — will retry next session. Also mark as pending
            // so the listener doesn't overwrite the in-memory copy in this session.
            if (op.type === 'write') _pendingWrites.add(op.item.id);
            else if (op.type === 'delete') _pendingDeletes.add(op.item.id);
        }
    }

    _completeOps(succeeded);
    const remaining = _pendingOpsLog.length;
    console.log(`[sync] replay done: ${succeeded.length}/${total} succeeded, ${remaining} still pending`);
    if (remaining > 0 && typeof showToast === 'function') {
        showToast(`${remaining} change${remaining === 1 ? '' : 's'} couldn't be restored — will retry on next save`, 'error');
    }
}

// Load ops log eagerly at module load so we know what's pending from the start.
_loadPendingOpsLog();

function attachListeners() {
    if (_listenersAttached) return;
    _listenersAttached = true;
    COLLECTIONS.forEach(c => {
        const unsub = db.collection(c.name).onSnapshot(snap => {
            let newData = snap.docs.map(d => ({ ...d.data(), id: d.id }));
            const snapIds = new Set(newData.map(d => d.id));

            // Hide items we just locally deleted that the cloud hasn't confirmed yet
            newData = newData.filter(d => !_pendingDeletes.has(d.id));

            // Add back items we just locally wrote that the cloud hasn't confirmed yet
            const cloudIds = new Set(newData.map(d => d.id));
            const stillPending = _state[c.stateKey].filter(local =>
                _pendingWrites.has(local.id) && !cloudIds.has(local.id)
            );
            const merged = stillPending.length ? [...newData, ...stillPending] : newData;

            // Clear pending markers for items the cloud has confirmed
            for (const id of Array.from(_pendingWrites)) {
                if (snapIds.has(id)) _pendingWrites.delete(id);
            }
            for (const id of Array.from(_pendingDeletes)) {
                if (!snapIds.has(id)) _pendingDeletes.delete(id);
            }

            // Skip if nothing actually changed
            const oldJson = JSON.stringify(_state[c.stateKey] || []);
            const newJson = JSON.stringify(merged);
            if (oldJson === newJson) return;
            _state[c.stateKey] = merged;
            try { localStorage.setItem(c.storageKey, newJson); }
            catch (e) {
                if (e && e.name === 'QuotaExceededError') {
                    console.error(`[storage] listener cache write failed (quota) for ${c.name}`);
                    if (typeof showToast === 'function') {
                        showToast('Browser storage full — clear cache', 'error');
                    }
                }
            }
            _scheduleNotify();
        }, err => {
            console.error(`[sync] listener error on ${c.name}:`, err);
        });
        _unsubscribers.push(unsub);
    });
}
function detachListeners() {
    _unsubscribers.forEach(u => { try { u(); } catch {} });
    _unsubscribers.length = 0;
    _listenersAttached = false;
}

// Debounce data-change notifications via rAF — multiple snapshots in the same tick coalesce to one render.
let _notifyScheduled = false;
function _scheduleNotify() {
    if (_notifyScheduled) return;
    _notifyScheduled = true;
    requestAnimationFrame(() => {
        _notifyScheduled = false;
        _notifyDataChange();
    });
}

// Tell the page its data changed — calls whichever render functions exist
function _notifyDataChange() {
    const fns = ['refreshAll', 'renderClients', 'renderInvoiceList', 'renderStats', 'updateStats'];
    for (const name of fns) {
        if (typeof window[name] === 'function') {
            try { window[name](); } catch (e) { console.error(`[sync] ${name} threw:`, e); }
        }
    }
}

// --- Store API (synchronous from caller's perspective) ---
// Getters return DEEP CLONES — callers mutate freely without affecting internal state.
// This is essential: if a caller mutates a getter result and passes it back to a setter,
// the setter must be able to diff against the pre-mutation state. Sharing references
// would cause "no diff detected" and silently skip the Firestore write.
function _deepClone(x) { return JSON.parse(JSON.stringify(x)); }

window.Store = {
    load(key, defaultValue) {
        try {
            const raw = localStorage.getItem(key);
            return raw ? JSON.parse(raw) : defaultValue;
        } catch { return defaultValue; }
    },
    save(key, value) {
        // For collection keys, route through Firestore. For one-off keys (logo), localStorage only.
        const matching = COLLECTIONS.find(c => c.storageKey === key);
        if (matching) return _saveCollection(matching, value);
        try { localStorage.setItem(key, JSON.stringify(value)); return true; }
        catch (e) {
            console.error('Save error:', e);
            if (typeof showToast === 'function') showToast('Save failed.', 'error');
            return false;
        }
    },
    getClients() { return _deepClone(_state.clients); },
    getVisits() { return _deepClone(_state.visits); },
    getPersonalEvents() { return _deepClone(_state.personalEvents); },
    getInvoices() { return _deepClone(_state.invoices); },
    getQuickNotes() { return _deepClone(_state.quickNotes); },
    getMileage() { return _deepClone(_state.mileage); },
    getSettings() { return _deepClone(_state.settings); },
    saveClients(arr) { return _saveCollection(COLLECTIONS[0], arr); },
    saveVisits(arr) { return _saveCollection(COLLECTIONS[1], arr); },
    savePersonalEvents(arr) { return _saveCollection(COLLECTIONS[2], arr); },
    saveInvoices(arr) { return _saveCollection(COLLECTIONS[3], arr); },
    saveQuickNotes(arr) { return _saveCollection(COLLECTIONS[4], arr); },
    saveMileage(arr) { return _saveCollection(COLLECTIONS[5], arr); },
    saveSettings(arr) { return _saveCollection(COLLECTIONS[6], arr); }
};

/* =============================================================
   SYNC STATUS — visible feedback for save success/failure
   - Tracks pending Firestore writes by op count
   - Tracks unrecoverable failures (storage quota, persistent network)
   - Injects a top banner when something needs attention
   - Exposes window.SyncStatus.retry() for manual retry of failed writes
============================================================= */
let _syncPendingOps = 0;        // ops in flight to Firestore
let _syncFailures = [];          // [{ coll, oldArr, newArr, ts, err }]
let _bannerEl = null;

function _ensureBanner() {
    if (_bannerEl) return _bannerEl;
    const el = document.createElement('div');
    el.id = 'syncStatusBanner';
    el.style.cssText = `
        position: fixed; top: 0; left: 0; right: 0; z-index: 10000;
        background: #A85A66; color: white;
        padding: 10px 16px; font-family: inherit; font-size: 0.92em;
        display: none; align-items: center; justify-content: space-between;
        gap: 12px; flex-wrap: wrap;
        box-shadow: 0 2px 8px rgba(0,0,0,0.3);
    `;
    el.innerHTML = `
        <span id="syncStatusMsg">Save failed</span>
        <span style="display: flex; gap: 8px; flex-wrap: wrap;">
            <button id="syncRetryBtn" style="background: rgba(255,255,255,0.2); color: white; border: 1px solid rgba(255,255,255,0.4); padding: 5px 12px; border-radius: 4px; cursor: pointer; font-family: inherit;">Retry</button>
            <button id="syncDismissBtn" style="background: transparent; color: white; border: 1px solid rgba(255,255,255,0.4); padding: 5px 12px; border-radius: 4px; cursor: pointer; font-family: inherit;">Dismiss</button>
        </span>
    `;
    document.body.appendChild(el);
    el.querySelector('#syncRetryBtn').addEventListener('click', () => window.SyncStatus.retry());
    el.querySelector('#syncDismissBtn').addEventListener('click', () => { _syncFailures = []; _refreshBanner(); });
    _bannerEl = el;
    return el;
}

function _refreshBanner() {
    const el = _ensureBanner();
    const msg = el.querySelector('#syncStatusMsg');
    if (_syncFailures.length === 0) {
        el.style.display = 'none';
        return;
    }
    el.style.display = 'flex';
    const collCounts = {};
    _syncFailures.forEach(f => { collCounts[f.coll.name] = (collCounts[f.coll.name] || 0) + 1; });
    const summary = Object.entries(collCounts).map(([n, c]) => `${c} ${n}`).join(', ');
    msg.textContent = `Save failed — ${summary} not synced to cloud. Click Retry to try again.`;
}

window.SyncStatus = {
    get pending() { return _syncPendingOps; },
    get failureCount() { return _syncFailures.length; },
    async retry() {
        if (_syncFailures.length === 0) return;
        const toRetry = _syncFailures.slice();
        _syncFailures = [];
        _refreshBanner();
        for (const f of toRetry) {
            try {
                _syncPendingOps++;
                await _persistToFirestore(f.coll, f.oldArr, f.newArr);
                // Retry succeeded — clear the persistent ops log entries too.
                _completeOps(f.opIds || []);
            } catch (err) {
                _syncFailures.push({ ...f, err, ts: Date.now() });
            } finally {
                _syncPendingOps--;
            }
        }
        _refreshBanner();
        if (_syncFailures.length === 0 && typeof showToast === 'function') {
            showToast('All saves synced');
        }
    }
};

function _saveCollection(coll, newArr) {
    if (!auth.currentUser) {
        console.warn('[sync] save attempted while signed out — discarded');
        if (typeof showToast === 'function') showToast('Not signed in — change not saved', 'error');
        return false;
    }
    const oldArr = _state[coll.stateKey].slice();
    const oldById = Object.fromEntries(oldArr.map(x => [x.id, x]));
    const newIds = new Set(newArr.map(x => x.id));

    // Track op IDs queued for THIS save so we can clear them from the persistent
    // log when Firestore confirms. The log is the safety net against the
    // tab-closes-mid-write data-loss pattern — see PERSISTENT PENDING-OPS LOG above.
    const opIds = [];

    // Mark items being written/updated as pending (so listener doesn't lose them to stale snapshots)
    for (const item of newArr) {
        if (!item.id) continue;
        const old = oldById[item.id];
        if (!old || JSON.stringify(old) !== JSON.stringify(item)) {
            _pendingWrites.add(item.id);
            const id = _enqueueOp(coll.name, 'write', item);
            if (id) opIds.push(id);
        }
    }
    // Mark deletes as pending
    for (const oldItem of oldArr) {
        if (!newIds.has(oldItem.id)) {
            _pendingDeletes.add(oldItem.id);
            const id = _enqueueOp(coll.name, 'delete', oldItem);
            if (id) opIds.push(id);
        }
    }

    // Optimistic local update — caller's next get*() returns fresh data
    _state[coll.stateKey] = JSON.parse(JSON.stringify(newArr));
    // Notify the UI immediately. The listener's later snapshot will diff equal
    // and skip — so this is the ONLY signal that fires for local writes.
    // Without this, summaries on other parts of the page (finances totals, tax
    // projection, etc.) stay stale until a page reload or focus event.
    _scheduleNotify();
    // localStorage cache write — surface quota / corruption failures
    try {
        localStorage.setItem(coll.storageKey, JSON.stringify(newArr));
    } catch (e) {
        console.error(`[storage] localStorage write failed for ${coll.name}:`, e);
        if (e && e.name === 'QuotaExceededError') {
            if (typeof showToast === 'function') {
                showToast('Browser storage full — data still saving to cloud, but clear browser cache soon', 'error');
            }
        }
        // Don't return false — _state is still updated and Firestore write proceeds
    }

    // Push to Firestore (async). Listener will reconcile.
    _syncPendingOps++;
    _persistToFirestore(coll, oldArr, newArr)
        .then(() => {
            _syncPendingOps--;
            // Firestore confirmed — clear these ops from the persistent log.
            _completeOps(opIds);
        })
        .catch(err => {
            _syncPendingOps--;
            console.error(`[sync] persist error on ${coll.name}:`, err);
            // Keep opIds in the failure record so retry can complete them.
            _syncFailures.push({ coll, oldArr, newArr, opIds, err, ts: Date.now() });
            _refreshBanner();
            if (typeof showToast === 'function') {
                showToast(`Save failed — see banner at top to retry`, 'error');
            }
        });
    return true;
}

async function _persistToFirestore(coll, oldArr, newArr) {
    const oldById = Object.fromEntries(oldArr.map(x => [x.id, x]));
    const newIds = new Set(newArr.map(x => x.id));
    const ops = [];

    // Adds + updates (only if actually changed)
    for (const item of newArr) {
        if (!item.id) item.id = _generateSyncId(coll.stateKey);
        const old = oldById[item.id];
        const isNew = !old;
        const isChanged = old && JSON.stringify(old) !== JSON.stringify(item);
        if (isNew || isChanged) {
            const { id, ...data } = item;
            const cleaned = JSON.parse(JSON.stringify(data));  // strips undefined
            ops.push(db.collection(coll.name).doc(item.id).set(cleaned));
        }
    }

    // Deletes
    for (const oldItem of oldArr) {
        if (!newIds.has(oldItem.id)) {
            ops.push(db.collection(coll.name).doc(oldItem.id).delete());
        }
    }

    if (ops.length === 0) return;
    return Promise.all(ops);
}

function _generateSyncId(prefix) {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

/* ============================================================
   APP PIN — secondary local factor for sensitive data access
   
   Why: Firebase Auth's LOCAL persistence keeps the user signed in
   across browser sessions via IndexedDB. This is convenient but
   means a stolen/borrowed device with an unlocked browser can
   open the CRM with no challenge. The PIN adds a challenge that
   protects against that scenario.
   
   When is the PIN required?
   - First sign-in after this feature shipped
   - After auto-logout (60 min inactivity)
   - After explicit sign-out
   - First load on a brand-new browser/device (where the PIN session
     flag was never set on that device)
   
   When is the PIN NOT required?
   - Navigating between pages in the same tab
   - Opening additional tabs (the verified flag is in localStorage,
     shared across tabs)
   - Refreshing the page
   - Closing and reopening the browser (so long as you haven't
     been signed out by inactivity)
   
   Design:
   - 4-6 digit PIN, set by user once
   - Stored as PBKDF2 hash + per-PIN salt in the settings collection
   - localStorage flag tracks "verified" — cleared on every sign-out
   - 5 wrong attempts → forced full sign-out (need password to retry)
   ============================================================ */

const PIN_SESSION_KEY = 'myreliacare_pin_verified';
const PIN_FAIL_KEY = 'myreliacare_pin_failures';
const PIN_MAX_FAILURES = 5;

function _getSettingsRecord() {
    const arr = _state.settings || [];
    return arr.find(s => s.id === 'global') || null;
}

function _hasPinConfigured() {
    const s = _getSettingsRecord();
    return !!(s && s.pinHash && s.pinSalt);
}

function _isPinVerified() {
    try { return localStorage.getItem(PIN_SESSION_KEY) === 'verified'; } catch { return false; }
}

function _markPinVerified() {
    try { localStorage.setItem(PIN_SESSION_KEY, 'verified'); } catch {}
    try { localStorage.removeItem(PIN_FAIL_KEY); } catch {}
}

function _clearPinSession() {
    try { localStorage.removeItem(PIN_SESSION_KEY); } catch {}
}

function _getPinFailures() {
    try { return parseInt(localStorage.getItem(PIN_FAIL_KEY) || '0', 10) || 0; } catch { return 0; }
}

function _incrementPinFailures() {
    const n = _getPinFailures() + 1;
    try { localStorage.setItem(PIN_FAIL_KEY, String(n)); } catch {}
    return n;
}

function _resetPinFailures() {
    try { localStorage.removeItem(PIN_FAIL_KEY); } catch {}
}

async function _hashPin(pin, salt) {
    const enc = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
        'raw', enc.encode(pin), { name: 'PBKDF2' }, false, ['deriveBits']
    );
    const bits = await crypto.subtle.deriveBits(
        { name: 'PBKDF2', salt: enc.encode(salt), iterations: 100000, hash: 'SHA-256' },
        keyMaterial,
        256
    );
    return Array.from(new Uint8Array(bits)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function _randomSalt() {
    const arr = new Uint8Array(16);
    crypto.getRandomValues(arr);
    return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function _savePinHash(pin) {
    const salt = _randomSalt();
    const hash = await _hashPin(pin, salt);
    const arr = _deepClone(_state.settings || []);
    let g = arr.find(s => s.id === 'global');
    if (!g) { g = { id: 'global' }; arr.push(g); }
    g.pinHash = hash;
    g.pinSalt = salt;
    g.pinSetAt = Date.now();
    return _saveCollection(COLLECTIONS[6], arr);
}

async function _verifyPin(pin) {
    const s = _getSettingsRecord();
    if (!s || !s.pinHash || !s.pinSalt) return false;
    const hash = await _hashPin(pin, s.pinSalt);
    return hash === s.pinHash;
}

// Wait briefly for Firestore settings sync after sign-in, so we know
// whether PIN is configured before showing setup vs. challenge.
async function _waitForSettingsSync(timeoutMs = 4000) {
    if (_getSettingsRecord()) return;
    return new Promise(resolve => {
        const start = Date.now();
        const intv = setInterval(() => {
            if (_getSettingsRecord() || Date.now() - start > timeoutMs) {
                clearInterval(intv);
                resolve();
            }
        }, 150);
    });
}

let _pinGateActive = false;

async function _enforcePinGate() {
    if (_pinGateActive) return;
    if (_isPinVerified()) return;
    _pinGateActive = true;

    // Hide main content while the gate is up
    const mainContent = document.getElementById('mainContent');
    if (mainContent) mainContent.style.display = 'none';

    await _waitForSettingsSync();

    if (_hasPinConfigured()) {
        _showPinChallenge();
    } else {
        _showPinSetup();
    }
}

function _showPinSetup() {
    let el = document.getElementById('pinOverlay');
    if (el) el.remove();
    el = document.createElement('div');
    el.id = 'pinOverlay';
    el.style.cssText = `
        position: fixed; inset: 0; background: rgba(0,0,0,0.92);
        z-index: 99998; display: flex; align-items: center; justify-content: center;
        padding: 20px;
    `;
    el.innerHTML = `
        <div style="background: #2A2220; border: 1px solid #4A413E; border-radius: 12px; padding: 28px 32px; max-width: 400px; width: 100%; color: #F0E6E8; font-family: inherit;">
            <h2 style="margin: 0 0 8px; font-family: 'Cormorant Unicase', serif; font-weight: 500;">Set up a PIN</h2>
            <p style="margin: 0 0 20px; color: #C0B0B4; font-size: 0.92em; line-height: 1.5;">
                Pick a 4-6 digit PIN. You'll enter it each time you open the CRM in a new tab, after auto-logout, or after closing your browser. This protects client data even if your device is borrowed or lost while logged in.
            </p>
            <label style="display: block; color: #C0B0B4; font-size: 0.85em; margin-bottom: 6px;">New PIN</label>
            <input type="password" id="pinSetup1" inputmode="numeric" pattern="[0-9]*" maxlength="6" autocomplete="one-time-code" placeholder="••••" style="width: 100%; padding: 12px; background: #1A1614; border: 1px solid #4A413E; border-radius: 6px; color: #F0E6E8; font-family: monospace; font-size: 1.4em; letter-spacing: 0.5em; text-align: center; box-sizing: border-box; margin-bottom: 12px;">
            <label style="display: block; color: #C0B0B4; font-size: 0.85em; margin-bottom: 6px;">Confirm PIN</label>
            <input type="password" id="pinSetup2" inputmode="numeric" pattern="[0-9]*" maxlength="6" autocomplete="one-time-code" placeholder="••••" style="width: 100%; padding: 12px; background: #1A1614; border: 1px solid #4A413E; border-radius: 6px; color: #F0E6E8; font-family: monospace; font-size: 1.4em; letter-spacing: 0.5em; text-align: center; box-sizing: border-box; margin-bottom: 10px;">
            <div id="pinSetupError" style="color: #A85A66; font-size: 0.88em; margin-bottom: 10px; display: none;"></div>
            <button id="pinSetupBtn" style="width: 100%; padding: 12px; background: #B59197; color: white; border: none; border-radius: 6px; cursor: pointer; font-family: inherit; font-size: 1em; font-weight: 500;">Set PIN</button>
            <p style="margin: 14px 0 0; color: #A85A66; font-size: 0.82em; line-height: 1.5;">
                Important: Write this down somewhere safe. If you forget the PIN, you'll need a one-time reset through the developer console.
            </p>
        </div>
    `;
    document.body.appendChild(el);
    const i1 = el.querySelector('#pinSetup1');
    const i2 = el.querySelector('#pinSetup2');
    const errEl = el.querySelector('#pinSetupError');
    const submit = async () => {
        const a = (i1.value || '').trim();
        const b = (i2.value || '').trim();
        errEl.style.display = 'none';
        if (!/^\d{4,6}$/.test(a)) { errEl.textContent = 'PIN must be 4–6 digits'; errEl.style.display = 'block'; return; }
        if (a !== b) { errEl.textContent = "PINs don't match"; errEl.style.display = 'block'; return; }
        const btn = el.querySelector('#pinSetupBtn');
        btn.disabled = true; btn.textContent = 'Saving…';
        try {
            const ok = await _savePinHash(a);
            if (ok === false) throw new Error('save failed');
            _markPinVerified();
            _pinGateActive = false;
            el.remove();
            const mainContent = document.getElementById('mainContent');
            if (mainContent) mainContent.style.display = 'block';
            if (typeof showToast === 'function') showToast('PIN set');
        } catch (e) {
            errEl.textContent = 'Could not save PIN — check connection';
            errEl.style.display = 'block';
            btn.disabled = false; btn.textContent = 'Set PIN';
        }
    };
    el.querySelector('#pinSetupBtn').addEventListener('click', submit);
    i2.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
    setTimeout(() => i1.focus(), 100);
}

function _showPinChallenge() {
    let el = document.getElementById('pinOverlay');
    if (el) el.remove();
    const failures = _getPinFailures();
    const remaining = Math.max(0, PIN_MAX_FAILURES - failures);
    el = document.createElement('div');
    el.id = 'pinOverlay';
    el.style.cssText = `
        position: fixed; inset: 0; background: rgba(0,0,0,0.92);
        z-index: 99998; display: flex; align-items: center; justify-content: center;
        padding: 20px;
    `;
    el.innerHTML = `
        <div style="background: #2A2220; border: 1px solid #4A413E; border-radius: 12px; padding: 28px 32px; max-width: 380px; width: 100%; color: #F0E6E8; font-family: inherit;">
            <h2 style="margin: 0 0 8px; font-family: 'Cormorant Unicase', serif; font-weight: 500;">Enter PIN</h2>
            <p style="margin: 0 0 20px; color: #C0B0B4; font-size: 0.92em; line-height: 1.5;">
                Enter your PIN to unlock the CRM.
            </p>
            <input type="password" id="pinChallenge" inputmode="numeric" pattern="[0-9]*" maxlength="6" autocomplete="one-time-code" placeholder="••••" style="width: 100%; padding: 14px; background: #1A1614; border: 1px solid #4A413E; border-radius: 6px; color: #F0E6E8; font-family: monospace; font-size: 1.6em; letter-spacing: 0.5em; text-align: center; box-sizing: border-box; margin-bottom: 10px;">
            <div id="pinChallengeError" style="color: #A85A66; font-size: 0.88em; margin-bottom: 10px; display: none;"></div>
            <button id="pinChallengeBtn" style="width: 100%; padding: 12px; background: #B59197; color: white; border: none; border-radius: 6px; cursor: pointer; font-family: inherit; font-size: 1em; font-weight: 500;">Unlock</button>
            <p id="pinAttemptsLeft" style="margin: 12px 0 0; color: #C0B0B4; font-size: 0.82em; text-align: center;">${failures > 0 ? remaining + ' attempts remaining before sign-out' : ''}</p>
        </div>
    `;
    document.body.appendChild(el);
    const input = el.querySelector('#pinChallenge');
    const errEl = el.querySelector('#pinChallengeError');
    const btn = el.querySelector('#pinChallengeBtn');
    const attemptsEl = el.querySelector('#pinAttemptsLeft');
    const submit = async () => {
        const v = (input.value || '').trim();
        errEl.style.display = 'none';
        if (!/^\d{4,6}$/.test(v)) { errEl.textContent = 'PIN must be 4–6 digits'; errEl.style.display = 'block'; return; }
        btn.disabled = true; btn.textContent = 'Checking…';
        try {
            const ok = await _verifyPin(v);
            if (ok) {
                _markPinVerified();
                _pinGateActive = false;
                el.remove();
                const mainContent = document.getElementById('mainContent');
                if (mainContent) mainContent.style.display = 'block';
            } else {
                const n = _incrementPinFailures();
                const left = PIN_MAX_FAILURES - n;
                if (left <= 0) {
                    _resetPinFailures();
                    _clearPinSession();
                    await auth.signOut();
                    return;
                }
                errEl.textContent = 'Wrong PIN';
                errEl.style.display = 'block';
                attemptsEl.textContent = left + ' attempt' + (left === 1 ? '' : 's') + ' remaining before sign-out';
                input.value = '';
                btn.disabled = false; btn.textContent = 'Unlock';
                input.focus();
            }
        } catch (e) {
            console.error('[pin] verify error:', e);
            errEl.textContent = 'PIN check failed — try again';
            errEl.style.display = 'block';
            btn.disabled = false; btn.textContent = 'Unlock';
        }
    };
    btn.addEventListener('click', submit);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
    setTimeout(() => input.focus(), 100);
}

// Allow user to change PIN later from the signed-in indicator menu
window.changePin = async function() {
    if (!auth.currentUser) return;
    if (!_isPinVerified()) {
        alert('Unlock with current PIN first.');
        return;
    }
    const current = prompt('Enter your CURRENT PIN to confirm:');
    if (!current) return;
    const ok = await _verifyPin(current);
    if (!ok) { alert('Wrong current PIN.'); return; }
    const next = prompt('Enter your NEW PIN (4-6 digits):');
    if (!next || !/^\d{4,6}$/.test(next)) { alert('PIN must be 4-6 digits.'); return; }
    const confirm = prompt('Confirm new PIN:');
    if (confirm !== next) { alert("PINs don't match."); return; }
    const saveOk = await _savePinHash(next);
    if (saveOk === false) { alert('Save failed.'); return; }
    alert('PIN updated.');
};

/* ============================================================
   CHANGE FIREBASE PASSWORD
   Requires recent authentication. We reauthenticate with the
   current password before issuing updatePassword, so a stolen
   PIN-verified session can't be used to lock the real owner out.
   ============================================================ */

window.changePassword = async function() {
    if (!auth.currentUser) { alert('Sign in first.'); return; }
    if (!_isPinVerified()) { alert('Unlock with PIN first.'); return; }
    _showChangePasswordModal();
};

function _showChangePasswordModal() {
    let el = document.getElementById('changePasswordOverlay');
    if (el) el.remove();
    el = document.createElement('div');
    el.id = 'changePasswordOverlay';
    el.style.cssText = `
        position: fixed; inset: 0; background: rgba(0,0,0,0.92);
        z-index: 99998; display: flex; align-items: center; justify-content: center;
        padding: 20px;
    `;
    el.innerHTML = `
        <div style="background: #2A2220; border: 1px solid #4A413E; border-radius: 12px; padding: 28px 32px; max-width: 420px; width: 100%; color: #F0E6E8; font-family: inherit;">
            <h2 style="margin: 0 0 8px; font-family: 'Cormorant Unicase', serif; font-weight: 500;">Change password</h2>
            <p style="margin: 0 0 20px; color: #C0B0B4; font-size: 0.92em; line-height: 1.5;">
                Update the shared MyReliaCare login password. Charlie will be signed out within an hour and will need the new password.
            </p>
            <label style="display: block; color: #C0B0B4; font-size: 0.85em; margin-bottom: 6px;">Current password</label>
            <input type="password" id="cpCurrent" autocomplete="current-password" style="width: 100%; padding: 12px; background: #1A1614; border: 1px solid #4A413E; border-radius: 6px; color: #F0E6E8; font-family: inherit; font-size: 1em; box-sizing: border-box; margin-bottom: 12px;">
            <label style="display: block; color: #C0B0B4; font-size: 0.85em; margin-bottom: 6px;">New password</label>
            <input type="password" id="cpNew1" autocomplete="new-password" style="width: 100%; padding: 12px; background: #1A1614; border: 1px solid #4A413E; border-radius: 6px; color: #F0E6E8; font-family: inherit; font-size: 1em; box-sizing: border-box; margin-bottom: 12px;">
            <label style="display: block; color: #C0B0B4; font-size: 0.85em; margin-bottom: 6px;">Confirm new password</label>
            <input type="password" id="cpNew2" autocomplete="new-password" style="width: 100%; padding: 12px; background: #1A1614; border: 1px solid #4A413E; border-radius: 6px; color: #F0E6E8; font-family: inherit; font-size: 1em; box-sizing: border-box; margin-bottom: 10px;">
            <div id="cpError" style="color: #A85A66; font-size: 0.88em; margin-bottom: 10px; display: none;"></div>
            <div style="display: flex; gap: 10px;">
                <button id="cpCancelBtn" style="flex: 1; padding: 12px; background: transparent; color: #C0B0B4; border: 1px solid #4A413E; border-radius: 6px; cursor: pointer; font-family: inherit; font-size: 1em;">Cancel</button>
                <button id="cpSubmitBtn" style="flex: 1; padding: 12px; background: #B59197; color: white; border: none; border-radius: 6px; cursor: pointer; font-family: inherit; font-size: 1em; font-weight: 500;">Update password</button>
            </div>
        </div>
    `;
    document.body.appendChild(el);

    const cur = el.querySelector('#cpCurrent');
    const n1 = el.querySelector('#cpNew1');
    const n2 = el.querySelector('#cpNew2');
    const errEl = el.querySelector('#cpError');
    const cancelBtn = el.querySelector('#cpCancelBtn');
    const submitBtn = el.querySelector('#cpSubmitBtn');

    cancelBtn.addEventListener('click', () => el.remove());

    const submit = async () => {
        errEl.style.display = 'none';
        const current = cur.value;
        const newPw = n1.value;
        const confirmPw = n2.value;

        if (!current) { errEl.textContent = 'Enter your current password'; errEl.style.display = 'block'; return; }
        if (!newPw || newPw.length < 8) { errEl.textContent = 'New password must be at least 8 characters'; errEl.style.display = 'block'; return; }
        if (newPw === current) { errEl.textContent = "New password can't be the same as current"; errEl.style.display = 'block'; return; }
        if (newPw !== confirmPw) { errEl.textContent = "New passwords don't match"; errEl.style.display = 'block'; return; }

        submitBtn.disabled = true; cancelBtn.disabled = true;
        submitBtn.textContent = 'Updating…';

        try {
            const credential = firebase.auth.EmailAuthProvider.credential(SHARED_EMAIL, current);
            await auth.currentUser.reauthenticateWithCredential(credential);
            await auth.currentUser.updatePassword(newPw);
            el.remove();
            if (typeof showToast === 'function') {
                showToast('Password updated — Charlie will need to sign in with the new one');
            } else {
                alert('Password updated. Charlie will be signed out within an hour and will need the new password to sign back in.');
            }
        } catch (e) {
            console.error('[changePassword]', e);
            const code = e.code || '';
            if (code === 'auth/wrong-password' || code === 'auth/invalid-credential' || code === 'auth/invalid-login-credentials') {
                errEl.textContent = 'Current password is incorrect';
            } else if (code === 'auth/weak-password') {
                errEl.textContent = 'New password is too weak — try a longer one';
            } else if (code === 'auth/too-many-requests') {
                errEl.textContent = 'Too many attempts — wait a few minutes and try again';
            } else if (code === 'auth/network-request-failed') {
                errEl.textContent = 'Network error — check your connection';
            } else if (code === 'auth/requires-recent-login') {
                errEl.textContent = 'Session too old — sign out and back in, then try again';
            } else {
                errEl.textContent = 'Could not update: ' + (e.message || code);
            }
            errEl.style.display = 'block';
            submitBtn.disabled = false; cancelBtn.disabled = false;
            submitBtn.textContent = 'Update password';
        }
    };

    submitBtn.addEventListener('click', submit);
    n2.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
    setTimeout(() => cur.focus(), 100);
}

/* =============================================================
   AUTH FLOW
============================================================= */
window.checkPassword = async function() {
    const input = document.getElementById('passwordInput');
    const error = document.getElementById('passwordError');
    const btn = document.querySelector('.password-btn');
    const password = input.value;
    if (!password) return;

    if (btn) { btn.disabled = true; btn.textContent = 'Signing in…'; }
    if (error) error.style.display = 'none';

    try {
        await auth.signInWithEmailAndPassword(SHARED_EMAIL, password);
        // onAuthStateChanged will handle UI transition. Firebase Auth's LOCAL persistence
        // keeps the session alive via its own token in IndexedDB — no need to store the
        // raw password ourselves.
    } catch (e) {
        console.error('[sync] login error:', e);
        if (error) {
            const code = e.code || '';
            if (code === 'auth/wrong-password' || code === 'auth/invalid-credential' || code === 'auth/invalid-email' || code === 'auth/user-not-found') {
                error.textContent = 'Incorrect password. Please try again.';
            } else if (code === 'auth/too-many-requests') {
                error.textContent = 'Too many attempts. Try again in a few minutes.';
            } else if (code === 'auth/network-request-failed') {
                error.textContent = 'Network error — check your connection.';
            } else {
                error.textContent = 'Login failed. Try again.';
            }
            error.style.display = 'block';
        }
        if (btn) { btn.disabled = false; btn.textContent = 'Access CRM'; }
        input.value = '';
        input.focus();
    }
};

window.logout = async function() {
    // Clean up any leftover legacy storage entry from previous versions
    try { localStorage.removeItem('myreliacare_session_token'); } catch {}
    try {
        await auth.signOut();
        // Don't reload — onAuthStateChanged handles UI
    } catch (e) {
        console.error('[sync] logout error:', e);
        // Force reload as fallback
        location.reload();
    }
};

window.checkLoginState = function() {
    // No-op now; onAuthStateChanged is the real driver
};

/* =============================================================
   MIGRATION (one-time, on first login per device)
   Uses _preMigrationCache (snapshot from module load) — never
   reads localStorage at this point because the listener may have
   already overwritten it.
============================================================= */
async function _maybeMigrate() {
    if (localStorage.getItem('myreliacare_migrated') === 'yes') return;

    const ops = [];
    let totalToMigrate = 0;
    for (const c of COLLECTIONS) {
        const localArr = _preMigrationCache[c.stateKey] || [];
        if (localArr.length === 0) continue;

        // Pull current Firestore IDs at migration time (one read per collection,
        // but accurate even if listener hasn't fired yet)
        let firestoreIds = new Set();
        try {
            const snap = await db.collection(c.name).get();
            snap.docs.forEach(d => firestoreIds.add(d.id));
        } catch (e) {
            console.error(`[sync] migration: could not read ${c.name}:`, e);
            return; // bail without setting flag — try again next login
        }

        for (const item of localArr) {
            if (item.id && !firestoreIds.has(item.id)) {
                const { id, ...data } = item;
                const cleaned = JSON.parse(JSON.stringify(data));
                ops.push(db.collection(c.name).doc(item.id).set(cleaned));
                totalToMigrate++;
            }
        }
    }

    if (ops.length > 0) {
        try {
            await Promise.all(ops);
            console.log(`[sync] migrated ${totalToMigrate} records to cloud`);
            if (typeof showToast === 'function') showToast(`Synced ${totalToMigrate} record${totalToMigrate === 1 ? '' : 's'} to cloud`);
        } catch (e) {
            console.error('[sync] migration error:', e);
            return; // don't mark as migrated if it failed
        }
    } else {
        console.log('[sync] no local-only records to migrate');
    }
    localStorage.setItem('myreliacare_migrated', 'yes');
}

/* =============================================================
   AUTH STATE → UI
============================================================= */
auth.onAuthStateChanged(async user => {
    const passwordScreen = document.getElementById('passwordScreen');
    const mainContent = document.getElementById('mainContent');

    if (user) {
        // Logged in
        if (passwordScreen) passwordScreen.style.display = 'none';
        // Show mainContent only if PIN is already verified this session.
        // Otherwise leave it hidden — the PIN gate (called below) reveals it on success.
        // Prevents a brief flash of dashboard content before the PIN modal mounts.
        if (mainContent) mainContent.style.display = _isPinVerified() ? 'block' : 'none';

        // Hide session-expired modal if it was showing
        const expEl = document.getElementById('sessionExpiredOverlay');
        if (expEl) expEl.style.display = 'none';

        // Start inactivity tracking + show signed-in indicator
        _markActivity();
        _startInactivityTimer();
        _injectSignedInIndicator();
        const indicator = document.getElementById('signedInIndicator');
        if (indicator) indicator.style.display = 'flex';
        const searchBtn = document.getElementById('globalSearchBtn');
        if (searchBtn) searchBtn.style.display = 'flex';
        const refreshBtn = document.getElementById('globalRefreshBtn');
        if (refreshBtn) refreshBtn.style.display = 'flex';

        // CRITICAL ORDER:
        // 1) Run migration (uses _preMigrationCache; safe even before listeners)
        // 2) Replay any pending ops from a previous session (where save started
        //    but never completed — e.g. tab closed mid-write). This MUST happen
        //    before listeners attach, otherwise the listener would see Firestore
        //    is missing those items and overwrite them out of local state.
        // 3) Then attach listeners (which can safely overwrite localStorage now)
        // 4) Then enforce PIN gate (which may need settings synced from Firestore)
        // 5) Then render the app — but mainContent stays hidden until PIN passes
        try { await _maybeMigrate(); } catch (e) { console.error('[sync] migrate error:', e); }
        try { await _replayPendingOps(); } catch (e) { console.error('[sync] replay error:', e); }
        attachListeners();

        if (typeof window.initApp === 'function' && !window._initialized) {
            window._initialized = true;
            try { window.initApp(); } catch (e) { console.error('[sync] initApp error:', e); }
        }

        // Show PIN gate AFTER initApp — initApp sets up the page, gate hides it until verified.
        _enforcePinGate().catch(e => console.error('[pin] gate error:', e));
    } else {
        // Not signed in — Firebase Auth's LOCAL persistence handles "stay signed in"
        // via its own session token in IndexedDB. No need to store the raw password.
        _stopInactivityTimer();
        _clearPinSession();
        _pinGateActive = false;
        const pinOverlay = document.getElementById('pinOverlay');
        if (pinOverlay) pinOverlay.remove();
        const cpOverlay = document.getElementById('changePasswordOverlay');
        if (cpOverlay) cpOverlay.remove();
        const indicator = document.getElementById('signedInIndicator');
        if (indicator) indicator.style.display = 'none';
        const menu = document.getElementById('indicatorMenu');
        if (menu) menu.style.display = 'none';
        const searchBtn2 = document.getElementById('globalSearchBtn');
        if (searchBtn2) searchBtn2.style.display = 'none';
        const refreshBtn2 = document.getElementById('globalRefreshBtn');
        if (refreshBtn2) refreshBtn2.style.display = 'none';

        detachListeners();
        if (passwordScreen) passwordScreen.style.display = 'flex';
        if (mainContent) mainContent.style.display = 'none';
        window._initialized = false;
        const inp = document.getElementById('passwordInput');
        if (inp) { inp.value = ''; setTimeout(() => inp.focus(), 100); }
    }
});

console.log('[sync] firebase-sync.js loaded');

/* ============================================================
   BEFOREUNLOAD GUARD
   If the user tries to close the tab while there's an in-flight Firestore
   write, prompt them. Catches the most common cause of silent data loss:
   user clicks save, sees the toast (which fires on the optimistic update),
   then immediately closes the tab before the async write finishes.
   The ops log in localStorage would still catch this on next login, but
   the prompt prevents the round-trip entirely.
   ============================================================ */
window.addEventListener('beforeunload', (e) => {
    if (_syncPendingOps > 0) {
        const msg = 'Saves still in progress — wait a moment so your changes reach the cloud.';
        e.preventDefault();
        e.returnValue = msg;
        return msg;
    }
});
