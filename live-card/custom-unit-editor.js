// Custom-unit editor for the Master tab. Produces / edits a template object shaped exactly like an
// fww_unit_templates.json entry, so it renders through the same FWWCardRender/FWWEngine pipeline
// as any official unit. Requires engine.js + card-render.js to be loaded first.
(function (global) {
  'use strict';

  const ICONS_DIR = 'live-card/icons/';
  const STATS = ['S', 'P', 'E', 'C', 'I', 'A', 'L'];
  const STAT_NAMES = { S: 'Str', P: 'Per', E: 'End', C: 'Cha', I: 'Int', A: 'Agi', L: 'Luc' };
  const SKILLS = ['Battle Cry', 'Battle Cry resist', 'Computers', 'Health', 'Heavy Weapon', 'Lockpick',
    'Melee', 'Pistol', 'Presence', 'Rifle', 'Search', 'Thrown'];
  // only these skills have per-colour icons (presence_red.png, thrown_blue.png, ...) — the rest are one plain icon
  const COLOURED_SKILLS = new Set(['Battle Cry', 'Presence', 'Thrown']);
  const COLOURS = ['Orange', 'Yellow', 'Red', 'Green', 'Blue', 'Black'];
  const TYPES = ['creature', 'cryptid', 'dog', 'enclave', 'ghoul', 'gunner', 'mothman', 'robot', 'scorched', 'synth', 'turret', 'zetan'];
  const AWARENESS = ['awareness_black', 'awareness_blue', 'awareness_green', 'awareness_red', 'awareness_yellow'];
  // the small icon row at the bottom of a card (what actions the unit can take / can't take)
  const ACTION_ICONS = [
    ['action_point_use_reaction', 'AP: реакция'], ['action_point_use_expertise', 'AP: экспертиза'],
    ['action_point_use_movement', 'AP: перемещение'], ['action_point_use_move', 'AP: Move'],
    ['action_point_use_attack', 'AP: атака'], ['action_point_use_melee', 'AP: ближний бой'],
    ['action_point_use_pistol', 'AP: пистолет'], ['action_point_use_rifle', 'AP: винтовка'],
    ['action_point_use_ranged', 'AP: дальний бой'], ['action_point_use_heavy', 'AP: тяжёлое'],
    ['action_point_use_thrown', 'AP: метание'], ['action_point_use_charge', 'AP: рывок'],
    ['battle_cry_not', 'Battle Cry ✕'], ['climb_not', 'Лазание ✕'], ['difficult_terrain_not', 'Сложная местность ✕'],
    ['stun_not', 'Оглушение ✕'], ['poison_not', 'Яд ✕'], ['crippled_arm_not', 'Ранение руки ✕'],
    ['crippled_leg_not', 'Ранение ноги ✕'], ['fire_not', 'Огонь ✕'], ['frozen_not', 'Заморозка ✕'],
    ['fire_resistant', 'Огнеупорный'], ['poison_resist', 'Сопр. яду'], ['battle_cry_resist', 'Сопр. Battle Cry'],
    ['luck', 'Удача'], ['critical', 'Крит'], ['dog_handler', 'Дрессировщик'], ['melee', 'Ближний бой'], ['pistol', 'Пистолет'],
  ];

  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'); }
  function skillIcon(name, colour) {
    return ICONS_DIR + (colour ? `${name}_${colour}` : name).replace(/ /g, '_').toLowerCase() + '.png';
  }

  // The picker of [[icon]] codes for rule text. The list of icon files comes from data/icon_index.json
  // (built by build_icon_index.py — a static site can't list a folder), fetched once.
  let iconIndexPromise = null;
  function loadIconIndex() {
    if (!iconIndexPromise) {
      iconIndexPromise = fetch('live-card/data/icon_index.json').then(r => r.json())
        .catch(() => { iconIndexPromise = null; return null; });
    }
    return iconIndexPromise;
  }
  function iconGroupTitle(code) {
    const p = code.split('/');
    if (p.length === 1) return 'Основные';
    if (p[0] === 'dice') return 'Кубики: ' + p[1];
    return { 'status-selectors': 'Статусы', 'equipment-icons': 'Категории снаряжения', itw: 'ITW' }[p[0]] || p[0];
  }
  function copyText(text) {
    const legacy = () => new Promise((resolve, reject) => {
      const prev = document.activeElement;
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.cssText = 'position:fixed;opacity:0';
      document.body.appendChild(ta); ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { /* falls through to reject */ }
      ta.remove();
      if (prev && prev.focus) prev.focus();
      ok ? resolve() : reject(new Error('copy failed'));
    });
    if (global.navigator.clipboard && global.isSecureContext) return global.navigator.clipboard.writeText(text).catch(legacy);
    return legacy();
  }

  function blankTemplate() {
    const skills = {};
    SKILLS.forEach(s => { skills[s] = { stat: '', colour: '' }; });
    skills.Health.stat = 'E';
    return {
      name: { en: '' }, factions: [], types: [], unique: false, legendary: false, image: '',
      skills,
      stats: { S: 5, P: 5, E: 5, C: 5, I: 5, A: 5, L: 5 },
      armour: { physical: 0, physical_hard: 0, energy: 0, energy_hard: 0, radiation: 0, radiation_hard: 0 },
      move: { main: 'Move Yellow', charge: 'Charge Red' },
      awarenessIcon: 'awareness_black', specialIcons: [], specialRules: [], baseCost: 0,
    };
  }

  // Rules are free text (typed here, or copied from an official card and edited); card-render
  // feeds them to innerHTML after expanding [[icon|label]] tags. Official rules legitimately use a
  // few tags (<em>, <br>, <div class="aoe_icon ...">), so those survive; every other "<" is
  // neutralised, as is a bare "&".
  const SAFE_TAG = /^<\/?(em|b|br|div( class="[a-z0-9_ -]*")?)\s*\/?>/i;
  function sanitizeRule(r) {
    return String(r).replace(/&(?![a-z]+;|#\d+;)/gi, '&amp;').replace(/<[^]*?(?=<|$)/g, seg => {
      const m = seg.match(SAFE_TAG);
      return m ? m[0] + seg.slice(m[0].length).replace(/</g, '&lt;') : seg.replace(/</g, '&lt;');
    });
  }
  function toRenderTemplate(tpl) {
    const t = JSON.parse(JSON.stringify(tpl));
    t.specialRules = (t.specialRules || []).map(sanitizeRule);
    t._growToFit = true; // see card-render.js fitSpecialRulesFontScale: taller card instead of smaller text
    return t;
  }

  // a portrait is either a bare filename from the official database (live-card/portraits/) or an
  // inline data: URL from an uploaded picture
  function resolveImage(image) {
    if (!image) return '';
    return /^(data:|blob:|https?:)/i.test(image) ? image : 'live-card/portraits/' + image;
  }

  // Lets the user pick one of the unit portraits we already ship (every official unit's picture)
  function openPicker(onPick) {
    const list = global.FWWBridge && global.FWWBridge.listUnits ? global.FWWBridge.listUnits() : [];
    const pk = document.createElement('div');
    pk.className = 'cu-overlay cu-picker';
    pk.innerHTML = `<div class="cu-dialog"><div class="cu-head"><h2>Картинка из базы</h2><button class="ghost" data-pk="close">✕ Закрыть</button></div>
      <input type="text" data-pk="q" placeholder="Поиск по названию юнита…" autocomplete="off">
      <div class="cu-pgrid" data-pk="grid"></div></div>`;
    document.body.appendChild(pk);
    const grid = pk.querySelector('[data-pk="grid"]'), q = pk.querySelector('[data-pk="q"]');
    function draw() {
      const needle = q.value.trim().toLowerCase();
      const shown = list.filter(u => !needle || u.name.toLowerCase().includes(needle));
      grid.innerHTML = shown.map(u => `<button type="button" class="cu-ptile" data-img="${esc(u.image)}" title="${esc(u.name)}"><img loading="lazy" src="live-card/portraits/${esc(u.image)}" alt=""><span>${esc(u.name)}</span></button>`).join('')
        || `<div class="hint">${list.length ? 'Ничего не найдено.' : 'База ещё загружается — попробуйте через секунду.'}</div>`;
    }
    draw();
    q.addEventListener('input', draw);
    q.focus();
    function close() { global.removeEventListener('keydown', onKey, true); pk.remove(); }
    // capture phase + stopImmediatePropagation: Escape here must close only the picker, not the editor beneath
    function onKey(e) { if (e.key === 'Escape') { e.stopImmediatePropagation(); close(); } }
    global.addEventListener('keydown', onKey, true);
    pk.addEventListener('click', e => {
      const tile = e.target.closest('[data-img]');
      if (tile) { onPick(tile.dataset.img); close(); return; }
      if (e.target === pk || e.target.closest('[data-pk="close"]')) close();
    });
  }

  // square centre-crop, downscaled, inline data URL (webp keeps transparency at a fraction of PNG's size)
  function fileToPortrait(file) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onerror = reject;
      fr.onload = () => {
        const img = new Image();
        img.onerror = reject;
        img.onload = () => {
          const S = 320, c = document.createElement('canvas');
          c.width = c.height = S;
          const side = Math.min(img.width, img.height);
          c.getContext('2d').drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, S, S);
          let url = c.toDataURL('image/webp', 0.85);
          if (!url.startsWith('data:image/webp')) url = c.toDataURL('image/png');
          resolve(url);
        };
        img.src = fr.result;
      };
      fr.readAsDataURL(file);
    });
  }

  function open(opts) {
    const t = JSON.parse(JSON.stringify(opts.template || blankTemplate()));
    // make sure every expected key exists even for older/partial templates
    const base = blankTemplate();
    t.skills = Object.assign({}, base.skills, t.skills || {});
    t.stats = Object.assign({}, base.stats, t.stats || {});
    t.armour = Object.assign({}, base.armour, t.armour || {});
    t.specialIcons = t.specialIcons || []; t.specialRules = t.specialRules || []; t.types = t.types || [];
    t.factions = t.factions || [];

    const factionEntries = Object.entries(global.FWWCardRender.FACTION_SUBTITLES).filter(([, v]) => v);

    const overlay = document.createElement('div');
    overlay.className = 'cu-overlay';
    overlay.innerHTML = `
    <div class="cu-dialog" role="dialog">
      <div class="cu-head"><h2>${esc(opts.title || 'Свой юнит')}</h2><button class="ghost" data-cu="cancel">✕ Закрыть</button></div>
      <div class="cu-body">
        <div class="cu-form">
          <div class="cu-sec">
            <div class="cu-sec-title">1. Основное</div>
            <div class="cu-row">
              <div style="flex:3 1 220px"><label>Название</label><input type="text" data-f="name" maxlength="40" placeholder="Например: Raider Warlord"></div>
              ${opts.hideCost ? '' : '<div><label>Стоимость (caps)</label><input type="number" data-f="cost" min="0" step="1"></div>'}
            </div>
            <label>Картинка — из базы юнитов или своя (своя обрезается до квадрата по центру и хранится внутри сохранения)</label>
            <div class="cu-img-row">
              <div class="cu-img-thumb" data-cu="thumb"></div>
              <div><input type="file" accept="image/*" data-cu="file" style="display:none">
                <button data-cu="pickdb">Выбрать из базы…</button><button data-cu="pickimg">Загрузить свою…</button><button class="ghost" data-cu="delimg">Убрать</button></div>
            </div>
          </div>

          <div class="cu-sec">
            <div class="cu-sec-title">2. Тип и фракция</div>
            <label>Тип (значки справа от названия)</label>
            <div class="cu-chips">${TYPES.map(ty => `<label class="cu-chip" data-type="${ty}"><input type="checkbox"><img src="${ICONS_DIR}type_${ty}.png" alt="">${ty}</label>`).join('')}</div>
            <div class="cu-row">
              <div><label>Фракция (подпись под названием)</label>
                <select data-f="faction"><option value="">— нет —</option>${factionEntries.map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}</select></div>
              <div><label>Особые метки</label><div class="cu-chips">
                <label class="cu-chip" data-unique style="margin-top:0!important"><input type="checkbox"><img src="${ICONS_DIR}unique.png" alt="">Уникальный</label>
                <label class="cu-chip" data-legendary style="margin-top:0!important"><input type="checkbox"><img src="${ICONS_DIR}legendary.png" alt="">Легендарный</label></div></div>
            </div>
          </div>

          <div class="cu-sec">
            <div class="cu-sec-title">3. Движение</div>
            <div class="cu-row">
              <div><label>Move</label><select data-f="moveMain">${COLOURS.map(c => `<option>Move ${c}</option>`).join('')}</select></div>
              <div><label>Charge</label><select data-f="moveCharge">${COLOURS.map(c => `<option>Charge ${c}</option>`).join('')}</select></div>
            </div>
          </div>

          <div class="cu-sec">
            <div class="cu-sec-title">4. Характеристики и навыки</div>
            <div class="cu-stats">${STATS.map(s => `<div><label>${STAT_NAMES[s]}</label><input type="number" data-stat="${s}" min="-1" max="15" step="1"></div>`).join('')}</div>
            <div class="hint" style="margin:4px 0 8px">-1 показывается как «X» (характеристика недоступна), 0 — как «-».</div>
            <label>Навыки — к какой характеристике привязан каждый (значок появится рядом с ней на карте)</label>
            <div class="cu-skills">${SKILLS.map(sk => `
              <div class="cu-skill-name"><img data-skillimg="${esc(sk)}" src="${skillIcon(sk, '')}" alt="">${esc(sk)}</div>
              <select data-skill="${esc(sk)}" data-part="stat"><option value="">—</option>${STATS.map(s => `<option value="${s}">${STAT_NAMES[s]}</option>`).join('')}</select>
              ${COLOURED_SKILLS.has(sk)
                ? `<select class="cu-skill-colour" data-skill="${esc(sk)}" data-part="colour">${COLOURS.map(c => `<option>${c}</option>`).join('')}</select>`
                : '<span class="cu-skill-colour"></span>'}`).join('')}
            </div>
            <label style="margin-top:12px">Броня</label>
            <div class="cu-row">
              <div><label>Physical</label><input type="number" data-armour="physical" min="-1" max="15"></div>
              <div><label>Energy</label><input type="number" data-armour="energy" min="-1" max="15"></div>
              <div><label>Radiation</label><input type="number" data-armour="radiation" min="-1" max="15"></div>
            </div>
          </div>

          <div class="cu-sec">
            <div class="cu-sec-title">5. Особые свойства</div>
            <div data-cu="rules"></div>
            <button data-cu="addrule">+ Добавить свойство</button>
            <details class="cu-ipanel" data-cu="ipanel">
              <summary>🖼 Вставить значок в текст свойства</summary>
              <div class="hint">Поставьте курсор в тексте нужного свойства и кликните по значку — код вставится в это место. <b>Shift+клик</b> — только скопировать код в буфер.</div>
              <input type="text" data-cu="isearch" placeholder="Поиск значка по названию…" autocomplete="off">
              <div class="cu-istatus" data-cu="istatus"></div>
              <div class="cu-igrid" data-cu="igrid"></div>
            </details>
            <div class="hint">Каждое свойство — отдельный абзац. Значок в тексте: <b>[[damage|Damage]]</b>, <b>[[rifle|Rifle]]</b>, <b>[[aura|Aura]]</b> — вместо этого фрагмента на карте будет иконка. Разрешены также <b>&lt;em&gt;</b> (курсив, как «Yellow»/«Orange» на картах) и <b>&lt;br&gt;</b> (перенос строки).</div>
          </div>

          <div class="cu-sec">
            <div class="cu-sec-title">6. Доступные действия (значки внизу карты)</div>
            <label>Осведомлённость (глаз)</label>
            <select data-f="awareness"><option value="">— нет —</option>${AWARENESS.map(a => `<option value="${a}">${a.replace('awareness_', '')}</option>`).join('')}</select>
            <label>Значки действий</label>
            <div class="cu-chips">${ACTION_ICONS.map(([id, label]) => `<button type="button" class="cu-icon-btn" data-icon="${id}" title="${id}"><img src="${ICONS_DIR}${id}.png" alt="">${esc(label)}</button>`).join('')}</div>
          </div>

          <div class="cu-err" data-cu="err"></div>
          <div class="cu-foot"><button class="ghost" data-cu="cancel">Отмена</button><button data-cu="save">✓ Сохранить юнита</button></div>
        </div>
        <div class="cu-preview"><div class="cu-preview-box"><div class="cu-preview-inner" data-cu="preview"></div></div></div>
      </div>
    </div>`;
    document.body.appendChild(overlay);
    const $ = sel => overlay.querySelector(sel);
    const $$ = sel => overlay.querySelectorAll(sel);

    function refreshPreview() {
      const host = $('[data-cu="preview"]');
      const shown = JSON.parse(JSON.stringify(t));
      if (!shown.name.en) shown.name.en = 'Без названия';
      const cost = opts.hideCost ? opts.previewCost : t.baseCost;
      try { host.innerHTML = global.FWWCardRender.buildCardHtml(toRenderTemplate(shown), [], 'live-card/', { cost }); }
      catch (e) { host.textContent = 'Не удалось построить предпросмотр: ' + e.message; }
      fitPreviewScale();
    }
    // Preview at true size (text on the card is 18px — shrinking it made it hard to judge), only
    // scaled down when the window is too short to show the whole 620px card.
    function fitPreviewScale() {
      const card = $('[data-cu="preview"] .fww-live-card');
      const ch = card ? card.offsetHeight : 620;
      const sc = Math.max(0.6, Math.min(1, (global.innerHeight - 70) / ch));
      const box = $('.cu-preview-box'), inner = $('[data-cu="preview"]');
      box.style.width = Math.round(450 * sc) + 'px'; box.style.height = Math.round(ch * sc) + 'px';
      inner.style.transform = 'scale(' + sc + ')';
    }
    fitPreviewScale();
    global.addEventListener('resize', fitPreviewScale);
    let previewTimer = null;
    function schedulePreview() { clearTimeout(previewTimer); previewTimer = setTimeout(refreshPreview, 120); }

    function refreshThumb() {
      $('[data-cu="thumb"]').innerHTML = t.image ? `<img src="${esc(resolveImage(t.image))}" alt="">` : 'нет картинки';
    }
    function renderRules() {
      $('[data-cu="rules"]').innerHTML = t.specialRules.map((r, i) => `
        <div class="cu-rule"><textarea data-rule="${i}" placeholder="НАЗВАНИЕ: описание свойства…">${esc(r)}</textarea>
        <button class="danger" data-delrule="${i}" title="Убрать">✕</button></div>`).join('') || '<div class="hint">Свойств пока нет.</div>';
    }
    function syncSkillControls() {
      SKILLS.forEach(sk => {
        const st = $(`select[data-skill="${sk}"][data-part="stat"]`);
        const col = $(`select[data-skill="${sk}"][data-part="colour"]`);
        st.value = t.skills[sk].stat || '';
        if (col) { col.value = t.skills[sk].colour || 'Yellow'; col.disabled = !t.skills[sk].stat; }
        const img = $(`img[data-skillimg="${sk}"]`);
        if (img) img.src = skillIcon(sk, COLOURED_SKILLS.has(sk) ? (t.skills[sk].colour || 'Yellow') : '');
      });
    }

    // ---- initial values ----
    $('[data-f="name"]').value = t.name.en || '';
    if ($('[data-f="cost"]')) $('[data-f="cost"]').value = t.baseCost || 0;
    $('[data-f="faction"]').value = (t.factions.find(f => global.FWWCardRender.FACTION_SUBTITLES[f]) || '');
    $('[data-f="moveMain"]').value = t.move.main;
    $('[data-f="moveCharge"]').value = t.move.charge;
    $('[data-f="awareness"]').value = t.awarenessIcon || '';
    STATS.forEach(s => { $(`[data-stat="${s}"]`).value = t.stats[s]; });
    ['physical', 'energy', 'radiation'].forEach(k => { $(`[data-armour="${k}"]`).value = t.armour[k]; });
    $$('[data-type]').forEach(chip => {
      const on = t.types.map(x => String(x).toLowerCase()).includes(chip.dataset.type);
      chip.classList.toggle('on', on); chip.querySelector('input').checked = on;
    });
    $('[data-unique]').classList.toggle('on', !!t.unique);
    $('[data-unique] input').checked = !!t.unique;
    $('[data-legendary]').classList.toggle('on', !!t.legendary);
    $('[data-legendary] input').checked = !!t.legendary;
    $$('[data-icon]').forEach(b => b.classList.toggle('on', t.specialIcons.includes(b.dataset.icon)));
    refreshThumb(); renderRules(); syncSkillControls(); refreshPreview();

    function close() { clearTimeout(previewTimer); global.removeEventListener('resize', fitPreviewScale); overlay.remove(); document.removeEventListener('keydown', onKey); }
    function onKey(e) { if (e.key === 'Escape') close(); }
    document.addEventListener('keydown', onKey);

    // ---- icon picker for rule text ----
    // Which rule box the picker writes into = the last one the user had the text cursor in.
    let lastRule = null;
    // focusin alone isn't enough: it doesn't fire when the page itself isn't focused
    ['focusin', 'input', 'click', 'keyup'].forEach(ev => overlay.addEventListener(ev, e => {
      if (e.target.dataset && e.target.dataset.rule !== undefined) lastRule = e.target;
    }));
    const iStatus = $('[data-cu="istatus"]'), iGrid = $('[data-cu="igrid"]'), iSearch = $('[data-cu="isearch"]');
    function iconTile(code) {
      return `<button type="button" class="cu-itile" data-ic="${esc(code)}" title="[[${esc(code)}]]"><img loading="lazy" src="${ICONS_DIR}${esc(code)}.png" alt=""><span>${esc(code)}</span></button>`;
    }
    function drawIcons(idx) {
      if (!idx) { iGrid.innerHTML = '<div class="hint">Не удалось загрузить список значков (data/icon_index.json).</div>'; return; }
      const needle = iSearch.value.trim().toLowerCase();
      if (needle) {
        const hits = idx.icons.filter(c => c.toLowerCase().includes(needle));
        iGrid.innerHTML = hits.length ? hits.slice(0, 200).map(iconTile).join('') + (hits.length > 200 ? '<div class="hint">Показаны первые 200 — уточните поиск.</div>' : '')
          : '<div class="hint">Ничего не найдено.</div>';
        return;
      }
      const groups = new Map();
      idx.icons.forEach(c => { const g = iconGroupTitle(c); if (!groups.has(g)) groups.set(g, []); groups.get(g).push(c); });
      let html = `<div class="cu-igroup">Частые</div>${idx.common.map(iconTile).join('')}`;
      groups.forEach((list, g) => { html += `<div class="cu-igroup">${esc(g)} (${list.length})</div>${list.map(iconTile).join('')}`; });
      iGrid.innerHTML = html;
    }
    $('[data-cu="ipanel"]').addEventListener('toggle', e => { if (e.target.open && !iGrid.children.length) loadIconIndex().then(drawIcons); });
    iSearch.addEventListener('input', () => loadIconIndex().then(drawIcons));
    // mousedown would move focus off the text box and lose the cursor — keep it there
    iGrid.addEventListener('mousedown', e => { if (e.target.closest('.cu-itile')) e.preventDefault(); });
    function insertIcon(code) {
      let ta = lastRule && overlay.contains(lastRule) ? lastRule : null;
      const fromCursor = !!ta;
      if (!ta) ta = Array.from($$('[data-rule]')).pop();
      if (!ta) { t.specialRules.push(''); renderRules(); ta = Array.from($$('[data-rule]')).pop(); }
      const tag = `[[${code}]]`;
      // never clicked into any box: append to the last one instead of guessing a position
      const start = fromCursor ? ta.selectionStart : ta.value.length;
      const end = fromCursor ? ta.selectionEnd : ta.value.length;
      ta.value = ta.value.slice(0, start) + tag + ta.value.slice(end);
      ta.focus(); ta.setSelectionRange(start + tag.length, start + tag.length);
      lastRule = ta;
      ta.dispatchEvent(new Event('input', { bubbles: true })); // updates t.specialRules + preview
      iStatus.textContent = 'Вставлено: ' + tag;
    }
    iGrid.addEventListener('click', e => {
      const tile = e.target.closest('.cu-itile');
      if (!tile) return;
      const code = tile.dataset.ic;
      if (e.shiftKey) {
        copyText(`[[${code}]]`).then(() => { iStatus.textContent = 'Скопировано в буфер: [[' + code + ']]'; },
          () => { iStatus.textContent = 'Не удалось скопировать — код: [[' + code + ']]'; });
      } else insertIcon(code);
    });

    // ---- events ----
    overlay.addEventListener('input', e => {
      const el = e.target;
      if (el.dataset.f === 'name') t.name.en = el.value;
      else if (el.dataset.f === 'cost') t.baseCost = Math.max(0, Number(el.value) || 0);
      else if (el.dataset.stat) t.stats[el.dataset.stat] = el.value === '' ? 0 : Number(el.value);
      else if (el.dataset.armour) t.armour[el.dataset.armour] = el.value === '' ? 0 : Number(el.value);
      else if (el.dataset.rule !== undefined) t.specialRules[Number(el.dataset.rule)] = el.value;
      else return;
      schedulePreview();
    });
    overlay.addEventListener('change', e => {
      const el = e.target;
      if (el.dataset.f === 'faction') t.factions = el.value ? [el.value] : [];
      else if (el.dataset.f === 'moveMain') t.move.main = el.value;
      else if (el.dataset.f === 'moveCharge') t.move.charge = el.value;
      else if (el.dataset.f === 'awareness') t.awarenessIcon = el.value;
      else if (el.dataset.skill) {
        const sk = el.dataset.skill;
        if (el.dataset.part === 'stat') {
          t.skills[sk].stat = el.value;
          if (COLOURED_SKILLS.has(sk)) t.skills[sk].colour = el.value ? (t.skills[sk].colour || 'Yellow') : '';
        } else t.skills[sk].colour = el.value;
        syncSkillControls();
      } else if (el.dataset.cu === 'file') {
        const file = el.files && el.files[0];
        if (!file) return;
        fileToPortrait(file).then(url => { t.image = url; refreshThumb(); refreshPreview(); })
          .catch(() => { $('[data-cu="err"]').textContent = 'Не удалось прочитать картинку.'; });
        el.value = '';
        return;
      } else return;
      refreshPreview();
    });
    overlay.addEventListener('click', e => {
      const chip = e.target.closest('[data-type],[data-unique],[data-legendary]');
      if (chip) {
        e.preventDefault();
        if (chip.hasAttribute('data-unique')) { t.unique = !t.unique; chip.classList.toggle('on', t.unique); chip.querySelector('input').checked = t.unique; }
        else if (chip.hasAttribute('data-legendary')) { t.legendary = !t.legendary; chip.classList.toggle('on', t.legendary); chip.querySelector('input').checked = t.legendary; }
        else {
          const ty = chip.dataset.type, on = !t.types.map(x => String(x).toLowerCase()).includes(ty);
          t.types = on ? [...t.types, ty] : t.types.filter(x => String(x).toLowerCase() !== ty);
          chip.classList.toggle('on', on); chip.querySelector('input').checked = on;
        }
        refreshPreview();
        return;
      }
      const iconBtn = e.target.closest('[data-icon]');
      if (iconBtn) {
        const id = iconBtn.dataset.icon, on = !t.specialIcons.includes(id);
        const known = ACTION_ICONS.map(a => a[0]);
        const extras = t.specialIcons.filter(x => !known.includes(x));
        t.specialIcons = known.filter(x => x === id ? on : t.specialIcons.includes(x)).concat(extras);
        iconBtn.classList.toggle('on', on);
        refreshPreview();
        return;
      }
      const del = e.target.closest('[data-delrule]');
      if (del) { t.specialRules.splice(Number(del.dataset.delrule), 1); renderRules(); refreshPreview(); return; }
      const cu = e.target.closest('[data-cu]');
      if (!cu) { if (e.target === overlay) close(); return; }
      const act = cu.dataset.cu;
      if (act === 'cancel') close();
      else if (act === 'pickimg') $('[data-cu="file"]').click();
      else if (act === 'pickdb') openPicker(img => { t.image = img; refreshThumb(); refreshPreview(); });
      else if (act === 'delimg') { t.image = ''; refreshThumb(); refreshPreview(); }
      else if (act === 'addrule') { t.specialRules.push(''); renderRules(); refreshPreview(); const tas = $$('[data-rule]'); if (tas.length) tas[tas.length - 1].focus(); }
      else if (act === 'save') {
        const name = (t.name.en || '').trim();
        if (!name) { $('[data-cu="err"]').textContent = 'Введите название юнита.'; $('[data-f="name"]').focus(); return; }
        const out = JSON.parse(JSON.stringify(t));
        out.name.en = name;
        out.specialRules = out.specialRules.map(r => r.trim()).filter(Boolean);
        out.factions = out.factions.filter(Boolean);
        // colours only make sense while the skill is bound to a stat
        SKILLS.forEach(sk => { if (!out.skills[sk].stat) out.skills[sk].colour = ''; });
        close();
        opts.onSave(out);
      }
    });
  }

  global.FWWCustomUnit = { open, blankTemplate, toRenderTemplate, STATS, STAT_NAMES };
})(window);
