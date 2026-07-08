import axios from "axios";
import { config } from "./config.js";

function stripCodeFences(text) {
  return text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
}

async function askGroqForJson(prompt) {
  const res = await axios.post(
    "https://api.groq.com/openai/v1/chat/completions",
    {
      model: "llama-3.3-70b-versatile",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.3,
    },
    {
      headers: {
        Authorization: `Bearer ${config.groq.apiKey}`,
        "Content-Type": "application/json",
      },
    }
  );
  const raw = res.data.choices[0].message.content;
  return JSON.parse(stripCodeFences(raw));
}

async function extractJobDetails({ subject, body, fromHeader, strongPhraseDetected }) {
  const hintLine = strongPhraseDetected
    ? `\nNote: an automated pre-scan already found an explicit confirmation phrase (e.g. "thank you for applying" / "we received your application") in this email — treat that as a strong signal it IS a genuine application confirmation unless the rest of the content clearly contradicts it.\n`
    : "";

  const prompt = `You are reading an email a job seeker received. The email may be written in any language (e.g. Hebrew, Arabic, Spanish) — read and understand it regardless of language, but always respond in the English JSON shape below. The email may come from a third-party ATS/recruiting platform (e.g. Greenhouse, Lever, Workday, SmartRecruiters, LinkedIn Easy Apply, Indeed) rather than the hiring company's own domain — do not assume the sender's email domain is the company's website. Regardless of who sent it, identify the actual hiring company the application was submitted to.

Email subject: ${subject}
Email sender: ${fromHeader}
Email body (may be partial):
${body.slice(0, 800)}
${hintLine}
First decide: is this a direct confirmation that the recipient's OWN job application was received/submitted (e.g. "Thank you for applying", "We received your application", "Your application to X has been submitted")?

Default to false. Only answer true if the email is unambiguously about a JOB APPLICATION at a company — i.e. it clearly references a position/role the recipient applied for and a hiring process. Answer false for everything else, including but not limited to: banking/payment/transaction notifications (even ones with a reference/confirmation number), bills, invoices, receipts, shipping/delivery updates, subscription or account notices, government/insurance correspondence, job recommendation/suggestion digests ("jobs you may like", job alerts/newsletters), interview invitations, assessment/task requests, offer letters, rejection notices, or anything else not explicitly about submitting a job application. Words like "confirmation," "update," or the presence of a reference number are NOT enough on their own — the email must be clearly employment-related.

Respond with ONLY valid JSON (no markdown fences, no commentary) in this exact shape:
{
  "isApplicationConfirmation": true or false,
  "company": "the actual hiring company's name (best guess even if isApplicationConfirmation is false)",
  "position": "job title mentioned in the email, or 'Not specified' if unclear",
  "status": "short status phrase, e.g. 'Application received'",
  "officialWebsiteDomain": "your best-known official website domain for the hiring company itself, e.g. 'stripe.com' — NOT a job board or ATS domain like greenhouse.io/lever.co/myworkday.com/linkedin.com/indeed.com. If genuinely unsure, use null."
}`;

  return askGroqForJson(prompt);
}

function formatReceivedDate(dateHeader) {
  const parsed = dateHeader ? new Date(dateHeader) : null;
  if (!parsed || isNaN(parsed.getTime())) return "Date unavailable";
  return parsed.toLocaleString("en-US", {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function decodeHtmlEntities(text) {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ");
}

const JUNK_BLURB_PATTERNS = [
  /enable javascript/i,
  /cookie/i,
  /just a moment/i,
  /access denied/i,
  /are you a robot/i,
  /captcha/i,
];

function fetchWebsiteBlurb(domain) {
  return fetchWebsiteBlurbInner(domain).catch(() => "");
}

async function fetchWebsiteBlurbInner(domain) {
  if (!domain) return "";
  const { data: html } = await axios.get(`https://${domain}`, {
    timeout: 5000,
    headers: { "User-Agent": "Mozilla/5.0 (compatible; ApplyAndFlyBot/1.0)" },
  });
  const descMatch = html.match(
    /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i
  );
  const raw = descMatch ? descMatch[1] : (html.match(/<title>([^<]+)<\/title>/i) || [])[1];
  if (!raw) return "";

  const cleaned = decodeHtmlEntities(raw).trim().slice(0, 300);
  if (cleaned.length < 15) return "";
  if (JUNK_BLURB_PATTERNS.some((p) => p.test(cleaned))) return "";
  return cleaned;
}

async function enrichCompany({ company, position, websiteBlurb }) {
  const prompt = `You are building a short company snapshot for a job seeker who applied to "${position}" at "${company}".

Live snippet pulled from the company's official website (may be empty, generic, or irrelevant — e.g. a cookie-consent notice or homepage tagline that doesn't actually describe the company): ${websiteBlurb || "(not available)"}

Your primary source should be your own general knowledge of "${company}". Only use the live snippet above if it's clearly a genuine, specific description of what the company does — ignore it entirely if it's vague, generic marketing copy, or unrelated to the company's actual business.

Respond with ONLY valid JSON (no markdown fences, no commentary) in this exact shape:
{
  "employees": "approximate employee count if reasonably well known, else 'Not publicly disclosed'",
  "industry": "industry/category",
  "hq": "headquarters city, else 'Unknown'",
  "publicPrivate": "'Public company (TICKER)' or 'Private company', else 'Unknown'",
  "whatTheyDo": "1-2 sentence plain, specific description of what the company actually does, based on your own knowledge of the company"
}

Do not fabricate precise numbers you are not reasonably confident about — use 'Not publicly disclosed' or 'Unknown' instead of guessing.`;

  return askGroqForJson(prompt);
}

// Returns: a message string on success, null on a real enrichment failure
// (caller falls back to a plain message), or undefined when the email is
// deliberately skipped (not an application confirmation — caller sends nothing).
export async function buildJobUpdateMessage({ subject, body, fromHeader, dateHeader, strongPhraseDetected }) {
  let details;
  try {
    details = await extractJobDetails({ subject, body, fromHeader, strongPhraseDetected });
  } catch (err) {
    console.error("Enrichment error:", err.response?.data || err.message || err);
    return null;
  }

  // A strong phrase match (e.g. literal "thank you for applying" found in
  // the email) is a deterministic signal from our own code, not a guess —
  // it should never be overridden by the LLM's classification wavering.
  if (!details.isApplicationConfirmation && !strongPhraseDetected) {
    return undefined;
  }

  try {
    const websiteBlurb = await fetchWebsiteBlurb(details.officialWebsiteDomain);
    const snapshot = await enrichCompany({
      company: details.company,
      position: details.position,
      websiteBlurb,
    });

    return `🚀 ApplyAndFly

We detected a new application update.

🏢 Company
${details.company}

💼 Position
${details.position}

📩 Status
${details.status}

📅 Timeline
Application received ${formatReceivedDate(dateHeader)}.

🏢 Company Snapshot
• ${snapshot.employees} employees
• ${snapshot.industry}
• Headquarters: ${snapshot.hq}
• ${snapshot.publicPrivate}

⭐ What they do
${snapshot.whatTheyDo}

Good luck! 🍀`;
  } catch (err) {
    console.error("Enrichment error:", err.response?.data || err.message || err);
    return null;
  }
}
