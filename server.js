require("dotenv").config();

const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

console.log("=================================");
console.log("API Key Loaded:", process.env.GEMINI_API_KEY ? "YES" : "NO");
console.log("=================================");

// ─── USAGE TRACKING (3 free letters per day per IP) ───────────────
const usageMap = {}; // { ip: { count: 3, date: "2026-06-06" } }
const FREE_LIMIT = 3;

function getToday() {
  return new Date().toISOString().split("T")[0]; // "2026-06-06"
}

function checkLimit(ip) {
  const today = getToday();
  if (!usageMap[ip] || usageMap[ip].date !== today) {
    usageMap[ip] = { count: 0, date: today }; // reset daily
  }
  return usageMap[ip].count < FREE_LIMIT;
}

function incrementUsage(ip) {
  usageMap[ip].count++;
}

function getRemainingCount(ip) {
  const today = getToday();
  if (!usageMap[ip] || usageMap[ip].date !== today) return FREE_LIMIT;
  return FREE_LIMIT - usageMap[ip].count;
}
// ──────────────────────────────────────────────────────────────────

app.post("/api/generate", async (req, res) => {
  try {
    // Get real IP (works on Render)
    const ip = req.headers["x-forwarded-for"]?.split(",")[0] || req.socket.remoteAddress;

    // Check usage limit
    if (!checkLimit(ip)) {
      return res.status(429).json({
        error: "LIMIT_REACHED",
        message: "You have used your 3 free cover letters for today. Upgrade to Pro for unlimited access."
      });
    }

    console.log("Received request from IP:", ip);

    const { name, profession, exp, skills, achievement, company, jobtitle, jobdesc, tone } = req.body;

    const prompt = `Write a cover letter using ONLY the details provided below. Do not invent or assume any information.

Applicant Name : ${name}
Profession     : ${profession}
Experience     : ${exp}
Skills         : ${skills || 'not specified'}
Achievement    : ${achievement || 'none'}
Company        : ${company}
Job Title      : ${jobtitle}
Job Description: ${jobdesc || 'not provided'}
Tone           : ${tone || 'Professional'}

STRICT RULES — you must follow every rule exactly:
1. Start the letter with "Dear Hiring Manager,"
2. Write exactly 3 paragraphs: a strong opening, why I am the best fit using the skills and achievement above, and a confident closing.
3. Use the applicant's REAL name "${name}" — NEVER write [Your Name] or any bracket placeholder.
4. Do NOT add any address, phone number, email, or date lines at the top.
5. Do NOT write anything inside square brackets like [Your Address], [Date], [Company Address], [Your Phone] etc.
6. End the letter exactly like this (using the real name):
   Sincerely,
   ${name}
7. Keep the letter between 220 and 280 words.
8. Output the letter text ONLY — no extra explanation, no subject line, no markdown formatting.`;

    console.log("Sending request to Gemini REST API...");

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
        }),
      }
    );

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error?.message || "Failed to generate content");
    }

    const letter = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!letter) throw new Error("No cover letter returned by Gemini");

    // Increment usage AFTER successful generation
    incrementUsage(ip);
    const remaining = getRemainingCount(ip);

    res.json({ letter, remaining });

  } catch (error) {
    console.error("FULL ERROR:", error);
    res.status(500).json({ error: error.message });
  }
});

// ─── Check remaining count for a user ─────────────────────────────
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
        body: JSON.stringify({
          contents: [{ parts: [{ text: "Say hello in one sentence." }] }],
        }),
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
  console.log("");
  console.log("🚀 Server running");
  console.log(`🌐 http://localhost:${PORT}`);
  console.log("");
});