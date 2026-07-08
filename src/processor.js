const CONFIRMATION_PHRASES = [
  'thank you for applying', 'thanks for applying',
  'we received your application', "we've received your application",
  'your application has been received', 'your application was received',
  'your application has been submitted', 'application confirmation'
];

export function isJobEmail(text = '') {
  const keywords = [
    'application','applied','applying','interview','recruiter',
    'position','job','hiring','assessment'
  ];
  const suggestionPhrases = [
    'jobs you may be interested', 'recommended jobs', 'recommended for you',
    'new jobs for you', 'job alert', 'jobs matching', 'similar jobs',
    'jobs based on your', 'weekly job digest', 'jobs you might like',
    'people are also viewing', 'top job picks'
  ];
  const lower = text.toLowerCase();
  if (CONFIRMATION_PHRASES.some(p => lower.includes(p))) return true;
  if (suggestionPhrases.some(p => lower.includes(p))) return false;
  return keywords.some(k => lower.includes(k));
}

export function hasStrongConfirmationPhrase(text = '') {
  const lower = text.toLowerCase();
  return CONFIRMATION_PHRASES.some(p => lower.includes(p));
}

// Covers Hebrew, Arabic, Cyrillic, Greek, Devanagari, Thai, CJK, Hangul.
// The English keyword lists above only ever match Latin-script English text,
// so anything written in one of these scripts would otherwise be silently
// dropped before it ever reaches the LLM. This is a broad "might be a
// non-English email, let the LLM take a look" signal — not a precise
// language detector.
const NON_LATIN_SCRIPT_REGEX =
  /[Ͱ-ϿЀ-ӿ֐-׿؀-ۿऀ-ॿ฀-๿぀-ヿ一-鿿가-힣]/;

export function looksNonEnglish(text = '') {
  return NON_LATIN_SCRIPT_REGEX.test(text);
}

// Cheap reject list for obvious marketing/promo emails in non-English scripts,
// so we don't burn an LLM call (and rate-limit budget) on things like
// "...| פרסומת" (Hebrew for "advertisement"). Mirrors suggestionPhrases above.
const NON_ENGLISH_PROMO_MARKERS = [
  'פרסומת', 'מבצע', 'מבצעים', 'הנחה', 'הנחות', 'קופון',
  'إعلان', 'خصم', 'عرض',
];

export function looksPromotional(text = '') {
  return NON_ENGLISH_PROMO_MARKERS.some(p => text.includes(p));
}

// Cheap reject list for common non-job transactional emails in non-English
// scripts (banking, payments, deliveries) — these often contain words like
// "confirmation" or a reference number that could otherwise look job-like
// to a keyword scan, e.g. a bank notice with an אסמכתה (reference number).
const NON_ENGLISH_NON_JOB_MARKERS = [
  // Hebrew: bank / payment / transaction terms
  'בנק', 'אסמכתה', 'חיוב', 'זיכוי', 'יתרה', 'העברה בנקאית',
  'כרטיס אשראי', 'חשבונית', 'תשלום', 'משכורת', 'ביטוח לאומי',
];

export function looksNonJobTransactional(text = '') {
  return NON_ENGLISH_NON_JOB_MARKERS.some(p => text.includes(p));
}

export function extractCompany(from = '') {
  return from.split('<')[0]?.trim() || 'Unknown Company';
}
