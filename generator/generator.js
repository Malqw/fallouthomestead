// Master tab → "Сгенерировать юнита": pick an army list (or any) and optionally a unit, set the chance
// of each equipment section × category, roll — the unit comes with random gear (and mods) drawn from
// what THAT army list may actually use per the BMCE spreadsheet (generator/army_lists.json, built by
// build_army_lists.py). Preview first, then "add to the Master roster".
// Relies on host globals at call time: UNITS_DB, ITEMS_DB, HIDDEN_ITEM_INDICES, INNATE_ONLY_WEAPON_IDX,
// MOD_SLOT_MAP, MOD_ITEM_RESTRICTION, modSlotForItem, itemAllowedForTag, unitModTypeForIdx, isDogUnitIdx,
// isAutomatronHeadIdx, addMasterMemberWithUnit, makeItemInstance, mintModInstance, saveState, render,
// toast, escHtml, state.
(function (global) {
  'use strict';

  const SECTION_ORDER = ['Standard Items', 'Wasteland Items', 'Advanced Items', 'Hightech Items', 'Useable Items', 'Power Armor', 'Super Mutants Items', 'Personal Items'];
  const CATEGORY_ORDER = ['Armor', 'Clothes', 'Melee', 'Pistol', 'Rifle', 'Heavy Weapon', 'Thrown Weapon', 'Mine', 'Gear', 'Chem', 'Food', 'Alcohol', 'Power Armor'];
  const SECTION_LABEL = { 'Standard Items': 'Standard', 'Wasteland Items': 'Wasteland', 'Advanced Items': 'Advanced', 'Hightech Items': 'High-Tech', 'Useable Items': 'Usable', 'Power Armor': 'Power Armor', 'Super Mutants Items': 'Super Mutant', 'Personal Items': 'Personal' };
  // robots/creatures/dogs/aliens have their own fixed gear system in the tool — nothing to roll
  const SKIP_SECTIONS = new Set(['Upgrades', 'Robot Items', 'Creature Items', 'Dog Items', 'Alien Items']);

  const S = {
    data: null, listId: '', unitKey: '', grid: {}, modChance: 30, maxItems: 6, result: null,
  };
  let overlay = null;

  const key = (s, c) => s + '|' + c;
  const rnd = n => Math.floor(Math.random() * n);
  const pick = a => a[rnd(a.length)];

  function defaultGrid() {
    const g = {};
    ['Wasteland Items', 'Advanced Items', 'Hightech Items'].forEach(s => ['Armor', 'Melee', 'Pistol', 'Rifle', 'Heavy Weapon'].forEach(c => { g[key(s, c)] = 35; }));
    g[key('Standard Items', 'Gear')] = 30;
    ['Chem', 'Food', 'Alcohol'].forEach(c => { g[key('Useable Items', c)] = 20; });
    g[key('Power Armor', 'Power Armor')] = 5;
    return g;
  }
  S.grid = defaultGrid();

  // ---------- data ----------
  async function load() {
    if (S.data) return S.data;
    S.data = (await fetch('generator/army_lists.json').then(r => r.json())).lists;
    return S.data;
  }
  const curList = () => (S.listId === '' ? null : S.data.find(l => String(l.id) === String(S.listId)));
  const listUnits = l => l.units.filter(u => u.u != null);
  const unitBlocksItems = uIdx => !!(unitModTypeForIdx(uIdx) || isDogUnitIdx(uIdx) || isAutomatronHeadIdx(uIdx));

  function lists() { return S.listId === '' ? S.data : [curList()]; }
  // (section, category) cells that exist in the chosen list(s), with pool sizes
  function cells() {
    const m = new Map();
    lists().forEach(l => l.items.forEach(it => {
      if (SKIP_SECTIONS.has(it.s) || it.c === 'Mod' || it.i == null) return;
      const k = key(it.s, it.c);
      m.set(k, (m.get(k) || 0) + 1);
    }));
    return m;
  }

  // ---------- generation ----------
  function poolFor(list, unit, sec, cat) {
    const innate = new Set(((UNITS_DB[unit.u] || [])[4] || []).map(x => x[0]));
    const seen = new Set();
    return list.items.filter(it => {
      if (it.s !== sec || it.c !== cat || it.i == null || seen.has(it.i)) return false;
      seen.add(it.i);
      return !HIDDEN_ITEM_INDICES.has(it.i) && !INNATE_ONLY_WEAPON_IDX.has(it.i) && !innate.has(it.i) && itemAllowedForTag(it.i, null);
    });
  }
  function modFor(list, unit, hostIdx) {
    if (!unit.a || unit.a.includes('Upgrades')) {
      const slot = modSlotForItem(ITEMS_DB[hostIdx]);
      if (!slot) return null;
      const hostName = ITEMS_DB[hostIdx][2];
      const cand = [...new Set(list.items.filter(it => it.c === 'Mod' && it.i != null).map(it => it.i))].filter(i => {
        const slots = MOD_SLOT_MAP[i];
        if (!slots || !slots.includes(slot)) return false;
        const r = MOD_ITEM_RESTRICTION[ITEMS_DB[i][2]];
        return !r || r === hostName;
      });
      return cand.length ? pick(cand) : null;
    }
    return null;
  }

  function generate() {
    const pool = S.listId === '' ? S.data.filter(l => listUnits(l).length) : [curList()];
    let list = pick(pool), unit = null;
    if (S.unitKey !== '') unit = listUnits(list).find(u => u.n === S.unitKey);
    if (!unit) unit = pick(listUnits(list));
    const res = { list, unit, entries: [], note: '' };
    if (unitBlocksItems(unit.u)) {
      res.note = 'Роботы, существа и собаки получают снаряжение по своим правилам (у них оно фиксированное) — случайные предметы не выдаются.';
      S.result = res;
      return;
    }
    const allowed = unit.a; // null = no restriction stated
    const picks = [];
    cells().forEach((_, k) => {
      const [sec, cat] = k.split('|');
      if (allowed && !allowed.includes(sec)) return;
      const chance = S.grid[k] || 0;
      if (chance <= 0 || Math.random() * 100 >= chance) return;
      const items = poolFor(list, unit, sec, cat);
      if (items.length) picks.push({ cell: k, item: pick(items) });
    });
    // one copy of an item at most, then trim to the cap at random
    const seen = new Set();
    let chosen = picks.filter(p => (seen.has(p.item.i) ? false : seen.add(p.item.i)));
    for (let i = chosen.length - 1; i > 0; i--) { const j = rnd(i + 1); [chosen[i], chosen[j]] = [chosen[j], chosen[i]]; }
    chosen = chosen.slice(0, Math.max(0, S.maxItems));
    res.entries = chosen.map(p => {
      const e = { cell: p.cell, idx: p.item.i, mod: null };
      if (Math.random() * 100 < S.modChance) e.mod = modFor(list, unit, e.idx);
      return e;
    });
    S.result = res;
  }
  function rerollEntry(pos) {
    const r = S.result, e = r.entries[pos];
    const [sec, cat] = e.cell.split('|');
    const taken = new Set(r.entries.map(x => x.idx));
    const cand = poolFor(r.list, r.unit, sec, cat).filter(it => !taken.has(it.i));
    if (!cand.length) { toast('В этой категории больше нет других предметов.', true); return; }
    e.idx = pick(cand).i;
    e.mod = Math.random() * 100 < S.modChance ? modFor(r.list, r.unit, e.idx) : null;
  }
  function totalCost(r) {
    const u = UNITS_DB[r.unit.u];
    const innate = (u[4] || []).reduce((s, [i, q]) => s + (ITEMS_DB[i] ? ITEMS_DB[i][3] * q : 0), 0);
    return u[2] + innate + r.entries.reduce((s, e) => s + ITEMS_DB[e.idx][3] + (e.mod != null ? ITEMS_DB[e.mod][3] : 0), 0);
  }

  function addToRoster() {
    const r = S.result;
    if (!r) return;
    addMasterMemberWithUnit(r.unit.u);
    const memberId = -(state.master.nextMemberId - 1);
    r.entries.forEach(e => {
      const id = state.warehouse.nextInstId++;
      const inst = makeItemInstance(id, e.idx, memberId);
      state.warehouse.items[id] = inst;
      if (e.mod != null) inst.modInstId = mintModInstance(e.mod, memberId);
    });
    saveState();
    render();
    toast('Юнит «' + UNITS_DB[r.unit.u][1] + '» добавлен в ростер мастера (' + r.entries.length + ' предм.).');
    S.result = null;
  }

  // ---------- UI ----------
  function options() {
    const groups = {};
    S.data.forEach(l => { (groups[l.faction] = groups[l.faction] || []).push(l); });
    return '<option value="">🎲 Любая фракция</option>' + Object.entries(groups).map(([f, ls]) =>
      `<optgroup label="${escHtml(f)}">${ls.map(l => `<option value="${l.id}" ${String(l.id) === String(S.listId) ? 'selected' : ''}>${escHtml(l.name)}</option>`).join('')}</optgroup>`).join('');
  }
  function gridHtml() {
    const cs = cells();
    const list = curList();
    const unit = list && S.unitKey ? listUnits(list).find(u => u.n === S.unitKey) : null;
    const secs = SECTION_ORDER.filter(s => [...cs.keys()].some(k => k.startsWith(s + '|')));
    const cats = CATEGORY_ORDER.filter(c => [...cs.keys()].some(k => k.endsWith('|' + c)));
    return `<table class="gn-grid"><tr><th></th>${cats.map(c => `<th>${escHtml(c)}</th>`).join('')}</tr>
      ${secs.map(s => `<tr><th>${SECTION_LABEL[s] || s}</th>${cats.map(c => {
        const k = key(s, c), n = cs.get(k);
        if (!n) return '<td class="gn-na">—</td>';
        const off = unit && unit.a && !unit.a.includes(s);
        return `<td class="${off ? 'gn-off' : ''}" title="${off ? 'Этому юниту недоступно' : 'В списке предметов: ' + n}"><input type="number" min="0" max="100" step="5" value="${S.grid[k] || 0}" data-gn-cell="${escHtml(k)}" ${off ? 'disabled' : ''}>%</td>`;
      }).join('')}</tr>`).join('')}</table>`;
  }
  // the unit's real card with the rolled gear equipped (live stats/armour), scaled down; static card art as fallback
  function unitCardHtml(r) {
    const u = UNITS_DB[r.unit.u], SC = 0.7;
    const official = window.officialUnitForMember ? officialUnitForMember({ unitIdx: r.unit.u }, u[1]) : null;
    if (official && global.FWWCardRender) {
      const eq = [];
      const add = idx => { const o = FWWBridge.getOfficialItem(ITEMS_DB[idx][2]); if (o) eq.push(o); };
      (u[4] || []).forEach(([i, q]) => { for (let k = 0; k < q; k++) add(i); });
      r.entries.forEach(e => { add(e.idx); if (e.mod != null) add(e.mod); });
      const html = FWWCardRender.buildCardHtml(official, eq, 'live-card/', { cost: u[2] });
      return `<div class="gn-card" style="width:${Math.round(450 * SC)}px;height:${Math.round(620 * SC)}px"><div style="width:450px;height:620px;transform:scale(${SC});transform-origin:top left">${html}</div></div>`;
    }
    const f = UNIT_CARD_BY_NAME[u[1]];
    const file = Array.isArray(f) ? f[0] : f;
    return file ? `<div class="gn-card gn-static"><img src="cards-web/${file}" alt="${escHtml(u[1])}"></div>` : '';
  }
  function resultHtml() {
    const r = S.result;
    if (!r) return '';
    const u = UNITS_DB[r.unit.u];
    return `<div class="cu-sec"><div class="cu-sec-title">Результат</div>
      <div class="gn-result"><div class="gn-result-main">
      <div class="gn-unit"><b>${escHtml(u[1])}</b> <span class="gn-dim">(${escHtml(r.list.name)}) · базовая цена ${u[2]}</span></div>
      ${r.note ? `<div class="hint">${escHtml(r.note)}</div>` : ''}
      ${r.entries.length ? `<div class="lt-results">${r.entries.map((e, pos) => {
        const it = ITEMS_DB[e.idx], mod = e.mod != null ? ITEMS_DB[e.mod] : null;
        return `<div class="lt-item"><span class="lt-name">${escHtml(it[2])} <span class="lt-cost">(${it[3]})</span> ${cardBtnHtml(it[2], ITEM_CARD_BY_NAME)}
          ${mod ? `<span class="gn-mod">+ ${escHtml(mod[2])} (${mod[3]}) ${cardBtnHtml(mod[2], ITEM_CARD_BY_NAME)}</span>` : ''}</span>
          <span class="lt-meta">${escHtml(it[0])} · ${escHtml(it[1])}</span>
          <button type="button" class="ghost" data-gn-reroll="${pos}" title="Заменить на другой из этой же категории">🔁</button>
          <button type="button" class="ghost" data-gn-del="${pos}" title="Убрать">✕</button></div>`;
      }).join('')}</div>` : (r.note ? '' : '<div class="hint">Ничего не выпало — поднимите шансы.</div>')}
      <div class="gn-total">Итого: <b>${totalCost(r)}</b> caps</div>
      <div class="cu-foot" style="justify-content:flex-start"><button type="button" data-gn="again">🎲 Ещё раз</button><button type="button" data-gn="add">＋ Добавить в ростер</button></div>
      </div>${unitCardHtml(r)}</div></div>`;
  }
  function redraw() {
    if (!overlay) return;
    const list = curList();
    const units = list ? listUnits(list) : [];
    const box = overlay.querySelector('[data-gn=body]');
    box.innerHTML = `
      <div class="cu-sec"><div class="cu-sec-title">1. Кого генерировать</div>
        <div class="cu-row">
          <div><label>Фракция / список армии</label><select data-gn="list">${options()}</select></div>
          <div><label>Юнит</label><select data-gn="unit" ${list ? '' : 'disabled'}>
            <option value="">🎲 Случайный юнит</option>${units.map(u => `<option value="${escHtml(u.n)}" ${u.n === S.unitKey ? 'selected' : ''}>${escHtml(u.n)} (${u.p})</option>`).join('')}</select></div>
        </div></div>
      <div class="cu-sec"><div class="cu-sec-title">2. Шанс предметов</div>
        <div class="hint" style="margin:0 0 6px">Каждая ячейка — шанс (%), что юнит получит одну вещь из этого раздела и категории; какая именно — случайно из разрешённых его армии. Серые ячейки этому юниту недоступны.</div>
        <div class="gn-scroll">${gridHtml()}</div>
        <div class="cu-row" style="margin-top:8px">
          <div><label>Шанс мода на оружие/броню, %</label><input type="number" min="0" max="100" step="5" value="${S.modChance}" data-gn="mod"></div>
          <div><label>Макс. предметов</label><input type="number" min="0" max="30" value="${S.maxItems}" data-gn="max"></div>
        </div>
        <div class="cu-foot" style="justify-content:flex-start;margin-top:8px">
          <button type="button" class="ghost" data-gn="preset0">Всё 0%</button>
          <button type="button" class="ghost" data-gn="preset25">Всё 25%</button>
          <button type="button" class="ghost" data-gn="presetDef">Стандартный набор</button>
          <button type="button" data-gn="roll">🎲 Сгенерировать</button></div></div>
      ${resultHtml()}`;
  }

  async function open() {
    if (overlay) overlay.remove();
    overlay = document.createElement('div');
    overlay.className = 'cu-overlay';
    overlay.innerHTML = `<div class="cu-dialog" style="width:min(1000px,100%)">
      <div class="cu-head"><h2>🎲 Генератор юнита</h2><button class="ghost" data-gn="close">✕ Закрыть</button></div>
      <div data-gn="body"><div class="hint">Загружаю списки армий…</div></div></div>`;
    document.body.appendChild(overlay);
    const close = () => { overlay.remove(); overlay = null; document.removeEventListener('keydown', onKey); };
    const onKey = e => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    try { await load(); } catch (e) { overlay.querySelector('[data-gn=body]').textContent = 'Не удалось загрузить списки армий: ' + e.message; return; }
    redraw();

    overlay.addEventListener('change', e => {
      const t = e.target, d = t.dataset;
      if (d.gn === 'list') { S.listId = t.value; S.unitKey = ''; redraw(); }
      else if (d.gn === 'unit') { S.unitKey = t.value; redraw(); }
      else if (d.gn === 'mod') S.modChance = Math.min(100, Math.max(0, Number(t.value) || 0));
      else if (d.gn === 'max') S.maxItems = Math.min(30, Math.max(0, Number(t.value) || 0));
      else if (d.gnCell) S.grid[d.gnCell] = Math.min(100, Math.max(0, Number(t.value) || 0));
    });
    overlay.addEventListener('click', e => {
      if (e.target === overlay) { close(); return; }
      const b = e.target.closest('button');
      if (!b) return;
      const d = b.dataset;
      if (d.gn === 'close') close();
      else if (d.gn === 'roll' || d.gn === 'again') { generate(); redraw(); }
      else if (d.gn === 'add') { addToRoster(); redraw(); }
      else if (d.gn === 'preset0') { S.grid = {}; redraw(); }
      else if (d.gn === 'preset25') { S.grid = {}; cells().forEach((_, k) => { S.grid[k] = 25; }); redraw(); }
      else if (d.gn === 'presetDef') { S.grid = defaultGrid(); redraw(); }
      else if (d.gnReroll !== undefined) { rerollEntry(Number(d.gnReroll)); redraw(); }
      else if (d.gnDel !== undefined) { S.result.entries.splice(Number(d.gnDel), 1); redraw(); }
    });
  }

  global.FWWGen = { open };
})(window);
