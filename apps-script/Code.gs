/**
 * Homestead — облачное сохранение в Google Таблице (Apps Script Web App).
 *
 * Одна вкладка «Сохранения» (создаётся сама при первом обращении), ОДНА строка на игрока:
 *   ownerName | accessCode | isMaster | updatedAt | settlement… | squad… | warehouse… | master… | inbox
 *
 *  inbox — предметы, которые мастер выдал игроку кнопкой на сайте (JSON). Игрок забирает их сам
 *  (сайт раз в минуту проверяет входящие), после чего ячейка очищается. Вручную ничего вписывать не нужно.
 *
 *  isMaster — галочка. ЧТОБЫ ВЫДАТЬ ВКЛАДКУ «МАСТЕР»: найдите строку игрока и поставьте галочку.
 *
 *  Каждая часть состояния лежит в своих ячейках, чтобы не упереться в лимит Google Таблицы
 *  (50 000 символов на ячейку): settlement (поселение) | squad (отряд) | warehouse (склад) | master (мастер).
 *  Если часть не влезла в одну ячейку, продолжение идёт в settlement_2, settlement_3…
 *
 *  Старая таблица (без колонки isMaster и с вкладкой «Игроки») мигрирует сама: колонка добавляется
 *  после accessCode, а флаги мастера из «Игроки» переносятся. Вкладку «Игроки» потом можно удалить.
 *
 * Деплой: Развернуть → Новое развёртывание → Веб-приложение, «Выполнять как: Я», «Доступ: Все».
 * После правки кода: Развернуть → Управление развёртываниями → карандаш → Новая версия.
 */
var SAVES = 'Сохранения';
var OLD_PLAYERS = 'Игроки'; // только для миграции старой таблицы
var PARTS = ['settlement', 'squad', 'warehouse', 'master'];
var CHUNKS = 3;            // ячеек на одну часть
var CELL_MAX = 49000;      // лимит Таблицы — 50 000, оставляем запас

var SAVE_HEADERS = (function () {
  var h = ['ownerName', 'accessCode', 'isMaster', 'updatedAt'];
  PARTS.forEach(function (p) { for (var i = 1; i <= CHUNKS; i++) h.push(i === 1 ? p : p + '_' + i); });
  h.push('inbox');
  return h;
})();

function sheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SAVES);
  if (!sh) { sh = ss.insertSheet(SAVES); sh.appendRow(SAVE_HEADERS); sh.setFrozenRows(1); return sh; }
  if (sh.getRange(1, 3).getValue() !== 'isMaster') migrate_(sh, ss);
  var inboxCol = SAVE_HEADERS.indexOf('inbox') + 1;
  if (sh.getRange(1, inboxCol).getValue() !== 'inbox') sh.getRange(1, inboxCol).setValue('inbox'); // колонка входящих появилась позже
  return sh;
}
// старая раскладка: ownerName | accessCode | updatedAt | … — вставляем isMaster после accessCode
function migrate_(sh, ss) {
  sh.insertColumnBefore(3);
  sh.getRange(1, 3).setValue('isMaster');
  var last = sh.getLastRow();
  if (last >= 2) {
    var flags = [];
    var old = ss.getSheetByName(OLD_PLAYERS), oldRows = old && old.getLastRow() >= 2 ? old.getRange(2, 1, old.getLastRow() - 1, 2).getValues() : [];
    var names = sh.getRange(2, 1, last - 1, 1).getValues();
    names.forEach(function (n) {
      var f = oldRows.some(function (r) { return norm_(r[0]) === norm_(n[0]) && (r[1] === true || /^(true|1|да|yes)$/i.test(String(r[1]).trim())); });
      flags.push([f]);
    });
    var rng = sh.getRange(2, 3, last - 1, 1);
    rng.insertCheckboxes();
    rng.setValues(flags);
  }
}
// Время сохранения хранится строкой ISO; Таблица могла превратить старые значения в Date — приводим к строке
function iso_(v) { return v instanceof Date ? v.toISOString() : String(v || ''); }
function sameTime_(a, b) {
  if (a === b) return true;
  var x = Date.parse(a), y = Date.parse(b);
  return !isNaN(x) && !isNaN(y) && Math.abs(x - y) < 2000; // округление Таблицей до секунд
}
function norm_(s) { return String(s || '').trim().toLowerCase(); }
function out_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }

