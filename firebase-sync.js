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

// "Remember me" credential storage. Stored base64'd (light obfuscation, not encryption) —
// for the threat model of a private 2-person CRM behind phone unlock, this is acceptable.
// Tradeoff: anyone with unlocked phone access can open the CRM without entering a password.
const _REMEMBER_KEY = 'myreliacare_session_token';
function _saveRemembered(pw) {
    try { localStorage.setItem(_REMEMBER_KEY, btoa(pw)); } catch {}
}
function _getRemembered() {
    try {
        const raw = localStorage.getItem(_REMEMBER_KEY);
        return raw ? atob(raw) : null;
    } catch { return null; }
}
function _clearRemembered() {
    try { localStorage.removeItem(_REMEMBER_KEY); } catch {}
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
    logo: 'myreliacare_logo'  // logo stays per-device; not synced (large base64)
};

// --- Collections that sync to Firestore ---
const COLLECTIONS = [
    { name: 'clients',        stateKey: 'clients',        storageKey: STORAGE_KEYS.clients },
    { name: 'visits',         stateKey: 'visits',         storageKey: STORAGE_KEYS.visits },
    { name: 'personalEvents', stateKey: 'personalEvents', storageKey: STORAGE_KEYS.personalEvents },
    { name: 'invoices',       stateKey: 'invoices',       storageKey: STORAGE_KEYS.invoices },
    { name: 'quickNotes',     stateKey: 'quickNotes',     storageKey: STORAGE_KEYS.quickNotes }
];

// --- In-memory state ---
const _state = {
    clients: [], visits: [], personalEvents: [], invoices: [], quickNotes: []
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
function attachListeners() {
    if (_listenersAttached) return;
    _listenersAttached = true;
    COLLECTIONS.forEach(c => {
        const unsub = db.collection(c.name).onSnapshot(snap => {
            _state[c.stateKey] = snap.docs.map(d => ({ ...d.data(), id: d.id }));
            try { localStorage.setItem(c.storageKey, JSON.stringify(_state[c.stateKey])); } catch {}
            _notifyDataChange();
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
    getClients() { return _state.clients.slice(); },
    getVisits() { return _state.visits.slice(); },
    getPersonalEvents() { return _state.personalEvents.slice(); },
    getInvoices() { return _state.invoices.slice(); },
    saveClients(arr) { return _saveCollection(COLLECTIONS[0], arr); },
    saveVisits(arr) { return _saveCollection(COLLECTIONS[1], arr); },
    savePersonalEvents(arr) { return _saveCollection(COLLECTIONS[2], arr); },
    saveInvoices(arr) { return _saveCollection(COLLECTIONS[3], arr); }
};

function _saveCollection(coll, newArr) {
    if (!auth.currentUser) {
        console.warn('[sync] save attempted while signed out — discarded');
        return false;
    }
    const oldArr = _state[coll.stateKey].slice();

    // Optimistic local update — caller's next get*() returns fresh data
    _state[coll.stateKey] = JSON.parse(JSON.stringify(newArr));
    try { localStorage.setItem(coll.storageKey, JSON.stringify(newArr)); } catch {}

    // Push to Firestore (async, fire and forget). Listener will reconcile.
    _persistToFirestore(coll, oldArr, newArr).catch(err => {
        console.error(`[sync] persist error on ${coll.name}:`, err);
        if (typeof showToast === 'function') showToast('Save failed — check connection', 'error');
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
        _saveRemembered(password);
        // onAuthStateChanged will handle UI transition
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
    _clearRemembered();
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
        // Not logged in. Before showing the password screen, try silent auto-relogin
        // using a remembered credential (Safari ITP and aggressive storage cleanup
        // sometimes wipe the Firebase session token even when localStorage survives).
        const remembered = _getRemembered();
        if (remembered) {
            try {
                await auth.signInWithEmailAndPassword(SHARED_EMAIL, remembered);
                // Success — onAuthStateChanged will fire again with user set
                return;
            } catch (e) {
                // Stored password no longer works (rotated, etc). Clear it.
                console.warn('[sync] auto-relogin failed:', e.code || e.message);
                _clearRemembered();
            }
        }

        // Fall through to manual login
        detachListeners();
        if (passwordScreen) passwordScreen.style.display = 'flex';
        if (mainContent) mainContent.style.display = 'none';
        window._initialized = false;
        const inp = document.getElementById('passwordInput');
        if (inp) { inp.value = ''; setTimeout(() => inp.focus(), 100); }
    }
});

console.log('[sync] firebase-sync.js loaded');
