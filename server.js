require("dotenv").config();
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

    if (!checkLimit(ip)) {
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

    incrementUsage(ip);
    res.json({ letter, remaining: getRemainingCount(ip) });

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => { console.log(`\n🚀 Server running on http://localhost:${PORT}\n`); });
