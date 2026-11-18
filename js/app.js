import * as db from './db.js';

// ---------- Utilities ----------
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const today = () => {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
};
const fmtDate = (iso) => {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y.slice(2)}`;
};
const num = (v) => {
  const n = parseFloat(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};
const round1 = (n) => Math.round(n * 10) / 10;
const daysBetween = (a, b) => Math.round((new Date(b) - new Date(a)) / 86400000);

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 2200);
}

const sheet = $('#sheet');
function openSheet(html, onMount) {
  // Fresh element each time so listeners from a previous sheet don't leak.
  const old = $('#sheet-body');
  const body = old.cloneNode(false);
  old.replaceWith(body);
  body.innerHTML = html;
  if (!sheet.open) sheet.showModal();
  onMount?.($('#sheet-body'));
}
function closeSheet() {
  sheet.close();
}
sheet.addEventListener('click', (e) => {
  if (e.target === sheet) closeSheet();
});

// Object URLs for photo thumbnails — revoked on every re-render.
let objectURLs = [];
const blobURL = (blob) => {
  const u = URL.createObjectURL(blob);
  objectURLs.push(u);
  return u;
};
const revokeURLs = () => {
  objectURLs.forEach(URL.revokeObjectURL);
  objectURLs = [];
};

// Minimal, safe Markdown → HTML (headings, bullets, bold).
function md(text) {
  const lines = esc(text).split('\n');
  let html = '';
  let inList = false;
  for (const raw of lines) {
    const line = raw.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
    const li = line.match(/^\s*[-*•]\s+(.*)/) || line.match(/^\s*\d+[.)]\s+(.*)/);
    if (li) {
      if (!inList) (html += '<ul>'), (inList = true);
      html += `<li>${li[1]}</li>`;
      continue;
    }
    if (inList) (html += '</ul>'), (inList = false);
    const h = line.match(/^#{1,6}\s+(.*)/);
    if (h) html += `<h3>${h[1]}</h3>`;
    else if (line.trim()) html += `<p>${line}</p>`;
  }
  if (inList) html += '</ul>';
  return html;
}

// Simple SVG line chart. points: [{x: isoDate, y: number}] (any order)
function lineChart(points, { unit = '' } = {}) {
  const pts = points.filter((p) => p.y != null).sort((a, b) => a.x.localeCompare(b.x));
  if (pts.length < 2) return '<div class="muted small">צריך לפחות 2 רשומות כדי להציג גרף</div>';
  const W = 340, H = 180, P = { l: 34, r: 10, t: 12, b: 22 };
  const t0 = new Date(pts[0].x).getTime();
  const t1 = new Date(pts.at(-1).x).getTime() || t0 + 1;
  const ys = pts.map((p) => p.y);
  let min = Math.min(...ys), max = Math.max(...ys);
  if (min === max) (min -= 1), (max += 1);
  const pad = (max - min) * 0.1;
  min -= pad; max += pad;
  const X = (x) => P.l + ((new Date(x).getTime() - t0) / (t1 - t0 || 1)) * (W - P.l - P.r);
  const Y = (y) => P.t + (1 - (y - min) / (max - min)) * (H - P.t - P.b);
  // Chart is drawn LTR (time flows left→right) regardless of page direction.
  const path = pts.map((p, i) => `${i ? 'L' : 'M'}${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`).join('');
  const area = `${path}L${X(pts.at(-1).x).toFixed(1)},${H - P.b}L${X(pts[0].x).toFixed(1)},${H - P.b}Z`;
  const grid = [0, 0.5, 1]
    .map((f) => {
      const v = min + (max - min) * f;
      const y = Y(v);
      return `<line x1="${P.l}" x2="${W - P.r}" y1="${y}" y2="${y}" stroke="#2b303b" stroke-dasharray="3 3"/><text x="2" y="${y + 3}">${round1(v)}</text>`;
    })
    .join('');
  const dots = pts.map((p) => `<circle cx="${X(p.x)}" cy="${Y(p.y)}" r="2.5" fill="#4ade80"/>`).join('');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="direction:ltr">
    <defs><linearGradient id="g" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#4ade80" stop-opacity=".35"/><stop offset="1" stop-color="#4ade80" stop-opacity="0"/></linearGradient></defs>
    ${grid}<path d="${area}" fill="url(#g)"/><path d="${path}" fill="none" stroke="#4ade80" stroke-width="2"/>${dots}
    <text x="${P.l}" y="${H - 6}">${fmtDate(pts[0].x)}</text><text x="${W - P.r}" y="${H - 6}" text-anchor="end">${fmtDate(pts.at(-1).x)}</text>
  </svg>${unit ? `<div class="muted small">${unit}</div>` : ''}`;
}

// Compress a user-picked image file before storing it.
async function compressImage(file, maxSide = 1600, quality = 0.85) {
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale);
    c.height = Math.round(bmp.height * scale);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    return await new Promise((r) => c.toBlob(r, 'image/jpeg', quality));
  } catch {
    return file; // fallback: store original
  }
}

// ---------- Profile ----------
const profile = () => JSON.parse(localStorage.getItem('profile') || '{}');
const setProfile = (p) => localStorage.setItem('profile', JSON.stringify(p));

// ---------- Router ----------
const TITLES = { home: 'יומן אימונים', weight: 'שקילה', checkins: 'מעקבים', exercises: 'התרגילים שלי', settings: 'הגדרות' };
let current = 'home';
const views = {};

