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
    if (el) { el.style.display = 'flex'; return; }
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
            <input type="password" id="sessionExpiredPw" placeholder="Password" style="width: 100%; padding: 10px 12px; background: #1A1614; border: 1px solid #4A413E; border-radius: 6px; color: #F0E6E8; font-family: inherit; font-size: 1em; box-sizing: border-box; margin-bottom: 10px;">
            <div id="sessionExpiredError" style="color: #ff8585; font-size: 0.88em; margin-bottom: 10px; display: none;"></div>
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
            if (e.code === 'auth/multi-factor-auth-required') {
                el.style.display = 'none';
                _showMfaChallenge(e.resolver);
                return;
            }
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

// Inject visible "signed in" status pill + sign-out into every page
function _injectSignedInIndicator() {
    if (document.getElementById('signedInIndicator')) return;
    const el = document.createElement('div');
    el.id = 'signedInIndicator';
    el.style.cssText = `
        position: fixed; bottom: 14px; right: 14px; z-index: 9500;
        background: rgba(42, 34, 32, 0.92); border: 1px solid #4A413E;
        color: #C0B0B4; padding: 6px 10px; border-radius: 20px;
        font-family: inherit; font-size: 0.78em;
        display: none; align-items: center; gap: 8px;
        backdrop-filter: blur(4px);
    `;
    el.innerHTML = `
        <span style="width: 8px; height: 8px; border-radius: 50%; background: #7FB069; display: inline-block;"></span>
        <span>Signed in</span>
        <button onclick="window.signOutCRM()" style="background: transparent; color: #B59197; border: none; cursor: pointer; font-family: inherit; font-size: 1em; padding: 0 0 0 4px; border-left: 1px solid #4A413E;">Sign out</button>
    `;
    document.body.appendChild(el);
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
        background: #C0392B; color: white;
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

    // Mark items being written/updated as pending (so listener doesn't lose them to stale snapshots)
    for (const item of newArr) {
        if (!item.id) continue;
        const old = oldById[item.id];
        if (!old || JSON.stringify(old) !== JSON.stringify(item)) {
            _pendingWrites.add(item.id);
        }
    }
    // Mark deletes as pending
    for (const oldItem of oldArr) {
        if (!newIds.has(oldItem.id)) _pendingDeletes.add(oldItem.id);
    }

    // Optimistic local update — caller's next get*() returns fresh data
    _state[coll.stateKey] = JSON.parse(JSON.stringify(newArr));
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
        .then(() => { _syncPendingOps--; })
        .catch(err => {
            _syncPendingOps--;
            console.error(`[sync] persist error on ${coll.name}:`, err);
            _syncFailures.push({ coll, oldArr, newArr, err, ts: Date.now() });
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
   MFA (TOTP) — enrollment + sign-in challenge
   Requires Identity Platform enabled on the Firebase project.
   Both Kasey's and Charlie's phones scan the same QR code at
   enrollment time, so either of them can produce valid codes.
   ============================================================ */

let _mfaResolver = null;      // set when sign-in throws auth/multi-factor-auth-required
let _mfaEnrollmentSecret = null;
let _qrcodeLibLoaded = false;

async function _loadQrcodeLib() {
    if (_qrcodeLibLoaded || window.QRCode) { _qrcodeLibLoaded = true; return; }
    return new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js';
        s.onload = () => { _qrcodeLibLoaded = true; resolve(); };
        s.onerror = () => reject(new Error('Could not load QR code library'));
        document.head.appendChild(s);
    });
}

function _isMfaEnrolled() {
    if (!auth.currentUser) return false;
    const factors = auth.currentUser.multiFactor && auth.currentUser.multiFactor.enrolledFactors;
    return Array.isArray(factors) && factors.length > 0;
}

function _refreshMfaButtonOnIndicator() {
    const wrap = document.getElementById('signedInIndicator');
    if (!wrap) return;
    let setupBtn = document.getElementById('mfaSetupBtn');
    const enrolled = _isMfaEnrolled();
    if (!enrolled && !setupBtn) {
        setupBtn = document.createElement('button');
        setupBtn.id = 'mfaSetupBtn';
        setupBtn.textContent = 'Enable 2FA';
        setupBtn.style.cssText = 'background: #B59197; color: white; border: none; cursor: pointer; font-family: inherit; font-size: 1em; padding: 2px 8px; border-radius: 10px; margin-right: 4px;';
        setupBtn.onclick = () => window.setupMfa();
        wrap.insertBefore(setupBtn, wrap.querySelector('button'));   // before Sign out
    } else if (enrolled && setupBtn) {
        setupBtn.remove();
    }
}

// MFA Sign-In Challenge
function _showMfaChallenge(resolver) {
    _mfaResolver = resolver;
    let el = document.getElementById('mfaChallengeOverlay');
    if (!el) {
        el = document.createElement('div');
        el.id = 'mfaChallengeOverlay';
        el.style.cssText = `
            position: fixed; inset: 0; background: rgba(0,0,0,0.85);
            z-index: 99999; display: flex; align-items: center; justify-content: center;
            padding: 20px;
        `;
        el.innerHTML = `
            <div style="background: #2A2220; border: 1px solid #4A413E; border-radius: 12px; padding: 28px 32px; max-width: 400px; width: 100%; color: #F0E6E8; font-family: inherit;">
                <h2 style="margin: 0 0 8px; font-family: 'Cormorant Unicase', serif; font-weight: 500;">Two-factor verification</h2>
                <p style="margin: 0 0 20px; color: #C0B0B4; font-size: 0.95em; line-height: 1.5;">
                    Open your authenticator app and enter the current 6-digit code for MyReliaCare CRM.
                </p>
                <input type="text" id="mfaChallengeCode" inputmode="numeric" pattern="[0-9]*" maxlength="6" placeholder="000000" style="width: 100%; padding: 14px 12px; background: #1A1614; border: 1px solid #4A413E; border-radius: 6px; color: #F0E6E8; font-family: monospace; font-size: 1.4em; letter-spacing: 0.3em; text-align: center; box-sizing: border-box; margin-bottom: 10px;">
                <div id="mfaChallengeError" style="color: #ff8585; font-size: 0.88em; margin-bottom: 10px; display: none;"></div>
                <button id="mfaChallengeBtn" style="width: 100%; padding: 10px; background: #B59197; color: white; border: none; border-radius: 6px; cursor: pointer; font-family: inherit; font-size: 1em; font-weight: 500;">Verify</button>
            </div>
        `;
        document.body.appendChild(el);
        const inp = el.querySelector('#mfaChallengeCode');
        el.querySelector('#mfaChallengeBtn').addEventListener('click', () => _submitMfaCode(inp.value.trim()));
        inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') _submitMfaCode(inp.value.trim()); });
    }
    el.style.display = 'flex';
    const input = el.querySelector('#mfaChallengeCode');
    input.value = '';
    el.querySelector('#mfaChallengeError').style.display = 'none';
    setTimeout(() => input.focus(), 100);
}

async function _submitMfaCode(code) {
    const errEl = document.getElementById('mfaChallengeError');
    const btn = document.getElementById('mfaChallengeBtn');
    if (!code || code.length !== 6) {
        errEl.textContent = 'Enter the 6-digit code';
        errEl.style.display = 'block';
        return;
    }
    if (!_mfaResolver) return;
    btn.disabled = true;
    btn.textContent = 'Verifying…';
    try {
        const factorUid = _mfaResolver.hints[0].uid;
        const assertion = firebase.auth.TotpMultiFactorGenerator.assertionForSignIn(factorUid, code);
        await _mfaResolver.resolveSignIn(assertion);
        document.getElementById('mfaChallengeOverlay').style.display = 'none';
        _mfaResolver = null;
    } catch (e) {
        console.error('[mfa] verify error:', e);
        errEl.textContent = 'Wrong code — try again';
        errEl.style.display = 'block';
        btn.disabled = false;
        btn.textContent = 'Verify';
    }
}

// MFA Enrollment
window.setupMfa = async function() {
    if (!auth.currentUser) return;
    try {
        await _loadQrcodeLib();
        const session = await auth.currentUser.multiFactor.getSession();
        const secret = await firebase.auth.TotpMultiFactorGenerator.generateSecret(session);
        _mfaEnrollmentSecret = secret;
        const otpauthUrl = secret.generateQrCodeUrl(SHARED_EMAIL, 'MyReliaCare CRM');
        _showMfaEnrollmentModal(otpauthUrl, secret.secretKey);
    } catch (e) {
        console.error('[mfa] setup error:', e);
        const code = e.code || '';
        if (code === 'auth/operation-not-allowed' || code === 'auth/unsupported-tenant-operation' || code === 'auth/unsupported-first-factor') {
            alert('MFA is not enabled on this Firebase project. Go to Firebase Console → Authentication → Sign-in method, upgrade to Identity Platform, then enable TOTP.');
        } else if (code === 'auth/requires-recent-login') {
            alert('Please sign out and sign in again before setting up 2FA.');
        } else {
            alert('Could not start MFA setup: ' + (e.message || code));
        }
    }
};

function _showMfaEnrollmentModal(otpauthUrl, secretKey) {
    let el = document.getElementById('mfaEnrollOverlay');
    if (el) el.remove();
    el = document.createElement('div');
    el.id = 'mfaEnrollOverlay';
    el.style.cssText = `
        position: fixed; inset: 0; background: rgba(0,0,0,0.85);
        z-index: 99999; display: flex; align-items: center; justify-content: center;
        padding: 20px; overflow-y: auto;
    `;
    el.innerHTML = `
        <div style="background: #2A2220; border: 1px solid #4A413E; border-radius: 12px; padding: 28px 32px; max-width: 460px; width: 100%; color: #F0E6E8; font-family: inherit; margin: 20px auto;">
            <h2 style="margin: 0 0 10px; font-family: 'Cormorant Unicase', serif; font-weight: 500;">Enable two-factor authentication</h2>
            <p style="margin: 0 0 16px; color: #C0B0B4; font-size: 0.92em; line-height: 1.5;">
                <strong>Step 1:</strong> Open Google Authenticator, 1Password, Authy, or another TOTP app on <strong>both</strong> your phone <em>and</em> Charlie's phone.
            </p>
            <p style="margin: 0 0 12px; color: #C0B0B4; font-size: 0.92em; line-height: 1.5;">
                <strong>Step 2:</strong> Scan this QR code with both phones (or paste the secret key manually).
            </p>
            <div id="mfaQrContainer" style="background: white; padding: 16px; border-radius: 8px; margin: 0 auto 14px; width: fit-content;"></div>
            <details style="margin-bottom: 16px; color: #C0B0B4; font-size: 0.88em;">
                <summary style="cursor: pointer;">Can't scan? Show secret key for manual entry</summary>
                <code style="display: block; background: #1A1614; padding: 10px; border-radius: 6px; margin-top: 8px; font-family: monospace; font-size: 0.95em; word-break: break-all; user-select: all;">${secretKey}</code>
            </details>
            <p style="margin: 0 0 10px; color: #C0B0B4; font-size: 0.92em; line-height: 1.5;">
                <strong>Step 3:</strong> Enter the current 6-digit code shown in either authenticator app to confirm.
            </p>
            <input type="text" id="mfaEnrollCode" inputmode="numeric" pattern="[0-9]*" maxlength="6" placeholder="000000" style="width: 100%; padding: 12px; background: #1A1614; border: 1px solid #4A413E; border-radius: 6px; color: #F0E6E8; font-family: monospace; font-size: 1.4em; letter-spacing: 0.3em; text-align: center; box-sizing: border-box; margin-bottom: 10px;">
            <div id="mfaEnrollError" style="color: #ff8585; font-size: 0.88em; margin-bottom: 10px; display: none;"></div>
            <div style="display: flex; gap: 8px;">
                <button id="mfaEnrollCancel" style="flex: 1; padding: 10px; background: transparent; color: #C0B0B4; border: 1px solid #4A413E; border-radius: 6px; cursor: pointer; font-family: inherit;">Cancel</button>
                <button id="mfaEnrollConfirm" style="flex: 2; padding: 10px; background: #B59197; color: white; border: none; border-radius: 6px; cursor: pointer; font-family: inherit; font-weight: 500;">Confirm & enable</button>
            </div>
            <p style="margin: 14px 0 0; color: #ff8585; font-size: 0.82em; line-height: 1.5;">
                ⚠️ <strong>Important:</strong> Save the secret key somewhere safe (password manager, printed copy in a drawer). If both phones are ever lost or wiped, this is the only way to recover access without a Firebase admin reset.
            </p>
        </div>
    `;
    document.body.appendChild(el);
    new window.QRCode(el.querySelector('#mfaQrContainer'), {
        text: otpauthUrl,
        width: 200,
        height: 200,
    });
    el.querySelector('#mfaEnrollCancel').onclick = () => { el.remove(); _mfaEnrollmentSecret = null; };
    const inp = el.querySelector('#mfaEnrollCode');
    el.querySelector('#mfaEnrollConfirm').onclick = () => _completeMfaEnrollment(inp.value.trim());
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') _completeMfaEnrollment(inp.value.trim()); });
    setTimeout(() => inp.focus(), 100);
}

async function _completeMfaEnrollment(code) {
    const errEl = document.getElementById('mfaEnrollError');
    const btn = document.getElementById('mfaEnrollConfirm');
    if (!code || code.length !== 6) {
        errEl.textContent = 'Enter the 6-digit code';
        errEl.style.display = 'block';
        return;
    }
    if (!_mfaEnrollmentSecret) return;
    btn.disabled = true;
    btn.textContent = 'Enabling…';
    try {
        const assertion = firebase.auth.TotpMultiFactorGenerator.assertionForEnrollment(_mfaEnrollmentSecret, code);
        await auth.currentUser.multiFactor.enroll(assertion, 'Authenticator');
        _mfaEnrollmentSecret = null;
        document.getElementById('mfaEnrollOverlay').remove();
        _refreshMfaButtonOnIndicator();
        if (typeof showToast === 'function') showToast('Two-factor authentication enabled');
    } catch (e) {
        console.error('[mfa] enroll error:', e);
        errEl.textContent = 'Wrong code — make sure you have the right account in your authenticator';
        errEl.style.display = 'block';
        btn.disabled = false;
        btn.textContent = 'Confirm & enable';
    }
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
        // MFA challenge — Firebase didn't sign in because second factor is required
        if (e.code === 'auth/multi-factor-auth-required') {
            if (btn) { btn.disabled = false; btn.textContent = 'Access CRM'; }
            _showMfaChallenge(e.resolver);
            return;
        }
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
        if (mainContent) mainContent.style.display = 'block';

        // Hide session-expired modal if it was showing
        const expEl = document.getElementById('sessionExpiredOverlay');
        if (expEl) expEl.style.display = 'none';

        // Start inactivity tracking + show signed-in indicator
        _markActivity();
        _startInactivityTimer();
        _injectSignedInIndicator();
        const indicator = document.getElementById('signedInIndicator');
        if (indicator) indicator.style.display = 'flex';
        _refreshMfaButtonOnIndicator();

        // CRITICAL ORDER:
        // 1) Run migration (uses _preMigrationCache; safe even before listeners)
        // 2) Then attach listeners (which can safely overwrite localStorage now)
        // 3) Then render the app
        try { await _maybeMigrate(); } catch (e) { console.error('[sync] migrate error:', e); }
        attachListeners();

        if (typeof window.initApp === 'function' && !window._initialized) {
            window._initialized = true;
            try { window.initApp(); } catch (e) { console.error('[sync] initApp error:', e); }
        }
    } else {
        // Not signed in — Firebase Auth's LOCAL persistence handles "stay signed in"
        // via its own session token in IndexedDB. No need to store the raw password.
        _stopInactivityTimer();
        const indicator = document.getElementById('signedInIndicator');
        if (indicator) indicator.style.display = 'none';

        detachListeners();
        if (passwordScreen) passwordScreen.style.display = 'flex';
        if (mainContent) mainContent.style.display = 'none';
        window._initialized = false;
        const inp = document.getElementById('passwordInput');
        if (inp) { inp.value = ''; setTimeout(() => inp.focus(), 100); }
    }
});

console.log('[sync] firebase-sync.js loaded');
