// Master tab → "Случайные предметы": draw X random items from chosen categories (ITEMS_DB group) and
// types (ITEMS_DB category), equal odds, optionally send the result straight to a player's warehouse
// through the cloud sheet (see the give/inbox actions in apps-script/Code.gs and cloud.js).
// Relies on host globals at call time: ITEMS_DB, HIDDEN_ITEM_INDICES, INNATE_ONLY_WEAPON_IDX,
// cardBtnHtml, ITEM_CARD_BY_NAME, toast, escHtml.
(function (global) {
  'use strict';

  // creature/robot/dog "items" are innate attacks — nothing a GM hands out as loot
  const EXCLUDED_GROUPS = new Set(['Robot Items', 'Creature Items', 'Dog Items']);

  const ui = { groups: new Set(), groupW: {}, types: new Set(), count: 3, results: [], open: false, players: null, to: '', busy: false };

  // ITEMS_DB category -> equipment icon (live-card/icons/equipment-icons/)
  const TYPE_ICON = { Armor: 'armor', Clothes: 'clothing', Melee: 'melee', Pistol: 'pistol', Rifle: 'rifle', Heavy: 'heavy_weapon',
    Thrown: 'grenade', Mine: 'mine', Gear: 'utility', Chem: 'chem', Food: 'food', Alcohol: 'drink', Mod: 'mod', 'Power Armor': 'power_armor' };

  function allGroups() { return [...new Set(ITEMS_DB.map(it => it[0]))].filter(g => !EXCLUDED_GROUPS.has(g)); }
  function allTypes() { return [...new Set(ITEMS_DB.map(it => it[1]))]; }

  function pool() {
    const out = [];
    ITEMS_DB.forEach((it, i) => {
      if (EXCLUDED_GROUPS.has(it[0])) return;
      if (HIDDEN_ITEM_INDICES.has(i) || INNATE_ONLY_WEAPON_IDX.has(i)) return;
      if (ui.groups.size && !ui.groups.has(it[0])) return;
      if (ui.types.size && !ui.types.has(it[1])) return;
      out.push(i);
    });
    return out;
  }
  function shuffle(a) {
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  }
  // With 2+ categories chosen each pick first chooses a category by its weight (the % boxes; they're
  // normalised, so they don't have to add up to exactly 100), then a random item of that category.
  // With 0/1 categories every matching item is equally likely.
  function drawOne(exclude) {
    const cand = pool().filter(i => !exclude.has(i));
    if (!cand.length) return null;
    if (ui.groups.size < 2) return cand[Math.floor(Math.random() * cand.length)];
    const byGroup = {};
    cand.forEach(i => { (byGroup[ITEMS_DB[i][0]] = byGroup[ITEMS_DB[i][0]] || []).push(i); });
    const opts = Object.keys(byGroup).map(g => [g, Math.max(0, Number(ui.groupW[g]) || 0)]).filter(x => x[1] > 0);
    if (!opts.length) return null;
    let r = Math.random() * opts.reduce((s, x) => s + x[1], 0);
    let g = opts[opts.length - 1][0];
    for (const [name, w] of opts) { if ((r -= w) < 0) { g = name; break; } }
    return byGroup[g][Math.floor(Math.random() * byGroup[g].length)];
  }
  function draw() {
    const taken = new Set(), out = [];
    for (let n = 0; n < Math.max(1, ui.count); n++) {
      const idx = drawOne(taken);
      if (idx == null) break;
      taken.add(idx); out.push({ idx });
    }
    ui.results = out;
    if (!out.length) toast('Под выбранные фильтры не подходит ни один предмет (проверьте, что у категорий вероятность больше 0).', true);
    else if (out.length < ui.count) toast('Нашлось только ' + out.length + ' подходящих предметов — выдал их.');
  }
  function reroll(pos) {
    const taken = new Set(ui.results.map(r => r.idx));
    const idx = drawOne(taken);
    if (idx == null) { toast('Больше нет подходящих предметов для замены.', true); return; }
    ui.results[pos] = { idx };
  }
  function toggleGroup(g) {
    ui.groups.has(g) ? ui.groups.delete(g) : ui.groups.add(g);
    // newly changed selection: split the probability evenly, the GM then adjusts the boxes
    const sel = [...ui.groups], each = sel.length ? Math.floor(100 / sel.length) : 0;
    sel.forEach((name, i) => { ui.groupW[name] = i === 0 ? 100 - each * (sel.length - 1) : each; });
  }

  const cloudReady = () => global.FWWCloud && FWWCloud.enabled() && FWWCloud.canMaster() && FWWCloud.isLoggedIn && FWWCloud.isLoggedIn();

  async function loadPlayers(force) {
    if (!cloudReady() || (ui.players && !force)) return;
    try { ui.players = await FWWCloud.request('players'); } catch (e) { ui.players = []; toast('Не удалось получить список игроков: ' + e.message, true); }
  }
  async function send() {
    if (!ui.to) { toast('Выберите игрока.', true); return; }
    if (!ui.results.length) return;
    ui.busy = true; redraw();
    try {
      const items = ui.results.map(r => ({ idx: r.idx, name: ITEMS_DB[r.idx][2] }));
      await FWWCloud.request('give', { to: ui.to, items });
      toast('Отправлено игроку ' + ui.to + ': ' + items.map(i => i.name).join(', '));
      ui.results = [];
    } catch (e) { toast('Не удалось отправить: ' + e.message, true); }
    ui.busy = false; redraw();
  }

  let host = null;
  function chip(kind, value, on) {
    return `<label class="lt-chip${on ? ' on' : ''}" data-lt-${kind}="${escHtml(value)}">${escHtml(value)}</label>`;
  }
  function typeChip(t, on) {
    const icon = TYPE_ICON[t];
    return `<label class="lt-chip lt-typechip${on ? ' on' : ''}" data-lt-type="${escHtml(t)}" title="${escHtml(t)}">${icon
      ? `<img src="live-card/icons/equipment-icons/${icon}.png" alt="${escHtml(t)}">` : escHtml(t)}</label>`;
  }
  // a result as its real card image, shown right away (click to enlarge) — plain text tile when there's no card art
  function resultTile(r, pos) {
    const it = ITEMS_DB[r.idx];
    const val = ITEM_CARD_BY_NAME[it[2]];
    const files = val ? (Array.isArray(val) ? val : [val]) : [];
    const img = files.length
      ? `<span class="card-btn lt-cardimg" data-cards="${files.map(f => 'cards-web/' + f).join('|')}" title="Увеличить"><img src="cards-web/${files[0]}" alt="${escHtml(it[2])}" loading="lazy"></span>`
      : `<div class="lt-nocard">${escHtml(it[2])}<br><small>нет картинки карты</small></div>`;
    return `<div class="lt-tile">${img}
      <div class="lt-tile-line"><span class="lt-name">${escHtml(it[2])} <span class="lt-cost">(${it[3]})</span></span></div>
      <div class="lt-tile-line"><span class="lt-meta">${escHtml(it[0])} · ${escHtml(it[1])}</span>
        <span><button type="button" class="ghost" data-lt-reroll="${pos}" title="Заменить на другой">🔁</button><button type="button" class="ghost" data-lt-del="${pos}" title="Убрать">✕</button></span></div></div>`;
  }
  function weightsHtml() {
    const sel = allGroups().filter(g => ui.groups.has(g));
    if (sel.length < 2) return '';
    const sum = sel.reduce((s, g) => s + (Number(ui.groupW[g]) || 0), 0);
    return `<div class="lt-weights"><div class="lt-label">Вероятность категорий <small>(процент шансов, что предмет выпадет из неё; сумма сейчас ${sum}%${sum === 100 ? '' : ' — будет пересчитано пропорционально'})</small></div>
      ${sel.map(g => `<label class="lt-w">${escHtml(g)} <input type="number" min="0" max="100" value="${Number(ui.groupW[g]) || 0}" data-lt-w="${escHtml(g)}">%</label>`).join('')}</div>`;
  }
  function redraw() {
    if (!host) return;
    const p = pool().length;
    const canSend = cloudReady();
    host.innerHTML = `<details class="lt-panel" ${ui.open ? 'open' : ''}>
      <summary>🎲 Случайные предметы (из колоды мастера)</summary>
      <div class="lt-body">
        <div class="lt-label">Категории <small>(ничего не выбрано — любые)</small></div>
        <div class="lt-chips">${allGroups().map(g => chip('group', g, ui.groups.has(g))).join('')}</div>
        ${weightsHtml()}
        <div class="lt-label">Тип <small>(ничего не выбрано — любой; наведите на значок, чтобы увидеть название)</small></div>
        <div class="lt-chips">${allTypes().map(t => typeChip(t, ui.types.has(t))).join('')}</div>
        <div class="lt-row">
          <label>Количество <input type="number" min="1" max="30" value="${ui.count}" data-lt="count"></label>
          <button type="button" data-lt="draw">🎲 Выдать</button>
          <span class="lt-pool">подходит предметов: ${p}</span>
        </div>
        ${ui.results.length ? `<div class="lt-cards">${ui.results.map(resultTile).join('')}</div>` : ''}
        ${ui.results.length && canSend ? `<div class="lt-send">
          <select data-lt="to"><option value="">— кому отправить —</option>${(ui.players || []).map(n => `<option ${n === ui.to ? 'selected' : ''}>${escHtml(n)}</option>`).join('')}</select>
          <button type="button" class="ghost" data-lt="players" title="Обновить список игроков">↻</button>
          <button type="button" data-lt="send" ${ui.busy ? 'disabled' : ''}>📤 Отправить игроку</button>
        </div><div class="hint">Предметы сами появятся на складе игрока (в течение минуты, пока он в игре, или при следующем входе).</div>`
        : ui.results.length ? '<div class="hint">Чтобы отправлять предметы игрокам, войдите в облако как мастер.</div>' : ''}
      </div></details>`;
    const q = s => host.querySelector(s);
    q('details').addEventListener('toggle', e => {
      if (e.target.open === ui.open) return; // the initial toggle event of a freshly rendered <details open>
      ui.open = e.target.open;
      if (ui.open) loadPlayers().then(redraw);
    });
    host.querySelectorAll('[data-lt-group]').forEach(el => el.onclick = () => {
      toggleGroup(el.dataset.ltGroup); redraw();
    });
    host.querySelectorAll('[data-lt-w]').forEach(inp => inp.onchange = () => {
      ui.groupW[inp.dataset.ltW] = Math.min(100, Math.max(0, Number(inp.value) || 0)); redraw();
    });
    host.querySelectorAll('[data-lt-type]').forEach(el => el.onclick = () => {
      const v = el.dataset.ltType; ui.types.has(v) ? ui.types.delete(v) : ui.types.add(v); redraw();
    });
    q('[data-lt=count]').onchange = e => { ui.count = Math.min(30, Math.max(1, Number(e.target.value) || 1)); redraw(); };
    q('[data-lt=draw]').onclick = () => { draw(); redraw(); };
    host.querySelectorAll('[data-lt-reroll]').forEach(b => b.onclick = () => { reroll(Number(b.dataset.ltReroll)); redraw(); });
    host.querySelectorAll('[data-lt-del]').forEach(b => b.onclick = () => { ui.results.splice(Number(b.dataset.ltDel), 1); redraw(); });
    const to = q('[data-lt=to]'); if (to) to.onchange = e => { ui.to = e.target.value; };
    const pl = q('[data-lt=players]'); if (pl) pl.onclick = () => loadPlayers(true).then(redraw);
    const sd = q('[data-lt=send]'); if (sd) sd.onclick = send;
  }

  function mount(el) { host = el; redraw(); }
  global.FWWLoot = { mount };
})(window);
