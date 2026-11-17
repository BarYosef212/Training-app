// AI progress review via the Claude API (official Anthropic SDK, loaded as an ES module).
// The API key is stored only on this device (localStorage) and sent directly to api.anthropic.com.
import Anthropic from './vendor/anthropic-sdk.js'; // @anthropic-ai/sdk 1.9.0, bundled with esbuild

const MODEL = 'claude-opus-5-5';

export const getKey = () => localStorage.getItem('anthropic_key') || '';
export const setKey = (k) => localStorage.setItem('anthropic_key', k.trim());

function client() {
  const apiKey = getKey();
  if (!apiKey) throw new Error('חסר מפתח API — הגדר אותו במסך ההגדרות');
  return new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
}

const SYSTEM = `אתה מאמן כושר ותזונאי מנוסה שנותן סקירת התקדמות אישית בעברית.
המשתמש מתעד שקילות, היקפים, תמונות התקדמות ואימונים. תפקידך:
- לנתח את התמונות (מבנה גוף, הגדרה, יציבה, שינויים בין תמונות אם יש כמה) בצורה עניינית ומכבדת.
- לשלב את נתוני המשקל, ההיקפים והאימונים ולזהות מגמות.
- לתת המלצות מעשיות וספציפיות לאימון, לתזונה ולהתאוששות.
אל תאבחן מצבים רפואיים. אם משהו נראה מדאיג, המלץ לפנות לאיש מקצוע.
כתוב בעברית, בפורמט Markdown קצר וברור עם הכותרות: "סיכום", "מה רואים בתמונות", "מגמות בנתונים", "המלצות", "יעד לתקופה הקרובה". עד כ-400 מילים.`;

/** Resize/compress an image Blob to a base64 JPEG suitable for the API. */
export async function blobToBase64Jpeg(blob, maxSide = 1280, quality = 0.85) {
  const bmp = await createImageBitmap(blob);
  const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
  const dataURL = canvas.toDataURL('image/jpeg', quality);
  return dataURL.split(',')[1];
}

/**
 * @param {Blob[]} images  progress photos (oldest → newest)
 * @param {string} context text summary of the user's logged data
 * @param {string} question optional extra question from the user
 */
export async function reviewProgress(images, context, question = '') {
  const content = [];
  for (const [i, img] of images.entries()) {
    content.push({ type: 'text', text: `תמונה ${i + 1}${img.label ? ` (${img.label})` : ''}:` });
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg', data: await blobToBase64Jpeg(img.blob) },
    });
  }
  content.push({
    type: 'text',
    text: `הנתונים שלי:\n${context}\n\n${question ? `שאלה/בקשה נוספת: ${question}` : 'תן לי סקירת התקדמות.'}`,
  });

  const stream = client().beta.messages.stream({
    model: MODEL,
    max_tokens: 16000,
    system: SYSTEM,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'medium' },
    // If a safety classifier declines, let the API retry on a suitable fallback model.
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    messages: [{ role: 'user', content }],
  });
  const msg = await stream.finalMessage();

  if (msg.stop_reason === 'refusal') {
    throw new Error('הבקשה נדחתה על ידי המודל. נסה תמונה אחרת או נסח מחדש.');
  }
  const text = msg.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
  if (!text) throw new Error('לא התקבלה תשובה מהמודל');
  return text;
}

export function friendlyError(err) {
  if (err instanceof Anthropic.AuthenticationError) return 'מפתח ה-API שגוי. בדוק אותו בהגדרות.';
  if (err instanceof Anthropic.PermissionDeniedError) return 'אין הרשאה לשימוש במודל עם המפתח הזה.';
  if (err instanceof Anthropic.RateLimitError) return 'יותר מדי בקשות — נסה שוב בעוד רגע.';
  if (err instanceof Anthropic.BadRequestError) return 'בקשה לא תקינה: ' + (err.message || '');
  if (err instanceof Anthropic.APIConnectionError) return 'אין חיבור לשרת. בדוק את החיבור לאינטרנט.';
  if (err instanceof Anthropic.APIError) return 'שגיאת שרת: ' + (err.message || '');
  return err?.message || String(err);
}
