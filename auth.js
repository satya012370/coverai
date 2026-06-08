import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, signInWithPopup, GoogleAuthProvider, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, doc, getDoc, setDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyBfR2_eSuJoDuQtTNGV1ZQdtP5AQCwpnWk",
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

// Expose functions globally so buttons can trigger them
window.signInWithGoogle = async () => {
  try {
    const result = await signInWithPopup(auth, provider);
    const user = result.user;
    
    // Check if user exists in Firestore, if not create a default entry
    const userRef = doc(db, "users", user.uid);
    const userSnap = await getDoc(userRef);
    if (!userSnap.exists()) {
      await setDoc(userRef, {
        email: user.email,
        name: user.displayName,
        pro: false, // Default to free plan
        createdAt: new Date().toISOString()
      });
    }
  } catch (error) {
    console.error("Login failed:", error);
    alert("Login failed: " + error.message);
  }
};

window.signOutUser = () => {
  signOut(auth).then(() => {
    // Optional: show a toast or redirect
  }).catch((error) => {
    console.error("Sign out error", error);
  });
};

// Listen for auth state changes and update the UI
onAuthStateChanged(auth, async (user) => {
  const authContainer = document.getElementById("auth-container");
  
  if (user) {
    // User is signed in
    // Fetch user's pro status from Firestore
    const userRef = doc(db, "users", user.uid);
    const userSnap = await getDoc(userRef);
    let isPro = false;
    if (userSnap.exists()) {
      isPro = userSnap.data().pro === true;
    }
    
    // Save Pro status to window object so other scripts can access it easily
    window.currentUser = {
      uid: user.uid,
      email: user.email,
      name: user.displayName,
      isPro: isPro
    };

    if (authContainer) {
      authContainer.innerHTML = `
        <div style="display:flex; align-items:center; gap:12px; position:relative;" id="user-menu-container">
          ${isPro ? '<span style="background:linear-gradient(90deg,#f59e0b,#d97706);color:#fff;font-size:10px;font-weight:700;padding:2px 6px;border-radius:4px;">PRO</span>' : ''}
          <img src="${user.photoURL}" alt="${user.displayName}" style="width:32px; height:32px; border-radius:50%; border:2px solid #5c4fc7; cursor:pointer;" onclick="const d=document.getElementById('user-dropdown');d.style.display=d.style.display==='none'?'block':'none'"/>
          <div id="user-dropdown" style="display:none; position:absolute; top:45px; right:0; background:#fff; border:1px solid #e8e8e8; border-radius:8px; box-shadow:0 4px 12px rgba(0,0,0,0.1); padding:8px; min-width:150px; z-index:999;">
            <div style="font-size:12px; color:#1a1a1a; font-weight:600; padding:6px 12px; border-bottom:1px solid #f0f0f0; margin-bottom:4px;">${user.displayName}</div>
            <button onclick="signOutUser()" style="width:100%; text-align:left; background:none; border:none; padding:8px 12px; font-size:13px; color:#e24b4a; cursor:pointer; border-radius:4px;">Sign Out</button>
          </div>
        </div>
      `;
      
      // Close dropdown when clicking outside
      document.addEventListener('click', (e) => {
        const menu = document.getElementById('user-menu-container');
        const dropdown = document.getElementById('user-dropdown');
        if (menu && !menu.contains(e.target) && dropdown) {
          dropdown.style.display = 'none';
        }
      });
    }
  } else {
    // User is signed out
    window.currentUser = null;
    if (authContainer) {
      authContainer.innerHTML = `
        <button onclick="signInWithGoogle()" style="display:flex; align-items:center; gap:8px; background:#fff; border:1px solid #d0d0d0; padding:6px 14px; border-radius:8px; font-size:13px; font-weight:600; color:#444; cursor:pointer; box-shadow:0 2px 4px rgba(0,0,0,0.05); transition:all 0.2s;">
          <svg width="16" height="16" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/><path d="M1 1h22v22H1z" fill="none"/></svg>
          Sign In
        </button>
      `;
    }
  }
});
