/* skins.js : switchable looks for the three games.
 *
 * A skin is one script (assets/skins/<id>.js) that calls SKINS.register, and
 * one stylesheet (assets/skins/<id>.css) whose rules start with
 * html[data-skin="<id>"]. Only the active skin's files are loaded; the
 * choice is kept in localStorage ('odg.skin') and shared by all games.
 *
 * What a skin gives (anything left out falls back to Lab, today's look):
 *   palette  named colors, as '#rrggbb', used by every game's canvas
 *            drawing through SKINS.col(name, alpha); the keys are Lab's below
 *   fonts    { mono, sans, serif } CSS font-family strings for canvas text
 *            (load the font files from the skin's stylesheet)
 *   cmap     color stops for raster fields: wave (the animated field, 0 =
 *            most negative, 0.5 = zero, 1 = most positive), intensity
 *            (|E|^2, 0 = dark), beam (the coupler's beam intensity)
 *   field(ctx, F)   optional: draws the Component Designer's field and
 *            silicon in its own way (pixels, ASCII, halftone, contours...).
 *            F is documented at drawField in component/game.js. Return true
 *            if it drew the silicon outline itself.
 *   post(ctx, W, H, t, game)  optional: an overlay drawn over every game
 *            canvas after the game draws (scanlines, paper grain...);
 *            game is 'component', 'coupler' or 'ring'; W, H in device px
 *   medal(tier, card)  optional: extra effect when the medal card shows
 *            (tier 'b', 's' or 'g'; card is the .mp-card element, which
 *            also carries data-tier)
 *   games    optional per-game overrides: { component | coupler | ring:
 *            { palette, cmap, fonts } } over the skin's own, for a game that
 *            needs a different ground (a paper skin's coupler on a plate)
 *   backdrop(ctx, W, H, t, game)  optional: drawn right after the coupler
 *            and Ring Lock fill their background, under the scene
 *   beamBlend  optional: the canvas composite mode for the coupler's beam
 *            ('lighter' by default; 'multiply' or 'darken' suit light grounds)
 *   pixelOverlays  optional: true draws the Component Designer's
 *            sensitivity, zone and fab-check overlays without smoothing
 *   field() may return an object { outline, ports, box } instead of true:
 *            each true part is one the painter drew, which the game then
 *            skips (the silicon outline, the port lines and labels, the
 *            design box and its label). F.ports and F.level say where those are.
 *
 * Games call SKINS.init() once, read SKINS.col / SKINS.font / SKINS.lut while
 * drawing, and redraw on SKINS.onChange. The Settings button calls
 * SKINS.picker(button).
 */
