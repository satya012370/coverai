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

// ─── RENDER AUTH UI ───────────────────────────────────────────
function renderAuthUI(user, isPro) {
  const authContainer = document.getElementById("auth-container");
  if (!authContainer) return;

  if (user) {
    authContainer.innerHTML = `
      <div style="display:flex;align-items:center;gap:10px;">
        ${isPro ? '<span style="background:linear-gradient(90deg,#f59e0b,#d97706);color:#fff;font-size:10px;font-weight:700;padding:3px 8px;border-radius:20px;letter-spacing:.3px;">⭐ PRO</span>' : ''}
        <img src="${user.photoURL || ''}" alt="${user.displayName || 'User'}"
             style="width:30px;height:30px;border-radius:50%;border:2px solid ${isPro ? '#f59e0b' : '#5c4fc7'};object-fit:cover;"
             onerror="this.style.display='none'"/>
        <div style="display:flex;flex-direction:column;line-height:1.2;max-width:120px;overflow:hidden;">
          <span style="font-size:12px;font-weight:600;color:#1a1a1a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${user.displayName ? user.displayName.split(' ')[0] : 'User'}</span>
          ${isPro ? '' : '<span style="font-size:10px;color:#888;">Free plan</span>'}
        </div>
        <button onclick="signOutUser()"
                style="background:none;border:1px solid #e0e0e0;padding:5px 12px;font-size:12px;font-weight:600;color:#e24b4a;cursor:pointer;border-radius:8px;transition:all .2s;white-space:nowrap;"
                onmouseover="this.style.background='#fef2f2'"
                onmouseout="this.style.background='none'">
          Sign Out
        </button>
      </div>
    `;
  } else {
    authContainer.innerHTML = `
      <button onclick="signInWithGoogle()"
              style="display:flex;align-items:center;gap:8px;background:#fff;border:1px solid #d0d0d0;padding:7px 14px;border-radius:9px;font-size:13px;font-weight:600;color:#444;cursor:pointer;box-shadow:0 2px 6px rgba(0,0,0,0.07);transition:all .2s;"
              onmouseover="this.style.boxShadow='0 4px 12px rgba(0,0,0,0.12)'"
              onmouseout="this.style.boxShadow='0 2px 6px rgba(0,0,0,0.07)'">
        <svg width="16" height="16" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
          <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
          <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
          <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
          <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
        </svg>
        Sign In
      </button>
    `;
  }
}

// ─── SIGN IN ──────────────────────────────────────────────────
window.signInWithGoogle = async () => {
  try {
    const result = await signInWithPopup(auth, provider);
    const user = result.user;

    // Create Firestore user doc if first login
    const userRef = doc(db, "users", user.uid);
    const userSnap = await getDoc(userRef);
    if (!userSnap.exists()) {
      await setDoc(userRef, {
        email: user.email,
        name: user.displayName,
        pro: false,
        createdAt: new Date().toISOString()
      });
    }
  } catch (error) {
    console.error("Login failed:", error);
    if (error.code !== 'auth/popup-closed-by-user') {
      alert("Login failed: " + error.message);
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
onAuthStateChanged(auth, async (user) => {
  if (user) {
    // Fetch Pro status from Firestore
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

    // Dispatch event so other scripts (e.g. payment.html) can react
    window.dispatchEvent(new CustomEvent('coverai:authchange', {
      detail: { user: window.currentUser, isPro }
    }));
  } else {
    window.currentUser = null;
    renderAuthUI(null, false);

    window.dispatchEvent(new CustomEvent('coverai:authchange', {
      detail: { user: null, isPro: false }
    }));
  }
});
