// Bridges our own UNITS_DB/ITEMS_DB (by name) to the official fww_unit_templates.json /
// fww_equipment.json entries (by key), via the name-mapping tables built earlier.
(function (global) {
  'use strict';

  let unitsByKey = null, itemsByKey = null, unitMapping = null, itemMapping = null;

  async function loadData(basePath) {
    basePath = basePath || 'data/';
    const [units, items, uMap, iMap] = await Promise.all([
      fetch(basePath + 'fww_unit_templates.json').then(r => r.json()),
      fetch(basePath + 'fww_equipment.json').then(r => r.json()),
      fetch(basePath + 'unit_name_mapping.json').then(r => r.json()),
      fetch(basePath + 'item_name_mapping.json').then(r => r.json()),
    ]);
    units.forEach(stripDuplicatedRules);
    unitsByKey = new Map(units.map(u => [u.key, u]));
    itemsByKey = new Map(items.map(u => [u.key, u]));
    unitMapping = uMap;
    itemMapping = iMap;
  }

  function isReady() { return unitMapping !== null; }

  // Frank Horrigan's three cards each repeat rules that the game prints on his separate reference
  // card, so they're left off every Horrigan card (I, II, III and the combos). Matched by prefix so
  // a small wording change in a data refresh doesn't bring them back.
  const HORRIGAN_HIDDEN_RULES = [/^BARGE:/, /^Cannot use \[\[chem\|/, /^EQUIPPED: Horrigan's /];
  function stripDuplicatedRules(unit) {
    if (!unit.key || !unit.key.startsWith('ENC-FRANK_HORRIGAN_') || !unit.specialRules) return;
    unit.specialRules = unit.specialRules.filter(rule => !HORRIGAN_HIDDEN_RULES.some(re => re.test(rule)));
  }

  // Portrait files the official data references but that don't exist anywhere (the app's server
  // answers with an HTML error page for them) — Liberty Prime's picture.
  const MISSING_PORTRAITS = new Set(['liberty_prime.png']);
  function isPortraitMissing(image) { return MISSING_PORTRAITS.has(image); }

  // our UNITS_DB row's name (row[1]) -> official unit template, or null if homebrew/unmapped
  // (or if loadData() hasn't resolved yet — callers should treat that the same as "unmapped").
  // A combo entry ("Frank Horrigan I+II") maps to an ARRAY of keys and has no single template, so
  // this returns null for it — use getOfficialUnitParts() for those.
  function getOfficialUnit(ourUnitName) {
    if (!unitMapping) return null;
    const key = unitMapping[ourUnitName];
    return typeof key === 'string' ? (unitsByKey.get(key) || null) : null;
  }

  // every card a roster entry shows: one template for a normal unit, one per mini for a combo entry
  // (Deathclaw Matriarch I+II, Swan I+II, Frank Horrigan I+II…). Empty array = no live card.
  function getOfficialUnitParts(ourUnitName) {
    if (!unitMapping) return [];
    const key = unitMapping[ourUnitName];
    if (!key) return [];
    const parts = (Array.isArray(key) ? key : [key]).map(k => unitsByKey.get(k));
    return parts.every(Boolean) ? parts : [];
  }

  // builder name of each mini in a combo entry (for per-mini tags such as Legendary)
  function getPartNames(ourUnitName) {
    const key = unitMapping && unitMapping[ourUnitName];
    if (!Array.isArray(key)) return [ourUnitName];
    return key.map(k => Object.keys(unitMapping).find(n => unitMapping[n] === k) || ourUnitName);
  }

  // our ITEMS_DB row's name (row[2]) -> official equipment entry, or null if homebrew/unmapped/not-yet-loaded
  function getOfficialItem(ourItemName) {
    if (!itemMapping) return null;
    const key = itemMapping[ourItemName];
    return key ? (itemsByKey.get(key) || null) : null;
  }

  function getOfficialEquippedItems(ourItemNames) {
    return (ourItemNames || []).map(getOfficialItem).filter(Boolean);
  }

  // every distinct portrait in the official unit data, {name, image}, for the custom-unit editor's
  // "pick a picture from the database" dialog
  function listUnits() {
    if (!unitsByKey) return [];
    const seen = new Set(), out = [];
    for (const u of unitsByKey.values()) {
      if (!u.image || seen.has(u.image) || MISSING_PORTRAITS.has(u.image)) continue;
      seen.add(u.image);
      out.push({ name: (u.name && u.name.en) || u.key, image: u.image });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  global.FWWBridge = { loadData, isReady, getOfficialUnit, getOfficialUnitParts, getPartNames, getOfficialItem, getOfficialEquippedItems, listUnits, isPortraitMissing };
})(typeof window !== 'undefined' ? window : globalThis);
