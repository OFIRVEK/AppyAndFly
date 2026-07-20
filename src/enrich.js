import axios from "axios";
import { config } from "./config.js";

function stripCodeFences(text) {
  return text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
}

function repairJson(text) {
  // Best-effort cleanup for the common ways a smaller model's JSON output
  // gets slightly malformed: trailing commas before a closing brace/bracket.
  return text.replace(/,(\s*[}\]])/g, "$1");
}

async function askGroqForJson(prompt, model = "llama-3.1-8b-instant") {
  const res = await axios.post(
    "https://api.groq.com/openai/v1/chat/completions",
    {
      model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.3,
      response_format: { type: "json_object" },
    },
    {
      headers: {
        Authorization: `Bearer ${config.groq.apiKey}`,
        "Content-Type": "application/json",
      },
    }
  );
  const raw = stripCodeFences(res.data.choices[0].message.content);
  try {
    return JSON.parse(raw);
  } catch {
    return JSON.parse(repairJson(raw));
  }
}

async function extractJobDetails({ subject, body, fromHeader, strongPhraseDetected, rejectionDetected }) {
  const hintLines = [];
  if (strongPhraseDetected) {
    hintLines.push(
      `Note: an automated pre-scan found an explicit confirmation phrase (e.g. "thank you for applying" / "we received your application") somewhere in this email. That phrase alone does NOT settle it — plenty of rejection emails open with the exact same wording before declining further down. Keep reading the full email before deciding.`
    );
  }
  if (rejectionDetected) {
    hintLines.push(
      `Note: an automated pre-scan found language elsewhere in this email that resembles a rejection/decline (e.g. "moving forward with other candidates", "unfortunately", "will not be proceeding"). This is a strong signal the email is a REJECTION, not a confirmation — set isApplicationConfirmation to false in that case, even if the email also opens with a "thank you for applying"-style line.`
    );
  }
  const hintBlock = hintLines.length ? `\n${hintLines.join("\n")}\n` : "";

  const prompt = `You are reading an email a job seeker received. The email may be written in any language (e.g. Hebrew, Arabic, Spanish) — read and understand it regardless of language, but always respond in the English JSON shape below. The email may come from a third-party ATS/recruiting platform (e.g. Greenhouse, Lever, Workday, SmartRecruiters, LinkedIn Easy Apply, Indeed) rather than the hiring company's own domain — do not assume the sender's email domain is the company's website. Regardless of who sent it, identify the actual hiring company the application was submitted to.

Email subject: ${subject}
Email sender: ${fromHeader}
Email body (may be partial):
${body.slice(0, 1500)}
${hintBlock}
First decide: is this a direct confirmation that the recipient's OWN job application was received/submitted (e.g. "Thank you for applying", "We received your application", "Your application to X has been submitted")? Read the ENTIRE email before deciding — many rejection emails open with the same "thank you for applying" style line before declining later in the body. An opening thank-you does NOT make it a confirmation if the email goes on to reject, decline, or say the role was filled by someone else.

For the "position" field: check the EMAIL SUBJECT LINE carefully, not just the body — job titles are very often stated there even when the body is generic (e.g. "Thank you for applying for the QA Engineer position at X", "We Got It: Thanks for applying for Flight Test & QA"). Only use "Not specified" if neither the subject nor the body names a role.

Default to false. Only answer true if the email is unambiguously about a JOB APPLICATION at a company AND does not contain any rejection/decline language. Answer false for everything else, including but not limited to: banking/payment/transaction notifications (even ones with a reference/confirmation number), bills, invoices, receipts, shipping/delivery updates, subscription or account notices, government/insurance correspondence, job recommendation/suggestion digests ("jobs you may like", job alerts/newsletters), interview invitations, assessment/task requests, offer letters, rejection/decline notices (even ones that open with a thank-you line), or anything else not explicitly a clean application-received confirmation. This also includes ANY purchase/booking/reservation confirmation for something other than a job — concert or event tickets, restaurant reservations, flight/hotel bookings, online orders, deliveries, etc. — and ANY membership/loyalty-program/subscription/service sign-up confirmation (e.g. "Welcome to X Membership"), even if it uses the word "application" or "welcome" (a membership application, loan application, or software application is NOT a job application). Such emails can easily contain words that superficially look job-related (e.g. a seat "position", a "job well done" in marketing copy) — that is NOT a job application. Words like "confirmation," "welcome," "application," "position," or the presence of a reference number are NOT enough on their own — the email must be unmistakably about applying for EMPLOYMENT at a hiring company and free of any rejection language.

Respond with ONLY valid JSON (no markdown fences, no commentary) in this exact shape:
{
  "isApplicationConfirmation": true or false,
  "isRejection": true or false,
  "company": "the actual hiring company's name (best guess even if isApplicationConfirmation is false)",
  "position": "job title mentioned in the email, or 'Not specified' if unclear",
  "status": "short status phrase, e.g. 'Application received'"
}`;

  return askGroqForJson(prompt);
}

