require("dotenv").config();
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const pdfParse = require("pdf-parse");
const mammoth = require("mammoth");
const admin = require("firebase-admin");
const { GoogleGenAI } = require("@google/genai");

let isFirebaseAdminInitialized = false;

// Initialize Firebase Admin SDK if service account is provided in env
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    isFirebaseAdminInitialized = true;
    console.log("✅ Firebase Admin SDK initialized successfully.");
  } catch (err) {
    console.error("❌ Failed to initialize Firebase Admin SDK:", err.message);
  }
} else {
  console.warn("⚠️ FIREBASE_SERVICE_ACCOUNT not set in .env — payment upgrades will fall back to using client Bearer tokens.");
}

const dbAdmin = isFirebaseAdminInitialized ? admin.firestore() : null;

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

const GEMINI_MODEL = "gemini-2.5-flash";
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

function parseSafeJSON(text) {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch (err) {
    try {
      const startIdx = Math.min(
        text.indexOf('{') === -1 ? Infinity : text.indexOf('{'),
        text.indexOf('[') === -1 ? Infinity : text.indexOf('[')
      );
      const endIdx = Math.max(
        text.lastIndexOf('}'),
        text.lastIndexOf(']')
      );
      if (startIdx !== Infinity && endIdx !== -1 && startIdx < endIdx) {
        return JSON.parse(text.substring(startIdx, endIdx + 1));
      }
    } catch (e) {}
    try {
      return JSON.parse(text.replace(/```json|```/g, "").trim());
    } catch (e) {
      throw new Error("Invalid JSON structure: " + e.message);
    }
  }
}

console.log("=================================");
console.log("API Key Loaded:", process.env.GEMINI_API_KEY ? "YES" : "NO");
console.log("=================================");

// ─── USAGE TRACKING (PERSISTENT) ──────────────────────────────
const USAGE_FILE = path.join(__dirname, "usage.json");

const LIMITS = {
  coverLetter: 5,
  linkedin: 5,
  interview: 2,
  ats: 5
};

function getToday() { return new Date().toISOString().split("T")[0]; }

function readLocalUsage() {
  try {
    if (fs.existsSync(USAGE_FILE)) {
      return JSON.parse(fs.readFileSync(USAGE_FILE, "utf8"));
    }
  } catch (err) {
    console.error("❌ Error reading local usage file:", err);
  }
  return {};
}

function writeLocalUsage(data) {
  try {
    fs.writeFileSync(USAGE_FILE, JSON.stringify(data, null, 2), "utf8");
  } catch (err) {
    console.error("❌ Error writing local usage file:", err);
  }
}

async function getUsageRecord(ip) {
  const today = getToday();
  const safeIp = ip.replace(/[^a-zA-Z0-9]/g, "_");
  const docId = `${safeIp}_${today}`;

  if (dbAdmin) {
    try {
      const docRef = dbAdmin.collection("usage_logs").doc(docId);
      const docSnap = await docRef.get();
      if (docSnap.exists) {
        return docSnap.data();
      }
    } catch (err) {
      console.warn("⚠️ Firestore usage read failed, falling back to local file:", err.message);
    }
  }

  const data = readLocalUsage();
  return data[docId] || { coverLetter: 0, linkedin: 0, interview: 0, ats: 0 };
}

async function updateUsageRecord(ip, type) {
  const today = getToday();
  const safeIp = ip.replace(/[^a-zA-Z0-9]/g, "_");
  const docId = `${safeIp}_${today}`;

  const record = await getUsageRecord(ip);
  record[type] = (record[type] || 0) + 1;
  record.updatedAt = new Date().toISOString();

  if (dbAdmin) {
    try {
      const docRef = dbAdmin.collection("usage_logs").doc(docId);
      await docRef.set(record, { merge: true });
      return;
    } catch (err) {
      console.warn("⚠️ Firestore usage write failed, writing to local file:", err.message);
    }
  }

  const data = readLocalUsage();
  data[docId] = record;

  // Clean up old entries to keep the file small
  const keys = Object.keys(data);
  if (keys.length > 500) {
    const yesterday = new Date(Date.now() - 86400000).toISOString().split("T")[0];
    const cleaned = {};
    for (const key of keys) {
      if (key.endsWith(today) || key.endsWith(yesterday)) {
        cleaned[key] = data[key];
      }
    }
    writeLocalUsage(cleaned);
  } else {
    writeLocalUsage(data);
  }
}

