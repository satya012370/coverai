require("dotenv").config();
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const pdfParse = require("pdf-parse");

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

console.log("=================================");
console.log("API Key Loaded:", process.env.GEMINI_API_KEY ? "YES" : "NO");
console.log("=================================");

// ─── USAGE TRACKING ───────────────────────────────────────────
const usageMap = {};
const FREE_LIMIT = 3;
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

// ─── RESUME UPLOAD & PARSE ────────────────────────────────────
app.post("/api/parse-resume", upload.single("resume"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    const pdfData = await pdfParse(req.file.buffer);
    const text = pdfData.text;

    // Send resume text to Gemini to extract structured info
    const prompt = `Extract information from this resume text and return ONLY a valid JSON object with these exact keys:
{
  "name": "full name of the person",
  "profession": "their current job title or profession",
  "exp": "years of experience as a string like '3-5 years' or 'fresher'",
  "skills": "top 5 skills comma separated",
  "achievement": "their single most impressive achievement in one sentence"
}

If any field is not found, use an empty string.
Return ONLY the JSON object, no explanation, no markdown, no backticks.

Resume text:
${text.slice(0, 3000)}`;

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
      }
    );

    const data = await response.json();
    const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text || "{}";

    // Clean and parse JSON
    const clean = raw.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(clean);

    res.json({ success: true, data: parsed });

  } catch (err) {
    console.error("Resume parse error:", err);
    res.status(500).json({ error: "Could not read resume. Please try a text-based PDF." });
  }
});
// ──────────────────────────────────────────────────────────────

// ─── GENERATE COVER LETTER ────────────────────────────────────
app.post("/api/generate", async (req, res) => {
  try {
    const ip = req.headers["x-forwarded-for"]?.split(",")[0] || req.socket.remoteAddress;

    if (!checkLimit(ip)) {
      return res.status(429).json({
        error: "LIMIT_REACHED",
        message: "You have used your 3 free cover letters for today. Upgrade to Pro for unlimited access."
      });
    }

    const { name, profession, exp, skills, achievement, company, jobtitle, jobdesc, tone, resumeText } = req.body;

    // Build prompt — richer if resume was uploaded
    const resumeSection = resumeText
      ? `\nCandidate's Resume Content:\n${resumeText.slice(0, 2000)}\n`
      : "";

    const prompt = `Write a cover letter using the details below.${resumeSection ? " Use the resume content to add specific details and make the letter highly personalized." : ""}

Applicant Name : ${name}
Profession     : ${profession}
Experience     : ${exp}
Skills         : ${skills || 'not specified'}
Achievement    : ${achievement || 'none'}
Company        : ${company}
Job Title      : ${jobtitle}
Job Description: ${jobdesc || 'not provided'}
Tone           : ${tone || 'Professional'}
${resumeSection}
STRICT RULES:
1. Start with "Dear Hiring Manager,"
2. Write exactly 3 paragraphs: strong opening, why I am the best fit (use specific skills/achievements from resume if available), confident closing.
3. Use the REAL name "${name}" — NEVER write [Your Name] or any placeholder.
4. Do NOT add address, phone, email, or date lines at the top.
5. Do NOT write anything inside square brackets.
6. End with: Sincerely,\n${name}
7. Keep between 220 and 280 words.
8. Output the letter ONLY — no explanation, no subject line, no markdown.`;

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
      }
    );

    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || "Failed to generate content");

    const letter = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!letter) throw new Error("No cover letter returned by Gemini");

    incrementUsage(ip);
    res.json({ letter, remaining: getRemainingCount(ip) });

  } catch (error) {
    console.error("Generate error:", error);
    res.status(500).json({ error: error.message });
  }
});
// ──────────────────────────────────────────────────────────────

app.get("/api/remaining", (req, res) => {
  const ip = req.headers["x-forwarded-for"]?.split(",")[0] || req.socket.remoteAddress;
  res.json({ remaining: getRemainingCount(ip) });
});

app.get("/test", async (req, res) => {
  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: [{ text: "Say hello in one sentence." }] }] }),
      }
    );
    const data = await response.json();
    res.send(data?.candidates?.[0]?.content?.parts?.[0]?.text || JSON.stringify(data));
  } catch (error) {
    res.status(500).send(error.message);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 Server running on http://localhost:${PORT}\n`);
});
