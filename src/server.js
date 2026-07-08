import express from "express";
import fs from "fs";
import path from "path";
import { config } from "./config.js";
import { oauth2Client, getAuthUrl } from "./auth.js";
import { getGmailClient, listEmails, getEmail, decodeEmail } from "./gmail.js";
import { isJobEmail, hasStrongConfirmationPhrase, looksNonEnglish, looksPromotional, looksNonJobTransactional } from "./processor.js";
import { sendWhatsApp } from "./whatsapp.js";
import { buildJobUpdateMessage } from "./enrich.js";

const app = express();

const PORT = process.env.PORT || config.port || 3000;

// Persisted across restarts so we don't re-scan (and re-burn LLM tokens on)
// the same emails every time the server is restarted during development.
const SEEN_FILE = path.resolve(process.cwd(), "seen.json");

function loadSeen() {
  try {
    const raw = fs.readFileSync(SEEN_FILE, "utf8");
    return new Set(JSON.parse(raw));
  } catch {
    return new Set();
  }
}

function persistSeen() {
  fs.writeFileSync(SEEN_FILE, JSON.stringify([...seen]));
}

let userAuth = null;
let seen = loadSeen();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 🔥 ADD THIS (fix race / duplicate callback issues)
let authInProgress = false;

/**
 * STEP 1: start OAuth
 */
app.get("/auth/google", (req, res) => {
  const url = getAuthUrl();
  console.log("Redirecting to Google OAuth:", url);
  res.redirect(url);
});

/**
 * STEP 2: OAuth callback
 */
app.get("/auth/google/callback", async (req, res) => {
  try {
    if (authInProgress) {
      return res.send("Auth already processing...");
    }

    authInProgress = true;

    const code = req.query.code;

    // 🔥 THIS is your "Missing OAuth code" safeguard
    if (!code) {
      authInProgress = false;
      return res.status(400).send(
        "Missing OAuth code. You must start from /auth/google"
      );
    }

    const { tokens } = await oauth2Client.getToken(code);

    oauth2Client.setCredentials(tokens);
    userAuth = oauth2Client;

    authInProgress = false;

    console.log("✅ OAuth success. Tokens received.");

    res.send("✅ Auth successful. Bot is now running.");
  } catch (err) {
    authInProgress = false;

    console.error("OAuth error:", err?.response?.data || err);

    res.status(500).send("Authentication failed");
  }
});

/**
 * EMAIL POLLING
 */
async function poll() {
  try {
    if (!userAuth) return;

    const gmail = getGmailClient(userAuth);
    const messages = await listEmails(gmail);

    for (const m of messages) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      persistSeen();

      const full = await getEmail(gmail, m.id);
      const body = decodeEmail(full);

      const subjectHeader =
        full.payload?.headers?.find((h) => h.name === "Subject")?.value || "";
      const fromHeader =
        full.payload?.headers?.find((h) => h.name === "From")?.value || "";
      const dateHeader =
        full.payload?.headers?.find((h) => h.name === "Date")?.value || "";

      const text = `${subjectHeader}\n${body}`;
      const matched = isJobEmail(text);
      // English pipeline is untouched: if the English keyword pre-filter
      // already matched, proceed exactly as before. Only when it DIDN'T
      // match do we check whether the email might be in another language
      // (e.g. Hebrew) — in that case we still let the LLM decide, since the
      // English-only keyword lists can't recognize non-English confirmations.
      const nonEnglishCandidate =
        !matched &&
        looksNonEnglish(text) &&
        !looksPromotional(text) &&
        !looksNonJobTransactional(text);

      console.log(
        `[poll] id=${m.id} subject="${subjectHeader}" matched=${matched} nonEnglishCandidate=${nonEnglishCandidate}`
      );

      if (!matched && !nonEnglishCandidate) continue;

      // Throttle: only reached for actual LLM-classification candidates, so a
      // burst of matches in one poll cycle (e.g. right after a restart) gets
      // spread out over time instead of firing every request in the same
      // second — keeps us under Groq's per-minute token rate limit.
      await sleep(2000);

      const enriched = await buildJobUpdateMessage({
        subject: subjectHeader,
        body,
        fromHeader,
        dateHeader,
        strongPhraseDetected: hasStrongConfirmationPhrase(text),
      });

      if (!enriched) {
        console.log(
          `[poll] id=${m.id} skipped (not confirmed as an application, or enrichment failed)`
        );
        continue;
      }

      await sendWhatsApp(enriched);
    }
  } catch (err) {
    console.error("Poll error:", err);
  }
}

setInterval(poll, 60000);

/**
 * START SERVER
 */
app.listen(PORT, () => {
  console.log(`Running on http://localhost:${PORT}`);
  console.log(`START HERE → http://localhost:${PORT}/auth/google`);
});