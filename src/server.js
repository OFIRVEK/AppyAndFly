import express from "express";
import { config } from "./config.js";
import { oauth2Client, getAuthUrl } from "./auth.js";
import { getGmailClient, listEmails, listEmailsByFolder, getEmail, decodeEmail } from "./gmail.js";
import { isJobEmail, hasStrongConfirmationPhrase, looksLikeRejection, looksNonEnglish, looksJobRelatedNonEnglish, looksPromotional, looksNonJobTransactional, looksLikePayment } from "./processor.js";
import { sendWhatsApp } from "./whatsapp.js";
import { buildJobUpdateMessage } from "./enrich.js";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || config.port || 3000;

let userAuth = null;
// Set once WhatsApp-first onboarding completes; overrides the hardcoded
// WHATSAPP_TO_NUMBER fallback so replies go to whoever actually onboarded.
let activeRecipient;
// In-memory only: resets on every restart, so a restart re-scans the full
// maxResults window from scratch.
let seen = new Set();
let pollInProgress = false;

// One entry per WhatsApp user who has started onboarding. Keyed by their
// WhatsApp ID (phone number). Single-user in practice today, but keyed this
// way so it's ready for more than one WhatsApp identity later.
const sessions = new Map();

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
    const waId = req.query.state; // present when this OAuth flow started from WhatsApp

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

    if (waId) {
      activeRecipient = waId;
      sessions.set(waId, { state: "awaiting_folder_answer" });
      await sendWhatsApp(
        `✅ Google connected!\n\nDo you have a folder where you moved your recent job application emails? If yes, reply with its name. If not, reply "Continue".`,
        waId
      );
      return res.send("✅ Auth successful — check WhatsApp to finish setup.");
    }

    res.send("✅ Auth successful. Bot is now running.");
  } catch (err) {
    authInProgress = false;

    console.error("OAuth error:", err?.response?.data || err);

    res.status(500).send("Authentication failed");
  }
});

/**
 * WHATSAPP WEBHOOK — receives inbound messages (Meta calls this)
 */
app.get("/webhook/whatsapp", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === config.whatsapp.verifyToken) {
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

app.post("/webhook/whatsapp", (req, res) => {
  res.sendStatus(200); // ack immediately, Meta expects a fast response

  const message = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  if (!message || message.type !== "text") return;

  const waId = message.from;
  const text = message.text?.body?.trim() || "";

  handleIncomingWhatsAppMessage(waId, text).catch((err) =>
    console.error("Webhook handling error:", err)
  );
});

/**
 * ONBOARDING CONVERSATION
 */
async function handleIncomingWhatsAppMessage(waId, text) {
  const session = sessions.get(waId);

  if (!session) {
    sessions.set(waId, { state: "awaiting_oauth" });
    const authUrl = getAuthUrl(waId);
    await sendWhatsApp(
      `👋 Hey, thanks for choosing ApplyAndFly as your applications manager!\n\nFirst, sign in with Google so I can read your Gmail:\n${authUrl}`,
      waId
    );
    return;
  }

  if (session.state === "awaiting_folder_answer") {
    const folder = text.toLowerCase() === "continue" ? null : text;
    activeRecipient = waId;

    if (folder) {
      await sendWhatsApp(`Got it — scanning "${folder}" for existing applications first...`, waId);
      await scanFolderOnce(folder);
    }

    sessions.set(waId, { state: "onboarded", folder });
    await sendWhatsApp(
      `✅ All set! I'll keep watching your Inbox for new application confirmations.`,
      waId
    );
  }
}

/**
 * SHARED MESSAGE PROCESSING — used by both the recurring Inbox poll and the
 * one-time onboarding folder scan, so the classification/enrichment/send
 * logic only lives in one place.
 */
async function processMessage(gmail, m) {
  if (seen.has(m.id)) return;
  seen.add(m.id);

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
  const nonEnglishCandidate =
    !matched &&
    looksNonEnglish(text) &&
    looksJobRelatedNonEnglish(text) &&
    !looksPromotional(text) &&
    !looksNonJobTransactional(text);

  console.log(
    `[poll] id=${m.id} subject="${subjectHeader}" matched=${matched} nonEnglishCandidate=${nonEnglishCandidate}`
  );

  if (!matched && !nonEnglishCandidate) return;

  if (looksLikePayment(text)) {
    console.log(`[poll] id=${m.id} skipped (looks like a payment/purchase receipt)`);
    return;
  }

  // Throttle: spreads LLM calls out so a burst of matches in one poll cycle
  // (e.g. right after a restart) doesn't blow through Groq's per-minute
  // token cap. llama-3.1-8b-instant's free tier is 6,000 TPM — at roughly
  // ~1,200 tokens for a confirmed email's two calls combined, 8s spacing
  // keeps us under that even for several matches in a row.
  await sleep(8000);

  const enriched = await buildJobUpdateMessage({
    subject: subjectHeader,
    body,
    fromHeader,
    dateHeader,
    strongPhraseDetected: hasStrongConfirmationPhrase(text),
    rejectionDetected: looksLikeRejection(text),
  });

  if (!enriched) {
    console.log(
      `[poll] id=${m.id} skipped (not confirmed as an application, or enrichment failed)`
    );
    return;
  }

  await sendWhatsApp(enriched, activeRecipient);
}

async function scanFolderOnce(folderName) {
  try {
    const gmail = getGmailClient(userAuth);
    const messages = await listEmailsByFolder(gmail, folderName);
    console.log(`[onboarding] scanning folder "${folderName}": ${messages.length} messages`);
    for (const m of messages) {
      await processMessage(gmail, m);
    }
  } catch (err) {
    console.error("Folder scan error:", err);
  }
}

/**
 * EMAIL POLLING
 */
async function poll() {
  if (pollInProgress) return; // previous cycle still running, don't overlap
  if (!userAuth) return;

  pollInProgress = true;
  try {
    const gmail = getGmailClient(userAuth);
    const messages = await listEmails(gmail);

    for (const m of messages) {
      await processMessage(gmail, m);
    }
  } catch (err) {
    console.error("Poll error:", err);
  } finally {
    pollInProgress = false;
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