function findRow_(sh, name) {
  var last = sh.getLastRow();
  if (last < 2) return 0;
  var names = sh.getRange(2, 1, last - 1, 1).getValues();
  for (var i = 0; i < names.length; i++) if (norm_(names[i][0]) === norm_(name)) return i + 2;
  return 0;
}

// ---- флаг мастера: галочка в колонке isMaster строки игрока ----
function isMaster_(a) {
  var v = a.sh.getRange(a.row, 3).getValue();
  return v === true || /^(true|1|да|yes)$/i.test(String(v).trim());
}

// ---- «Сохранения»: проверка имени/кода ----
// Игрок создаётся ТОЛЬКО явным действием register (кнопка «Создать игрока»); обычный вход,
// загрузка и сохранение с неизвестным именем — ошибка, чтобы опечатка в логине не плодила новых игроков.
function authRow_(name, code, create) {
  var n = String(name || '').trim(), c = String(code || '');
  if (!n || !c) throw new Error('Укажите имя и код доступа.');
  var sh = sheet_();
  var row = findRow_(sh, n);
  if (create) {
    if (row) throw new Error('Игрок с таким именем уже есть. Выберите другое имя или войдите.');
  } else if (!row) {
    throw new Error('Игрок с таким именем не найден. Проверьте имя или создайте нового игрока.');
  }
  if (!row) {
    var blank = SAVE_HEADERS.map(function () { return ''; });
    blank[0] = n; blank[1] = c; blank[2] = false;
    sh.appendRow(blank);
    row = sh.getLastRow();
    sh.getRange(row, 2).setNumberFormat('@').setValue(c); // как текст, чтобы «007» не стало 7
    sh.getRange(row, 3).insertCheckboxes();
  } else if (String(sh.getRange(row, 2).getValue()) !== c) {
    throw new Error('Неверный код доступа для этого имени.');
  }
  return { sh: sh, row: row, name: n };
}

function readParts_(a) {
  var vals = a.sh.getRange(a.row, 1, 1, SAVE_HEADERS.length).getValues()[0];
  var parts = {}, any = false;
  PARTS.forEach(function (p) {
    var chunks = [];
    for (var i = 0; i < CHUNKS; i++) {
      var v = vals[SAVE_HEADERS.indexOf(i === 0 ? p : p + '_' + (i + 1))];
      if (v !== '' && v !== null) chunks.push(String(v));
    }
    if (chunks.length) any = true;
    parts[p] = chunks;
  });
  return { parts: parts, any: any, updatedAt: iso_(vals[3]) };
}

// ---- выдача предметов мастером ----
function requireMaster_(p) {
  var a = authRow_(p.name, p.code);
  if (!isMaster_(a)) throw new Error('Это действие только для мастера.');
  return a;
}
function inboxCol_() { return SAVE_HEADERS.indexOf('inbox') + 1; }
function readInbox_(sh, row) {
  var raw = sh.getRange(row, inboxCol_()).getValue();
  try { var l = JSON.parse(raw || '[]'); return Array.isArray(l) ? l : []; } catch (e) { return []; }
}
function writeInbox_(sh, row, list) {
  var text = JSON.stringify(list);
  if (text.length > CELL_MAX) throw new Error('У игрока переполнены входящие — пусть сначала войдёт и заберёт предыдущие выдачи.');
  sh.getRange(row, inboxCol_()).setNumberFormat('@').setValue(list.length ? text : '');
}
function players_(p) {
  var a = requireMaster_(p);
  var last = a.sh.getLastRow();
  if (last < 2) return [];
  return a.sh.getRange(2, 1, last - 1, 1).getValues().map(function (r) { return String(r[0]).trim(); })
    .filter(function (n) { return n && norm_(n) !== norm_(a.name); });
}
function give_(p) {
  var lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    var a = requireMaster_(p);
    var row = findRow_(a.sh, p.to);
    if (!row) throw new Error('Игрок «' + p.to + '» не найден.');
    var items = (p.items || []).slice(0, 50).map(function (i) { return { idx: Number(i.idx), name: String(i.name || '').slice(0, 80) }; });
    if (!items.length) throw new Error('Нечего отправлять.');
    var list = readInbox_(a.sh, row);
    list.push({ id: Utilities.getUuid(), from: a.name, at: new Date().toISOString(), items: items });
    writeInbox_(a.sh, row, list);
    return { count: items.length };
  } finally { lock.releaseLock(); }
}
function inbox_(p) {
  var a = authRow_(p.name, p.code);
  return { entries: readInbox_(a.sh, a.row) };
}
function ack_(p) {
  var lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    var a = authRow_(p.name, p.code);
    var done = p.ids || [];
    var left = readInbox_(a.sh, a.row).filter(function (e) { return done.indexOf(e.id) < 0; });
    writeInbox_(a.sh, a.row, left);
    return { left: left.length };
  } finally { lock.releaseLock(); }
}