// Deterministic backstop for when the LLM comes back with "Not specified" —
// job titles are frequently stated plainly in the subject line using one of
// a handful of common phrasings.
const POSITION_SUBJECT_PATTERNS = [
  /for the (.+?) position/i,
  /for (.+?) position/i,
  /applying for the (.+?) role/i,
  /applying for (.+?) role/i,
  /for the role of (.+?)(?:\s+at\b|$)/i,
  /applying for (.+?) at\b/i,
  /application for (.+?) at\b/i,
  /thanks for applying for (.+?)(?:\s+at\b|$)/i,
];

function extractPositionFromSubject(subject = "") {
  for (const pattern of POSITION_SUBJECT_PATTERNS) {
    const match = subject.match(pattern);
    if (match?.[1]) return match[1].trim().replace(/[.,;:]+$/, "");
  }
  return null;
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

async function enrichCompany({ company, position }) {
  const prompt = `You are building a short company snapshot for a job seeker who applied to "${position}" at "${company}".

Using your own general knowledge of "${company}", respond with ONLY valid JSON (no markdown fences, no commentary) in this exact shape:
{
  "employees": "approximate employee count if reasonably well known, else 'Not publicly disclosed'",
  "industry": "industry/category",
  "hq": "headquarters city, else 'Unknown'",
  "publicPrivate": "'Public company (TICKER)' or 'Private company', else 'Unknown'",
  "whatTheyDo": "1-2 sentence plain, specific description of what the company actually does"
}

Do not fabricate precise numbers you are not reasonably confident about — use 'Not publicly disclosed' or 'Unknown' instead of guessing. If you are not genuinely confident what this specific company does (there may be multiple companies with similar names), say so honestly in whatTheyDo (e.g. "Specific business area unclear") rather than guessing a plausible-sounding but potentially wrong industry.`;

  // This call only fires for emails already confirmed as genuine
  // applications — much lower volume than the classification step — so we
  // can afford the more capable model here for better accuracy without
  // meaningfully affecting the daily token budget.
  return askGroqForJson(prompt, "llama-3.3-70b-versatile");
}

// Returns: a message string on success, null on a real enrichment failure
// (caller falls back to a plain message), or undefined when the email is
// deliberately skipped (not an application confirmation — caller sends nothing).
export async function buildJobUpdateMessage({ subject, body, fromHeader, dateHeader, strongPhraseDetected, rejectionDetected }) {
  let details;
  try {
    details = await extractJobDetails({ subject, body, fromHeader, strongPhraseDetected, rejectionDetected });
  } catch (err) {
    console.error("Enrichment error:", err.response?.data || err.message || err);
    return null;
  }

  // The LLM's own rejection call is authoritative — never send a "confirmed"
  // message for something it flagged as a rejection, no matter what else
  // matched. A strong confirmation-phrase match only overrides the LLM's
  // isApplicationConfirmation=false when there's no rejection signal at all
  // (from either our own deterministic scan or the LLM itself) — this is
  // what lets a genuine confirmation the LLM under-called still go through,
  // without letting a rejection that opens with "thank you for applying"
  // slip through as a false positive.
  if (details.isRejection) {
    return undefined;
  }
  if (!details.isApplicationConfirmation && !(strongPhraseDetected && !rejectionDetected)) {
    return undefined;
  }

  if (!details.position || /not specified/i.test(details.position)) {
    details.position = extractPositionFromSubject(subject) || details.position;
  }

  try {
    const snapshot = await enrichCompany({
      company: details.company,
      position: details.position,
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
