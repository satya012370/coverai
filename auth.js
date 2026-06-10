import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, signInWithPopup, GoogleAuthProvider, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, doc, getDoc, setDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyBfR2_eSuJoDuQtTNGV1ZQdtP5AQCWpnWk",
  authDomain: "coverai-a26bf.firebaseapp.com",
  projectId: "coverai-a26bf",
  storageBucket: "coverai-a26bf.firebasestorage.app",
  messagingSenderId: "644824895944",
  appId: "1:644824895944:web:f050b1d81f6d8b54b3b0fd",
  measurementId: "G-M0JQ2XS3NJ"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const provider = new GoogleAuthProvider();

// Expose Firebase services globally for other scripts
window.auth = auth;
window.db = db;

// ─── AUTH READY PROMISE ───────────────────────────────────────
// Resolves once the first auth state is known (user or null).
// Use: await window.authReady  — before checking window.currentUser
let _authResolve;
window.authReady = new Promise(resolve => { _authResolve = resolve; });

// ─── RENDER AUTH UI ───────────────────────────────────────────
// Shows a subtle loading pulse in auth-container while auth resolves
function renderAuthLoading() {
  const c = document.getElementById('auth-container');
  if (!c) return;
  c.innerHTML = `<div style="width:80px;height:30px;border-radius:8px;background:linear-gradient(90deg,#f0f0f0 25%,#e0e0e0 50%,#f0f0f0 75%);background-size:200% 100%;animation:authShimmer 1.2s infinite;" id="auth-loading-skeleton"></div>`;
  if (!document.getElementById('auth-shimmer-style')) {
    const s = document.createElement('style');
    s.id = 'auth-shimmer-style';
    s.textContent = '@keyframes authShimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}';
    document.head.appendChild(s);
  }
}

