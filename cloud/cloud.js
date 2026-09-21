// Cloud save (Google Sheets via an Apps Script web app — see apps-script/Code.gs) + the login screen.
// Identity = name + access code, remembered in localStorage. The settlement is stored in separate
// parts (settlement / squad / warehouse / master) so no single spreadsheet cell hits its size limit,
// and the Master tab is only offered to players flagged isMaster in the sheet's «Игроки» tab.
// Relies on the host page's globals (state, saveState, render, toast, applyLoadedState) at call time.
(function (global) {
  'use strict';

  // Fill in after deploying apps-script/Code.gs (Deploy → Web app → copy the /exec URL). While this
  // is empty the builder behaves exactly as before: no login screen, Master tab always available.
  const API_URL = 'https://script.google.com/macros/s/AKfycbw4nrUNX7J7TXf4Hlh3EFifzp6VTd1TPSZO6dVD8HQ6MQuq4itIRRAVyA_EabJwoukScg/exec';

  const ID_KEY = 'homestead-identity';
  const PARTS = ['settlement', 'squad', 'warehouse', 'master'];
  const CHUNK = 45000, MAX_CHUNKS = 3; // must match CELL_MAX / CHUNKS in Code.gs
  let identity = null; // {name, code, isMaster}

  function enabled() { return !!API_URL; }
  // Guest = "continue without logging in": per-tab-session flag (sessionStorage), so a new visit asks to log in again.
  // Works on a separate scratch copy of the state (see stateKey() in index.html); never touches the cloud.
  const GUEST_KEY = 'homestead-guest';
  function isGuest() { try { return sessionStorage.getItem(GUEST_KEY) === '1'; } catch (e) { return false; } }
  function loadIdentity() {
    try { const v = JSON.parse(localStorage.getItem(ID_KEY) || 'null'); return v && v.name && v.code ? v : null; } catch (e) { return null; }
  }
  function storeIdentity() {
    try { localStorage.setItem(ID_KEY, JSON.stringify(identity)); } catch (e) { /* private mode: identity just lasts this session */ }
  }
  // Master tab: offered when the cloud isn't configured (nothing to gate on), or the sheet says so.
  function canMaster() { return !enabled() || (!isGuest() && !!(identity && identity.isMaster)); }

  // ---------- transport ----------
  function api(payload) {
    // plain-string body, NO Content-Type header: anything else triggers a CORS preflight that Apps Script doesn't answer
    // credentials:'omit' — don't send Google cookies: with several Google accounts signed in, the cookies make
    // script.google.com answer with an HTML "unable to open the file" page instead of the JSON
    return fetch(API_URL, { method: 'POST', body: JSON.stringify(payload), credentials: 'omit' })
      .then(r => r.text().then(t => {
        let j;
        try { j = JSON.parse(t); } catch (e) { throw new Error('сервер вернул не JSON (HTTP ' + r.status + '): ' + t.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120)); }
        if (!j.ok) throw new Error(j.error || 'Ошибка сервера');
        return j.result;
      }));
  }

  // ---------- split / merge ----------
  const isMasterHolder = inst => typeof inst.holder === 'number' && inst.holder < 0;
  function splitState(st) {
    const { squad, master, warehouse, ...settlement } = st;
    const wItems = {}, mItems = {};
    Object.entries((warehouse && warehouse.items) || {}).forEach(([id, inst]) => { (isMasterHolder(inst) ? mItems : wItems)[id] = inst; });
    return { settlement, squad, warehouse: { ...warehouse, items: wItems }, master: { master, items: mItems } };
  }
  function mergeState(parts, localMaster) {
    const warehouse = parts.warehouse || { nextInstId: 1, items: {} };
    const items = { ...(warehouse.items || {}) };
    let master = localMaster;
    if (parts.master) { Object.assign(items, parts.master.items || {}); master = parts.master.master; }
    return { ...(parts.settlement || {}), squad: parts.squad, warehouse: { ...warehouse, items }, master };
  }

  // ---------- gzip + base64 + chunks ----------
  function bytesToB64(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function b64ToBytes(b64) {
    const s = atob(b64), out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }
  async function encodePart(name, obj) {
    const json = JSON.stringify(obj);
    let text;
    if (typeof CompressionStream !== 'undefined') {
      const gz = new Blob([new TextEncoder().encode(json)]).stream().pipeThrough(new CompressionStream('gzip'));
      text = 'gz1:' + bytesToB64(new Uint8Array(await new Response(gz).arrayBuffer()));
    } else text = 'raw:' + json;
    const chunks = [];
    for (let i = 0; i < text.length; i += CHUNK) chunks.push(text.slice(i, i + CHUNK));
    if (chunks.length > MAX_CHUNKS) throw new Error(`Часть «${name}» слишком большая для таблицы (${text.length} симв., максимум ${CHUNK * MAX_CHUNKS}).`);
    return chunks;
  }
  async function decodePart(chunks) {
    const text = chunks.join('');
    if (text.startsWith('raw:')) return JSON.parse(text.slice(4));
    if (!text.startsWith('gz1:')) throw new Error('Неизвестный формат данных в таблице.');
    const ds = new Blob([b64ToBytes(text.slice(4))]).stream().pipeThrough(new DecompressionStream('gzip'));
    return JSON.parse(await new Response(ds).text());
  }

  // `state` is a top-level `let` in the host page's script — visible by name to other classic scripts, but not as window.state
  const curState = () => (typeof state !== 'undefined' ? state : {});

  // ---------- actions ----------
  function localHasContent() {
    const s = curState();
    return Object.keys(s.structures || {}).length || Object.keys((s.squad || {}).members || {}).length ||
      Object.keys((s.master || {}).members || {}).length || Object.keys(((s.warehouse || {}).items) || {}).length;
  }
  function fmtDate(iso) {
    const d = new Date(iso);
    return isNaN(d) ? '' : d.toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' });
  }
  function busy(on) {
    document.querySelectorAll('#cloudBar button').forEach(b => { b.disabled = on; });
  }
  const say = (m, err) => (global.toast ? global.toast(m, err) : console.log(m));

  // ---------- autosave ----------
  // Every saveState() in the host page calls onChange(); a few seconds after the LAST change the whole
  // state is pushed to the cloud. identity.syncedAt = the cloud version this browser's data is based on;
  // the server refuses to overwrite a newer one (another device saved meanwhile) and we ask what to do.
  const DEBOUNCE_MS = 8000, RETRY_MS = 30000;
  let dirty = false, saving = false, timer = null, suppress = 0, paused = false, status = { text: '', cls: '' };
  const clock = () => new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  function setStatus(text, cls) {
    status = { text, cls: cls || '' };
    const el = document.getElementById('clStatus');
    if (el) { el.textContent = text; el.className = 'cl-status ' + (cls || ''); }
  }
  function schedule(ms) { clearTimeout(timer); timer = setTimeout(() => saveToCloud({ auto: true }), ms); }
  function onChange() {
    if (!enabled() || !identity || suppress) return;
    dirty = true;
    if (paused) return; // unresolved conflict: keep the data marked dirty, don't hammer the server
    setStatus('… изменения', 'pending');
    schedule(DEBOUNCE_MS);
  }
  global.addEventListener('beforeunload', e => {
    if (enabled() && identity && (dirty || saving)) { e.preventDefault(); e.returnValue = ''; }
  });

  async function saveToCloud(opts) {
    opts = opts || {};
    if (!identity) return showLogin({ required: false });
    if (saving) { dirty = true; return; }
    clearTimeout(timer);
    saving = true; dirty = false;
    let retryable = false;
    setStatus('⏳ сохраняю…', 'saving');
    if (!opts.auto) busy(true);
    try {
      const sp = splitState(curState());
      const parts = {};
      for (const p of PARTS) {
        if (p === 'master' && !identity.isMaster) continue;
        parts[p] = await encodePart(p, sp[p]);
      }
      const res = await api({ action: 'save', name: identity.name, code: identity.code, parts,
        expectedUpdatedAt: identity.syncedAt || null, force: !!opts.force });
      identity.isMaster = !!res.isMaster;
      if (res.conflict) {
        dirty = true; paused = true;
        setStatus('⚠ конфликт версий', 'warn');
        askConflict(res.updatedAt);
      } else {
        paused = false;
        identity.syncedAt = res.updatedAt;
        setStatus('☁ ✓ сохранено ' + clock(), 'ok');
        if (!opts.auto) say('Сохранено в облако ✓');
      }
      storeIdentity(); refreshBar();
    } catch (e) {
      dirty = true;
      retryable = /Failed to fetch|не JSON|NetworkError/i.test(e.message);
      setStatus(retryable ? '⚠ нет связи — повторю' : '⚠ ' + e.message, 'warn');
      if (!opts.auto || !retryable) say('Не удалось сохранить: ' + e.message, true);
      if (retryable) schedule(RETRY_MS);
    }
    saving = false;
    busy(false);
    if (dirty && !paused && !retryable) schedule(DEBOUNCE_MS); // changed while we were saving
  }

  // Another device saved after this one last synced: let the player choose, never overwrite silently.
  function askConflict(cloudTime) {
    const box = document.createElement('div');
    box.className = 'cl-overlay';
    box.innerHTML = `<div class="cl-crt"></div><div class="cl-box">
      <div class="cl-title" style="margin-top:0">⚠ КОНФЛИКТ ВЕРСИЙ</div>
      <div class="cl-hint" style="font-size:13px;color:#14f074">В облаке более новое сохранение (${fmtDate(cloudTime)}) — вы, скорее всего, играли с другого устройства. Что сделать?</div>
      <div class="cl-actions" style="flex-direction:column;margin-top:14px">
        <button type="button" data-cl="cload">⬇ ЗАГРУЗИТЬ ИЗ ОБЛАКА<br><small>(изменения здесь будут потеряны)</small></button>
        <button type="button" data-cl="cforce">⬆ ПЕРЕЗАПИСАТЬ ОБЛАКО МОИМ<br><small>(то, что в облаке, будет потеряно)</small></button>
        <button type="button" class="cl-ghost" data-cl="clater">РАЗБЕРУСЬ ПОТОМ</button>
      </div></div>`;
    document.body.appendChild(box);
    const q = s => box.querySelector('[data-cl=' + s + ']');
    q('cload').onclick = () => { box.remove(); loadFromCloud(false); };
    q('cforce').onclick = () => { box.remove(); paused = false; saveToCloud({ force: true }); };
    q('clater').onclick = () => { box.remove(); setStatus('⚠ не сохранено (конфликт)', 'warn'); };
  }

  async function loadFromCloud(silent) {
    if (!identity) return showLogin({ required: false });
    busy(true); if (!silent) say('Загружаю из облака…');
    try {
      const res = await api({ action: 'load', name: identity.name, code: identity.code });
      identity.isMaster = !!res.isMaster; storeIdentity();
      const decoded = {};
      for (const p of PARTS) if (res.parts[p] && res.parts[p].length) decoded[p] = await decodePart(res.parts[p]);
      if (!decoded.settlement) { say('В облаке ещё нет сохранения.', true); busy(false); refreshBar(); return; }
      suppress++; // applyLoadedState() calls saveState(); that must not bounce straight back to the cloud
      try { global.applyLoadedState(mergeState(decoded, curState().master)); } finally { suppress--; }
      clearTimeout(timer); dirty = false; paused = false;
      identity.syncedAt = res.updatedAt; storeIdentity();
      setStatus('☁ ✓ загружено ' + clock(), 'ok');
      refreshBar();
      say('Загружено из облака ✓ ' + fmtDate(res.updatedAt));
    } catch (e) { say('Не удалось загрузить: ' + e.message, true); }
    busy(false);
  }

  // ---------- guest mode ----------
  function replaceLocalState(parsed) {
    suppress++; // applyLoadedState() calls saveState(); nothing here goes to the cloud
    try { global.applyLoadedState(parsed); } finally { suppress--; }
  }
  async function enterGuest() {
    if (identity && (dirty || saving)) { try { await saveToCloud({ auto: true }); } catch (e) { /* stays in this browser's own copy */ } }
    clearTimeout(timer); dirty = false; paused = false; setStatus('');
    identity = null;
    try { sessionStorage.setItem(GUEST_KEY, '1'); } catch (e) { /* ignore */ }
    try { localStorage.removeItem(global.stateKey()); } catch (e) { /* ignore */ }
    replaceLocalState({}); // a fresh, empty settlement — the player's own local data is left untouched under its own key
    refreshBar();
    say('Гостевой режим: данные только в этом браузере и не уходят в облако.');
  }
  function leaveGuest() {
    try { sessionStorage.removeItem(GUEST_KEY); } catch (e) { /* ignore */ }
    let raw = null;
    try { raw = localStorage.getItem(global.stateKey()); } catch (e) { /* ignore */ }
    let parsed = {};
    try { parsed = raw ? JSON.parse(raw) : {}; } catch (e) { /* unreadable: start fresh */ }
    replaceLocalState(parsed); // back to this browser's own (non-guest) data
  }

  // ---------- login screen ----------
  let overlay = null;
  function showLogin(opts) {
    opts = opts || {};
    let mode = 'login'; // 'login' | 'register'  — creating a player is a separate, explicit action
    if (overlay) overlay.remove();
    overlay = document.createElement('div');
    overlay.className = 'cl-overlay';
    overlay.innerHTML = `
      <div class="cl-crt"></div>
      <form class="cl-box" autocomplete="off">
        <div class="cl-logo">☢ VAULT-TEC</div>
        <div class="cl-title">HOMESTEAD // LAYOUT TERMINAL</div>
        <div class="cl-tabs">
          <button type="button" data-cl="tab-login" class="on">ВОЙТИ</button>
          <button type="button" data-cl="tab-register">СОЗДАТЬ ИГРОКА</button>
        </div>
        <div class="cl-boot" data-cl="boot"></div>
        <label>ИДЕНТИФИКАТОР (имя)</label>
        <input type="text" name="cl-name" maxlength="40" spellcheck="false" autocomplete="off" data-cl="name">
        <label>КОД ДОСТУПА</label>
        <input type="text" name="cl-code" maxlength="60" spellcheck="false" autocomplete="off" data-cl="code">
        <div data-cl="code2-wrap" style="display:none">
          <label>КОД ДОСТУПА ЕЩЁ РАЗ</label>
          <input type="text" name="cl-code2" maxlength="60" spellcheck="false" autocomplete="off" data-cl="code2">
        </div>
        <div class="cl-hint" data-cl="hint"></div>
        <div class="cl-err" data-cl="err"></div>
        <div class="cl-actions">
          <button type="submit" data-cl="go">▶ ВОЙТИ</button>
          ${opts.required ? '' : '<button type="button" class="cl-ghost" data-cl="cancel">ОТМЕНА</button>'}
        </div>
        ${isGuest() ? '' : `<div class="cl-guest"><button type="button" class="cl-ghost" data-cl="guest">👤 ПРОДОЛЖИТЬ БЕЗ ВХОДА</button></div>`}
      </form>`;
    document.body.appendChild(overlay);
    const $ = s => overlay.querySelector(s);
    const nameEl = $('[data-cl=name]'), codeEl = $('[data-cl=code]'), code2El = $('[data-cl=code2]'), err = $('[data-cl=err]'), go = $('[data-cl=go]');
    const HINTS = {
      login: 'Введите имя и код, с которыми вы уже создавали игрока. Впервые здесь — откройте «СОЗДАТЬ ИГРОКА».',
      register: 'Придумайте имя и код: с любого устройства введите те же и найдёте свой лагерь. Код введите дважды, чтобы не ошибиться. Не используйте настоящие пароли.',
    };
    function setMode(m) {
      mode = m;
      $('[data-cl=tab-login]').classList.toggle('on', m === 'login');
      $('[data-cl=tab-register]').classList.toggle('on', m === 'register');
      $('[data-cl=code2-wrap]').style.display = m === 'register' ? '' : 'none';
      $('[data-cl=hint]').textContent = HINTS[m];
      go.textContent = m === 'login' ? '▶ ВОЙТИ' : '▶ СОЗДАТЬ';
      err.textContent = '';
    }
    $('[data-cl=tab-login]').onclick = () => setMode('login');
    $('[data-cl=tab-register]').onclick = () => setMode('register');
    setMode('login');
    const known = identity || loadIdentity();
    if (known) nameEl.value = known.name;
    typeBoot($('[data-cl=boot]'));
    (nameEl.value ? codeEl : nameEl).focus();
    const guestBtn = $('[data-cl=guest]');
    if (guestBtn) guestBtn.onclick = () => { overlay.remove(); overlay = null; enterGuest(); };
    const cancel = $('[data-cl=cancel]');
    if (cancel) cancel.onclick = () => { overlay.remove(); overlay = null; };
    $('form').onsubmit = async e => {
      e.preventDefault();
      const name = nameEl.value.trim(), code = codeEl.value;
      if (!name || !code) { err.textContent = 'ОШИБКА: введите имя и код доступа.'; return; }
      if (mode === 'register' && code !== code2El.value) { err.textContent = 'ОШИБКА: коды не совпадают.'; return; }
      go.disabled = true; err.textContent = ''; $('[data-cl=boot]').textContent = '> СВЯЗЬ С СЕРВЕРОМ… (первый запрос может занять несколько секунд)';
      try {
        const res = await api({ action: mode, name, code });
        if (isGuest()) leaveGuest(); // the guest scratch copy is dropped; this browser's own data comes back
        identity = { name, code, isMaster: !!res.isMaster, syncedAt: null };
        storeIdentity();
        overlay.remove(); overlay = null;
        refreshBar();
        if (global.render) global.render();
        say('Добро пожаловать, ' + name + (identity.isMaster ? ' ♛' : '') + '.');
        if (res.hasSave) {
          if (!localHasContent() || confirm('В облаке есть сохранение от ' + fmtDate(res.updatedAt) + '.\nЗагрузить его? Текущее состояние в этом браузере будет заменено.\n(«Отмена» — оставить текущее: оно перезапишет облако.)')) loadFromCloud(true);
          else { identity.syncedAt = res.updatedAt; storeIdentity(); onChange(); } // deliberate choice to overwrite
        } else if (localHasContent()) onChange(); // brand-new player with an existing local settlement: upload it
      } catch (ex) {
        go.disabled = false;
        err.textContent = 'ОШИБКА: ' + (ex.message === 'Failed to fetch' ? 'нет связи с сервером.' : ex.message);
        typeBoot($('[data-cl=boot]'));
      }
    };
  }
  function typeBoot(el) {
    const lines = ['> ROBCO INDUSTRIES (TM) TERMLINK', '> ВВЕДИТЕ ИДЕНТИФИКАТОР И КОД ДОСТУПА_'];
    el.textContent = '';
    let li = 0, ci = 0;
    (function tick() {
      if (!el.isConnected || li >= lines.length) return;
      el.textContent += lines[li][ci++];
      if (ci >= lines[li].length) { el.textContent += '\n'; li++; ci = 0; }
      setTimeout(tick, 14);
    })();
  }

  // ---------- header bar ----------
  function refreshBar() {
    const bar = document.getElementById('cloudBar');
    if (!bar) return;
    bar.style.display = enabled() ? 'inline-flex' : 'none';
    if (!enabled()) return;
    bar.innerHTML = isGuest()
      ? `<span class="cl-who" title="Данные гостя живут только в этом браузере и не сохраняются в облако">👤 Гость</span>
         <button type="button" data-cl="switch" title="Войти или создать игрока">☁ Войти</button>`
      : identity
      ? `<span class="cl-who" title="Вы вошли как ${identity.name}">☁ ${identity.name.replace(/</g, '&lt;')}${identity.isMaster ? ' ♛' : ''}</span>
         <span id="clStatus" class="cl-status ${status.cls}">${status.text}</span>
         <button type="button" data-cl="save" title="Сохранить всё в облако прямо сейчас (обычно это происходит само через несколько секунд после изменений)">⬆ В облако</button>
         <button type="button" data-cl="load" title="Заменить текущее состояние сохранением из облака">⬇ Из облака</button>
         <button type="button" data-cl="switch" title="Сменить игрока">⎋</button>`
      : `<button type="button" data-cl="switch">☁ Войти</button>`;
    const b = s => bar.querySelector('[data-cl=' + s + ']');
    if (b('save')) b('save').onclick = saveToCloud;
    if (b('load')) b('load').onclick = () => { if (!localHasContent() || confirm('Заменить текущее состояние сохранением из облака?')) loadFromCloud(false); };
    if (b('switch')) b('switch').onclick = () => showLogin({ required: false });
    const mb = document.getElementById('viewMasterBtn');
    if (mb) mb.style.display = canMaster() ? '' : 'none';
  }

  function init() {
    identity = isGuest() ? null : loadIdentity();
    refreshBar();
    if (!enabled()) return;
    if (isGuest()) return; // stays a guest for this tab session (reloads included)
    if (!identity) { showLogin({ required: true }); return; }
    // already known: quietly refresh the master flag (the sheet owner may have changed it)
    api({ action: 'login', name: identity.name, code: identity.code })
      .then(res => { if (!!res.isMaster !== !!identity.isMaster) { identity.isMaster = !!res.isMaster; storeIdentity(); refreshBar(); if (global.render) global.render(); } })
      .catch(() => { /* offline / cold start: keep the cached flag */ });
  }

  global.FWWCloud = { init, canMaster, enabled, isGuest, onChange, saveToCloud, loadFromCloud, showLogin, refreshBar, splitState, mergeState };
})(window);
