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
    unitsByKey = new Map(units.map(u => [u.key, u]));
    itemsByKey = new Map(items.map(u => [u.key, u]));
    unitMapping = uMap;
    itemMapping = iMap;
  }

  function isReady() { return unitMapping !== null; }

  // our UNITS_DB row's name (row[1]) -> official unit template, or null if homebrew/unmapped
  // (or if loadData() hasn't resolved yet — callers should treat that the same as "unmapped").
  function getOfficialUnit(ourUnitName) {
    if (!unitMapping) return null;
    const key = unitMapping[ourUnitName];
    return key ? (unitsByKey.get(key) || null) : null;
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

  global.FWWBridge = { loadData, isReady, getOfficialUnit, getOfficialItem, getOfficialEquippedItems };
})(typeof window !== 'undefined' ? window : globalThis);