async function go(tab) {
  current = tab;
  $$('.tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  $('#title').textContent = TITLES[tab];
  revokeURLs();
  const v = $('#view');
  v.innerHTML = '<div class="empty"><span class="spinner"></span></div>';
  await views[tab](v);
  window.scrollTo(0, 0);
}
const refresh = () => go(current);

$$('.tabbar button').forEach((b) => b.addEventListener('click', () => go(b.dataset.tab)));
$('#btn-settings').addEventListener('click', () => go('settings'));

// ---------- HOME ----------
views.home = async (v) => {
  const [weights, exercises, checkins, reviews] = await Promise.all(['weights', 'exercises', 'checkins', 'reviews'].map(db.all));
  const last = weights[0];
  const first = weights.at(-1);
  const weekAgo = weights.find((w) => daysBetween(w.date, last?.date) >= 7);
  const diff = (a, b) => (a && b ? round1(a.weight - b.weight) : null);
  const sign = (d) => (d == null ? '—' : `<span class="${d > 0 ? 'up' : 'down'}">${d > 0 ? '+' : ''}${d}</span>`);
  const lastCk = checkins[0];
  const lastBf = checkins.find((c) => c.bf != null);
  const prevBf = checkins.filter((c) => c.bf != null)[1];
  const recentEx = exercises.slice(0, 4); // most recently updated

  v.innerHTML = `
    ${!localStorage.getItem('installed_hint') && !navigator.standalone ? `<div class="banner">📲 להתקנה באייפון: פתח בספארי ← כפתור שיתוף ← <b>"הוסף למסך הבית"</b>. <button class="btn sm ghost" id="hide-hint">הבנתי</button></div>` : ''}
    <div class="fab-row">
      <button class="btn" id="q-weight">+ שקילה</button>
      <button class="btn" id="q-ck">+ מעקב</button>
    </div>
    <div class="grid3" style="margin-bottom:14px">
      <div class="stat"><div class="v">${last ? last.weight : '—'}</div><div class="l">משקל אחרון (ק"ג)</div></div>
      <div class="stat"><div class="v">${sign(diff(last, weekAgo))}</div><div class="l">שינוי שבועי</div></div>
      <div class="stat"><div class="v">${lastBf ? `${lastBf.bf}%` : '—'}</div><div class="l">אחוז שומן${prevBf ? `<br>${diffSpan(lastBf.bf, prevBf.bf)}` : ''}</div></div>
    </div>
    <div class="card"><h3>מגמת משקל</h3>${lineChart(weights.slice(0, 60).map((w) => ({ x: w.date, y: w.weight })))}
      ${first && last && first !== last ? `<div class="muted small">שינוי כולל: ${sign(diff(last, first))} ק"ג</div>` : ''}</div>
    <div class="card">
      <div class="row between"><h3>📋 מעקב אחרון</h3><button class="btn sm ghost" id="q-all-ck">לכל המעקבים</button></div>
      ${lastCk ? `<div class="tap" id="q-last-ck">${checkinCard(lastCk, checkins[1]).replace('class="card tap"', 'class=""')}</div>` : '<div class="muted">עוד אין מעקבים. מעקב = תמונות + היקפים + קפלי עור לחישוב אחוז שומן.</div>'}
    </div>
    <div class="card">
      <div class="row between"><h3>🤖 סקירת AI אחרונה</h3>${reviews[0] ? `<span class="muted">${fmtDate(reviews[0].date)}</span>` : ''}</div>
      ${reviews[0] ? `<div class="md">${md(reviews[0].text.slice(0, 600))}${reviews[0].text.length > 600 ? '…' : ''}</div>` : `<div class="muted">פתח מעקב ולחץ "🤖 סקירת AI" לקבלת סקירה מותאמת אישית</div>`}
    </div>
    <div class="card">
      <div class="row between"><h3>🏋️ התרגילים שלי</h3><button class="btn sm ghost" id="q-all-ex">לכל התרגילים</button></div>
      ${recentEx.length ? `<ul class="list">${recentEx.map((e) => `<li class="tap" data-ex="${e.id}"><div class="row between"><b>${esc(e.name)}</b><span class="muted small">${fmtDate(e.date)}</span></div><div class="small">${setsSummary(e.sets)}</div></li>`).join('')}</ul>` : '<div class="muted">עוד לא הוספת תרגילים</div>'}
    </div>
  `;
  $('#hide-hint')?.addEventListener('click', () => {
    localStorage.setItem('installed_hint', '1');
    refresh();
  });
  $('#q-weight').onclick = () => editWeight();
  $('#q-ck').onclick = () => editCheckin({}, lastCk);
  $('#q-all-ck').onclick = () => go('checkins');
  $('#q-last-ck')?.addEventListener('click', () => viewCheckin(lastCk.id));
  $('#q-all-ex').onclick = () => go('exercises');
  $$('[data-ex]', v).forEach((li) => (li.onclick = async () => editExercise(await db.get('exercises', li.dataset.ex))));
};

// ---------- WEIGHT ----------
views.weight = async (v) => {
  const weights = await db.all('weights');
  const ws = weights.map((w) => w.weight);
  const avg7 = weights.filter((w) => daysBetween(w.date, today()) < 7);
  v.innerHTML = `
    <button class="btn block" id="add" style="margin-bottom:14px">+ שקילה חדשה</button>
    ${weights.length ? `<div class="grid3" style="margin-bottom:14px">
      <div class="stat"><div class="v">${Math.min(...ws)}</div><div class="l">מינימום</div></div>
      <div class="stat"><div class="v">${Math.max(...ws)}</div><div class="l">מקסימום</div></div>
      <div class="stat"><div class="v">${avg7.length ? round1(avg7.reduce((s, w) => s + w.weight, 0) / avg7.length) : '—'}</div><div class="l">ממוצע 7 ימים</div></div>
    </div>` : ''}
    <div class="card"><h3>משקל (ק"ג)</h3>${lineChart(weights.map((w) => ({ x: w.date, y: w.weight })))}</div>
    <div class="card"><h3>היסטוריה</h3>
      ${weights.length ? `<ul class="list">${weights.map((w, i) => {
        const prev = weights[i + 1];
        const d = prev ? round1(w.weight - prev.weight) : null;
        return `<li class="tap row between" data-id="${w.id}">
          <div><b>${w.weight} ק"ג</b> ${d != null ? `<span class="small ${d > 0 ? 'up' : 'down'}">(${d > 0 ? '+' : ''}${d})</span>` : ''}
          ${w.bodyFat ? `<span class="chip">${w.bodyFat}% שומן</span>` : ''}
          ${w.note ? `<div class="muted small">${esc(w.note)}</div>` : ''}</div>
          <span class="muted">${fmtDate(w.date)}</span></li>`;
      }).join('')}</ul>` : '<div class="empty">אין עדיין שקילות</div>'}
    </div>`;
  $('#add').onclick = () => editWeight();
  $$('[data-id]', v).forEach((li) => (li.onclick = async () => editWeight(await db.get('weights', li.dataset.id))));
};

function editWeight(item = {}) {
  openSheet(
    `<h2>${item.id ? 'עריכת שקילה' : 'שקילה חדשה'}</h2>
    <label>תאריך</label><input type="date" id="f-date" value="${item.date || today()}">
    <label>משקל (ק"ג)</label><input type="number" inputmode="decimal" step="0.1" id="f-w" value="${item.weight ?? ''}">
    <label>הערה</label><textarea id="f-note" placeholder="לדוגמה: בבוקר, אחרי שירותים">${esc(item.note)}</textarea>
    <div class="row" style="margin-top:16px">
      <button class="btn" style="flex:1" id="save">שמירה</button>
      ${item.id ? '<button class="btn danger" id="del">מחיקה</button>' : ''}
      <button class="btn ghost" id="cancel">ביטול</button>
    </div>`,
    (root) => {
      if (!item.id) setTimeout(() => $('#f-w', root).focus(), 50);
      $('#cancel', root).onclick = closeSheet;
      $('#save', root).onclick = async () => {
        const weight = num($('#f-w', root).value);
        if (!weight) return toast('הכנס משקל');
        await db.put('weights', { ...item, date: $('#f-date', root).value || today(), weight, note: $('#f-note', root).value.trim() });
        closeSheet();
        toast('נשמר ✓');
        refresh();
      };
      $('#del', root)?.addEventListener('click', async () => {
        if (!confirm('למחוק את השקילה?')) return;
        await db.remove('weights', item.id);
        closeSheet();
        refresh();
      });
    }
  );
}

// ---------- CHECK-INS (מעקבים) ----------
// { date, weight, age, circ: {navel, chest, thigh}, skin: {chest, abdomen, thigh}, bf, notes, photos: {front, side, back} }
const POSES = [['front', 'חזית'], ['side', 'צד'], ['back', 'גב']];
const CIRC = [['navel', 'טבור'], ['chest', 'חזה'], ['thigh', 'ירך']];
const SKIN = [['chest', 'חזה'], ['abdomen', 'בטן'], ['thigh', 'ירך']];

/**
 * Body-fat % from 3 skinfolds (chest, abdomen, thigh, in mm).
 * Jackson & Pollock 3-site (men) → body density, then Siri equation.
 */
function bodyFat(skin = {}, age) {
  const vals = SKIN.map(([k]) => skin[k]);
  if (vals.some((v) => !v) || !age) return null;
  const s = vals.reduce((a, b) => a + b, 0);
  const bd = 1.10938 - 0.0008267 * s + 0.0000016 * s * s - 0.0002574 * age;
  const bf = 495 / bd - 450;
  return Number.isFinite(bf) ? round1(Math.max(bf, 0)) : null;
}

const diffSpan = (cur, prev, { invert = false } = {}) => {
  if (cur == null || prev == null) return '';
  const d = round1(cur - prev);
  if (!d) return '';
  // For body measurements, down is usually good (green); invert flips it.
  const good = invert ? d > 0 : d < 0;
  return ` <span class="${good ? 'down' : 'up'}">${d > 0 ? '+' : ''}${d}</span>`;
};

// Full-screen photo viewer; tap anywhere to close.
function lightbox(src) {
  const el = document.createElement('div');
  el.className = 'lightbox';
  el.innerHTML = `<img src="${src}" alt="">`;
  el.onclick = () => el.remove();
  sheet.appendChild(el); // inside the <dialog> so it stays above the modal
}

const photoCount = (c) => POSES.filter(([k]) => c.photos?.[k]).length;

views.checkins = async (v) => {
  const [checkins, reviews] = await Promise.all([db.all('checkins'), db.all('reviews')]);
  const tab = views.checkins.tab || 'list';
  v.innerHTML = `
    <div class="seg"><button data-s="list" class="${tab === 'list' ? 'active' : ''}">מעקבים (${checkins.length})</button><button data-s="reviews" class="${tab === 'reviews' ? 'active' : ''}">סקירות AI (${reviews.length})</button></div>
    <div id="sub"></div>`;
  $$('.seg button', v).forEach((b) => (b.onclick = () => ((views.checkins.tab = b.dataset.s), refresh())));
  const sub = $('#sub', v);

  if (tab === 'reviews') {
    sub.innerHTML = reviews.length
      ? reviews.map((r) => `<div class="card"><div class="row between"><h3>🤖 ${fmtDate(r.date)}</h3><button class="x" data-del="${r.id}">🗑</button></div>
          ${r.question ? `<div class="muted small">שאלה: ${esc(r.question)}</div>` : ''}
          <div class="md">${md(r.text)}</div></div>`).join('')
      : '<div class="empty">אין עדיין סקירות.<br>פתח מעקב ולחץ "🤖 סקירת AI".</div>';
    $$('[data-del]', sub).forEach((b) => (b.onclick = async () => {
      if (!confirm('למחוק את הסקירה?')) return;
      await db.remove('reviews', b.dataset.del);
      refresh();
    }));
    return;
  }

  const last = checkins[0];
  const prev = checkins[1];
  const metric = views.checkins.metric || 'bf';
  const METRICS = [['bf', 'אחוז שומן', (c) => c.bf, '%'], ['weight', 'משקל', (c) => c.weight, 'ק"ג'], ...CIRC.map(([k, l]) => [k, `היקף ${l}`, (c) => c.circ?.[k], 'ס"מ'])];
  const [, , getter, unit] = METRICS.find((m) => m[0] === metric);

  sub.innerHTML = `
    <button class="btn block" id="add" style="margin-bottom:14px">+ מעקב חדש</button>
    ${last ? `<div class="grid3" style="margin-bottom:14px">
      <div class="stat"><div class="v">${last.bf != null ? `${last.bf}%` : '—'}</div><div class="l">אחוז שומן${prev?.bf != null && last.bf != null ? `<br>${diffSpan(last.bf, prev.bf)}` : ''}</div></div>
      <div class="stat"><div class="v">${last.circ?.navel ?? '—'}</div><div class="l">היקף טבור${prev ? `<br>${diffSpan(last.circ?.navel, prev.circ?.navel)}` : ''}</div></div>
      <div class="stat"><div class="v">${last.weight ?? '—'}</div><div class="l">משקל${prev ? `<br>${diffSpan(last.weight, prev.weight)}` : ''}</div></div>
    </div>
    <div class="card">
      <div class="row between"><h3>גרף</h3>
        <select id="metric" style="width:auto">${METRICS.map(([k, l]) => `<option value="${k}" ${k === metric ? 'selected' : ''}>${l}</option>`).join('')}</select>
      </div>
      ${lineChart(checkins.map((c) => ({ x: c.date, y: getter(c) ?? null })), { unit })}
    </div>` : ''}
    ${checkins.length ? checkins.map((c, i) => checkinCard(c, checkins[i + 1])).join('') : `<div class="empty">עוד אין מעקבים.<br>כל מעקב כולל תמונות (חזית, צד, גב), היקפים (טבור, חזה, ירך) וקפלי עור לחישוב אחוז שומן.</div>`}`;

  $('#add', sub).onclick = () => editCheckin({}, last);
  $('#metric', sub)?.addEventListener('change', (e) => ((views.checkins.metric = e.target.value), refresh()));
  $$('.card[data-id]', sub).forEach((el) => (el.onclick = () => viewCheckin(el.dataset.id)));
};

function checkinCard(c, prev) {
  return `<div class="card tap" data-id="${c.id}">
    <div class="row between"><h3 style="margin:0">${fmtDate(c.date)}</h3>${c.bf != null ? `<span class="chip" style="font-size:14px;color:var(--text)"><b>${c.bf}%</b> שומן${diffSpan(c.bf, prev?.bf)}</span>` : ''}</div>
    ${photoCount(c) ? `<div class="thumbs">${POSES.map(([k]) => (c.photos?.[k] ? `<img src="${blobURL(c.photos[k])}" alt="">` : '<div></div>')).join('')}</div>` : ''}
    <div style="margin-top:6px">
      ${c.weight != null ? `<span class="chip">משקל: ${c.weight}${diffSpan(c.weight, prev?.weight)}</span>` : ''}
      ${CIRC.filter(([k]) => c.circ?.[k]).map(([k, l]) => `<span class="chip">${l}: ${c.circ[k]}${diffSpan(c.circ[k], prev?.circ?.[k])}</span>`).join('')}
    </div>
    ${c.notes ? `<div class="muted small" style="margin-top:4px">📝 ${esc(c.notes)}</div>` : ''}
  </div>`;
}

async function viewCheckin(id) {
  const checkins = await db.all('checkins');
  const i = checkins.findIndex((c) => c.id === id);
  const c = checkins[i];
  const prev = checkins[i + 1];
  if (!c) return;
  const reviews = (await db.all('reviews')).filter((r) => r.checkinId === c.id);
  const compare = viewCheckin.compare && prev && photoCount(prev);
  const row = (label, cur, old, u = '') =>
    cur == null && old == null ? '' : `<tr><td>${label}</td><td><b>${cur ?? '—'}</b>${u}</td><td class="muted">${old ?? '—'}</td><td>${diffSpan(cur, old)}</td></tr>`;

  openSheet(
    `<div class="row between"><h2 style="margin:0">מעקב · ${fmtDate(c.date)}</h2>${prev ? `<span class="muted small">${daysBetween(prev.date, c.date)} ימים מהקודם</span>` : ''}</div>
    ${photoCount(c) ? `
      ${prev && photoCount(prev) ? `<div class="seg" style="margin:12px 0 8px"><button id="c-off" class="${compare ? '' : 'active'}">תמונות</button><button id="c-on" class="${compare ? 'active' : ''}">↔️ השוואה למעקב קודם</button></div>` : '<div style="height:12px"></div>'}
      ${compare
        ? POSES.filter(([k]) => c.photos?.[k] || prev.photos?.[k]).map(([k, l]) => `<div class="muted small" style="margin-top:6px">${l}</div><div class="compare">
            <div>${prev.photos?.[k] ? `<img class="zoom" src="${blobURL(prev.photos[k])}">` : '<div class="slot"></div>'}<div class="muted small">${fmtDate(prev.date)}</div></div>
            <div>${c.photos?.[k] ? `<img class="zoom" src="${blobURL(c.photos[k])}">` : '<div class="slot"></div>'}<div class="muted small">${fmtDate(c.date)}</div></div></div>`).join('')
        : `<div class="thumbs big">${POSES.map(([k, l]) => (c.photos?.[k] ? `<div><img class="zoom" src="${blobURL(c.photos[k])}"><div class="muted small">${l}</div></div>` : '')).join('')}</div>`}` : ''}
    <table class="tbl">
      <tr class="muted small"><td></td><td>עכשיו</td><td>קודם</td><td>שינוי</td></tr>
      ${row('אחוז שומן', c.bf, prev?.bf, '%')}
      ${row('משקל', c.weight, prev?.weight)}
      ${CIRC.map(([k, l]) => row(`היקף ${l}`, c.circ?.[k], prev?.circ?.[k])).join('')}
      ${SKIN.map(([k, l]) => row(`קפל ${l} (מ"מ)`, c.skin?.[k], prev?.skin?.[k])).join('')}
    </table>
    ${c.bf != null && c.weight ? `<div class="muted small">מסת שומן ≈ ${round1((c.weight * c.bf) / 100)} ק"ג · מסה רזה ≈ ${round1(c.weight * (1 - c.bf / 100))} ק"ג</div>` : ''}
    ${c.notes ? `<div style="margin-top:8px">📝 ${esc(c.notes)}</div>` : ''}
    ${reviews.map((r) => `<div class="card" style="margin-top:12px;background:var(--card2)"><h3>🤖 סקירת AI · ${fmtDate(r.date)}</h3><div class="md">${md(r.text)}</div></div>`).join('')}
    <div class="row" style="margin-top:16px">
      <button class="btn" style="flex:1" id="ai">🤖 סקירת AI</button>
      <button class="btn ghost" id="edit">✎ עריכה</button>
      <button class="btn ghost" id="close">סגירה</button>
    </div>`,
    (root) => {
      $('#c-on', root)?.addEventListener('click', () => ((viewCheckin.compare = true), viewCheckin(id)));
      $('#c-off', root)?.addEventListener('click', () => ((viewCheckin.compare = false), viewCheckin(id)));
      $$('.zoom', root).forEach((img) => (img.onclick = () => lightbox(img.src)));
      $('#close', root).onclick = closeSheet;
      $('#edit', root).onclick = () => editCheckin(c, prev);
      $('#ai', root).onclick = () => startReview(c, prev);
    }
  );
}

function slotHTML(pose, label, blob) {
  return `<div class="slot ${blob ? 'has' : ''}" data-pose="${pose}">
    ${blob ? `<img src="${blobURL(blob)}" alt=""><button class="x rm" type="button" data-pose="${pose}">✕</button>` : `<span>📷</span>`}
    <div class="lbl">${label}</div>
    <input type="file" accept="image/*" hidden data-pose="${pose}">
  </div>`;
}

async function editCheckin(item = {}, last) {
  const isNew = !item.id;
  const p = profile();
  const lastWeight = (await db.all('weights'))[0]?.weight;
  const photos = { ...(item.photos || {}) };
  const age = item.age ?? p.age ?? '';

  openSheet(
    `<h2>${isNew ? 'מעקב חדש' : `עריכת מעקב · ${fmtDate(item.date)}`}</h2>
    <div class="grid2">
      <div><label>תאריך</label><input type="date" id="f-date" value="${item.date || today()}"></div>
      <div><label>משקל (ק"ג)</label><input type="number" inputmode="decimal" step="0.1" id="f-w" value="${item.weight ?? ''}" placeholder="${lastWeight ?? ''}"></div>
    </div>

    <h3 style="margin:16px 0 8px">📸 תמונות</h3>
    <div class="slots">${POSES.map(([k, l]) => slotHTML(k, l, photos[k])).join('')}</div>

    <h3 style="margin:16px 0 4px">📏 היקפים <span class="muted small">(ס"מ)</span></h3>
    <div class="grid3">${CIRC.map(([k, l]) => `<div><label>${l}</label><input type="number" inputmode="decimal" step="0.1" data-circ="${k}" value="${item.circ?.[k] ?? ''}" placeholder="${last?.circ?.[k] ?? ''}"></div>`).join('')}</div>

    <h3 style="margin:16px 0 4px">📐 קפלי עור (קליפר) <span class="muted small">(מ"מ)</span></h3>
    <div class="grid3">${SKIN.map(([k, l]) => `<div><label>${l}</label><input type="number" inputmode="decimal" step="0.5" data-skin="${k}" value="${item.skin?.[k] ?? ''}" placeholder="${last?.skin?.[k] ?? ''}"></div>`).join('')}</div>
    <div class="grid2" style="align-items:end">
      <div><label>גיל (לחישוב)</label><input type="number" inputmode="numeric" id="f-age" value="${age}"></div>
      <div class="stat" style="text-align:center"><div class="v" id="bf-out">—</div><div class="l">אחוז שומן מחושב</div></div>
    </div>
    <div class="muted small" style="margin-top:6px">נוסחת Jackson-Pollock (3 קפלים: חזה, בטן, ירך).${p.sex === 'נקבה' ? ' <b>שים לב:</b> הנוסחה עם הקפלים האלה מיועדת לגברים.' : ''}</div>

    <label>הערות</label><textarea id="f-notes" placeholder="לדוגמה: בוקר, בצום">${esc(item.notes)}</textarea>
    ${last && isNew ? '<div class="muted small">הערכים האפורים הם מהמעקב הקודם</div>' : ''}
    <div class="row" style="margin-top:16px">
      <button class="btn" style="flex:1" id="save">שמירה</button>
      ${!isNew ? '<button class="btn danger" id="del">מחיקה</button>' : ''}
      <button class="btn ghost" id="cancel">ביטול</button>
    </div>`,
    (root) => {
      const readSkin = () => Object.fromEntries($$('[data-skin]', root).map((i) => [i.dataset.skin, num(i.value)]));
      const updateBF = () => {
        const bf = bodyFat(readSkin(), num($('#f-age', root).value));
        $('#bf-out', root).textContent = bf != null ? `${bf}%` : '—';
      };
      root.addEventListener('input', (e) => (e.target.dataset.skin || e.target.id === 'f-age') && updateBF());
      updateBF();

      // Photo slots: tap to pick (camera or library), ✕ to remove.
      const slots = $('.slots', root);
      const label = (pose) => POSES.find(([k]) => k === pose)[1];
      const redraw = (pose) => {
        const el = $(`.slot[data-pose="${pose}"]`, slots);
        el.outerHTML = slotHTML(pose, label(pose), photos[pose]);
      };
      slots.addEventListener('click', (e) => {
        const rm = e.target.closest('.rm');
        if (rm) {
          e.stopPropagation();
          delete photos[rm.dataset.pose];
          return redraw(rm.dataset.pose);
        }
        const slot = e.target.closest('.slot');
        if (slot) $('input[type=file]', slot).click();
      });
      slots.addEventListener('change', async (e) => {
        const f = e.target.files?.[0];
        if (!f) return;
        const pose = e.target.dataset.pose;
        photos[pose] = await compressImage(f);
        redraw(pose);
      });

      $('#cancel', root).onclick = closeSheet;
      $('#save', root).onclick = async () => {
        const circ = Object.fromEntries($$('[data-circ]', root).map((i) => [i.dataset.circ, num(i.value)]));
        const skin = readSkin();
        const ageV = num($('#f-age', root).value);
        const weight = num($('#f-w', root).value);
        const hasData = weight || Object.values(circ).some(Boolean) || Object.values(skin).some(Boolean) || Object.keys(photos).length;
        if (!hasData) return toast('הוסף לפחות תמונה או מדידה אחת');
        const date = $('#f-date', root).value || today();
        const obj = { ...item, date, weight, age: ageV, circ, skin, bf: bodyFat(skin, ageV), notes: $('#f-notes', root).value.trim(), photos };
        await db.put('checkins', obj);
        if (ageV && !p.age) setProfile({ ...p, age: ageV });
        // Keep the weight log in sync: add the weight if there's no weigh-in for that day.
        if (weight && !(await db.all('weights')).some((w) => w.date === date)) await db.put('weights', { date, weight, note: 'ממעקב' });
        closeSheet();
        toast('המעקב נשמר ✓');
        if (current === 'checkins') refresh();
        else go('checkins');
      };
      $('#del', root)?.addEventListener('click', async () => {
        if (!confirm('למחוק את המעקב (כולל התמונות)?')) return;
        await db.remove('checkins', item.id);
        closeSheet();
        refresh();
      });
    }
  );
}

async function buildContext() {
  const [weights, checkins, exercises] = await Promise.all(['weights', 'checkins', 'exercises'].map(db.all));
  const p = profile();
  const lines = [];
  const prof = [p.sex && `מין: ${p.sex}`, p.age && `גיל: ${p.age}`, p.height && `גובה: ${p.height} ס"מ`, p.goal && `מטרה: ${p.goal}`, p.target && `יעד משקל: ${p.target} ק"ג`].filter(Boolean);
  if (prof.length) lines.push('פרופיל: ' + prof.join(', '));
  if (checkins.length) {
    lines.push('מעקבים (היקפים בס"מ, קפלי עור במ"מ, אחוז שומן לפי Jackson-Pollock 3):');
    checkins.slice(0, 6).forEach((c) =>
      lines.push(
        `- ${c.date}: ` +
          [
            c.weight && `משקל ${c.weight}`,
            c.bf != null && `שומן ${c.bf}%`,
            ...CIRC.filter(([k]) => c.circ?.[k]).map(([k, l]) => `היקף ${l} ${c.circ[k]}`),
            ...SKIN.filter(([k]) => c.skin?.[k]).map(([k, l]) => `קפל ${l} ${c.skin[k]}`),
            c.notes && `הערה: ${c.notes}`,
          ].filter(Boolean).join(', ')
      )
    );
  }
  if (weights.length) {
    lines.push('שקילות אחרונות (תאריך: ק"ג):');
    weights.slice(0, 15).forEach((w) => lines.push(`- ${w.date}: ${w.weight}${w.note ? ` — ${w.note}` : ''}`));
    if (weights.length > 15) lines.push(`- השקילה הראשונה: ${weights.at(-1).date}: ${weights.at(-1).weight}`);
  }
  if (exercises.length) {
    lines.push('התרגילים שלי (משקל×חזרות לכל סט):');
    exercises.forEach((e) => {
      const sets = (e.sets || []).map((x) => `${x.w ?? '-'}×${x.r ?? '-'}`).join(', ');
      const old = e.history?.length ? ` (לפני ${e.history.at(-1).date}: ${(e.history.at(-1).sets || []).map((x) => `${x.w ?? '-'}×${x.r ?? '-'}`).join(', ')})` : '';
      lines.push(`- ${e.name}: ${sets}${old}${e.notes ? ` — ${e.notes}` : ''}`);
    });
  }
  return lines.join('\n') || 'אין נתונים נוספים.';
}

async function startReview(c, prev) {
  const ai = await import('./ai.js').catch(() => null);
  if (!ai) return toast('לא ניתן לטעון את מודול ה-AI (בדוק חיבור לאינטרנט)');
  if (!ai.getKey()) {
    toast('קודם צריך להגדיר מפתח API');
    closeSheet();
    return go('settings');
  }
  // Previous check-in's photos first (older → newer), so the model can compare.
  const imgs = [];
  for (const ck of [prev, c].filter(Boolean))
    for (const [k, l] of POSES) if (ck.photos?.[k]) imgs.push({ blob: ck.photos[k], label: `${ck.date}, ${l}${ck === c ? ' (נוכחי)' : ' (מעקב קודם)'}` });

  openSheet(
    `<h2>🤖 סקירת AI · ${fmtDate(c.date)}</h2>
    <div class="muted">${imgs.length ? `${imgs.length} תמונות${prev && photoCount(prev) ? ' (כולל המעקב הקודם להשוואה)' : ''}` : 'בלי תמונות'} · יחד עם ההיקפים, אחוזי השומן, השקילות והתרגילים</div>
    <label>שאלה או בקשה נוספת (לא חובה)</label>
    <textarea id="f-q" placeholder="לדוגמה: אני בחיטוב, האם אני בכיוון? על מה כדאי לי להתמקד?"></textarea>
    <div id="out" style="margin-top:12px"></div>
    <div class="row" style="margin-top:14px">
      <button class="btn" style="flex:1" id="go">שליחה לסקירה</button>
      <button class="btn ghost" id="cancel">חזרה</button>
    </div>`,
    (root) => {
      $('#cancel', root).onclick = () => viewCheckin(c.id);
      $('#go', root).onclick = async () => {
        const btn = $('#go', root);
        const out = $('#out', root);
        btn.disabled = true;
        out.innerHTML = '<span class="spinner"></span> מנתח... (עשוי לקחת עד דקה)';
        try {
          const question = $('#f-q', root).value.trim();
          const text = await ai.reviewProgress(imgs, await buildContext(), question);
          await db.put('reviews', { date: today(), checkinId: c.id, question, text });
          out.innerHTML = `<div class="card md">${md(text)}</div>`;
          btn.textContent = 'נשמר ✓';
          sheet.addEventListener('close', refresh, { once: true });
        } catch (err) {
          console.error(err);
          out.innerHTML = `<div class="banner" style="border-color:var(--danger)">${esc(ai.friendlyError(err))}</div>`;
          btn.disabled = false;
        }
      };
    }
  );
}

// One-time move of data from the old "measurements" / "photos" screens into check-ins.
async function migrateToCheckins() {
  if (localStorage.getItem('migrated_checkins')) return;
  const [measurements, photos] = await Promise.all([db.all('measurements'), db.all('photos')]);
  const byDate = {};
  const get = (date) => (byDate[date] ||= { date, circ: {}, skin: {}, photos: {}, notes: '' });
  for (const m of measurements) {
    const c = get(m.date);
    c.circ = { navel: m.belly ?? m.waist ?? null, chest: m.chest ?? null, thigh: m.thigh ?? null };
    if (m.note) c.notes = m.note;
  }
  for (const ph of photos) {
    const c = get(ph.date);
    const pose = ['front', 'side', 'back'].includes(ph.pose) && !c.photos[ph.pose] ? ph.pose : ['front', 'side', 'back'].find((k) => !c.photos[k]);
    if (pose) c.photos[pose] = ph.blob;
  }
  for (const c of Object.values(byDate)) await db.put('checkins', c);
  localStorage.setItem('migrated_checkins', '1');
}

// ---------- EXERCISES ----------
// Each exercise: { name, sets: [{w, r}], notes, history: [{date, sets}] }

function setsSummary(sets = []) {
  const s = sets.filter((x) => x.w != null || x.r != null);
  if (!s.length) return '';
  const key = (x) => `${x.w ?? ''}|${x.r ?? ''}`;
  if (s.every((x) => key(x) === key(s[0])))
    return `<span><b>${s.length}</b> סטים × <b class="ltr">${esc(s[0].r ?? '-')}</b> חזרות${s[0].w != null ? ` · <b>${s[0].w}</b> ק"ג` : ''}</span>`;
  // Each set is its own LTR island so long lists wrap cleanly in RTL.
  return `<span>${s.length} סטים: ${s.map((x) => `<span class="ltr">${x.w ?? '-'}×${esc(x.r ?? '-')}</span>`).join(' · ')}</span>`;
}
const maxWeight = (sets = []) => Math.max(0, ...sets.map((s) => s.w || 0)) || null;
const sameSets = (a = [], b = []) => JSON.stringify(a) === JSON.stringify(b);

// Exercises are shown in a user-defined order (▲▼).
const orderKey = (e) => e.order ?? e.createdAt ?? 0;
const loadExercises = async () => (await db.all('exercises')).sort((a, b) => orderKey(a) - orderKey(b));

views.exercises = async (v) => {
  const exercises = await loadExercises();
  const totalSets = exercises.reduce((t, e) => t + (e.sets?.length || 0), 0);
  v.innerHTML = `
    ${exercises.length ? `<div class="muted small" style="text-align:center;margin-bottom:10px">${exercises.length} תרגילים · ${totalSets} סטים</div>` : ''}
    ${exercises.map((e, i) => `<div class="card tap" data-id="${e.id}">
        <div class="row between">
          <b style="font-size:17px"><span class="muted">${i + 1}.</span> ${esc(e.name)}</b>
          <span class="row" style="gap:4px">
            <button class="btn sm ghost mv" data-mv="-1" data-i="${i}" ${i === 0 ? 'disabled' : ''} aria-label="למעלה">▲</button>
            <button class="btn sm ghost mv" data-mv="1" data-i="${i}" ${i === exercises.length - 1 ? 'disabled' : ''} aria-label="למטה">▼</button>
          </span>
        </div>
        <div style="margin-top:4px">${setsSummary(e.sets) || '<span class="muted small">לא הוגדרו סטים</span>'}</div>
        ${e.history?.length ? `<div class="muted small" style="margin-top:2px">📈 עודכן ${fmtDate(e.date)}</div>` : ''}
        ${e.notes ? `<div class="muted small" style="margin-top:4px">📝 ${esc(e.notes)}</div>` : ''}
      </div>`).join('')}
    ${exercises.length ? '' : '<div class="empty">עוד אין תרגילים.<br>הוסף את התרגילים שלך — סטים, משקל וחזרות.</div>'}
    <button class="btn ${exercises.length ? 'ghost' : ''} block" id="add">+ הוסף תרגיל</button>`;

  $('#add').onclick = () => editExercise();
  $$('.mv', v).forEach((b) =>
    b.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      const i = +b.dataset.i;
      const j = i + +b.dataset.mv;
      const [a, c] = [exercises[i], exercises[j]];
      // Normalise order values first so swapping is always well-defined.
      exercises.forEach((e, k) => (e.order = k));
      [a.order, c.order] = [c.order, a.order];
      for (const e of exercises) await db.put('exercises', e);
      refresh();
    })
  );
  $$('.card[data-id]', v).forEach((c) => (c.onclick = async () => editExercise(await db.get('exercises', c.dataset.id))));
};

const setRowHTML = (s = {}, i = 0) => `<div class="set-row">
  <span class="n">${i + 1}</span>
  <input type="number" inputmode="decimal" step="0.5" class="s-w" value="${s.w ?? ''}" placeholder="ק&quot;ג">
  <input inputmode="numeric" class="s-r" value="${esc(s.r ?? '')}" placeholder="חזרות" dir="ltr" style="text-align:center">
  <button class="x del-set" type="button">✕</button></div>`;

async function editExercise(item = {}, after) {
  const isNew = !item.id;
  const all = await db.all('exercises');
  const sets = item.sets?.length ? item.sets : [{}, {}, {}];
  const hist = [...(item.history || []), ...(isNew ? [] : [{ date: item.date, sets: item.sets }])];

  openSheet(
    `<h2>${isNew ? 'תרגיל חדש' : esc(item.name)}</h2>
    <label>שם התרגיל</label><input id="f-name" value="${esc(item.name)}" placeholder="לדוגמה: לחיצת חזה במוט">

    <h3 style="margin:16px 0 8px">סטים</h3>
    <div class="ex-block">
      <div class="set-head"><span>#</span><span>משקל (ק"ג)</span><span>חזרות</span><span></span></div>
      <div class="sets">${sets.map(setRowHTML).join('')}</div>
      <div class="row wrap" style="margin-top:6px">
        <button class="btn sm ghost" id="add-set" type="button">+ סט</button>
        <button class="btn sm ghost" id="dup-set" type="button">⧉ שכפל סט אחרון</button>
      </div>
      <div class="muted small" style="margin-top:6px">בחזרות אפשר לכתוב גם טווח (8-12) או זמן (30s).</div>
    </div>

    <label>הערות (טכניקה, הגדרות מכונה, תחושה...)</label><textarea id="f-notes">${esc(item.notes)}</textarea>

    ${hist.length > 1 ? `<div class="card" style="margin-top:14px;background:var(--card2)"><h3>📈 היסטוריית שינויים</h3>
      ${lineChart(hist.map((h) => ({ x: h.date, y: maxWeight(h.sets) })), { unit: 'משקל מקסימלי (ק"ג)' })}
      <ul class="list">${hist.slice().reverse().slice(0, 12).map((h) => `<li class="row between"><span class="muted">${fmtDate(h.date)}</span><span class="small">${setsSummary(h.sets)}</span></li>`).join('')}</ul></div>` : ''}

    <div class="row" style="margin-top:16px">
      <button class="btn" style="flex:1" id="save">שמירה</button>
      ${!isNew ? '<button class="btn danger" id="del">מחיקה</button>' : ''}
      <button class="btn ghost" id="cancel">ביטול</button>
    </div>
    ${!isNew ? '<div class="muted small" style="margin-top:8px">כשמשנים משקל/חזרות, הגרסה הקודמת נשמרת בהיסטוריה.</div>' : ''}`,
    (root) => {
      const wrap = $('.sets', root);
      const renumber = () => $$('.set-row .n', wrap).forEach((n, i) => (n.textContent = i + 1));
      $('#add-set', root).onclick = () => wrap.insertAdjacentHTML('beforeend', setRowHTML({}, $$('.set-row', wrap).length));
      $('#dup-set', root).onclick = () => {
        const last = $$('.set-row', wrap).at(-1);
        wrap.insertAdjacentHTML('beforeend', setRowHTML(last ? { w: $('.s-w', last).value, r: $('.s-r', last).value } : {}, $$('.set-row', wrap).length));
      };
      wrap.addEventListener('click', (e) => {
        if (e.target.classList.contains('del-set')) {
          e.target.closest('.set-row').remove();
          renumber();
        }
      });
      $('#cancel', root).onclick = () => (after ? after() : closeSheet());
      $('#save', root).onclick = async () => {
        const name = $('#f-name', root).value.trim();
        if (!name) return toast('הכנס שם תרגיל');
        if (all.some((e) => e.name === name && e.id !== item.id)) return toast('כבר קיים תרגיל בשם הזה');
        const newSets = $$('.set-row', wrap)
          .map((r) => {
            const rv = $('.s-r', r).value.trim();
            return { w: num($('.s-w', r).value), r: rv === '' ? null : /^\d+$/.test(rv) ? +rv : rv };
          })
          .filter((s) => s.w != null || s.r != null);
        const obj = {
          ...item,
          name,
          notes: $('#f-notes', root).value.trim(),
          sets: newSets,
          history: item.history || [],
        };
        for (const k of ['group', 'day', 'rest', 'link']) delete obj[k];
        if (isNew) obj.order = all.length ? Math.max(...all.map(orderKey)) + 1 : 0;
        // Keep the previous version when sets/weights change.
        // (Several edits on the same day count as one version.)
        if (!isNew && !sameSets(item.sets, newSets) && item.date !== today()) {
          obj.history = [...obj.history, { date: item.date, sets: item.sets }];
        }
        if (!isNew && !sameSets(item.sets, newSets)) obj.date = today();
        await db.put('exercises', obj);
        closeSheet();
        toast('נשמר ✓');
        if (after) after();
        else if (current === 'exercises') refresh();
        else go('exercises');
      };
      $('#del', root)?.addEventListener('click', async () => {
        if (!confirm('למחוק את התרגיל?')) return;
        await db.remove('exercises', item.id);
        closeSheet();
        refresh();
        if (after) after();
      });
      if (isNew) setTimeout(() => $('#f-name', root).focus(), 50);
    }
  );
}

// ---------- SETTINGS ----------
views.settings = async (v) => {
  const p = profile();
  const key = localStorage.getItem('openai_key') || '';
  const model = localStorage.getItem('openai_model') || '';
  let usage = '';
  try {
    const est = await navigator.storage?.estimate?.();
    if (est) usage = `${(est.usage / 1048576).toFixed(1)} MB בשימוש`;
  } catch {}
  v.innerHTML = `
    <div class="card"><h3>פרופיל (משמש לסקירת AI)</h3>
      <div class="grid2">
        <div><label>מין</label><select id="p-sex"><option value=""></option>${['זכר', 'נקבה'].map((s) => `<option ${p.sex === s ? 'selected' : ''}>${s}</option>`).join('')}</select></div>
        <div><label>גיל</label><input type="number" inputmode="numeric" id="p-age" value="${p.age ?? ''}"></div>
        <div><label>גובה (ס"מ)</label><input type="number" inputmode="numeric" id="p-height" value="${p.height ?? ''}"></div>
        <div><label>יעד משקל (ק"ג)</label><input type="number" inputmode="decimal" id="p-target" value="${p.target ?? ''}"></div>
      </div>
      <label>מטרה</label><input id="p-goal" value="${esc(p.goal)}" placeholder="לדוגמה: חיטוב, עלייה במסת שריר, כוח">
      <button class="btn block" style="margin-top:12px" id="p-save">שמירת פרופיל</button>
    </div>
    <div class="card"><h3>🤖 OpenAI API</h3>
      <div class="muted small">לסקירות AI צריך מפתח API מ-<b>platform.openai.com</b> (תשלום לפי שימוש). המפתח נשמר רק במכשיר הזה ונשלח ישירות ל-OpenAI.</div>
      <label>API Key</label><input id="k" type="password" autocomplete="off" dir="ltr" value="${esc(key)}" placeholder="sk-...">
      <label>מודל</label><input id="m" dir="ltr" list="models" value="${esc(model)}" placeholder="gpt-5.5">
      <datalist id="models">${['gpt-5.5', 'gpt-5.5-pro', 'gpt-5.4-mini', 'gpt-5.2', 'gpt-5.1', 'gpt-5', 'gpt-5-mini'].map((m) => `<option value="${m}">`).join('')}</datalist>
      <div class="muted small">ברירת מחדל: gpt-5.5. אפשר לשנות לכל מודל עם תמיכה בתמונות שזמין בחשבון שלך.</div>
      <div class="row" style="margin-top:10px"><button class="btn" style="flex:1" id="k-save">שמירה</button>${key ? '<button class="btn danger" id="k-del">הסרת מפתח</button>' : ''}</div>
    </div>
    <div class="card"><h3>💾 גיבוי ושחזור</h3>
      <div class="muted small">כל הנתונים נשמרים מקומית במכשיר (${usage || 'IndexedDB'}). מומלץ לייצא גיבוי מדי פעם — כולל תמונות.</div>
      <div class="row" style="margin-top:10px"><button class="btn ghost" style="flex:1" id="exp">ייצוא גיבוי</button><button class="btn ghost" style="flex:1" id="imp">ייבוא גיבוי</button></div>
      <input type="file" id="imp-file" accept="application/json,.json" hidden>
    </div>
    <div class="card"><h3>📲 התקנה באייפון</h3>
      <ol class="muted small" style="padding-inline-start:18px;margin:0">
        <li>פתח את האתר ב-<b>Safari</b></li><li>לחץ על כפתור השיתוף (ריבוע עם חץ)</li><li>בחר <b>"הוסף למסך הבית"</b></li>
      </ol>
    </div>
    <div class="muted small" style="text-align:center">גרסה 1.2</div>`;

  $('#p-save').onclick = () => {
    setProfile({ sex: $('#p-sex').value, age: num($('#p-age').value), height: num($('#p-height').value), target: num($('#p-target').value), goal: $('#p-goal').value.trim() });
    toast('נשמר ✓');
  };
  $('#k-save').onclick = () => {
    const k = $('#k').value.trim();
    if (!k.startsWith('sk-')) return toast('המפתח צריך להתחיל ב-sk-');
    localStorage.setItem('openai_key', k);
    const m = $('#m').value.trim();
    if (m) localStorage.setItem('openai_model', m);
    else localStorage.removeItem('openai_model');
    toast('נשמר ✓');
    refresh();
  };
  $('#k-del')?.addEventListener('click', () => {
    localStorage.removeItem('openai_key');
    refresh();
  });
  $('#exp').onclick = async () => {
    toast('מכין גיבוי...');
    const data = await db.exportAll();
    data.profile = profile();
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
    const file = new File([blob], `training-backup-${today()}.json`, { type: 'application/json' });
    if (navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: 'גיבוי יומן אימונים' });
        return;
      } catch (e) {
        if (e.name === 'AbortError') return;
      }
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = file.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  };
  $('#imp').onclick = () => $('#imp-file').click();
  $('#imp-file').onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const json = JSON.parse(await f.text());
      const replace = confirm('להחליף את כל הנתונים הקיימים? (ביטול = מיזוג עם הקיים)');
      await db.importAll(json, { replace });
      if (json.profile) setProfile(json.profile);
      toast('הגיבוי שוחזר ✓');
      refresh();
    } catch (err) {
      alert('שגיאה בייבוא: ' + err.message);
    }
  };
};

// ---------- Boot ----------
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
// Ask the browser not to evict our data.
navigator.storage?.persist?.().catch(() => {});
migrateToCheckins().catch(console.error).finally(() => go('home'));