async function checkLimit(ip, type) {
  const record = await getUsageRecord(ip);
  const limit = LIMITS[type] || 5;
  return (record[type] || 0) < limit;
}

async function incrementUsage(ip, type) {
  await updateUsageRecord(ip, type);
}

async function getRemainingCount(ip, type) {
  const record = await getUsageRecord(ip);
  const limit = LIMITS[type] || 5;
  const count = record[type] || 0;
  return Math.max(0, limit - count);
}


// ─── FIREBASE AUTH/PRO VERIFICATION ───────────────────────────
async function checkProStatus(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) return false;
  
  const token = authHeader.split(" ")[1];
  try {
    const apiKey = process.env.FIREBASE_API_KEY || "AIzaSyBfR2_eSuJoDuQtTNGV1ZQdtP5AQCWpnWk";
    const projId = process.env.FIREBASE_PROJECT_ID || "coverai-a26bf";
    
    // 1. Verify token with Identity Toolkit
    const verifyRes = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idToken: token })
      }
    );
    
    if (!verifyRes.ok) return false;
    const verifyData = await verifyRes.json();
    const uid = verifyData.users?.[0]?.localId;
    if (!uid) return false;
    
    // 2. Fetch Firestore user doc
    const firestoreUrl = `https://firestore.googleapis.com/v1/projects/${projId}/databases/(default)/documents/users/${uid}`;
    const dbRes = await fetch(firestoreUrl, {
      headers: { "Authorization": `Bearer ${token}` }
    });
    
    if (!dbRes.ok) return false;
    const dbData = await dbRes.json();
    
    const isPro = dbData.fields?.pro?.booleanValue === true;
    return isPro;
  } catch(e) {
    console.error("Auth verification failed:", e);
    return false;
  }
}
// ──────────────────────────────────────────────────────────────

// ─── RESUME PARSE ─────────────────────────────────────────────
app.post("/api/parse-resume", upload.single("resume"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    const originalName = req.file.originalname.toLowerCase();
    let extractedText = "";

    if (req.file.mimetype === "application/pdf" || originalName.endsWith(".pdf")) {
      try {
        const pdfData = await pdfParse(req.file.buffer);
        extractedText = pdfData.text;
      } catch(e) {
        return res.status(400).json({ error: "Could not read this PDF. Please save your resume from Word or Google Docs as PDF and try again." });
      }
    } else if (originalName.endsWith(".docx")) {
      const result = await mammoth.extractRawText({ buffer: req.file.buffer });
      extractedText = result.value;
    } else {
      return res.status(400).json({ error: "Please upload a PDF or Word (.docx) file." });
    }

    if (!extractedText || extractedText.trim().length < 50) {
      return res.status(400).json({ error: "Could not extract text. Make sure it's not a scanned image PDF." });
    }

    const prompt = `Extract information from this resume and return ONLY a valid JSON object:
{
  "name": "full name",
  "profession": "current job title or profession",
  "exp": "experience like '3-5 years' or 'fresher'",
  "skills": "top 5 skills comma separated",
  "achievement": "single most impressive achievement in one sentence"
}
Return ONLY JSON, no markdown, no backticks.
Resume: ${extractedText.slice(0, 50000)}`;

    const response = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: prompt
    });
    const raw = response.text || "{}";
    const parsed = parseSafeJSON(raw);
    res.json({ success: true, data: { ...parsed, rawText: extractedText.slice(0, 50000) } });

  } catch (err) {
    let errMsg = err.message || "Unknown error";
    if (err.status === 429 || errMsg.includes("429") || errMsg.includes("RESOURCE_EXHAUSTED") || errMsg.includes("quota")) {
      errMsg = "The AI parsing limit has been exceeded. Please wait a minute before retrying, or input your details manually.";
    } else {
      errMsg = errMsg.replace(/[\{\}\[\]"]/g, "").trim();
    }
    res.status(500).json({ error: "Failed to process resume: " + errMsg });
  }
});

