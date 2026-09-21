// Renders a live unit card as an HTML string, for embedding anywhere (the standalone prototype,
// or the real app's card lightbox). Requires engine.js (FWWEngine) to already be loaded.
// All asset paths are relative to `assetBase` (e.g. "live-card/" when called from index.html,
// "" when called from prototype.html which already sits inside live-card/).
(function (global) {
  'use strict';

  const STAT_LABELS = { S: 'Str', P: 'Per', E: 'End', C: 'Cha', I: 'Int', A: 'Agi', L: 'Luc' };

  // Type icon and faction text are TWO INDEPENDENT conditions, not a mutually-exclusive choice —
  // confirmed from the real component source (card_rendering_source.md §2.1):
  //   hasType    = types.length > 0 || legendary === true
  //   hasFaction = factions.some(f => f !== "RPG")   (RPG itself never counts)
  // A unit can show BOTH at once (e.g. SURV-DOGMEAT: types:["DOG"] + factions:["SURV"] shows the
  // dog icon AND "Survivor" text). The earlier whitelist-of-6-types / icon-suppresses-text version
  // was wrong — it happened to work for Codsworth (factions:[]) but not for the ~40 units that
  // carry both a real type and a real faction.
  //
  // The faction text itself is NOT the faction name/code — it's a separate `unitCardSubtitle`
  // field from fww_factions.json (e.g. SURV -> "Survivor", not "Survivors"; NCR -> "NCR", the
  // abbreviation, not "New California Republic"; MOTH -> null, so Cult-of-the-Mothman units never
  // show faction text at all regardless of icon). No fww_factions.json was saved to disk, so this
  // table is reconstructed from card_rendering_source.md's own lookup; SLOG isn't in that source
  // table (only 27 of the 27 known codes are — SLOG replaces the doc's unused "ROBOTS" row in our
  // actual unit data) so its subtitle is an unconfirmed best guess.
  const FACTION_SUBTITLES = {
    BOS: 'Brotherhood of Steel', SM: 'Super Mutant', SURV: 'Survivor', RAID: 'Raider',
    CREATURES: 'Creature', ROBOTS: 'Robots', INST: 'Institute', ENC: 'Enclave', MM: 'Minutemen',
    VAULT: 'Vault Dweller', NCR: 'NCR', LEGION: "Caesar's Legion", NK: 'Nightkin',
    RPG: null, GUN: 'Gunner', RR: 'Railroad', COA: 'Children of Atom', FORG: 'Forged',
    OPERATORS: 'Operators', DISCIPLES: 'Disciples', PACK: 'The Pack', MOTH: null,
    ZETAN: 'Zetan', SCORCHED: 'Scorched', HARBORMEN: 'Harbormen',
    ARCADIA_RENEGADES: 'Arcadia Renegades', TRAPPERS: 'Trappers',
    SLOG: 'Slog', // unconfirmed — not in the source's factions table
  };
  // factions minus "RPG", subtitles looked up and joined with " / "; null (MOTH/RPG) contributes
  // nothing — if every faction resolves to null, there's no subtitle and hasFaction is false.
  function factionSubtitle(unitTemplate) {
    const subtitles = (unitTemplate.factions || [])
      .filter(f => f !== 'RPG')
      .map(f => FACTION_SUBTITLES[f])
      .filter(Boolean);
    return subtitles.length ? subtitles.join(' / ') : null;
  }

  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;'); }

  function parseTags(text) {
    // icon may live in a subfolder (e.g. "status-selectors/crit"), hence "/" and "-"
    return text.replace(/\[\[([a-z0-9_\-\/]+)(?:\|([^\]]*))?\]\]/gi, (m, icon, label) =>
      `<img class="inlineIcon" src="${global.__fwwAssetBase}icons/${icon.replace(/^\/+/, '')}.png" alt="${esc(label || icon)}" title="${esc(label || icon)}">`);
  }

  function iconsForStat(derivedSkills, statLetter) {
    return Object.entries(derivedSkills)
      .filter(([, sk]) => sk.stat === statLetter)
      .map(([name, sk]) => {
        let slug = sk.colour ? `${name}_${sk.colour}` : name;
        return slug.replace(/ /g, '_').toLowerCase();
      });
  }

  function cls(derived, base) { if (derived > base) return 'boosted'; if (derived < base) return 'lowered'; return ''; }

  // .brandedText defaults to 1.6em (card.css). That's sized for the common case; a name long
  // enough to wrap inside .unitName pushes the type icons out of vertical alignment and, in the
  // worst case, crowds the row below. Two-or-more type icons (*ngFor, one per types[] entry) eat
  // much more of .unitTitle's width than zero/one, so long names squeeze earlier there. Verified
  // live in prototype.html against every 20+ char official name in fww_unit_templates.json: with
  // 0-1 icons even 32 chars fits on one line at 1.6em (ALIEN INVADER, SUPREME COMMANDER / FERAL
  // GHOUL SPECIAL OPERATOR / VAULT DWELLER, SNEAKY SURVIVOR); with 2 icons, 21 chars still fits
  // but 26 doesn't (MOTHMAN HATCHLING VENGEFUL wraps to 2 lines at 1.6em, fits at 1.4em) — that's
  // the only 2-icon name over 22 chars in the current data, so this narrowly targets that case.
  function nameFontSizeEm(name, iconCount) {
    if (iconCount >= 2 && name.length > 22) return 1.35;
    return 1.6;
  }

  // A unit with a lot of specialRules text (many rules, or just long ones) can push .specialIcons
  // past the card's fixed 620px height (card.css), where .fww-live-card's overflow:hidden silently
  // clips it — reported live: MOTHMAN HATCHLING VENGEFUL's 5 specialRules lines push specialIcons
  // ~28px past the bottom edge. Text-wrap height depends on the exact glyphs and on how the
  // right-floated armour box narrows the first couple of lines, so a char-count guess would be
  // unreliable in either direction — instead, render the card into a hidden offscreen copy (using
  // whatever document is calling us, since index.html/prototype.html both already load card.css)
  // and shrink .specialRules' font-size step by step until .specialIcons actually fits, or a floor
  // is hit. Runs once per buildCardHtml call; cheap relative to a click-to-open or a print job.
  // Floor is 0.6 (down from an initial 0.7): THE FLATWOODS MONSTER's ~680-char MIND CONTROL rule
  // still clipped specialIcons at 0.7 (only the tops of the icons were visible) — measured live,
  // 0.65 is the first step that actually clears the budget, 0.6 keeps a bit of margin over that.
  // allowGrow (custom units only): before shrinking any text, let the card itself grow taller — up
  // to MAX_GROW_H — so a hand-written rules block stays at the same 18px as every other card.
  // Official cards keep the fixed 620px (print packs 3 per page around it). Returns
  // {scale, height}; height is the card's final px height (620 unless it grew).
  const BASE_H = 620, MAX_GROW_H = 900;
  function fitSpecialRulesFontScale(cardHtml, doc, allowGrow) {
    if (!doc || !doc.body) return { scale: 1, height: BASE_H };
    const host = doc.createElement('div');
    host.style.cssText = 'position:absolute;left:-9999px;top:-9999px;visibility:hidden;pointer-events:none;';
    host.innerHTML = cardHtml;
    doc.body.appendChild(host);
    let scale = 1, height = BASE_H;
    try {
      const card = host.querySelector('.fww-live-card');
      const wrap = host.querySelector('.wrap');
      const rules = host.querySelector('.specialRules');
      const icons = host.querySelector('.specialIcons');
      if (card && wrap && rules && icons) {
        wrap.style.overflow = 'visible'; // bypass the by-design clip for measurement only
        const cardTop = card.getBoundingClientRect().top;
        if (allowGrow) {
          // .wrap keeps 20px of padding below its content — the card must end that far below the icons
          const needed = Math.ceil(icons.getBoundingClientRect().bottom - cardTop) + 20;
          height = Math.min(MAX_GROW_H, Math.max(BASE_H, needed));
        }
        const budget = height - 4; // small safety margin below the card's hard bottom edge
        for (; scale > 0.6; scale = +(scale - 0.05).toFixed(2)) {
          rules.style.fontSize = (1.1 * scale).toFixed(3) + 'em';
          if (icons.getBoundingClientRect().bottom - cardTop <= budget) break;
        }
      }
    } finally {
      doc.body.removeChild(host);
    }
    return { scale, height };
  }

  // unitTemplate: an fww_unit_templates.json entry. equippedItems: fww_equipment.json entries
  // (already resolved via FWWBridge). Returns an HTML string for one card.
  // opts.cost: the unit's price in caps, printed in the empty blue box under the armour (where the
  // old static card art had a blank slot for it)
  function buildCardHtml(unitTemplate, equippedItems, assetBase, opts) {
    opts = opts || {};
    assetBase = assetBase || '';
    global.__fwwAssetBase = assetBase; // parseTags() reads this — simplest way to thread it through String.replace's callback
    const icons = assetBase + 'icons/';
    const portraits = assetBase + 'portraits/';

    const derived = FWWEngine.computeDerived(unitTemplate, equippedItems);
    const healthVal = derived.skills['Health'] ? derived.skills['Health'].value : null;
    const healthBase = unitTemplate.skills['Health'] && unitTemplate.stats[unitTemplate.skills['Health'].stat];
    const healthCls = healthVal != null ? cls(healthVal, healthBase) : '';

    const statsRows = FWWEngine.STAT_ORDER.map(stat => {
      const statIcons = iconsForStat(derived.skills, stat).map(f => `<img class="icon" src="${icons}${f}.png">`).join('');
      const val = derived.stats[stat];
      return `<li>
        <span class="skills">${statIcons}</span>
        <span class="statName">${STAT_LABELS[stat]}</span>
        <span class="statVal ${cls(val, unitTemplate.stats[stat])}">${FWWEngine.statDisplay(val)}</span>
      </li>`;
    }).join('');

    const armourRows = [['physical', 'armor_physical'], ['energy', 'armor_energy'], ['radiation', 'armor_radiation']].map(([key, icon]) => {
      const hard = derived.armour[key + '_hard'];
      const val = derived.armour[key];
      return `<li>
        <img class="icon" src="${icons}${icon}.png">
        <span class="${cls(val, unitTemplate.armour[key])}">${FWWEngine.armourDisplay(val)}</span>
        ${hard > 0 ? `<span class="hard ${cls(hard, unitTemplate.armour[key + '_hard'])}"><span class="plus">+</span>${FWWEngine.armourDisplay(hard)}</span>` : ''}
      </li>`;
    }).join('');

    const moveIcon = unitTemplate.move.main.toLowerCase().replace(/ /g, '_');
    const chargeIcon = unitTemplate.move.charge.toLowerCase().replace(/ /g, '_');

    // Independent conditions (see the big comment above FACTION_SUBTITLES) — both can fire at once.
    const subtitle = factionSubtitle(unitTemplate);
    const hasFaction = subtitle != null;
    const hasType = (unitTemplate.types || []).length > 0 || unitTemplate.legendary === true;
    const titleClasses = ['unitTitle', hasFaction ? 'hasFaction' : 'noFaction', hasType ? 'hasType' : ''].filter(Boolean).join(' ');
    // One icon per types[] entry (*ngFor, not a single fixed icon), plus legendary.png and
    // rank_<N>.png as extra siblings when those fields are set.
    const typeIcons = [
      ...(unitTemplate.types || []).map(t => `<img src="${icons}type_${String(t).toLowerCase()}.png" alt="${esc(String(t).toUpperCase())}">`),
      unitTemplate.legendary ? `<img src="${icons}legendary.png" alt="Legendary">` : '',
      unitTemplate.rank ? `<img src="${icons}rank_${unitTemplate.rank}.png" alt="Rank ${unitTemplate.rank}">` : '',
    ].filter(Boolean).join('');
    const typeBlock = hasType ? `<div class="type">${typeIcons}</div>` : '';
    const iconCount = (unitTemplate.types || []).length + (unitTemplate.legendary ? 1 : 0);
    // .unitFaction nests INSIDE .unitName, right after the name span — confirmed real DOM
    // (card_rendering_source.md §2.1): a block-level span there naturally wraps to its own line
    // under the name, which is what the .hasFaction line-height/top adjustments are sized for.
    const factionSpan = hasFaction ? `<span class="unitFaction"><span>${esc(subtitle)}</span></span>` : '';

    const specialIconsRow = [unitTemplate.awarenessIcon, ...(unitTemplate.specialIcons || [])]
      .filter(Boolean).map(ic => `<img src="${icons}${ic}.png" title="${esc(ic)}">`).join('');
    const name = unitTemplate.name.en;
    // official portraits are bare filenames under portraits/; a user-made custom unit stores its
    // picture inline as a data: URL (see custom-unit-editor.js) — used as-is.
    const image = unitTemplate.image || '';
    const portraitSrc = !image ? '' : /^(data:|blob:|https?:)/i.test(image) ? image : portraits + image;
    const nameFontSize = nameFontSizeEm(name, iconCount);

    const html = `
    <div class="fww-live-card">
      <div class="wrap">
        <div class="frame"></div>
        <div class="card-edge"></div>
        <div class="scratches"></div>
        ${unitTemplate.unique ? `<img class="unique" src="${icons}unique.png" alt="unique">` : ''}
        <div class="topBarIcons">
          <span class="skillDisplay">
            <img src="${icons}health.png" class="largeIcon" alt="Health">
            <span class="${healthCls}">${healthVal == null ? '-' : healthVal}</span>
          </span>
        </div>
        <div class="thumbnail">${portraitSrc ? `<img src="${esc(portraitSrc).replace(/"/g, '&quot;')}" alt="${esc(name)}">` : ''}</div>
        <div class="top">
          <div class="movement">
            <img src="${icons}${moveIcon}.png" class="move" alt="${esc(unitTemplate.move.main)}">
            <img src="${icons}${chargeIcon}.png" class="charge" alt="${esc(unitTemplate.move.charge)}">
          </div>
          <div class="${titleClasses}">
            <div class="unitName"><span class="brandedText textShadow" style="font-size:${nameFontSize}em">${esc(name)}</span>${factionSpan}</div>
            ${typeBlock}
          </div>
        </div>
        <div class="center">
          <div class="stats"><ul>${statsRows}</ul></div>
          <div class="main">
            <div class="right">
              <ul class="armour">${armourRows}</ul>
              <div class="sub">${opts.cost == null ? '' : `<span class="cost">${esc(opts.cost)}</span>`}</div>
            </div>
            <div class="specialRules">${(unitTemplate.specialRules || []).map(p => `<p>${parseTags(p)}</p>`).join('')}</div>
            <div class="specialIcons">${specialIconsRow}</div>
          </div>
        </div>
      </div>
    </div>`;

    const fit = fitSpecialRulesFontScale(html, global.document, !!unitTemplate._growToFit);
    let out = html;
    if (fit.scale < 1) out = out.replace('<div class="specialRules">', `<div class="specialRules" style="font-size:${(1.1 * fit.scale).toFixed(3)}em">`);
    // data-card-h lets callers (print scaling, preview) know the real height without re-measuring
    if (fit.height !== BASE_H) out = out.replace('<div class="fww-live-card">', `<div class="fww-live-card" data-card-h="${fit.height}" style="height:${fit.height}px">`);
    return out;
  }

  global.FWWCardRender = { buildCardHtml, FACTION_SUBTITLES };
})(typeof window !== 'undefined' ? window : globalThis);
