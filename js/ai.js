// AI progress review via the OpenAI API (official `openai` SDK, bundled locally).
// The API key is stored only on this device (localStorage) and sent directly to api.openai.com.
import OpenAI from './vendor/openai-sdk.js'; // openai 7.57.0, bundled with esbuild

export const DEFAULT_MODEL = 'gpt-5.5';

export const getKey = () => localStorage.getItem('openai_key') || '';
export const getModel = () => localStorage.getItem('openai_model') || DEFAULT_MODEL;

function client() {
  const apiKey = getKey();
  if (!apiKey) throw new Error('חסר מפתח API — הגדר אותו במסך ההגדרות');
  return new OpenAI({ apiKey, dangerouslyAllowBrowser: true });
}

const SYSTEM = `אתה מאמן כושר ותזונאי מנוסה שנותן סקירת התקדמות אישית בעברית.
המשתמש מתעד שקילות, היקפים, תמונות התקדמות ותוכנית תרגילים (סטים, חזרות, משקלים). תפקידך:
- לנתח את התמונות (מבנה גוף, הגדרה, יציבה, שינויים בין תמונות אם יש כמה) בצורה עניינית ומכבדת.
- לשלב את נתוני המשקל, ההיקפים ותוכנית התרגילים ולזהות מגמות.
- לתת המלצות מעשיות וספציפיות לאימון, לתזונה ולהתאוששות.
אל תאבחן מצבים רפואיים. אם משהו נראה מדאיג, המלץ לפנות לאיש מקצוע.
כתוב בעברית, בפורמט Markdown קצר וברור עם הכותרות: "סיכום", "מה רואים בתמונות", "מגמות בנתונים", "המלצות", "יעד לתקופה הקרובה". עד כ-400 מילים.`;

/** Resize/compress an image Blob to a JPEG data URL suitable for the API. */
export async function blobToJpegDataURL(blob, maxSide = 1280, quality = 0.85) {
  const bmp = await createImageBitmap(blob);
  const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', quality);
}

/**
 * @param {{blob: Blob, label?: string}[]} images  progress photos (oldest → newest)
 * @param {string} context text summary of the user's logged data
 * @param {string} question optional extra question from the user
 */
export async function reviewProgress(images, context, question = '') {
  const content = [];
  for (const [i, img] of images.entries()) {
    content.push({ type: 'text', text: `תמונה ${i + 1}${img.label ? ` (${img.label})` : ''}:` });
    content.push({ type: 'image_url', image_url: { url: await blobToJpegDataURL(img.blob), detail: 'high' } });
  }
  content.push({
    type: 'text',
    text: `הנתונים שלי:\n${context}\n\n${question ? `שאלה/בקשה נוספת: ${question}` : 'תן לי סקירת התקדמות.'}`,
  });

  const res = await client().chat.completions.create({
    model: getModel(),
    max_completion_tokens: 16000,
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content },
    ],
  });

  const choice = res.choices?.[0];
  if (choice?.message?.refusal) throw new Error('הבקשה נדחתה על ידי המודל: ' + choice.message.refusal);
  const text = (choice?.message?.content || '').trim();
  if (!text) {
    if (choice?.finish_reason === 'length') throw new Error('התשובה נחתכה (מגבלת אורך). נסה שוב.');
    throw new Error('לא התקבלה תשובה מהמודל');
  }
  return text;
}

export function friendlyError(err) {
  if (err instanceof OpenAI.AuthenticationError) return 'מפתח ה-API שגוי. בדוק אותו בהגדרות.';
  if (err instanceof OpenAI.PermissionDeniedError) return 'אין הרשאה לשימוש במודל עם המפתח הזה.';
  if (err instanceof OpenAI.NotFoundError) return `המודל "${getModel()}" לא נמצא או לא זמין בחשבון שלך. שנה אותו בהגדרות.`;
  if (err instanceof OpenAI.RateLimitError) return 'חריגה ממגבלת שימוש או שאין יתרה בחשבון — נסה שוב בעוד רגע או בדוק את החיוב.';
  if (err instanceof OpenAI.BadRequestError) return 'בקשה לא תקינה: ' + (err.message || '');
  if (err instanceof OpenAI.APIConnectionError) return 'אין חיבור לשרת. בדוק את החיבור לאינטרנט.';
  if (err instanceof OpenAI.APIError) return 'שגיאת שרת: ' + (err.message || '');
  return err?.message || String(err);
}