function renderAuthUI(user, isPro) {
  const authContainer = document.getElementById('auth-container');
  if (!authContainer) return;

  // Show/hide standard nav "Get Pro" button based on Pro status
  const getProBtn = document.querySelector('nav .nav-btn');
  if (getProBtn) {
    getProBtn.style.display = isPro ? 'none' : '';
  }

  if (user) {
    const proBadge = isPro
      ? `<span style="background:linear-gradient(90deg,#f59e0b,#d97706);color:#fff;font-size:10px;font-weight:700;padding:3px 8px;border-radius:20px;letter-spacing:.3px;white-space:nowrap;">⭐ PRO</span>`
      : '';
    const avatarBorder = isPro ? '#f59e0b' : '#5c4fc7';
    const firstName = (user.displayName || 'User').split(' ')[0];
    const subLabel = isPro
      ? `<span style="font-size:10px;color:#f59e0b;font-weight:600;">Pro Member</span>`
      : `<span style="font-size:10px;color:#888;">Free plan</span>`;

    authContainer.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;">
        ${proBadge}
        <img src="${user.photoURL || ''}" alt="${user.displayName || 'User'}"
             style="width:32px;height:32px;border-radius:50%;border:2.5px solid ${avatarBorder};object-fit:cover;flex-shrink:0;"
             onerror="this.src='';this.style.display='none';document.getElementById('auth-fallback-avatar')&&(document.getElementById('auth-fallback-avatar').style.display='flex');"
        />
        <div id="auth-fallback-avatar"
             style="display:none;width:32px;height:32px;border-radius:50%;background:${avatarBorder};color:#fff;font-size:14px;font-weight:700;align-items:center;justify-content:center;flex-shrink:0;">
          ${firstName[0].toUpperCase()}
        </div>
        <div style="display:flex;flex-direction:column;line-height:1.3;">
          <span style="font-size:13px;font-weight:600;color:#1a1a1a;white-space:nowrap;">${firstName}</span>
          ${subLabel}
        </div>
        <button onclick="signOutUser()"
                style="background:none;border:1px solid #e8e8e8;padding:5px 11px;font-size:12px;font-weight:600;color:#e24b4a;cursor:pointer;border-radius:8px;transition:all .2s;white-space:nowrap;margin-left:2px;"
                onmouseover="this.style.background='#fef2f2';this.style.borderColor='#fca5a5';"
                onmouseout="this.style.background='none';this.style.borderColor='#e8e8e8';">
          Sign Out
        </button>
      </div>`;
  } else {
    authContainer.innerHTML = `
      <button onclick="signInWithGoogle()"
              id="nav-signin-btn"
              style="display:flex;align-items:center;gap:8px;background:#fff;border:1px solid #d0d0d0;padding:7px 14px;border-radius:9px;font-size:13px;font-weight:600;color:#444;cursor:pointer;box-shadow:0 2px 6px rgba(0,0,0,0.07);transition:all .2s;white-space:nowrap;"
              onmouseover="this.style.boxShadow='0 4px 12px rgba(0,0,0,0.14)';this.style.borderColor='#aaa';"
              onmouseout="this.style.boxShadow='0 2px 6px rgba(0,0,0,0.07)';this.style.borderColor='#d0d0d0';">
        <svg width="16" height="16" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
          <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
          <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
          <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
          <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
        </svg>
        Sign In
      </button>`;
  }
}

// ─── SIGN IN ─────────────────────────────────────────────
window.signInWithGoogle = async () => {
  try {
    const result = await signInWithPopup(auth, provider);
    const user = result.user;

    // Try to create Firestore user doc — but don't block sign-in if it fails
    try {
      const userRef = doc(db, 'users', user.uid);
      const userSnap = await getDoc(userRef);
      if (!userSnap.exists()) {
        await setDoc(userRef, {
          email: user.email,
          name: user.displayName,
          pro: false,
          createdAt: new Date().toISOString()
        });
      }
    } catch (firestoreErr) {
      // Firestore offline is OK — auth still works, doc will be created later
      console.warn('Firestore user doc creation skipped (offline?):', firestoreErr.message);
    }
    // onAuthStateChanged will fire next and update the UI
  } catch (error) {
    console.error('Google sign-in failed:', error);
    // Only show alert for real auth errors, not network/Firestore issues
    const silentCodes = ['auth/popup-closed-by-user', 'auth/cancelled-popup-request'];
    if (!silentCodes.includes(error.code)) {
      alert('Sign in failed. Please check your internet connection and try again.');
    }
  }
};

// ─── SIGN OUT ─────────────────────────────────────────────────
window.signOutUser = () => {
  signOut(auth).then(() => {
    window.currentUser = null;
    // Dispatch event so payment.html can react
    window.dispatchEvent(new CustomEvent('coverai:signout'));
  }).catch((error) => {
    console.error("Sign out error", error);
  });
};

// ─── REFRESH PRO STATUS ───────────────────────────────────────
// Called after a successful payment to update nav without full reload
window.refreshProStatus = async () => {
  const user = auth.currentUser;
  if (!user) return;

  try {
    const userRef = doc(db, "users", user.uid);
    const userSnap = await getDoc(userRef);
    const isPro = userSnap.exists() && userSnap.data().pro === true;

    window.currentUser = {
      uid: user.uid,
      email: user.email,
      name: user.displayName,
      photoURL: user.photoURL,
      isPro: isPro
    };

    renderAuthUI(user, isPro);
    return isPro;
  } catch(e) {
    console.error("refreshProStatus failed:", e);
    return false;
  }
};

// ─── AUTH STATE LISTENER ──────────────────────────────────────
// Show loading skeleton immediately so the nav doesn't look empty
renderAuthLoading();

onAuthStateChanged(auth, async (user) => {
  if (user) {
    // Try to fetch Pro status — default to false if Firestore is offline
    let isPro = false;
    try {
      const userRef = doc(db, 'users', user.uid);
      const userSnap = await getDoc(userRef);
      isPro = userSnap.exists() && userSnap.data().pro === true;
    } catch (firestoreErr) {
      console.warn('Could not fetch Pro status (offline?), defaulting to free:', firestoreErr.message);
      // isPro stays false — safe default; user can reload once online
    }

    window.currentUser = {
      uid: user.uid,
      email: user.email,
      name: user.displayName,
      photoURL: user.photoURL,
      isPro: isPro
    };

    renderAuthUI(user, isPro);

    // Resolve authReady so pages waiting on it can proceed
    _authResolve({ user: window.currentUser, isPro });

    // Dispatch event so payment.html and other pages can react
    window.dispatchEvent(new CustomEvent('coverai:authchange', {
      detail: { user: window.currentUser, isPro }
    }));
  } else {
    window.currentUser = null;
    renderAuthUI(null, false);

    // Resolve authReady with null user
    _authResolve({ user: null, isPro: false });

    window.dispatchEvent(new CustomEvent('coverai:authchange', {
      detail: { user: null, isPro: false }
    }));
  }
});
