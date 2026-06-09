require("dotenv").config();
const crypto = require("crypto");
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const pdfParse = require("pdf-parse");
const mammoth = require("mammoth");

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

console.log("=================================");
console.log("API Key Loaded:", process.env.GEMINI_API_KEY ? "YES" : "NO");
console.log("=================================");

// ─── USAGE TRACKING ───────────────────────────────────────────
const usageMap = {};
const FREE_LIMIT = 5; // 5 cover letters per day

function getToday() { return new Date().toISOString().split("T")[0]; }

function checkLimit(ip) {
  const today = getToday();
  if (!usageMap[ip] || usageMap[ip].date !== today) usageMap[ip] = { count: 0, date: today };
  return usageMap[ip].count < FREE_LIMIT;
}
function incrementUsage(ip) { usageMap[ip].count++; }
function getRemainingCount(ip) {
  const today = getToday();
  if (!usageMap[ip] || usageMap[ip].date !== today) return FREE_LIMIT;
  return FREE_LIMIT - usageMap[ip].count;
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
Resume: ${extractedText.slice(0, 4000)}`;

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }) }
    );
    const data = await response.json();
    const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
    const parsed = JSON.parse(raw.replace(/```json|```/g, "").trim());
    res.json({ success: true, data: { ...parsed, rawText: extractedText.slice(0, 3000) } });

  } catch (err) {
    res.status(500).json({ error: "Failed to process resume: " + err.message });
  }
});

// ─── GENERATE COVER LETTER ────────────────────────────────────
app.post("/api/generate", async (req, res) => {
  try {
    const ip = req.headers["x-forwarded-for"]?.split(",")[0] || req.socket.remoteAddress;

    const isPro = await checkProStatus(req);

    if (!isPro && !checkLimit(ip)) {
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

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }) }
    );
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || "API error");
    const letter = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!letter) throw new Error("No letter returned");

    if (!isPro) {
      incrementUsage(ip);
    }
    res.json({ letter, remaining: isPro ? "unlimited" : getRemainingCount(ip) });

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

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }) }
    );
    const data = await response.json();
    const summary = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
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

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }) }
    );
    const data = await response.json();
    const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
    res.json(JSON.parse(raw.replace(/```json|```/g,"").trim()));
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── ATS SCORE CHECKER ────────────────────────────────────────
app.post("/api/ats-check", async (req, res) => {
  try {
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

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }) }
    );
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || "API error");
    const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
    const result = JSON.parse(raw.replace(/```json|```/g, "").trim());
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: "ATS check failed: " + err.message });
  }
});

app.get("/api/remaining", (req, res) => {
  const ip = req.headers["x-forwarded-for"]?.split(",")[0] || req.socket.remoteAddress;
  res.json({ remaining: getRemainingCount(ip) });
});

app.get("/test", async (req, res) => {
  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      { method:"POST", headers:{"Content-Type":"application/json"},
        body: JSON.stringify({ contents:[{ parts:[{ text:"Say hello in one sentence." }] }] }) }
    );
    const data = await response.json();
    res.send(data?.candidates?.[0]?.content?.parts?.[0]?.text || JSON.stringify(data));
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
    if (!paymentId || !email) return res.status(400).json({ error: "paymentId and email required" });

    // Verify signature for live payments (order-based)
    if (orderId && signature) {
      const isValid = verifyRazorpaySignature(orderId, paymentId, signature);
      if (!isValid) {
        console.error("❌ INVALID RAZORPAY SIGNATURE for payment:", paymentId);
        return res.status(400).json({ error: "Payment verification failed — invalid signature" });
      }
      console.log("✅ Razorpay signature verified for payment:", paymentId);
    }

    const record = {
      paymentId, orderId, signature,
      email, uid,
      amount: 199,
      plan: "pro-monthly",
      verified: !!(orderId && signature),
      capturedAt: new Date().toISOString()
    };
    confirmedPayments.push(record);

    console.log("\n✅ RAZORPAY PAYMENT CONFIRMED:");
    console.log("   Payment ID:", paymentId);
    console.log("   Order ID  :", orderId);
    console.log("   Verified  :", record.verified ? "YES ✅" : "NO (no order)");
    console.log("   Email     :", email);
    console.log("   Time      :", record.capturedAt, "\n");

    res.json({ success: true, message: "Payment verified and logged" });
  } catch (err) {
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

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }) }
    );

    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || "API error");

    const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text || "[]";
    const messages = JSON.parse(raw.replace(/```json|```/g, "").trim());

    res.json({ messages });

  } catch (err) {
    console.error("LinkedIn message error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ─── INTERVIEW Q&A GENERATOR ───────────────────────────────────
app.post("/api/interview-prep", async (req, res) => {
  try {
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

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }) }
    );

    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || "Gemini API error");

    const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text || "[]";
    const questions = JSON.parse(raw.replace(/```json|```/g, "").trim());

    res.json({ questions });

  } catch (err) {
    console.error("Interview prep error:", err);
    res.status(500).json({ error: err.message });
  }
});

