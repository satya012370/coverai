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

// ─── RESUME PARSE ENDPOINT ────────────────────────────────────
app.post("/api/parse-resume", upload.single("resume"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    const mime = req.file.mimetype;
    const originalName = req.file.originalname.toLowerCase();
    let extractedText = "";

    // Extract text based on file type
    if (mime === "application/pdf" || originalName.endsWith(".pdf")) {
      try {
        const pdfData = await pdfParse(req.file.buffer);
        extractedText = pdfData.text;
      } catch (e) {
        return res.status(400).json({ error: "Could not read this PDF. Make sure it is a text-based PDF, not a scanned image. Try saving your resume as PDF from Word or Google Docs." });
      }
    } else if (
      mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
      originalName.endsWith(".docx")
    ) {
      const result = await mammoth.extractRawText({ buffer: req.file.buffer });
      extractedText = result.value;
    } else if (mime === "application/msword" || originalName.endsWith(".doc")) {
      return res.status(400).json({ error: "Old .doc format is not supported. Please save your resume as .docx or PDF and try again." });
    } else {
      return res.status(400).json({ error: "Unsupported file type. Please upload a PDF or Word (.docx) file." });
    }

    if (!extractedText || extractedText.trim().length < 50) {
      return res.status(400).json({ error: "Could not extract text from this file. If it's a PDF, make sure it's not a scanned image. Try exporting from Word or Google Docs as PDF." });
    }

    // Send to Gemini to extract structured info
    const prompt = `Extract information from this resume and return ONLY a valid JSON object with these exact keys:
{
  "name": "full name of the person",
  "profession": "their current job title or profession",
  "exp": "years of experience as a string like '3-5 years' or '1-2 years' or 'fresher'",
  "skills": "top 5 skills comma separated",
  "achievement": "their single most impressive achievement in one sentence"
}

Rules:
- If any field is not clearly found, use an empty string
- For exp, pick the closest match: fresher, 1-2 years, 3-5 years, 5-10 years, 10+ years
- Return ONLY the JSON object, no explanation, no markdown, no backticks

Resume text:
${extractedText.slice(0, 4000)}`;

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
    const clean = raw.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(clean);

    res.json({ success: true, data: { ...parsed, rawText: extractedText.slice(0, 3000) } });

  } catch (err) {
    console.error("Resume parse error:", err);
    res.status(500).json({ error: "Failed to process resume: " + err.message });
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

    const resumeSection = resumeText
      ? `\nCandidate Resume Content:\n${resumeText}\n`
      : "";

    const prompt = `Write a cover letter using the details below.${resumeSection ? " Use the resume content to add specific, accurate details." : ""}

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
    if (!response.ok) throw new Error(data.error?.message || "Failed to generate");

    const letter = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!letter) throw new Error("No cover letter returned");

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
app.listen(PORT, () => { console.log(`\n🚀 Server running on http://localhost:${PORT}\n`); });

// ─── RESUME SUMMARY GENERATOR ─────────────────────────────────
app.post("/api/generate-summary", async (req, res) => {
  try {
    const { name, title, skills, exps } = req.body;
    const expText = exps?.map(e => `${e.title} at ${e.company}`).join(', ') || '';
    const prompt = `Write a professional resume summary for:
Name: ${name}
Title: ${title}
Skills: ${skills}
Experience: ${expText}

Rules:
- 2-3 sentences only
- First person, confident tone
- Highlight value they bring
- No clichés like "hardworking" or "team player"
- Output the summary text ONLY`;

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      { method:"POST", headers:{"Content-Type":"application/json"},
        body: JSON.stringify({ contents:[{ parts:[{ text: prompt }] }] }) }
    );
    const data = await response.json();
    const summary = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    res.json({ summary: summary.trim() });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── RESUME ENHANCER ──────────────────────────────────────────
app.post("/api/enhance-resume", async (req, res) => {
  try {
    const { name, title, skills, exps, summary } = req.body;
    const prompt = `Improve this resume content and return ONLY valid JSON:
{
  "summary": "improved 2-3 sentence professional summary",
  "enhanced": ["improved description for job 1", "improved description for job 2"]
}

Name: ${name}, Title: ${title}, Skills: ${skills?.join?.(', ')||skills}
Experience: ${JSON.stringify(exps)}
Current summary: ${summary || 'none'}

Rules for descriptions:
- Start each bullet with a strong action verb
- Add specific impact where possible
- Keep each under 2 sentences
- Return ONLY the JSON, no markdown`;

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      { method:"POST", headers:{"Content-Type":"application/json"},
        body: JSON.stringify({ contents:[{ parts:[{ text: prompt }] }] }) }
    );
    const data = await response.json();
    const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
    const clean = raw.replace(/```json|```/g,'').trim();
    const parsed = JSON.parse(clean);
    res.json(parsed);
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});