// ─── FULL RESUME PARSE ─────────────────────────────────────────
app.post("/api/parse-full-resume", upload.single("resume"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    const originalName = req.file.originalname.toLowerCase();
    let extractedText = "";

    if (req.file.mimetype === "application/pdf" || originalName.endsWith(".pdf")) {
      try {
        const pdfData = await pdfParse(req.file.buffer);
        extractedText = pdfData.text;
      } catch(e) {
        return res.status(400).json({ error: "Could not read this PDF." });
      }
    } else if (originalName.endsWith(".docx")) {
      const result = await mammoth.extractRawText({ buffer: req.file.buffer });
      extractedText = result.value;
    } else {
      return res.status(400).json({ error: "Please upload a PDF or Word (.docx) file." });
    }

    if (!extractedText || extractedText.trim().length < 50) {
      return res.status(400).json({ error: "Could not extract text from this file." });
    }

    const prompt = `Extract ALL details from this resume and return ONLY a valid JSON object containing:
{
  "name": "full name",
  "title": "professional title or current job title",
  "email": "email address",
  "phone": "phone number",
  "location": "city and country",
  "linkedin": "LinkedIn profile link",
  "website": "portfolio or GitHub website link",
  "summary": "professional summary paragraph",
  "skills": ["Skill 1", "Skill 2", "Skill 3", "Skill 4", "Skill 5", "Skill 6", "Skill 7", "Skill 8", "Skill 9", "Skill 10"],
  "experience": [
    {
      "company": "Company Name",
      "title": "Job Title",
      "start": "Start Date",
      "end": "End Date",
      "desc": "Responsibility summary or bullet points"
    }
  ],
  "education": [
    {
      "school": "University or School Name",
      "degree": "Degree and Major",
      "year": "Year of study or graduation year",
      "grade": "GPA or Grade"
    }
  ],
  "projects": [
    {
      "title": "Project Name",
      "subtitle": "Project subtitle, association or link",
      "desc": "Key details or bullet points describing the project"
    }
  ],
  "publications": ["Publication 1", "Publication 2"],
  "certifications": ["Certification 1", "Certification 2"]
}
Return ONLY valid JSON. No markdown backticks or formatting.
Resume text: ${extractedText.slice(0, 50000)}`;

    const response = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: prompt
    });
    const raw = response.text || "{}";
    const parsed = parseSafeJSON(raw);
    res.json({ success: true, data: parsed });

  } catch (err) {
    let errMsg = err.message || "Unknown error";
    if (err.status === 429 || errMsg.includes("429") || errMsg.includes("RESOURCE_EXHAUSTED") || errMsg.includes("quota")) {
      errMsg = "The AI parsing limit has been exceeded. Please wait a minute before retrying, or input your details manually.";
    } else {
      errMsg = errMsg.replace(/[\{\}\[\]"]/g, "").trim();
    }
    res.status(500).json({ error: "Failed to parse resume: " + errMsg });
  }
});


