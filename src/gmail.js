import { google } from 'googleapis';

export function getGmailClient(auth) {
  return google.gmail({ version: 'v1', auth });
}

export async function listEmails(gmail) {
  const res = await gmail.users.messages.list({
    userId: 'me',
    labelIds: ['INBOX'],
    maxResults: 60
  });
  return res.data.messages || [];
}

// One-time onboarding scan of a user-named Gmail label/folder (e.g. a folder
// they've been manually moving application emails into), before the bot
// settles into the normal recurring Inbox-only poll.
export async function listEmailsByFolder(gmail, folderName) {
  const res = await gmail.users.messages.list({
    userId: 'me',
    q: `label:"${folderName}"`,
    maxResults: 200
  });
  return res.data.messages || [];
}

export async function getEmail(gmail, id) {
  const res = await gmail.users.messages.get({
    userId: 'me',
    id
  });
  return res.data;
}

function findTextPart(parts) {
  for (const part of parts) {
    if (part.mimeType === 'text/plain' && part.body?.data) return part.body.data;
    if (part.parts) {
      const found = findTextPart(part.parts);
      if (found) return found;
    }
  }
  return null;
}

export function decodeEmail(payload) {
  try {
    const parts = payload.payload?.parts;
    const data = parts ? findTextPart(parts) : payload.payload?.body?.data;
    if (!data) return payload.snippet || '';
    return Buffer.from(data, 'base64').toString('utf8');
  } catch {
    return payload.snippet || '';
  }
}
