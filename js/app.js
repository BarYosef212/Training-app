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

// ---------- Measurements ----------
const MEASURES = [
  ['chest', 'חזה'],
  ['waist', 'מותניים'],
  ['belly', 'בטן (טבור)'],
  ['hips', 'ירכיים/אגן'],
  ['arm', 'זרוע'],
  ['thigh', 'ירך'],
  ['calf', 'שוק'],
  ['shoulders', 'כתפיים'],
  ['neck', 'צוואר'],
];
const POSES = { front: 'חזית', side: 'צד', back: 'גב', other: 'אחר' };

// ---------- Router ----------
const TITLES = { home: 'יומן אימונים', weight: 'שקילה', body: 'היקפים', photos: 'תמונות התקדמות', workouts: 'אימונים', settings: 'הגדרות' };
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
  const [weights, workouts, photos, measurements, reviews] = await Promise.all(
    ['weights', 'workouts', 'photos', 'measurements', 'reviews'].map(db.all)
  );
  const last = weights[0];
  const first = weights.at(-1);
  const weekAgo = weights.find((w) => daysBetween(w.date, last?.date) >= 7);
  const diff = (a, b) => (a && b ? round1(a.weight - b.weight) : null);
  const sign = (d) => (d == null ? '—' : `<span class="${d > 0 ? 'up' : 'down'}">${d > 0 ? '+' : ''}${d}</span>`);
  const thisWeek = workouts.filter((w) => daysBetween(w.date, today()) < 7).length;

  v.innerHTML = `
    ${!localStorage.getItem('installed_hint') && !navigator.standalone ? `<div class="banner">📲 להתקנה באייפון: פתח בספארי ← כפתור שיתוף ← <b>"הוסף למסך הבית"</b>. <button class="btn sm ghost" id="hide-hint">הבנתי</button></div>` : ''}
    <div class="fab-row">
      <button class="btn" id="q-weight">+ שקילה</button>
      <button class="btn" id="q-workout">+ אימון</button>
      <button class="btn ghost" id="q-photo">+ תמונה</button>
    </div>
    <div class="grid3" style="margin-bottom:14px">
      <div class="stat"><div class="v">${last ? last.weight : '—'}</div><div class="l">משקל אחרון (ק"ג)</div></div>
      <div class="stat"><div class="v">${sign(diff(last, weekAgo))}</div><div class="l">שינוי שבועי</div></div>
      <div class="stat"><div class="v">${sign(diff(last, first))}</div><div class="l">שינוי כולל</div></div>
    </div>
    <div class="card"><h3>מגמת משקל</h3>${lineChart(weights.slice(0, 60).map((w) => ({ x: w.date, y: w.weight })))}</div>
    <div class="grid3" style="margin-bottom:14px">
      <div class="stat"><div class="v">${thisWeek}</div><div class="l">אימונים ב-7 ימים</div></div>
      <div class="stat"><div class="v">${workouts.length}</div><div class="l">סה"כ אימונים</div></div>
      <div class="stat"><div class="v">${photos.length}</div><div class="l">תמונות</div></div>
    </div>
    <div class="card">
      <div class="row between"><h3>אימון אחרון</h3>${workouts[0] ? `<span class="muted">${fmtDate(workouts[0].date)}</span>` : ''}</div>
      ${workouts[0] ? workoutSummary(workouts[0]) : '<div class="muted">עוד לא תיעדת אימון</div>'}
    </div>
    <div class="card">
      <div class="row between"><h3>🤖 סקירת AI אחרונה</h3>${reviews[0] ? `<span class="muted">${fmtDate(reviews[0].date)}</span>` : ''}</div>
      ${reviews[0] ? `<div class="md">${md(reviews[0].text.slice(0, 600))}${reviews[0].text.length > 600 ? '…' : ''}</div>` : `<div class="muted">העלה תמונת התקדמות וקבל סקירה מותאמת אישית</div>`}
      <button class="btn ghost block" style="margin-top:10px" id="q-review">לסקירת AI חדשה</button>
    </div>
    ${measurements[0] ? `<div class="card"><h3>היקפים אחרונים · ${fmtDate(measurements[0].date)}</h3><div>${MEASURES.filter(([k]) => measurements[0][k]).map(([k, l]) => `<span class="chip">${l}: ${measurements[0][k]}</span>`).join('')}</div></div>` : ''}
  `;
  $('#hide-hint')?.addEventListener('click', () => {
    localStorage.setItem('installed_hint', '1');
    refresh();
  });
  $('#q-weight').onclick = () => editWeight();
  $('#q-workout').onclick = () => editWorkout();
  $('#q-photo').onclick = () => addPhoto();
  $('#q-review').onclick = () => go('photos');
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
    ${weights.some((w) => w.bodyFat) ? `<div class="card"><h3>אחוז שומן</h3>${lineChart(weights.map((w) => ({ x: w.date, y: w.bodyFat })))}</div>` : ''}
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
    <div class="grid2">
      <div><label>משקל (ק"ג)</label><input type="number" inputmode="decimal" step="0.1" id="f-w" value="${item.weight ?? ''}"></div>
      <div><label>אחוז שומן (לא חובה)</label><input type="number" inputmode="decimal" step="0.1" id="f-bf" value="${item.bodyFat ?? ''}"></div>
    </div>
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
        await db.put('weights', { ...item, date: $('#f-date', root).value || today(), weight, bodyFat: num($('#f-bf', root).value), note: $('#f-note', root).value.trim() });
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

// ---------- BODY MEASUREMENTS ----------
views.body = async (v) => {
  const items = await db.all('measurements');
  const sel = views.body.sel || 'waist';
  v.innerHTML = `
    <button class="btn block" id="add" style="margin-bottom:14px">+ מדידת היקפים</button>
    <div class="card">
      <div class="row between"><h3>גרף</h3>
        <select id="sel" style="width:auto">${MEASURES.map(([k, l]) => `<option value="${k}" ${k === sel ? 'selected' : ''}>${l}</option>`).join('')}</select>
      </div>
      ${lineChart(items.map((m) => ({ x: m.date, y: m[sel] })), { unit: 'ס"מ' })}
    </div>
    <div class="card"><h3>היסטוריה</h3>
      ${items.length ? `<ul class="list">${items.map((m, i) => {
        const prev = items[i + 1];
        return `<li class="tap" data-id="${m.id}">
          <div class="row between"><b>${fmtDate(m.date)}</b><span class="muted small">לחץ לעריכה</span></div>
          <div>${MEASURES.filter(([k]) => m[k]).map(([k, l]) => {
            const d = prev?.[k] ? round1(m[k] - prev[k]) : null;
            return `<span class="chip">${l}: ${m[k]}${d ? ` <span class="${d > 0 ? 'up' : 'down'}">${d > 0 ? '+' : ''}${d}</span>` : ''}</span>`;
          }).join('')}</div>
          ${m.note ? `<div class="muted small">${esc(m.note)}</div>` : ''}</li>`;
      }).join('')}</ul>` : '<div class="empty">אין עדיין מדידות</div>'}
    </div>`;
  $('#add').onclick = async () => editMeasure({}, items[0]);
  $('#sel').onchange = (e) => {
    views.body.sel = e.target.value;
    refresh();
  };
  $$('[data-id]', v).forEach((li) => (li.onclick = async () => editMeasure(await db.get('measurements', li.dataset.id))));
};

function editMeasure(item = {}, last) {
  openSheet(
    `<h2>${item.id ? 'עריכת מדידה' : 'מדידת היקפים'} <span class="muted small">(ס"מ)</span></h2>
    <label>תאריך</label><input type="date" id="f-date" value="${item.date || today()}">
    <div class="grid2">${MEASURES.map(([k, l]) => `<div><label>${l}</label><input type="number" inputmode="decimal" step="0.1" data-k="${k}" value="${item[k] ?? ''}" placeholder="${last?.[k] ?? ''}"></div>`).join('')}</div>
    <label>הערה</label><textarea id="f-note">${esc(item.note)}</textarea>
    ${last ? '<div class="muted small">הערכים האפורים הם מהמדידה הקודמת</div>' : ''}
    <div class="row" style="margin-top:16px">
      <button class="btn" style="flex:1" id="save">שמירה</button>
      ${item.id ? '<button class="btn danger" id="del">מחיקה</button>' : ''}
      <button class="btn ghost" id="cancel">ביטול</button>
    </div>`,
    (root) => {
      $('#cancel', root).onclick = closeSheet;
      $('#save', root).onclick = async () => {
        const obj = { ...item, date: $('#f-date', root).value || today(), note: $('#f-note', root).value.trim() };
        let any = false;
        $$('[data-k]', root).forEach((inp) => {
          obj[inp.dataset.k] = num(inp.value);
          if (obj[inp.dataset.k]) any = true;
        });
        if (!any) return toast('הכנס לפחות מדידה אחת');
        await db.put('measurements', obj);
        closeSheet();
        toast('נשמר ✓');
        refresh();
      };
      $('#del', root)?.addEventListener('click', async () => {
        if (!confirm('למחוק את המדידה?')) return;
        await db.remove('measurements', item.id);
        closeSheet();
        refresh();
      });
    }
  );
}

// ---------- PHOTOS + AI REVIEW ----------
let selectedPhotos = new Set();

views.photos = async (v) => {
  const [photos, reviews] = await Promise.all([db.all('photos'), db.all('reviews')]);
  const tab = views.photos.tab || 'gallery';
  selectedPhotos = new Set([...selectedPhotos].filter((id) => photos.some((p) => p.id === id)));
  v.innerHTML = `
    <div class="seg"><button data-s="gallery" class="${tab === 'gallery' ? 'active' : ''}">גלריה</button><button data-s="reviews" class="${tab === 'reviews' ? 'active' : ''}">סקירות AI (${reviews.length})</button></div>
    <div id="sub"></div>`;
  $$('.seg button', v).forEach((b) => (b.onclick = () => ((views.photos.tab = b.dataset.s), refresh())));
  const sub = $('#sub', v);

  if (tab === 'reviews') {
    sub.innerHTML = reviews.length
      ? reviews.map((r) => `<div class="card"><div class="row between"><h3>🤖 ${fmtDate(r.date)}</h3><button class="x" data-del="${r.id}">🗑</button></div>
          ${r.question ? `<div class="muted small">שאלה: ${esc(r.question)}</div>` : ''}
          <div class="md">${md(r.text)}</div></div>`).join('')
      : '<div class="empty">אין עדיין סקירות. בחר תמונות בגלריה ולחץ "סקירת AI".</div>';
    $$('[data-del]', sub).forEach((b) => (b.onclick = async () => {
      if (!confirm('למחוק את הסקירה?')) return;
      await db.remove('reviews', b.dataset.del);
      refresh();
    }));
    return;
  }

  sub.innerHTML = `
    <div class="fab-row">
      <button class="btn" id="add">+ העלאת תמונה</button>
      <button class="btn ghost" id="review" ${selectedPhotos.size ? '' : 'disabled'}>🤖 סקירת AI (${selectedPhotos.size})</button>
    </div>
    <div class="muted small" style="margin-bottom:10px">לחיצה על תמונה בוחרת אותה לסקירה/השוואה (עד 4). לחיצה ארוכה פותחת אותה.</div>
    ${selectedPhotos.size === 2 ? '<button class="btn ghost block" id="compare" style="margin-bottom:10px">↔️ השוואה בין 2 התמונות</button>' : ''}
    ${photos.length ? `<div class="photo-grid">${photos.map((p) => `
      <div class="ph ${selectedPhotos.has(p.id) ? 'sel' : ''}" data-id="${p.id}">
        <img src="${blobURL(p.blob)}" alt="" loading="lazy"><span class="chk">✓</span>
        <div class="d">${fmtDate(p.date)} · ${POSES[p.pose] || ''}</div>
      </div>`).join('')}</div>` : '<div class="empty">עוד אין תמונות התקדמות.<br>מומלץ לצלם באותה תאורה, שעה ותנוחה בכל פעם.</div>'}
  `;
  $('#add', sub).onclick = () => addPhoto();
  $('#review', sub).onclick = () => startReview(photos.filter((p) => selectedPhotos.has(p.id)));
  $('#compare', sub)?.addEventListener('click', () => {
    const [a, b] = photos.filter((p) => selectedPhotos.has(p.id)).sort((x, y) => x.date.localeCompare(y.date));
    openSheet(`<h2>השוואה</h2><div class="compare">
      <div><img src="${blobURL(a.blob)}"><div class="muted small">${fmtDate(a.date)}</div></div>
      <div><img src="${blobURL(b.blob)}"><div class="muted small">${fmtDate(b.date)}</div></div></div>
      <div class="muted" style="margin-top:8px">${daysBetween(a.date, b.date)} ימים בין התמונות</div>
      <button class="btn ghost block" style="margin-top:14px" onclick="document.getElementById('sheet').close()">סגירה</button>`);
  });
  $$('.ph', sub).forEach((el) => {
    let timer, long = false;
    const start = () => {
      long = false;
      timer = setTimeout(() => {
        long = true;
        viewPhoto(photos.find((p) => p.id === el.dataset.id));
      }, 450);
    };
    const cancel = () => clearTimeout(timer);
    el.addEventListener('touchstart', start, { passive: true });
    el.addEventListener('touchend', cancel);
    el.addEventListener('touchmove', cancel, { passive: true });
    el.addEventListener('mousedown', start);
    el.addEventListener('mouseup', cancel);
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('click', () => {
      if (long) return;
      const id = el.dataset.id;
      if (selectedPhotos.has(id)) selectedPhotos.delete(id);
      else if (selectedPhotos.size >= 4) return toast('אפשר לבחור עד 4 תמונות');
      else selectedPhotos.add(id);
      refresh();
    });
  });
};

function addPhoto() {
  openSheet(
    `<h2>תמונת התקדמות</h2>
    <label>תמונה</label><input type="file" id="f-file" accept="image/*">
    <div id="preview" style="margin-top:8px"></div>
    <div class="grid2">
      <div><label>תאריך</label><input type="date" id="f-date" value="${today()}"></div>
      <div><label>תנוחה</label><select id="f-pose">${Object.entries(POSES).map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select></div>
    </div>
    <label>הערה</label><textarea id="f-note" placeholder="לדוגמה: בוקר, בצום"></textarea>
    <div class="row" style="margin-top:16px">
      <button class="btn" style="flex:1" id="save">שמירה</button>
      <button class="btn ghost" id="cancel">ביטול</button>
    </div>`,
    (root) => {
      $('#cancel', root).onclick = closeSheet;
      $('#f-file', root).onchange = (e) => {
        const f = e.target.files[0];
        if (f) $('#preview', root).innerHTML = `<img src="${blobURL(f)}" style="max-height:220px;border-radius:10px">`;
      };
      $('#save', root).onclick = async () => {
        const f = $('#f-file', root).files[0];
        if (!f) return toast('בחר תמונה');
        $('#save', root).disabled = true;
        const blob = await compressImage(f);
        await db.put('photos', { date: $('#f-date', root).value || today(), pose: $('#f-pose', root).value, note: $('#f-note', root).value.trim(), blob });
        closeSheet();
        toast('התמונה נשמרה ✓');
        if (current === 'photos') refresh();
        else go('photos');
      };
    }
  );
}

function viewPhoto(p) {
  if (!p) return;
  openSheet(
    `<img src="${blobURL(p.blob)}" style="width:100%;border-radius:12px">
    <div class="row between" style="margin-top:8px"><b>${fmtDate(p.date)} · ${POSES[p.pose] || ''}</b></div>
    ${p.note ? `<div class="muted">${esc(p.note)}</div>` : ''}
    <div class="row" style="margin-top:14px">
      <button class="btn ghost" style="flex:1" id="close">סגירה</button>
      <button class="btn danger" id="del">מחיקה</button>
    </div>`,
    (root) => {
      $('#close', root).onclick = closeSheet;
      $('#del', root).onclick = async () => {
        if (!confirm('למחוק את התמונה?')) return;
        await db.remove('photos', p.id);
        selectedPhotos.delete(p.id);
        closeSheet();
        refresh();
      };
    }
  );
}

async function buildContext() {
  const [weights, measurements, workouts] = await Promise.all(['weights', 'measurements', 'workouts'].map(db.all));
  const p = profile();
  const lines = [];
  const prof = [p.sex && `מין: ${p.sex}`, p.age && `גיל: ${p.age}`, p.height && `גובה: ${p.height} ס"מ`, p.goal && `מטרה: ${p.goal}`, p.target && `יעד משקל: ${p.target} ק"ג`].filter(Boolean);
  if (prof.length) lines.push('פרופיל: ' + prof.join(', '));
  if (weights.length) {
    lines.push('שקילות אחרונות (תאריך: ק"ג):');
    weights.slice(0, 15).forEach((w) => lines.push(`- ${w.date}: ${w.weight}${w.bodyFat ? ` (${w.bodyFat}% שומן)` : ''}${w.note ? ` — ${w.note}` : ''}`));
    if (weights.length > 15) lines.push(`- השקילה הראשונה: ${weights.at(-1).date}: ${weights.at(-1).weight}`);
  }
  if (measurements.length) {
    lines.push('היקפים (ס"מ):');
    measurements.slice(0, 4).forEach((m) => lines.push(`- ${m.date}: ` + MEASURES.filter(([k]) => m[k]).map(([k, l]) => `${l} ${m[k]}`).join(', ')));
  }
  if (workouts.length) {
    const recent = workouts.filter((w) => daysBetween(w.date, today()) <= 28);
    lines.push(`אימונים: ${recent.length} אימונים ב-4 השבועות האחרונים. אחרונים:`);
    workouts.slice(0, 8).forEach((w) =>
      lines.push(`- ${w.date} ${w.title || ''}: ` + (w.exercises || []).map((e) => `${e.name} ${e.sets.map((s) => `${s.w ?? 0}×${s.r ?? 0}`).join(',')}`).join('; '))
    );
  }
  return lines.join('\n') || 'אין נתונים נוספים.';
}

async function startReview(photos) {
  photos.sort((a, b) => a.date.localeCompare(b.date));
  const ai = await import('./ai.js').catch(() => null);
  if (!ai) return toast('לא ניתן לטעון את מודול ה-AI (בדוק חיבור לאינטרנט)');
  if (!ai.getKey()) {
    toast('קודם צריך להגדיר מפתח API');
    return go('settings');
  }
  openSheet(
    `<h2>🤖 סקירת AI</h2>
    <div class="muted">${photos.length} תמונות נבחרו · יחד עם נתוני השקילה, ההיקפים והאימונים שלך</div>
    <label>שאלה או בקשה נוספת (לא חובה)</label>
    <textarea id="f-q" placeholder="לדוגמה: אני בחיטוב, האם אני בכיוון? על מה כדאי לי להתמקד?"></textarea>
    <div id="out" style="margin-top:12px"></div>
    <div class="row" style="margin-top:14px">
      <button class="btn" style="flex:1" id="go">שליחה לסקירה</button>
      <button class="btn ghost" id="cancel">סגירה</button>
    </div>`,
    (root) => {
      $('#cancel', root).onclick = closeSheet;
      $('#go', root).onclick = async () => {
        const btn = $('#go', root);
        const out = $('#out', root);
        btn.disabled = true;
        out.innerHTML = '<span class="spinner"></span> מנתח... (עשוי לקחת עד דקה)';
        try {
          const question = $('#f-q', root).value.trim();
          const imgs = photos.map((p) => ({ blob: p.blob, label: `${p.date}, ${POSES[p.pose] || ''}` }));
          const text = await ai.reviewProgress(imgs, await buildContext(), question);
          await db.put('reviews', { date: today(), photoIds: photos.map((p) => p.id), question, text });
          out.innerHTML = `<div class="card md">${md(text)}</div>`;
          btn.textContent = 'נשמר ✓';
          views.photos.tab = 'reviews';
          selectedPhotos.clear();
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

// ---------- WORKOUTS ----------
function bestSet(sets) {
  let best = null;
  for (const s of sets || []) {
    if (!s.w || !s.r) continue;
    const e1rm = s.w * (1 + s.r / 30);
    if (!best || e1rm > best.e1rm) best = { ...s, e1rm };
  }
  return best;
}
const volume = (w) => (w.exercises || []).reduce((t, e) => t + e.sets.reduce((s, x) => s + (x.w || 0) * (x.r || 0), 0), 0);

function workoutSummary(w) {
  return `<div>${(w.exercises || []).map((e) => `<div class="small"><b>${esc(e.name)}</b> <span class="muted ltr">${e.sets.map((s) => `${s.w ?? '-'}×${s.r ?? '-'}`).join(' · ')}</span></div>`).join('')}
    ${w.notes ? `<div class="muted small" style="margin-top:4px">📝 ${esc(w.notes)}</div>` : ''}</div>`;
}

async function exerciseHistory(name) {
  const workouts = await db.all('workouts');
  const out = [];
  for (const w of workouts) for (const e of w.exercises || []) if (e.name.trim() === name.trim()) out.push({ date: w.date, ...e });
  return out; // newest first
}

views.workouts = async (v) => {
  const tab = views.workouts.tab || 'log';
  const [workouts, exercises] = await Promise.all([db.all('workouts'), db.all('exercises')]);
  v.innerHTML = `
    <div class="seg"><button data-s="log" class="${tab === 'log' ? 'active' : ''}">יומן אימונים</button><button data-s="lib" class="${tab === 'lib' ? 'active' : ''}">התרגילים שלי (${exercises.length})</button></div>
    <div id="sub"></div>`;
  $$('.seg button', v).forEach((b) => (b.onclick = () => ((views.workouts.tab = b.dataset.s), refresh())));
  const sub = $('#sub', v);

  if (tab === 'log') {
    const draft = localStorage.getItem('workout_draft');
    sub.innerHTML = `
      <button class="btn block" id="add" style="margin-bottom:14px">${draft ? '▶︎ המשך אימון פתוח' : '+ אימון חדש'}</button>
      ${workouts.length ? workouts.map((w) => `<div class="card tap" data-id="${w.id}">
        <div class="row between"><h3>${esc(w.title || 'אימון')}</h3><span class="muted">${fmtDate(w.date)}</span></div>
        ${workoutSummary(w)}
        <div class="muted small" style="margin-top:6px">${(w.exercises || []).length} תרגילים · ${(w.exercises || []).reduce((t, e) => t + e.sets.length, 0)} סטים · נפח ${Math.round(volume(w)).toLocaleString()} ק"ג${w.duration ? ` · ${w.duration} דק'` : ''}</div>
      </div>`).join('') : '<div class="empty">אין עדיין אימונים. לחץ "אימון חדש" כדי להתחיל.</div>'}`;
    $('#add', sub).onclick = () => editWorkout(draft ? JSON.parse(draft) : undefined);
    $$('[data-id]', sub).forEach((c) => (c.onclick = async () => editWorkout(await db.get('workouts', c.dataset.id))));
    return;
  }

  // Exercise library with stats
  const stats = {};
  for (const w of workouts)
    for (const e of w.exercises || []) {
      const s = (stats[e.name] ||= { count: 0, last: null, best: null });
      s.count++;
      if (!s.last) s.last = { date: w.date, sets: e.sets };
      const b = bestSet(e.sets);
      if (b && (!s.best || b.e1rm > s.best.e1rm)) s.best = { ...b, date: w.date };
    }
  sub.innerHTML = `
    <button class="btn block" id="add" style="margin-bottom:14px">+ תרגיל חדש</button>
    ${exercises.length ? `<div class="card"><ul class="list">${exercises.sort((a, b) => a.name.localeCompare(b.name, 'he')).map((e) => {
      const s = stats[e.name];
      return `<li class="tap" data-id="${e.id}"><div class="row between"><b>${esc(e.name)}</b>${e.group ? `<span class="chip">${esc(e.group)}</span>` : ''}</div>
        ${s ? `<div class="muted small">${s.count} פעמים · אחרון ${fmtDate(s.last.date)}${s.best ? ` · <span class="pr ltr">🏆 ${s.best.w}×${s.best.r}</span>` : ''}</div>` : '<div class="muted small">עוד לא בוצע</div>'}
        ${e.notes ? `<div class="muted small">📝 ${esc(e.notes)}</div>` : ''}</li>`;
    }).join('')}</ul></div>` : '<div class="empty">הוסף תרגילים שאתה עושה — עם קבוצת שריר, הערות טכניקה וכו\'. תרגילים מתווספים גם אוטומטית כשאתה שומר אימון.</div>'}`;
  $('#add', sub).onclick = () => editExercise();
  $$('[data-id]', sub).forEach((li) => (li.onclick = async () => editExercise(await db.get('exercises', li.dataset.id))));
};

async function editExercise(item = {}) {
  const hist = item.name ? await exerciseHistory(item.name) : [];
  openSheet(
    `<h2>${item.id ? esc(item.name) : 'תרגיל חדש'}</h2>
    <label>שם התרגיל</label><input id="f-name" value="${esc(item.name)}" placeholder="לדוגמה: לחיצת חזה במוט">
    <label>קבוצת שריר</label><input id="f-group" list="groups" value="${esc(item.group)}">
    <datalist id="groups">${['חזה', 'גב', 'כתפיים', 'יד קדמית', 'יד אחורית', 'רגליים', 'ישבן', 'בטן', 'קרדיו'].map((g) => `<option value="${g}">`).join('')}</datalist>
    <label>הערות (טכניקה, הגדרות מכונה וכו')</label><textarea id="f-notes">${esc(item.notes)}</textarea>
    ${hist.length ? `<div class="card" style="margin-top:14px"><h3>התקדמות (סט הכי טוב, 1RM משוער)</h3>
      ${lineChart(hist.map((h) => ({ x: h.date, y: bestSet(h.sets) ? round1(bestSet(h.sets).e1rm) : null })), { unit: 'ק"ג' })}
      <ul class="list">${hist.slice(0, 10).map((h) => `<li><div class="row between"><span class="muted">${fmtDate(h.date)}</span><span class="small ltr">${h.sets.map((s) => `${s.w ?? '-'}×${s.r ?? '-'}`).join(' · ')}</span></div>${h.notes ? `<div class="muted small">${esc(h.notes)}</div>` : ''}</li>`).join('')}</ul></div>` : ''}
    <div class="row" style="margin-top:16px">
      <button class="btn" style="flex:1" id="save">שמירה</button>
      ${item.id ? '<button class="btn danger" id="del">מחיקה</button>' : ''}
      <button class="btn ghost" id="cancel">ביטול</button>
    </div>`,
    (root) => {
      $('#cancel', root).onclick = closeSheet;
      $('#save', root).onclick = async () => {
        const name = $('#f-name', root).value.trim();
        if (!name) return toast('הכנס שם תרגיל');
        const exists = (await db.all('exercises')).find((e) => e.name === name && e.id !== item.id);
        if (exists) return toast('כבר קיים תרגיל בשם הזה');
        // Renaming: update past workouts too, so history stays linked.
        if (item.id && item.name && item.name !== name) {
          for (const w of await db.all('workouts')) {
            let changed = false;
            for (const e of w.exercises || []) if (e.name === item.name) (e.name = name), (changed = true);
            if (changed) await db.put('workouts', w);
          }
        }
        await db.put('exercises', { ...item, name, group: $('#f-group', root).value.trim(), notes: $('#f-notes', root).value.trim() });
        closeSheet();
        toast('נשמר ✓');
        refresh();
      };
      $('#del', root)?.addEventListener('click', async () => {
        if (!confirm('למחוק את התרגיל מהרשימה? (האימונים הקודמים יישמרו)')) return;
        await db.remove('exercises', item.id);
        closeSheet();
        refresh();
      });
    }
  );
}

const setRowHTML = (s = {}, i = 0) => `<div class="set-row">
  <span class="n">${i + 1}</span>
  <input type="number" inputmode="decimal" step="0.5" class="s-w" value="${s.w ?? ''}" placeholder="ק&quot;ג">
  <input type="number" inputmode="numeric" class="s-r" value="${s.r ?? ''}" placeholder="חזרות">
  <button class="x del-set" type="button">✕</button></div>`;

const exBlockHTML = (e = { name: '', sets: [{}], notes: '' }) => `<div class="ex-block">
  <div class="row"><input class="e-name" list="ex-list" value="${esc(e.name)}" placeholder="שם התרגיל"><button class="x del-ex" type="button">🗑</button></div>
  <div class="muted small e-last" style="margin:6px 0"></div>
  <div class="set-head"><span>#</span><span>משקל</span><span>חזרות</span><span></span></div>
  <div class="sets">${(e.sets.length ? e.sets : [{}]).map(setRowHTML).join('')}</div>
  <div class="row" style="margin:6px 0"><button class="btn sm ghost add-set" type="button">+ סט</button><button class="btn sm ghost dup-set" type="button">⧉ שכפל סט אחרון</button></div>
  <textarea class="e-notes" placeholder="הערות לתרגיל (תחושה, טכניקה, RPE...)" style="min-height:44px">${esc(e.notes)}</textarea>
</div>`;

async function editWorkout(item) {
  const isNew = !item?.id;
  item = item || { date: today(), title: '', exercises: [], notes: '' };
  const exercises = await db.all('exercises');
  const workouts = await db.all('workouts');
  const templates = workouts.filter((w) => w.title).filter((w, i, arr) => arr.findIndex((x) => x.title === w.title) === i).slice(0, 8);

  openSheet(
    `<h2>${isNew ? 'אימון חדש' : 'עריכת אימון'}</h2>
    <div class="grid2">
      <div><label>תאריך</label><input type="date" id="f-date" value="${item.date}"></div>
      <div><label>משך (דקות)</label><input type="number" inputmode="numeric" id="f-dur" value="${item.duration ?? ''}"></div>
    </div>
    <label>שם האימון</label><input id="f-title" value="${esc(item.title)}" placeholder="לדוגמה: חזה + יד אחורית / A / רגליים">
    ${isNew && templates.length && !item.exercises.length ? `<label>או התחל מאימון קודם</label><div>${templates.map((t) => `<button class="btn sm ghost tpl" data-id="${t.id}" style="margin:2px">${esc(t.title)}</button>`).join('')}</div>` : ''}
    <datalist id="ex-list">${exercises.map((e) => `<option value="${esc(e.name)}">`).join('')}</datalist>
    <h3 style="margin:16px 0 8px">תרגילים</h3>
    <div id="ex-wrap">${item.exercises.map(exBlockHTML).join('')}</div>
    <button class="btn ghost block" id="add-ex">+ הוסף תרגיל</button>
    <label>הערות כלליות לאימון</label><textarea id="f-notes" placeholder="אנרגיה, שינה, תזונה, כאבים...">${esc(item.notes)}</textarea>
    <div class="row" style="margin-top:16px">
      <button class="btn" style="flex:1" id="save">שמירת אימון</button>
      ${!isNew ? '<button class="btn danger" id="del">מחיקה</button>' : ''}
      <button class="btn ghost" id="cancel">${isNew ? 'סגירה' : 'ביטול'}</button>
    </div>
    ${isNew ? '<div class="muted small" style="margin-top:8px">האימון נשמר כטיוטה אוטומטית עד שתלחץ שמירה.</div>' : ''}`,
    (root) => {
      const wrap = $('#ex-wrap', root);

      const collect = () => ({
        ...item,
        date: $('#f-date', root).value || today(),
        duration: num($('#f-dur', root).value),
        title: $('#f-title', root).value.trim(),
        notes: $('#f-notes', root).value.trim(),
        exercises: $$('.ex-block', wrap)
          .map((b) => ({
            name: $('.e-name', b).value.trim(),
            notes: $('.e-notes', b).value.trim(),
            sets: $$('.set-row', b).map((r) => ({ w: num($('.s-w', r).value), r: num($('.s-r', r).value) })).filter((s) => s.w != null || s.r != null),
          }))
          .filter((e) => e.name),
      });
      const saveDraft = () => isNew && localStorage.setItem('workout_draft', JSON.stringify(collect()));
      const renumber = (b) => $$('.set-row .n', b).forEach((n, i) => (n.textContent = i + 1));

      const showLast = async (b) => {
        const name = $('.e-name', b).value.trim();
        const el = $('.e-last', b);
        if (!name) return (el.textContent = '');
        const h = (await exerciseHistory(name)).find((x) => x.date !== item.date || !item.id);
        const best = bestSet((await exerciseHistory(name)).flatMap((x) => x.sets));
        el.innerHTML = h ? `פעם קודמת (${fmtDate(h.date)}): <span class="ltr">${h.sets.map((s) => `${s.w ?? '-'}×${s.r ?? '-'}`).join(' · ')}</span>${best ? ` · <span class="pr ltr">🏆 ${best.w}×${best.r}</span>` : ''}` : 'תרגיל חדש 💪';
      };

      const addBlock = (e) => {
        wrap.insertAdjacentHTML('beforeend', exBlockHTML(e));
        const b = wrap.lastElementChild;
        showLast(b);
        return b;
      };
      $$('.ex-block', wrap).forEach(showLast);

      wrap.addEventListener('click', (ev) => {
        const b = ev.target.closest('.ex-block');
        if (!b) return;
        if (ev.target.classList.contains('add-set')) {
          $('.sets', b).insertAdjacentHTML('beforeend', setRowHTML({}, $$('.set-row', b).length));
        } else if (ev.target.classList.contains('dup-set')) {
          const rows = $$('.set-row', b);
          const lastRow = rows.at(-1);
          const s = lastRow ? { w: $('.s-w', lastRow).value, r: $('.s-r', lastRow).value } : {};
          $('.sets', b).insertAdjacentHTML('beforeend', setRowHTML(s, rows.length));
        } else if (ev.target.classList.contains('del-set')) {
          ev.target.closest('.set-row').remove();
          renumber(b);
        } else if (ev.target.classList.contains('del-ex')) {
          if ($('.e-name', b).value && !confirm('להסיר את התרגיל מהאימון?')) return;
          b.remove();
        } else return;
        saveDraft();
      });
      wrap.addEventListener('change', (ev) => {
        if (ev.target.classList.contains('e-name')) showLast(ev.target.closest('.ex-block'));
      });
      root.addEventListener('input', saveDraft);

      $('#add-ex', root).onclick = () => {
        const b = addBlock();
        $('.e-name', b).focus();
        saveDraft();
      };
      $$('.tpl', root).forEach((btn) => (btn.onclick = () => {
        const t = templates.find((x) => x.id === btn.dataset.id);
        $('#f-title', root).value = t.title;
        // Pre-fill with last session's weights/reps as a starting point.
        t.exercises.forEach((e) => addBlock({ name: e.name, notes: '', sets: e.sets.map((s) => ({ w: s.w, r: s.r })) }));
        btn.parentElement.previousElementSibling.remove();
        btn.parentElement.remove();
        saveDraft();
      }));

      $('#cancel', root).onclick = () => {
        closeSheet();
        refresh();
      };
      $('#save', root).onclick = async () => {
        const w = collect();
        if (!w.exercises.length) return toast('הוסף לפחות תרגיל אחד');
        await db.put('workouts', w);
        // Add new exercise names to the library.
        const lib = new Set((await db.all('exercises')).map((e) => e.name));
        for (const e of w.exercises) if (!lib.has(e.name)) await db.put('exercises', { name: e.name, group: '', notes: '' }), lib.add(e.name);
        if (isNew) localStorage.removeItem('workout_draft');
        closeSheet();
        toast('האימון נשמר 💪');
        if (current === 'workouts') refresh();
        else go('workouts');
      };
      $('#del', root)?.addEventListener('click', async () => {
        if (!confirm('למחוק את האימון?')) return;
        await db.remove('workouts', item.id);
        closeSheet();
        refresh();
      });
      if (isNew && !item.exercises.length && !templates.length) addBlock();
    }
  );
  // Discard draft explicitly
  if (isNew && localStorage.getItem('workout_draft')) {
    $('#sheet-body').insertAdjacentHTML('beforeend', '<button class="btn sm danger" id="discard" style="margin-top:10px">מחק טיוטה</button>');
    $('#discard').onclick = () => {
      if (!confirm('למחוק את הטיוטה?')) return;
      localStorage.removeItem('workout_draft');
      closeSheet();
      refresh();
    };
  }
}

// ---------- SETTINGS ----------
views.settings = async (v) => {
  const p = profile();
  const key = localStorage.getItem('anthropic_key') || '';
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
    <div class="card"><h3>🤖 מפתח Claude API</h3>
      <div class="muted small">לסקירות AI צריך מפתח API מ-<b>console.anthropic.com</b> (תשלום לפי שימוש, בערך כמה סנטים לסקירה). המפתח נשמר רק במכשיר הזה ונשלח ישירות ל-Anthropic.</div>
      <label>API Key</label><input id="k" type="password" autocomplete="off" dir="ltr" value="${esc(key)}" placeholder="sk-ant-...">
      <div class="row" style="margin-top:10px"><button class="btn" style="flex:1" id="k-save">שמירת מפתח</button>${key ? '<button class="btn danger" id="k-del">הסרה</button>' : ''}</div>
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
    <div class="muted small" style="text-align:center">גרסה 1.0</div>`;

  $('#p-save').onclick = () => {
    setProfile({ sex: $('#p-sex').value, age: num($('#p-age').value), height: num($('#p-height').value), target: num($('#p-target').value), goal: $('#p-goal').value.trim() });
    toast('נשמר ✓');
  };
  $('#k-save').onclick = () => {
    const k = $('#k').value.trim();
    if (!k.startsWith('sk-')) return toast('המפתח צריך להתחיל ב-sk-');
    localStorage.setItem('anthropic_key', k);
    toast('המפתח נשמר ✓');
    refresh();
  };
  $('#k-del')?.addEventListener('click', () => {
    localStorage.removeItem('anthropic_key');
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
go('home');