// ─── GENERATE COVER LETTER ────────────────────────────────────
app.post("/api/generate", async (req, res) => {
  try {
    const ip = req.headers["x-forwarded-for"]?.split(",")[0] || req.socket.remoteAddress;

    const isPro = await checkProStatus(req);

    if (!isPro && !(await checkLimit(ip, "coverLetter"))) {
      return res.status(429).json({
        error: "LIMIT_REACHED",
        message: "You have used your 5 free cover letters for today. Come back tomorrow or upgrade to Pro for unlimited access."
      });
    }

    const { name, profession, exp, skills, achievement, company, jobtitle, jobdesc, tone, resumeText } = req.body;

    const resumeSection = resumeText ? `\nResume Content:\n${resumeText}\n` : "";

    const prompt = `Write a cover letter using the details below.${resumeSection ? " Use resume content for specific details." : ""}

Applicant Name : ${name}
Profession     : ${profession}
Experience     : ${exp}
Skills         : ${skills || "not specified"}
Achievement    : ${achievement || "none"}
Company        : ${company}
Job Title      : ${jobtitle}
Job Description: ${jobdesc || "not provided"}
Tone           : ${tone || "Professional"}
${resumeSection}
STRICT RULES:
1. Start with "Dear Hiring Manager,"
2. Write exactly 3 paragraphs: strong opening, why I am the best fit, confident closing.
3. Use REAL name "${name}" — NEVER use [Your Name] or any placeholder.
4. Do NOT add address, phone, email, or date at the top.
5. No square bracket placeholders anywhere.
6. End with: Sincerely,\n${name}
7. 220 to 280 words only.
8. Output the letter ONLY.`;

    const response = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: prompt
    });
    const letter = response.text;
    if (!letter) throw new Error("No letter returned");

    if (!isPro) {
      await incrementUsage(ip, "coverLetter");
    }
    res.json({ letter, remaining: isPro ? "unlimited" : await getRemainingCount(ip, "coverLetter") });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── RESUME SUMMARY ───────────────────────────────────────────
app.post("/api/generate-summary", async (req, res) => {
  try {
    const { name, title, skills, exps } = req.body;
    const expText = exps?.map(e => `${e.title} at ${e.company}`).join(", ") || "";
    const prompt = `Write a professional resume summary for:
Name: ${name}, Title: ${title}, Skills: ${skills}, Experience: ${expText}
Rules: 2-3 sentences, first person, confident, no clichés. Output summary text ONLY.`;

    const response = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: prompt
    });
    const summary = response.text || "";
    res.json({ summary: summary.trim() });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── RESUME ENHANCER ──────────────────────────────────────────
app.post("/api/enhance-resume", async (req, res) => {
  try {
    const { name, title, skills, exps, summary } = req.body;
    const prompt = `Improve this resume and return ONLY valid JSON:
{"summary":"improved 2-3 sentence summary","enhanced":["improved desc for job 1","improved desc for job 2"]}
Name: ${name}, Title: ${title}, Skills: ${Array.isArray(skills)?skills.join(", "):skills}
Experience: ${JSON.stringify(exps)}, Current summary: ${summary||"none"}
Rules: Strong action verbs, specific impact, under 2 sentences each. ONLY JSON, no markdown.`;

    const response = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: prompt
    });
    const raw = response.text || "{}";
    res.json(parseSafeJSON(raw));
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── ATS SCORE CHECKER ────────────────────────────────────────
app.post("/api/ats-check", async (req, res) => {
  try {
    const ip = req.headers["x-forwarded-for"]?.split(",")[0] || req.socket.remoteAddress;
    const isPro = await checkProStatus(req);

    if (!isPro && !(await checkLimit(ip, "ats"))) {
      return res.status(429).json({
        error: "LIMIT_REACHED",
        message: "You have used your 5 free ATS checks for today. Come back tomorrow or upgrade to Pro for unlimited access."
      });
    }

    const { resumeText, jobDesc } = req.body;
    if (!resumeText || !jobDesc) return res.status(400).json({ error: "Resume and job description are required." });

    const prompt = `You are an ATS (Applicant Tracking System) expert. Analyse the resume against the job description and return ONLY a valid JSON object with no markdown or backticks.

RESUME:
${resumeText.slice(0, 4000)}

JOB DESCRIPTION:
${jobDesc.slice(0, 2000)}

Return this exact JSON structure:
{
  "score": <overall match score 0-100>,
  "breakdown": [
    { "label": "Keyword Match", "score": <0-100> },
    { "label": "Skills Alignment", "score": <0-100> },
    { "label": "Experience Relevance", "score": <0-100> },
    { "label": "Education & Qualifications", "score": <0-100> }
  ],
  "keywordsFound": ["keyword1", "keyword2"],
  "keywordsMissing": ["keyword1", "keyword2"],
  "suggestions": [
    { "priority": "high", "title": "Short title", "detail": "Specific actionable suggestion" },
    { "priority": "high", "title": "Short title", "detail": "Specific actionable suggestion" },
    { "priority": "medium", "title": "Short title", "detail": "Specific actionable suggestion" },
    { "priority": "medium", "title": "Short title", "detail": "Specific actionable suggestion" },
    { "priority": "low", "title": "Short title", "detail": "Specific actionable suggestion" }
  ]
}

Rules:
- keywordsFound: important keywords/skills from JD that ARE in the resume (max 12)
- keywordsMissing: important keywords/skills from JD that are NOT in the resume (max 10)
- suggestions: 4-6 specific, actionable improvements (not generic advice)
- Be strict and honest with scoring — a score of 80+ means genuinely strong match
- Return ONLY the JSON object`;

    const response = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: prompt
    });
    const raw = response.text || "{}";
    const result = parseSafeJSON(raw);

    if (!isPro) {
      await incrementUsage(ip, "ats");
    }

    res.json({ ...result, remaining: isPro ? "unlimited" : await getRemainingCount(ip, "ats") });
  } catch (err) {
    res.status(500).json({ error: "ATS check failed: " + err.message });
  }
});

// ─── CONFIG ENDPOINT ──────────────────────────────────────────
app.get("/api/config", (req, res) => {
  res.json({
    razorpayKeyId: process.env.RAZORPAY_KEY_ID || "rzp_live_SzV0Dg5rrF3L11"
  });
});

app.get("/api/remaining", async (req, res) => {
  const ip = req.headers["x-forwarded-for"]?.split(",")[0] || req.socket.remoteAddress;
  res.json({ remaining: await getRemainingCount(ip, "coverLetter") });
});

app.get("/test", async (req, res) => {
  try {
    const response = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: "Say hello in one sentence."
    });
    res.send(response.text || "Hello!");
  } catch(error) { res.status(500).send(error.message); }
});



