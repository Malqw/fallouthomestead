// Stat recomputation engine — implements the formulas from card_rendering_source.md §4,
// operating on official fww_unit_templates.json / fww_equipment.json entries.
// Pure functions: given a unit template + the list of its equipped official item entries
// (already resolved via the name mappings), compute derived SPECIAL stats, skill values,
// skill colours, and armour, exactly as the real app does.
(function (global) {
  'use strict';

  const COLOUR_LADDER = ['Orange', 'Yellow', 'Red', 'Green', 'Blue', 'Black'];

  function modApplies(mod, unitTemplate) {
    const types = (unitTemplate.types || []).map(t => String(t).toUpperCase());
    const req = mod.requirements;
    if (req && req.type && req.type.length) {
      if (!req.type.some(t => types.includes(String(t).toUpperCase()))) return false;
    }
    const not = mod.notAllowedBy;
    if (not && not.type && not.type.length) {
      if (not.type.some(t => types.includes(String(t).toUpperCase()))) return false;
    }
    return true;
  }

  // Some items (Power Armor) carry mutually-exclusive condition variants instead of one
  // fixed mod — e.g. T-60 Power Armor has a "undamaged" mod AND a separate "damaged" mod,
  // not two stacking bonuses. Pick the one matching the item's current condition (default
  // undamaged; pass {..., _damaged:true} on the item to select the damaged variant), and
  // pass through anything else (permanent/diminishing) untouched.
  function selectableMods(item) {
    const mods = item.mod || [];
    const hasConditionVariants = mods.some(m => m.type === 'undamaged' || m.type === 'damaged');
    if (!hasConditionVariants) return mods;
    const wantType = item._damaged ? 'damaged' : 'undamaged';
    return mods.filter(m => m.type === wantType || (m.type !== 'undamaged' && m.type !== 'damaged'));
  }

  // every mod object on every equipped item that actually applies to this unit
  function applicableMods(unitTemplate, equippedItems) {
    const out = [];
    for (const item of equippedItems || []) {
      for (const mod of selectableMods(item)) {
        if (modApplies(mod, unitTemplate)) out.push(mod);
      }
    }
    return out;
  }

  // §4.1 getSpecialStat: base + sum of permanent stat mods (diminishing mods excluded)
  function getSpecialStat(unitTemplate, equippedItems, statKey, mode) {
    const base = unitTemplate.stats[statKey];
    if (base < 0) return base; // "not available" sentinel
    if (mode === 'base') return base;
    let total = base || 0;
    for (const mod of applicableMods(unitTemplate, equippedItems)) {
      if (mod.type === 'diminishing') continue;
      const v = mod.stats && mod.stats[statKey];
      if (v) total += v;
    }
    return total;
  }

  // §4.2 getSkillValue: SPECIAL stat behind the skill + skill-specific mods; Health subtracts
  // current damage/radiation (and a heroic RPG penalty we don't model here, since this builder
  // doesn't have an RPG mode).
  function getSkillValue(unitTemplate, equippedItems, skillName, opts) {
    opts = opts || {};
    const skillDef = unitTemplate.skills[skillName];
    if (!skillDef || !skillDef.stat) return null;
    const special = getSpecialStat(unitTemplate, equippedItems, skillDef.stat, opts.mode);
    if (opts.mode === 'base') return special;
    let value = special;
    for (const mod of applicableMods(unitTemplate, equippedItems)) {
      const sk = mod.skills && mod.skills[skillName];
      if (typeof sk === 'number') value += sk;
    }
    value += unitTemplate.skills[skillName].mod || 0;
    if (skillName === 'Health') {
      value -= (opts.damage || 0) + (opts.radiation || 0);
      if (value < 0) value = 0;
    }
    return value || 0;
  }

  // §4.3 getSkillColour: base colour ± integer tier shifts from equipped mod.skills[skill].color
  function getSkillColour(unitTemplate, equippedItems, skillName) {
    const skillDef = unitTemplate.skills[skillName];
    const baseColour = skillDef && skillDef.colour;
    if (!baseColour) return null;
    let idx = COLOUR_LADDER.findIndex(c => c.toUpperCase() === baseColour.toUpperCase());
    if (idx < 0) idx = 0;
    for (const mod of applicableMods(unitTemplate, equippedItems)) {
      const sk = mod.skills && mod.skills[skillName];
      if (sk && typeof sk === 'object' && typeof sk.color === 'number') idx += sk.color;
    }
    idx = Math.max(0, Math.min(COLOUR_LADDER.length - 1, idx));
    return COLOUR_LADDER[idx];
  }

  // §4.4 getArmourValue (simplified per the README's own fallback: this builder has no
  // Power-Armor-vs-normal-replace edge case modelled with statuses/diminishing mods beyond
  // the tier-comparison itself, and no armor_boost status to add).
  const ARMOUR_KEYS = ['physical', 'energy', 'radiation'];

  function getArmourValue(unitTemplate, equippedItems) {
    const armour = {};
    for (const k of ARMOUR_KEYS) {
      armour[k] = unitTemplate.armour[k];
      armour[k + '_hard'] = unitTemplate.armour[k + '_hard'];
    }

    let paReplace = null, normalReplace = null;
    const adds = [];
    for (const item of equippedItems || []) {
      for (const mod of selectableMods(item)) {
        if (!modApplies(mod, unitTemplate)) continue;
        if (!mod.armour) continue;
        if (mod.armour.replace && Object.keys(mod.armour.replace).length) {
          if (item.type === 'Power Armor') paReplace = mod.armour.replace;
          else normalReplace = mod.armour.replace;
        }
        if (mod.armour.mod && Object.keys(mod.armour.mod).length) adds.push(mod.armour.mod);
      }
    }

    let chosen = paReplace || normalReplace;
    if (paReplace && normalReplace) {
      const sum = r => Object.values(r).reduce((a, b) => a + b, 0);
      chosen = sum(paReplace) >= sum(normalReplace) ? paReplace : normalReplace;
    }
    if (chosen) Object.assign(armour, chosen);
    for (const add of adds) {
      for (const [k, v] of Object.entries(add)) armour[k] = (armour[k] || 0) + v;
    }
    return armour;
  }

  // getArmourDisplayVal / getStat display rules, confirmed exactly against the live app
  function armourDisplay(v) {
    if (v === 0) return '-';
    if (v === -1) return 'X';
    return String(v);
  }
  function statDisplay(v) {
    if (v < 0) return 'X';
    if (!v) return '-';
    return String(v);
  }

  const STAT_ORDER = ['S', 'P', 'E', 'C', 'I', 'A', 'L'];

  // top-level convenience: everything a card renderer needs, in one call
  function computeDerived(unitTemplate, equippedItems, opts) {
    opts = opts || {};
    const stats = {};
    for (const k of STAT_ORDER) stats[k] = getSpecialStat(unitTemplate, equippedItems, k);

    const skills = {};
    for (const name of Object.keys(unitTemplate.skills)) {
      const def = unitTemplate.skills[name];
      skills[name] = {
        stat: def.stat || '',
        value: def.stat ? getSkillValue(unitTemplate, equippedItems, name, opts) : null,
        colour: def.colour ? getSkillColour(unitTemplate, equippedItems, name) : null,
      };
    }

    const armour = getArmourValue(unitTemplate, equippedItems);

    return { stats, skills, armour };
  }

  global.FWWEngine = {
    getSpecialStat, getSkillValue, getSkillColour, getArmourValue,
    armourDisplay, statDisplay, computeDerived, modApplies, applicableMods,
    COLOUR_LADDER, STAT_ORDER,
  };
})(typeof window !== 'undefined' ? window : globalThis);