function register_(p) {
  var lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    var a = authRow_(p.name, p.code, true);
    return { isMaster: false, hasSave: false, updatedAt: null };
  } finally { lock.releaseLock(); }
}

function login_(p) {
  var lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    var a = authRow_(p.name, p.code);
    var r = readParts_(a);
    return { isMaster: isMaster_(a), hasSave: r.any, updatedAt: r.updatedAt || null };
  } finally { lock.releaseLock(); }
}

function load_(p) {
  var a = authRow_(p.name, p.code);
  var master = isMaster_(a);
  var r = readParts_(a);
  if (!master) r.parts.master = []; // мастер-данные не-мастеру не отдаём
  return { isMaster: master, parts: r.parts, updatedAt: r.updatedAt || null };
}

function save_(p) {
  var lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    var a = authRow_(p.name, p.code);
    var master = isMaster_(a);
    var incoming = p.parts || {};
    // Защита от затирания с другого устройства: клиент присылает время облачной версии, на которой основан
    // (expectedUpdatedAt). Если в таблице уже более новая — не пишем, а сообщаем о конфликте (force=true — перезаписать).
    var current = iso_(a.sh.getRange(a.row, 4).getValue());
    if (!p.force && current && !sameTime_(current, String(p.expectedUpdatedAt || ''))) {
      return { conflict: true, isMaster: master, updatedAt: current };
    }
    var now = new Date().toISOString();
    PARTS.forEach(function (part) {
      if (part === 'master' && !master) return;            // не-мастер не может писать мастер-данные
      if (!(part in incoming)) return;                      // часть не прислана — не трогаем
      var chunks = incoming[part] || [];
      if (chunks.length > CHUNKS) throw new Error('Часть «' + part + '» слишком большая (' + chunks.length + ' ячеек из ' + CHUNKS + ' допустимых).');
      for (var i = 0; i < CHUNKS; i++) {
        var c = chunks[i] || '';
        if (c.length > CELL_MAX) throw new Error('Часть «' + part + '»: ячейка длиннее лимита Таблицы.');
        var col = SAVE_HEADERS.indexOf(i === 0 ? part : part + '_' + (i + 1)) + 1;
        a.sh.getRange(a.row, col).setNumberFormat('@').setValue(c);
      }
    });
    a.sh.getRange(a.row, 4).setNumberFormat('@').setValue(now);
    return { isMaster: master, updatedAt: now };
  } finally { lock.releaseLock(); }
}

function doGet() { return out_({ ok: true, ping: 'pong' }); }

function doPost(e) {
  try {
    var p = JSON.parse(e.postData.contents || '{}');
    if (p.action === 'login') return out_({ ok: true, result: login_(p) });
    if (p.action === 'register') return out_({ ok: true, result: register_(p) });
    if (p.action === 'players') return out_({ ok: true, result: players_(p) });
    if (p.action === 'give') return out_({ ok: true, result: give_(p) });
    if (p.action === 'inbox') return out_({ ok: true, result: inbox_(p) });
    if (p.action === 'ack') return out_({ ok: true, result: ack_(p) });
    if (p.action === 'load') return out_({ ok: true, result: load_(p) });
    if (p.action === 'save') return out_({ ok: true, result: save_(p) });
    return out_({ ok: false, error: 'Неизвестное действие: ' + p.action });
  } catch (err) {
    return out_({ ok: false, error: String((err && err.message) || err) });
  }
}