// ─── RAZORPAY PAYMENT (LIVE) ──────────────────────────────────
const RAZORPAY_KEY_ID     = process.env.RAZORPAY_KEY_ID;
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;

if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET) {
  console.warn("⚠️  RAZORPAY_KEY_ID or RAZORPAY_KEY_SECRET not set in .env — payments will fail!");
}

// Create a Razorpay order (frontend calls this before opening checkout)
app.post("/api/razorpay/create-order", async (req, res) => {
  try {
    const { amount = 199, currency = "INR", email } = req.body;

    const orderBody = JSON.stringify({
      amount: amount * 100,          // Razorpay expects paise
      currency,
      receipt: `order_${Date.now()}`,
      notes: { email: email || "" }
    });

    const credentials = Buffer.from(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`).toString("base64");
    const rzpRes = await fetch("https://api.razorpay.com/v1/orders", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Basic ${credentials}`
      },
      body: orderBody
    });

    const order = await rzpRes.json();
    if (!rzpRes.ok) {
      console.error("Razorpay order creation failed:", order);
      return res.status(500).json({ error: order.error?.description || "Order creation failed" });
    }

    console.log("\n🛒 Razorpay order created:", order.id, "| ₹", amount, "|", email);
    res.json(order);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Log confirmed Razorpay payments (frontend also writes to Firestore directly)
const confirmedPayments = [];

// Verify Razorpay payment signature (critical for live payments)
function verifyRazorpaySignature(orderId, paymentId, signature) {
  if (!RAZORPAY_KEY_SECRET) return false;
  const body = orderId + "|" + paymentId;
  const expectedSignature = crypto
    .createHmac("sha256", RAZORPAY_KEY_SECRET)
    .update(body)
    .digest("hex");
  return expectedSignature === signature;
}

app.post("/api/razorpay/payment-success", async (req, res) => {
  try {
    const { paymentId, orderId, signature, email, uid } = req.body;
    if (!paymentId || !email || !uid) {
      return res.status(400).json({ error: "paymentId, email, and uid are required" });
    }

    let isPaymentValid = false;
    let detail = "";

    // 1. Verify directly with Razorpay API (highly secure, works with or without orderId)
    if (RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET) {
      try {
        const credentials = Buffer.from(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`).toString("base64");
        const rzpRes = await fetch(`https://api.razorpay.com/v1/payments/${paymentId}`, {
          headers: { "Authorization": `Basic ${credentials}` }
        });
        if (rzpRes.ok) {
          const paymentData = await rzpRes.json();
          const isStatusOk = paymentData.status === "captured" || paymentData.status === "authorized";
          const isAmountOk = paymentData.amount === 19900;
          
          if (isStatusOk && isAmountOk) {
            isPaymentValid = true;
            console.log(`✅ Verified payment ${paymentId} directly with Razorpay API. Status: ${paymentData.status}, Amount: ${paymentData.amount}`);
          } else {
            detail = `Razorpay API mismatch: status=${paymentData.status} (expected captured/authorized), amount=${paymentData.amount} (expected 100 or 19900)`;
            console.warn(`⚠️ ${detail}`);
          }
        } else {
          const errText = await rzpRes.text();
          detail = `Razorpay API returned non-200: status=${rzpRes.status}, body=${errText.slice(0, 100)}`;
          console.warn(`⚠️ ${detail}`);
        }
      } catch (err) {
        detail = `Razorpay API fetch failed: ${err.message}`;
        console.warn(`⚠️ ${detail}`);
      }
    } else {
      detail = "Razorpay server keys (RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET) are not set in backend environment.";
      console.warn(`⚠️ ${detail}`);
    }

    // 2. Fallback: Verify signature if orderId and signature are present
    if (!isPaymentValid) {
      if (orderId && signature) {
        const isValid = verifyRazorpaySignature(orderId, paymentId, signature);
        if (isValid) {
          isPaymentValid = true;
          detail = ""; // Clear error details since signature succeeded
          console.log("✅ Verified payment via signature verification.");
        } else {
          detail += " | Local signature verification failed (invalid signature).";
        }
      } else {
        if (!orderId) detail += " | Local signature check skipped (missing orderId).";
        if (!signature) detail += " | Local signature check skipped (missing signature).";
      }
    }

    // 3. Fail if neither method could verify the payment
    if (!isPaymentValid) {
      console.error("❌ Payment verification failed:", detail);
      return res.status(400).json({ error: `Payment verification failed — ${detail}` });
    }

    const record = {
      paymentId, orderId, signature,
      email, uid,
      amount: 199,
      plan: "pro-monthly",
      verified: true,
      capturedAt: new Date().toISOString()
    };
    confirmedPayments.push(record);

    // Securely write to Firestore
    if (dbAdmin) {
      // 1. Update user to Pro in Firestore securely
      await dbAdmin.collection("users").doc(uid).set({
        pro: true,
        proActivatedAt: new Date().toISOString(),
        razorpayPaymentId: paymentId,
        razorpayOrderId: orderId || null,
        plan: "pro-monthly",
        email: email
      }, { merge: true });

      // 2. Log payment transaction
      await dbAdmin.collection("payments").doc(paymentId).set({
        userId: uid,
        email,
        amount: 199,
        currency: 'INR',
        plan: 'pro-monthly',
        razorpayPaymentId: paymentId,
        razorpayOrderId: orderId || null,
        verified: true,
        timestamp: new Date().toISOString()
      });
      console.log("✅ Firestore database updated securely via Firebase Admin SDK.");
    } else {
      // Fallback REST call using the client's Bearer token
      const authHeader = req.headers.authorization;
      const token = authHeader?.startsWith("Bearer ") ? authHeader.split(" ")[1] : null;
      if (token) {
        const projId = process.env.FIREBASE_PROJECT_ID || "coverai-a26bf";
        const firestoreUrl = `https://firestore.googleapis.com/v1/projects/${projId}/databases/(default)/documents/users/${uid}?updateMask.fieldPaths=pro&updateMask.fieldPaths=proActivatedAt&updateMask.fieldPaths=razorpayPaymentId&updateMask.fieldPaths=razorpayOrderId&updateMask.fieldPaths=plan&updateMask.fieldPaths=email`;
        
        const updateRes = await fetch(firestoreUrl, {
          method: "PATCH",
          headers: {
            "Authorization": `Bearer ${token}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            fields: {
              pro: { booleanValue: true },
              proActivatedAt: { stringValue: new Date().toISOString() },
              razorpayPaymentId: { stringValue: paymentId },
              razorpayOrderId: { stringValue: orderId || "" },
              plan: { stringValue: "pro-monthly" },
              email: { stringValue: email }
            }
          })
        });

        if (!updateRes.ok) {
          const errData = await updateRes.json();
          console.error("❌ REST Fallback Firestore update failed:", errData);
          throw new Error(errData.error?.message || "REST Fallback Firestore update failed");
        }

        // Also log payment record
        const payUrl = `https://firestore.googleapis.com/v1/projects/${projId}/databases/(default)/documents/payments/${paymentId}`;
        await fetch(payUrl, {
          method: "PATCH",
          headers: {
            "Authorization": `Bearer ${token}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            fields: {
              userId: { stringValue: uid },
              email: { stringValue: email },
              amount: { integerValue: "199" },
              currency: { stringValue: "INR" },
              plan: { stringValue: "pro-monthly" },
              razorpayPaymentId: { stringValue: paymentId },
              razorpayOrderId: { stringValue: orderId || "" },
              verified: { booleanValue: true },
              timestamp: { stringValue: new Date().toISOString() }
            }
          })
        });

        console.log("✅ Firestore database updated via client-token REST fallback.");
      } else {
        console.warn("⚠️ Firestore update skipped: No service account configured and no client Bearer token found.");
      }
    }

    console.log("\n✅ RAZORPAY PAYMENT CONFIRMED:");
    console.log("   Payment ID:", paymentId);
    console.log("   Order ID  :", orderId);
    console.log("   Email     :", email);
    console.log("   Time      :", record.capturedAt, "\n");

    res.json({ success: true, message: "Payment verified, logged, and user upgraded to Pro" });
  } catch (err) {
    console.error("❌ Razorpay success callback failed:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Admin: view confirmed Razorpay payments
app.get("/api/admin/payments", (req, res) => {
  const key = req.query.key;
  if (key !== "coverai012370") return res.status(401).json({ error: "Unauthorized" });
  res.json({ total: confirmedPayments.length, payments: confirmedPayments });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => { console.log(`\n🚀 Server running on http://localhost:${PORT}\n`); });

// ─── LINKEDIN MESSAGE GENERATOR ───────────────────────────────
app.post("/api/linkedin-message", async (req, res) => {
  try {
    const ip = req.headers["x-forwarded-for"]?.split(",")[0] || req.socket.remoteAddress;
    const isPro = await checkProStatus(req);

    if (!isPro && !(await checkLimit(ip, "linkedin"))) {
      return res.status(429).json({
        error: "LIMIT_REACHED",
        message: "You have used your 5 free LinkedIn messages for today. Come back tomorrow or upgrade to Pro for unlimited access."
      });
    }

    const { name, profession, skills, recruiterName, company, jobtitle, reason, messageType } = req.body;

    const greeting = recruiterName ? `Hi ${recruiterName.split(' ')[0]}` : 'Hi there';

    const typeInstructions = {
      connection: `Write a LinkedIn CONNECTION REQUEST NOTE (strictly under 300 characters). It should be warm, specific, and mention the job role. Do NOT make it generic.`,
      followup: `Write a LinkedIn FOLLOW-UP MESSAGE (after connecting). 3-4 sentences. Express genuine interest in the ${jobtitle} role, mention one relevant skill, and ask if they'd be open to a quick chat.`,
      referral: `Write a LinkedIn REFERRAL REQUEST message. 3-4 sentences. Be polite and respectful. Ask if they'd be willing to refer the candidate for the ${jobtitle} position. Make it easy to say yes.`,
      informational: `Write a LinkedIn INFORMATIONAL INTERVIEW REQUEST. 3-4 sentences. Ask for a 15-minute call to learn about the team or role. Be specific about why you're interested in ${company}.`
    };

    const prompt = `Generate 2 versions of a LinkedIn message for this person.

Sender: ${name}
Profession: ${profession}
Skills: ${skills || 'not specified'}
Target Company: ${company}
Target Role: ${jobtitle}
Reason for interest: ${reason || 'not specified'}
Greeting to use: ${greeting}

Message type: ${typeInstructions[messageType] || typeInstructions.connection}

Return ONLY a valid JSON array with exactly 2 objects:
[
  { "label": "Version 1 — Confident", "text": "the message text" },
  { "label": "Version 2 — Friendly", "text": "the message text" }
]

Rules:
- Use the sender's REAL name "${name}" — never use placeholders
- Make each version feel genuinely human and personal
- No buzzwords like "leverage", "synergy", "passionate about"
- Version 1 = more confident and direct
- Version 2 = warmer and conversational
- Return ONLY the JSON array, no markdown, no explanation`;

    const response = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: prompt
    });
    const raw = response.text || "[]";
    const messages = parseSafeJSON(raw);

    if (!isPro) {
      await incrementUsage(ip, "linkedin");
    }

    res.json({ messages, remaining: isPro ? "unlimited" : await getRemainingCount(ip, "linkedin") });

  } catch (err) {
    console.error("LinkedIn message error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ─── INTERVIEW Q&A GENERATOR ───────────────────────────────────
app.post("/api/interview-prep", async (req, res) => {
  try {
    const ip = req.headers["x-forwarded-for"]?.split(",")[0] || req.socket.remoteAddress;
    const isPro = await checkProStatus(req);

    if (!isPro && !(await checkLimit(ip, "interview"))) {
      return res.status(429).json({
        error: "LIMIT_REACHED",
        message: "You have used your 2 free interview prep sessions for today. Come back tomorrow or upgrade to Pro for unlimited access."
      });
    }

    const { jobTitle, company, jobDescription, experience, focusAreas } = req.body;
    if (!jobTitle) return res.status(400).json({ error: "Job title is required" });

    const focusStr = focusAreas && focusAreas.length ? focusAreas.join(", ") : "behavioral, technical, situational";

    const prompt = `You are an expert interview coach. Generate 8 highly targeted interview questions with strong model answers for this candidate.

Job Title: ${jobTitle}
Company: ${company || "Not specified"}
Years of Experience: ${experience || "Not specified"}
Job Description: ${jobDescription || "Not provided"}
Focus Areas: ${focusStr}

Return ONLY a valid JSON array with exactly 8 objects:
[
  {
    "category": "Behavioral" | "Technical" | "Situational" | "Culture Fit",
    "question": "The interview question",
    "answer": "A strong 3-5 sentence model answer using STAR method where applicable",
    "tip": "One short coaching tip for delivering this answer well"
  }
]

Rules:
- Questions must be SPECIFIC to the job title and company, not generic
- Answers should use first person ("I did...", "In my experience...")
- Include a mix: 3 behavioral, 2 technical, 2 situational, 1 culture fit
- Tips should be practical (e.g. "pause for 2 seconds before answering", "mention a specific metric")
- Return ONLY the JSON array, no markdown, no extra text`;

    const response = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: prompt
    });
    const raw = response.text || "[]";
    const questions = parseSafeJSON(raw);

    if (!isPro) {
      await incrementUsage(ip, "interview");
    }

    res.json({ questions, remaining: isPro ? "unlimited" : await getRemainingCount(ip, "interview") });

  } catch (err) {
    console.error("Interview prep error:", err);
    res.status(500).json({ error: err.message });
  }
});