(function () {
  'use strict';
  const base = (document.currentScript && document.currentScript.src) ? document.currentScript.src.replace(/[^/]*$/, '') : '../assets/skins/';
  const ORDER = [
    ['lab', 'Lab'], ['arcade', 'Arcade'], ['handheld', 'Handheld'], ['terminal', 'Terminal'], ['synthwave', 'Synthwave'],
    ['blueprint', 'Blueprint'], ['riso', 'Riso zine'], ['swiss', 'Swiss poster'], ['papercut', 'Papercut'],
    ['hud', 'HUD'], ['fchud', 'HUD Flexcompute'], ['neon', 'Neon glass'], ['deck', 'Flight deck'],
  ];
  // Lab: the games' own look, every value as it was before skins
  const LAB = {
    id: 'lab', name: 'Lab',
    palette: {
      bg: '#07090d', panel: '#0b0e15', ink: '#e7ecf4', dim: '#97a1b4', faint: '#5a6376',
      accent: '#8fd8ff', good: '#7ee0a0', bad: '#ff6b6b', warn: '#ffb36b', heat: '#ff9a4d', gold: '#f2c84b', silver: '#c6cfdb', bronze: '#c98a5c',
      // component
      outline: '#e2eeff', boxLine: '#8fd8ff', lock: '#78afff', keep: '#ff8269', keepFill: '#ff7860', lockFill: '#6eaaff',
      drc: '#ff6056', portIn: '#7ee0a0', port: '#e7ecf4', erase: '#ff8c78', keepCursor: '#ff966e', siliconTint: '#cddef5',
      sensPos: '#ff6955', sensNeg: '#50a0ff', thumbSi: '#cedcf0', drcThin: '#ff4646', drcGap: '#ffb22e', series3: '#c6a0ff', series4: '#ffb37f',
      // coupler
      oxide: '#0c1320', substrate: '#151a22', glass: '#a0cdff', glassFill: '#8cbeff', surface: '#a0c8ff', siLayer: '#8fa6c8', grating: '#6fe3b4',
      obstacle: '#ff8c78', obstacleFill: '#78322d', obstacleText: '#ffa08c', lens: '#aad7ff', lensLine: '#bee1ff', mirror: '#dfe6f0', mirrorBack: '#c8d2e1',
      fiberCoat: '#3c465a', fiberCoatLine: '#96a0b4', fiberClad: '#bed7f0', fiberCladFill: '#aac8e6', fiberCore: '#ffd678', facet: '#dcebff',
      handle: '#6fe3b4', arrow: '#ffd36b', plot: '#6fe3b4', gcSiTint: '#c8d7eb',
      // ring
      core: '#1a2130', light: '#8fd8ff', lightHi: '#c8ecff', haze: '#ff8c3c', pad: '#2a3245', laser: '#ffffff',
      ring1: '#8fd8ff', ring2: '#c3a6ff', ring3: '#ffd36b', ring4: '#ff8fb1', heaterCold: '#5a6376', heaterHot: '#ff9a3a',
    },
    fonts: { mono: '"Spline Sans Mono", "SF Mono", ui-monospace, Menlo, monospace', sans: '"Spline Sans Mono", ui-monospace, monospace', serif: '"STIX Two Text", Georgia, serif' },
    cmap: {
      wave: [[0, '#d9ecff'], [0.12, '#7fb4ff'], [0.32, '#2b5db8'], [0.45, '#0f1a2e'], [0.5, '#07090d'], [0.55, '#2e1410'], [0.68, '#b84a2b'], [0.88, '#ffb37f'], [1, '#fff1dc']],
      intensity: [[0, '#07090d'], [0.2, '#27123f'], [0.45, '#7e2553'], [0.68, '#d95b2a'], [0.86, '#ffb347'], [1, '#fff6dc']],
      beam: [[0, '#000000'], [0.25, '#06302c'], [0.5, '#0f7a63'], [0.75, '#55e0b0'], [0.92, '#c9ffe9'], [1, '#ffffff']],
      beamWave: [[0, '#d9ecff'], [0.12, '#7fb4ff'], [0.32, '#2b5db8'], [0.45, '#0f1a2e'], [0.5, '#000000'], [0.55, '#2e1410'], [0.68, '#b84a2b'], [0.88, '#ffb37f'], [1, '#fff1dc']],
    },
  };
  const defs = { lab: LAB };
  let cur = LAB, listeners = [], luts = {}, rgbCache = {}, GAME = null;

  function hexRGB(h) {
    if (rgbCache[h]) return rgbCache[h];
    const s = h.replace('#', ''), f = s.length === 3 ? s.split('').map(c => c + c).join('') : s;
    return (rgbCache[h] = [0, 2, 4].map(i => parseInt(f.slice(i, i + 2), 16)));
  }
  function buildLut(stops) {
    const out = new Uint8Array(256 * 3), cols = stops.map(s => [s[0], hexRGB(s[1])]);
    for (let i = 0; i < 256; i++) {
      const t = i / 255;
      let a = cols[0], b = cols[cols.length - 1];
      for (let s = 0; s < cols.length - 1; s++) if (t >= cols[s][0] && t <= cols[s + 1][0]) { a = cols[s]; b = cols[s + 1]; break; }
      const u = b[0] === a[0] ? 0 : (t - a[0]) / (b[0] - a[0]);
      for (let c = 0; c < 3; c++) out[i * 3 + c] = Math.round(a[1][c] + (b[1][c] - a[1][c]) * u);
    }
    return out;
  }
  // a skin's palette, fonts and color maps over Lab's
  // (a skin's wave and intensity maps also stand in for the coupler's beam
  // maps unless it gives those too)
  function complete(def) {
    const g = (def.games && GAME && def.games[GAME]) || {};
    const cm = Object.assign({}, def.cmap || {}, g.cmap || {});
    return Object.assign({}, LAB, def, {
      palette: Object.assign({}, LAB.palette, def.palette || {}, g.palette || {}),
      fonts: Object.assign({}, LAB.fonts, def.fonts || {}, g.fonts || {}),
      cmap: Object.assign({}, LAB.cmap, cm.wave ? { beamWave: cm.wave } : {}, cm.intensity ? { beam: cm.intensity } : {}, cm),
    });
  }
  // a page can set window.ODG_SKIN_DEFAULT (the look before the player picks
  // one) or window.ODG_SKIN_ONLY (one look, whatever was picked before)
  const stored = () => {
    if (window.ODG_SKIN_ONLY) return window.ODG_SKIN_ONLY;
    try { return localStorage.getItem('odg.skin') || window.ODG_SKIN_DEFAULT || 'lab'; } catch (e) { return window.ODG_SKIN_DEFAULT || 'lab'; }
  };
  let cssLink = null, pending = {};
  // swap in the skin's stylesheet; done() runs once it has loaded (or failed)
  function setCss(id, done) {
    if (cssLink) { cssLink.remove(); cssLink = null; }
    if (id === 'lab') { done(); return; }
    cssLink = document.createElement('link'); cssLink.rel = 'stylesheet'; cssLink.href = base + id + '.css';
    cssLink.onload = done; cssLink.onerror = done;
    document.head.appendChild(cssLink);
  }
  function activate(id) {
    cur = defs[id] || LAB; luts = {};
    document.documentElement.dataset.skin = cur.id;
    listeners.forEach(fn => { try { fn(cur); } catch (e) { console.error(e); } });
  }
  // switch skins: the new look takes over once both its script and its
  // stylesheet are in, so the games lay out with the new panels and fonts
  function apply(id) {
    if (!ORDER.some(o => o[0] === id)) id = 'lab';
    try { localStorage.setItem('odg.skin', id); } catch (e) { /* private mode */ }
    let cssDone = false, jsDone = !!defs[id];
    const done = () => { if (cssDone && jsDone && stored() === id) activate(id); };
    setCss(id, () => { cssDone = true; done(); });
    if (jsDone || pending[id]) return;
    pending[id] = true;
    const sc = document.createElement('script'); sc.src = base + id + '.js';
    sc.onload = () => { pending[id] = false; jsDone = true; done(); };
    sc.onerror = () => { pending[id] = false; console.error('skin failed to load: ' + id); setCss('lab', () => {}); activate('lab'); };
    document.head.appendChild(sc);
  }

  function picker(btn) {
    let pop = document.getElementById('skinPop');
    if (pop) { pop.remove(); return; }
    pop = document.createElement('div'); pop.id = 'skinPop'; pop.className = 'skinpop';
    pop.innerHTML = '<div class="sp-lab">Skin</div>' + ORDER.map(([id, name]) => `<button data-id="${id}" class="${id === cur.id ? 'on' : ''}">${name}</button>`).join('');
    document.body.appendChild(pop);
    // under the button, kept inside the window
    const r = btn.getBoundingClientRect(), pw = pop.offsetWidth, ph = pop.offsetHeight;
    const left = Math.max(8, Math.min(r.left, innerWidth - pw - 8)), top = r.bottom + 6 + ph > innerHeight - 8 ? Math.max(8, r.top - ph - 6) : r.bottom + 6;
    pop.style.left = `${Math.round(left)}px`; pop.style.top = `${Math.round(top)}px`;
    pop.onclick = e => { const id = e.target.dataset && e.target.dataset.id; if (!id) return; apply(id); pop.remove(); };
    setTimeout(() => document.addEventListener('pointerdown', function close(e) { if (!pop.contains(e.target) && e.target !== btn) { pop.remove(); document.removeEventListener('pointerdown', close); } }), 0);
  }

  window.SKINS = {
    order: ORDER,
    register(def) { defs[def.id] = complete(def); },
    // game: 'component', 'coupler' or 'ring', for per-game overrides
    init(game) { GAME = game || null; apply(stored()); },
    get game() { return GAME; },
    apply, picker,
    get current() { return cur; },
    // palette color by name as rgba text, alpha optional
    col(name, a = 1) { const v = cur.palette[name] || LAB.palette[name] || '#ff00ff', [r, g, b] = hexRGB(v); return a >= 1 ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${a})`; },
    rgb(name) { return hexRGB(cur.palette[name] || LAB.palette[name] || '#ff00ff'); },
    font(kind = 'mono') { return cur.fonts[kind] || LAB.fonts[kind]; },
    // 256-entry RGB table of a color map
    lut(name) { return luts[name] || (luts[name] = buildLut(cur.cmap[name] || LAB.cmap[name])); },
    onChange(fn) { listeners.push(fn); },
    hexRGB, buildLut,
  };
})();
