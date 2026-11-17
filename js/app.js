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
const TITLES = { home: 'יומן אימונים', weight: 'שקילה', body: 'היקפים', photos: 'תמונות התקדמות', exercises: 'אימון Full Body', settings: 'הגדרות' };
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
  const [weights, exercises, photos, measurements, reviews] = await Promise.all(
    ['weights', 'exercises', 'photos', 'measurements', 'reviews'].map(db.all)
  );
  const last = weights[0];
  const first = weights.at(-1);
  const weekAgo = weights.find((w) => daysBetween(w.date, last?.date) >= 7);
  const diff = (a, b) => (a && b ? round1(a.weight - b.weight) : null);
  const sign = (d) => (d == null ? '—' : `<span class="${d > 0 ? 'up' : 'down'}">${d > 0 ? '+' : ''}${d}</span>`);
  const recentEx = exercises.slice(0, 4); // most recently updated

  v.innerHTML = `
    ${!localStorage.getItem('installed_hint') && !navigator.standalone ? `<div class="banner">📲 להתקנה באייפון: פתח בספארי ← כפתור שיתוף ← <b>"הוסף למסך הבית"</b>. <button class="btn sm ghost" id="hide-hint">הבנתי</button></div>` : ''}
    <div class="fab-row">
      <button class="btn" id="q-weight">+ שקילה</button>
      <button class="btn" id="q-ex">▶︎ אימון</button>
      <button class="btn ghost" id="q-photo">+ תמונה</button>
    </div>
    <div class="grid3" style="margin-bottom:14px">
      <div class="stat"><div class="v">${last ? last.weight : '—'}</div><div class="l">משקל אחרון (ק"ג)</div></div>
      <div class="stat"><div class="v">${sign(diff(last, weekAgo))}</div><div class="l">שינוי שבועי</div></div>
      <div class="stat"><div class="v">${sign(diff(last, first))}</div><div class="l">שינוי כולל</div></div>
    </div>
    <div class="card"><h3>מגמת משקל</h3>${lineChart(weights.slice(0, 60).map((w) => ({ x: w.date, y: w.weight })))}</div>
    <div class="grid3" style="margin-bottom:14px">
      <div class="stat"><div class="v">${exercises.length}</div><div class="l">תרגילים</div></div>
      <div class="stat"><div class="v">${reviews.length}</div><div class="l">סקירות AI</div></div>
      <div class="stat"><div class="v">${photos.length}</div><div class="l">תמונות</div></div>
    </div>
    <div class="card">
      <div class="row between"><h3>🏋️ עודכנו לאחרונה</h3><button class="btn sm ghost" id="q-all-ex">לכל התרגילים</button></div>
      ${recentEx.length ? `<ul class="list">${recentEx.map((e) => `<li class="tap" data-ex="${e.id}"><div class="row between"><b>${esc(e.name)}</b><span class="muted small">${fmtDate(e.date)}</span></div><div class="small">${setsSummary(e.sets)}</div></li>`).join('')}</ul>` : '<div class="muted">עוד לא הוספת תרגילים</div>'}
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
  $('#q-ex').onclick = () => (exercises.length ? startWorkout() : go('exercises'));
  $('#q-all-ex').onclick = () => go('exercises');
  $$('[data-ex]', v).forEach((li) => (li.onclick = async () => editExercise(await db.get('exercises', li.dataset.ex))));
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
  const [weights, measurements, exercises] = await Promise.all(['weights', 'measurements', 'exercises'].map(db.all));
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
  if (exercises.length) {
    lines.push('תוכנית התרגילים שלי (משקל×חזרות לכל סט):');
    exercises.forEach((e) => {
      const sets = (e.sets || []).map((x) => `${x.w ?? '-'}×${x.r ?? '-'}`).join(', ');
      const prev = e.history?.length ? ` (לפני ${e.history.at(-1).date}: ${(e.history.at(-1).sets || []).map((x) => `${x.w ?? '-'}×${x.r ?? '-'}`).join(', ')})` : '';
      lines.push(`- ${e.name}: ${sets}${prev}${e.notes ? ` — ${e.notes}` : ''}`);
    });
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

// The exercise list is the (single, full-body) workout, in the order it's performed.
const orderKey = (e) => e.order ?? e.createdAt ?? 0;
const loadWorkout = async () => (await db.all('exercises')).sort((a, b) => orderKey(a) - orderKey(b));

views.exercises = async (v) => {
  const exercises = await loadWorkout();
  const totalSets = exercises.reduce((t, e) => t + (e.sets?.length || 0), 0);
  v.innerHTML = `
    ${exercises.length ? `<button class="btn block" id="start" style="margin-bottom:10px;padding:16px;font-size:18px">▶︎ התחל אימון</button>
      <div class="muted small" style="text-align:center;margin-bottom:14px">${exercises.length} תרגילים · ${totalSets} סטים</div>` : ''}
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
    ${exercises.length ? '' : '<div class="empty">עוד אין תרגילים.<br>הוסף את התרגילים של אימון ה-Full Body שלך, לפי הסדר שאתה עושה אותם.</div>'}
    <button class="btn ${exercises.length ? 'ghost' : ''} block" id="add">+ הוסף תרגיל</button>`;

  $('#add').onclick = () => editExercise();
  $('#start')?.addEventListener('click', () => startWorkout());
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

// ---------- WORKOUT MODE ----------
// Tick off sets while training. Ticks live only until "סיום אימון" — nothing is logged.
const getChecks = () => JSON.parse(localStorage.getItem('workout_checks') || '{}');
const setChecks = (c) => localStorage.setItem('workout_checks', JSON.stringify(c));

async function startWorkout() {
  const exercises = await loadWorkout();
  const checks = getChecks();
  const total = exercises.reduce((t, e) => t + (e.sets?.length || 0), 0);
  const done = exercises.reduce((t, e) => t + (e.sets || []).filter((_, k) => checks[`${e.id}:${k}`]).length, 0);

  openSheet(
    `<div class="row between"><h2 style="margin:0">💪 Full Body</h2><span class="muted"><b id="cnt">${done}</b>/${total} סטים</span></div>
    <div style="height:6px;background:var(--card2);border-radius:3px;margin:10px 0 14px;overflow:hidden"><div id="bar" style="height:100%;width:${total ? (done / total) * 100 : 0}%;background:var(--accent);transition:width .2s"></div></div>
    ${exercises.map((e, i) => `<div class="ex-block" data-ex="${e.id}">
      <div class="row between"><b>${i + 1}. ${esc(e.name)}</b><button class="btn sm ghost upd" data-id="${e.id}">✎ עדכון</button></div>
      ${e.notes ? `<div class="muted small">📝 ${esc(e.notes)}</div>` : ''}
      <div class="row wrap" style="margin-top:8px;gap:8px">
        ${(e.sets || []).map((st, k) => `<button class="setbtn ${checks[`${e.id}:${k}`] ? 'on' : ''}" data-k="${e.id}:${k}">
          ${st.w != null ? `<span class="sw"><b class="ltr">${st.w}</b> ק"ג</span>` : ''}<span class="sr"><b class="ltr">${esc(st.r ?? '-')}</b>${/^\d+$/.test(String(st.r ?? '')) ? ' חזרות' : ''}</span></button>`).join('')}
      </div></div>`).join('')}
    <div class="row" style="margin-top:16px">
      <button class="btn" style="flex:1" id="finish">✓ סיום אימון</button>
      <button class="btn ghost" id="close">סגירה</button>
    </div>
    <div class="muted small" style="margin-top:8px">הסימונים נשמרים גם אם סוגרים את האפליקציה, עד שלוחצים "סיום אימון". אם הורדת/העלית משקל — "עדכון" שומר את המשקל החדש בתרגיל.</div>`,
    (root) => {
      $$('.setbtn', root).forEach((b) =>
        b.addEventListener('click', () => {
          const c = getChecks();
          if (c[b.dataset.k]) delete c[b.dataset.k];
          else c[b.dataset.k] = 1;
          setChecks(c);
          b.classList.toggle('on');
          const n = $$('.setbtn.on', root).length;
          $('#cnt', root).textContent = n;
          $('#bar', root).style.width = `${total ? (n / total) * 100 : 0}%`;
          if (n === total) toast('כל הסטים הושלמו 🔥');
        })
      );
      $$('.upd', root).forEach((b) => (b.onclick = async () => editExercise(await db.get('exercises', b.dataset.id), startWorkout)));
      $('#close', root).onclick = closeSheet;
      $('#finish', root).onclick = () => {
        localStorage.removeItem('workout_checks');
        closeSheet();
        toast('כל הכבוד! 💪');
        refresh();
      };
    }
  );
}

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
    <div class="muted small" style="text-align:center">גרסה 1.1</div>`;

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
go('home');
