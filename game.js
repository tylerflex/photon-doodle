/* game.js : page side of the component designer.
 * Renders the field and the silicon boundary, turns pointer strokes into
 * level-set edits, and talks to worker.js, which owns the physics. On levels
 * with fabrication rules it also shows the etch-case scores and the 150 nm
 * check, takes lock and keep-out zones, keeps the collection of layout
 * families found, and shows the fab run (fields of all etch cases).
 */
(function () {
  'use strict';
  const { D, LEVELS } = window.COMPONENT_LEVELS;
  const LS = window.LS;
  const $ = id => document.getElementById(id);

  SKINS.init('component');
  // ------------------------------------------------------------- colors (the active skin's)
  const col = (n, a) => SKINS.col(n, a), rgb = n => SKINS.rgb(n);
  let BG, LUT_WAVE, LUT_FIRE;
  function skinColors() { BG = col('bg'); LUT_WAVE = SKINS.lut('wave'); LUT_FIRE = SKINS.lut('intensity'); }
  skinColors();

  // ------------------------------------------------------------- state
  const worker = new Worker('worker.js?v=e60eff5f15');
  // a second worker sweeps the spectrum of the latest design, so the curve
  // follows the drawing and the optimizer without slowing either
  const specWorker = new Worker('worker.js?v=e60eff5f15');
  let specSent = 0, specBusy = false, specStale = false, specPart = null;
  const cv = $('cv'), ctx = cv.getContext('2d');
  let li = 0, geo = null, mask = null;
  let phi = null, re = null, im = null, sens = null;
  let st = null;                         // latest worker state
  let asm = null;                        // latest assessment (fab-rule levels)
  let contour = null, structDirty = true;
  let tool = 'add', brushR = 0.12, view = 'wave', showSens = false, robust = false;
  let optimizing = false, seq = 0, pending = [], undo = [];
  let hist = [], spec = null;
  let cursor = null, drawing = null;
  let off = null, offImg = null, sensCv = null, zoneCv = null, drcCv = null, drcSpots = [];
  let lockLS = null, keepLS = null, anyKeep = false, zoneDirty = true, zoneLines = null;
  let map = { s: 1, ox: 0, oy: 0 };
  let rateT = 0, rateN = 0, itRate = 0;
  let fabOpen = false, curKey = null;
  const best = loadJSON('odg.component.best');
  // the design behind each level's best score (design box only, encPhi), for
  // the share card
  const bestDesign = loadJSON('odg.component.designs.v1');
  const dexAll = loadJSON('odg.component.dex.v1');

  function loadJSON(k) { try { return JSON.parse(localStorage.getItem(k) || '{}'); } catch (e) { return {}; } }
  function saveJSON(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode */ } }
  // fab-rule levels keep their own records: their scores mean something else
  const bestKey = L => L.rules ? `${L.id}@fab${L.v || 1}` : L.id;
  const nm = um => Math.round(um * 1000) + ' nm';

  // ------------------------------------------------------------- panel
  function medalOf(L, s) { return s >= L.medals[2] ? 'g' : s >= L.medals[1] ? 's' : s >= L.medals[0] ? 'b' : ''; }
  function buildLevels() {
    const box = $('levels'); box.innerHTML = '';
    LEVELS.forEach((L, i) => {
      const b = document.createElement('button');
      b.className = 'lvl' + (i === li ? ' on' : '');
      const bs = best[bestKey(L)];
      b.innerHTML = `<span class="n">${i + 1}</span><span>${L.title}</span>` +
        `<span class="best">${bs != null ? bs.toFixed(2) + ' dB' : ''}</span>` +
        `<span class="medal ${bs != null ? medalOf(L, bs) : ''}"></span>`;
      b.onclick = () => loadLevel(i);
      box.appendChild(b);
    });
  }
  function scoreWhat(L) {
    if (L.rules) return 'worst of 3 etch cases';
    if (L.id === 'splitter') return 'worse port vs. ideal 50%';
    if (L.id === 'demux') return 'worse channel';
    if (L.id === 'converter') return 'TE1 transmission';
    return 'transmission';
  }
  function buildLadder(L) {
    const el = $('ladder');
    el.innerHTML = '<div class="track"></div><div class="fill" id="ladFill"></div><div class="bestmark" id="ladBest" title="Your best"></div>';
    const pos = [40, 70, 90], cls = ['b', 's', 'g'];
    L.medals.forEach((m, k) => {
      const t = document.createElement('div'); t.className = 'tick ' + cls[k]; t.style.left = pos[k] + '%'; t.id = 'tick' + k;
      el.appendChild(t);
      const l = document.createElement('div'); l.className = 'tl'; l.style.left = pos[k] + '%'; l.textContent = m.toFixed(2);
      el.appendChild(l);
    });
  }
  function ladderPos(L, s) {
    const m = L.medals, P = [[m[0] - 3, 0], [m[0], 40], [m[1], 70], [m[2], 90], [0, 100]];
    if (s <= P[0][0]) return 0;
    for (let k = 0; k < P.length - 1; k++) {
      if (s <= P[k + 1][0]) return P[k][1] + (P[k + 1][1] - P[k][1]) * (s - P[k][0]) / (P[k + 1][0] - P[k][0]);
    }
    return 100;
  }

  function loadLevel(i) {
    li = i;
    const L = LEVELS[i], R = L.rules;
    emit('level', { li: i, rules: !!R });
    shownTier = ''; runBest = null;
    geo = null; st = null; asm = null; phi = null; re = null; im = null; sens = null; hist = []; spec = null; undo = []; pending = [];
    drcCv = null; drcSpots = []; curKey = null;
    setOpt(false, true);
    setFab(false);
    $('goal').textContent = L.goal;
    $('rules').style.display = R ? '' : 'none';
    if (R) {
      $('rules').innerHTML = `<b>Fab rules.</b> The score is the worst of three etch cases (&plusmn;${nm(R.etch)}). ` +
        `Silicon or gaps under ${nm(R.minFeature)}, including where the design meets a port, fail the fab check, and a failing design does not score. ` +
        `When Optimize stops on a failing design, the best passing one it found comes back.`;
    }
    for (const id of ['fabInfo', 'fabB', 'targetRow', 'dexSec']) $(id).style.display = R ? '' : 'none';
    $('fabInfo').innerHTML = '';
    robust = false; setTargetUI();
    $('hint').innerHTML = '<b>drag</b> add &middot; <b>shift-drag</b> remove &middot; <b>scroll</b> brush &middot; <b>space</b> optimize &middot; <b>z</b> undo';
    $('scoreWhat').textContent = scoreWhat(L);
    $('scoreV').textContent = '–'; $('scoreV').classList.remove('stale');
    specWorker.postMessage({ type: 'level', li: i }); specBusy = false; specStale = false; specPart = null;
    setSpec(L.lambdas.length > 1);
    buildLevels(); buildLadder(L); renderDex();
    const multi = L.lambdas.length > 1;
    $('lamSeg').style.display = multi ? '' : 'none';
    if (multi) {
      const seg = $('lamSeg'); seg.innerHTML = '';
      L.lambdas.forEach((lam, k) => {
        const b = document.createElement('button');
        b.textContent = `λ ${Math.round(lam * 1000)} nm`;
        b.dataset.v = k;
        if (k === L.lambdas.length - 1) b.className = 'on';
        b.onclick = () => { [...seg.children].forEach(c => c.classList.toggle('on', c === b)); worker.postMessage({ type: 'view', lam: k }); };
        seg.appendChild(b);
      });
    }
    worker.postMessage({ type: 'level', li: i });
    $('smooth').value = L.smooth ?? 0.3;
    sendParams();
  }

  function sendParams() {
    worker.postMessage({ type: 'params', speed: +$('speed').value, smooth: +$('smooth').value });
    $('speedV').textContent = (+$('speed').value * D * 1000).toFixed(0) + ' nm/step';
    $('smoothV').textContent = (+$('smooth').value).toFixed(2);
  }

  // page events for a guide on the page (single.html's walkthrough)
  const emit = (type, detail) => window.dispatchEvent(new CustomEvent('cd', { detail: Object.assign({ type }, detail) }));
  // window.CD_AUTO_ETCH = n (single.html): each Optimize run works on the
  // drawn shape for n steps, then on all three etch cases, in place of the
  // As drawn / Worst etch choice
  let optFrom = 0, runBest = null;
  // the player's own pause holds: auto-optimize (CD_AUTO_OPT) starts nothing
  // while it is set, until the player presses Optimize again
  let heldPause = false;
  function toggleOpt() { heldPause = optimizing; setOpt(!optimizing); }
  function setOpt(on, silent) {
    if (on !== optimizing) emit('opt', { on });
    if (on && !optimizing) runBest = null;
    if (on && !optimizing && window.CD_AUTO_ETCH && LEVELS[li].rules) { optFrom = st ? st.iter : 0; if (robust) setRobust(false); }
    optimizing = on;
    $('optB').classList.toggle('on', on);
    $('optL').textContent = on ? 'Optimizing… (pause)' : heldPause && window.CD_AUTO_OPT ? 'Resume' : 'Optimize';
    if (on && phi) pushUndo();
    if (!silent) worker.postMessage({ type: 'opt', on });
    rateT = performance.now(); rateN = 0;
  }
  function setTargetUI() {
    [...$('targetRow').children].forEach(b => b.classList.toggle('on', (b.dataset.v === 'worst') === robust));
  }
  function setRobust(on) {
    if (!LEVELS[li].rules) return;
    robust = on; setTargetUI();
    worker.postMessage({ type: 'robust', on });
  }

  function toast(msg) {
    const t = $('toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), 2200);
  }

  // ------------------------------------------------------------- worker
  worker.onmessage = e => {
    const m = e.data;
    if (m.li !== li) return;
    if (m.type === 'level') {
      geo = m;
      const N = m.nx * m.ny;
      mask = new Uint8Array(N);
      const [i0, i1, j0, j1] = m.design;
      for (let i = i0; i < i1; i++) for (let j = j0; j < j1; j++) mask[j + i * m.ny] = 1;
      off = document.createElement('canvas'); off.width = m.nx; off.height = m.ny;
      offImg = off.getContext('2d').createImageData(m.nx, m.ny);
      sensCv = document.createElement('canvas'); sensCv.width = m.nx; sensCv.height = m.ny;
      zoneCv = document.createElement('canvas'); zoneCv.width = m.nx; zoneCv.height = m.ny;
      lockLS = new Float32Array(N).fill(-1); keepLS = new Float32Array(N).fill(-1); anyKeep = false; zoneDirty = true;
      $('zonesClearB').style.display = 'none';
      layout();
      // window.CD_AUTO_OPT (single.html): a level that starts with a shape
      // optimizes as soon as it loads
      if (window.CD_AUTO_OPT && !heldPause && LEVELS[li].init !== 'empty') setOpt(true);
      return;
    }
    if (m.type === 'state') {
      st = m;
      phi = m.phi; re = m.re; im = m.im;
      pending = pending.filter(p => p.seq > m.seq);
      for (const p of pending) if (p.type === 'stroke') applyStroke(p);
      applyKeepLocal();
      structDirty = true;
      if (m.sens) { sens = m.sens; drawSens(); }
      if (m.optimizing !== optimizing) setOpt(m.optimizing, true);
      if (m.optimizing) {
        if (!LEVELS[li].rules) { hist.push(m.score); if (hist.length > 400) hist.shift(); }
        rateN++;
        const now = performance.now();
        if (now - rateT > 1000) { itRate = rateN * 1000 / (now - rateT); rateT = now; rateN = 0; }
      }
      updatePanel();
      requestSpec(); drawSpectrum();
      return;
    }
    if (m.type === 'assess') { onAssess(m); return; }
    if (m.type === 'restored') { if (m.failing) toast(`Back to the best design of this run that passes the fab check (${m.worst.toFixed(2)} dB)`); return; }
    if (m.type === 'fab') { renderFab(m); return; }
  };
  specWorker.onmessage = e => {
    const m = e.data;
    if (m.type !== 'spectrum' || m.li !== li || m.seq !== specSent) return;
    // the first sweep draws as it goes; later ones replace the curve when done
    if (m.done) { spec = m; specPart = null; specBusy = false; if (specStale) requestSpec(); }
    else specPart = m;
    drawSpectrum();
  };
  function requestSpec() {
    if (!phi || !$('specBox').classList.contains('show')) return;
    if (specBusy) { specStale = true; return; }
    specBusy = true; specStale = false;
    specWorker.postMessage({ type: 'spectrum', phi: Float32Array.from(phi), n: LEVELS[li].lambdas.length > 1 ? 15 : 11 });
    specSent++;
  }

  // the medal card shows each tier the first time it is reached since the
  // level was opened, whether or not it beats the saved best
  const RANK = { '': 0, b: 1, s: 2, g: 3 };
  let shownTier = '';
  function award(L, s, ph) {
    const key = bestKey(L), prev = best[key], now = medalOf(L, s);
    if (prev == null || s > prev + 1e-3) {
      best[key] = s; saveJSON('odg.component.best', best); buildLevels();
      if (ph && geo) { bestDesign[key] = { s, phi: encPhi(ph) }; saveJSON('odg.component.designs.v1', bestDesign); }
    }
    if (now && RANK[now] > RANK[shownTier]) { shownTier = now; medalPop(L, now, s); emit('medal', { tier: now }); return true; }
    return false;
  }
  const TIER = { b: 'Bronze', s: 'Silver', g: 'Gold' };
  function medalPop(L, tier, s) {
    $('mpMedal').className = 'mp-medal ' + tier;
    $('mpTier').textContent = TIER[tier];
    $('mpLine').textContent = `${L.title} · ${s.toFixed(2)} dB${L.rules ? ' worst etch case' : ''}`;
    $('medalPop').classList.add('show');
    $('medalPop').querySelector('.mp-card').dataset.tier = tier;
    if (SKINS.current.medal) SKINS.current.medal(tier, $('medalPop').querySelector('.mp-card'));
    clearTimeout(medalPop._t); medalPop._t = setTimeout(() => $('medalPop').classList.remove('show'), 6000);
  }

  // ------------------------------------------------------------- share
  // the level's best result as text people can paste anywhere, with a 9 x 9
  // picture of the design box (blue squares are silicon)
  function shareText() {
    const L = LEVELS[li], key = bestKey(L), sc = best[key];
    if (sc == null || !geo) return null;
    const [i0, i1, j0, j1] = geo.design, w = i1 - i0, h = j1 - j0;
    let des = null, label = '', clean = true;
    if (L.rules) {
      const es = Object.values(dexOf(L)).filter(e => e.clean != null).sort((a, b) => b.clean - a.clean);
      if (es.length) { des = decPhi(es[0].phi); label = es[0].label; }
    }
    if (!des && phi) {
      des = new Float32Array(w * h);
      for (let i = 0; i < w; i++) for (let j = 0; j < h; j++) des[j + i * h] = phi[(j0 + j) + (i0 + i) * geo.ny];
      clean = !L.rules || (asm && asm.fab.nThin + asm.fab.nGap === 0);
    }
    const n = 9, rows = [];
    for (let r = 0; r < n; r++) {
      let row = '';
      for (let c = 0; c < n; c++) {
        const i = Math.min(w - 1, Math.floor((c + 0.5) * w / n)), j = Math.min(h - 1, Math.floor((n - r - 0.5) * h / n));
        row += des[j + i * h] > 0 ? '🟦' : '⬛';
      }
      rows.push(row);
    }
    const md = medalOf(L, sc), emo = { g: '🥇', s: '🥈', b: '🥉' }[md];
    return [
      `${document.documentElement.dataset.page === 'single' ? 'Photon Doodle' : 'Component Designer'} · ${L.title}`,
      `${md ? emo + ' ' + TIER[md] : 'No medal yet'} · ${sc.toFixed(2)} dB${L.rules ? ' (worst etch case)' : ''}`,
      L.rules ? `${clean ? 'Fab check passed' : 'Fab check failed'}${label ? ' · ' + label.replace(/ · /g, ', ') : ''}` : null,
      rows.join('\n'),
      'Optical Design Games',
    ].filter(Boolean).join('\n');
  }
  // ---- the whole game's share card: one tile per level with the structure
  // behind the best score, the medal and the score; its text version; and
  // the window that shows both (single.html's #sharePop)
  const SITE = () => window.CD_SITE || location.href.split('#')[0];
  const MEDAL_EMO = { g: '🥇', s: '🥈', b: '🥉' };
  function levelResult(L) {
    const key = bestKey(L), sc = best[key];
    return { sc, md: sc == null ? '' : medalOf(L, sc), entry: bestDesign[key] || null };
  }
  function shareAllText() {
    const res = LEVELS.map(levelResult);
    const n = res.filter(r => r.md).length;
    return [
      `Photon Doodle ${res.map(r => MEDAL_EMO[r.md] || '⬜').join('')}`,
      ...LEVELS.map((L, k) => {
        const r = res[k];
        return `${MEDAL_EMO[r.md] || '⬜'} ${L.title}: ${r.sc == null ? 'not played yet' : r.sc.toFixed(2) + ' dB' + (r.md ? '' : ', no medal yet')}`;
      }),
      `${n} of ${LEVELS.length} levels with a medal`,
      SITE(),
    ].join('\n');
  }
  // a picture of a level's structure: the design box (the saved best design,
  // or empty) with its port waveguides, silicon light on the card's ground
  function thumb(L, entry, size) {
    const [i0, i1, j0, j1] = L.design, w = i1 - i0, h = j1 - j0, M = 7, RW = w + 2 * M, RH = h + 2 * M;
    const des = entry ? decPhi(entry.phi) : null, F = new Float32Array(RW * RH);
    for (let a = 0; a < RW; a++) for (let b = 0; b < RH; b++) {
      const i = i0 - M + a, j = j0 - M + b, inBox = i >= i0 && i < i1 && j >= j0 && j < j1;
      F[b + a * RH] = inBox ? (des ? des[(j - j0) + (i - i0) * h] : -0.05) : LS.sdShapes((i + 0.5) * D, (j + 0.5) * D, L.fixed);
    }
    const c = document.createElement('canvas'); c.width = c.height = size;
    const g = c.getContext('2d'), img = g.createImageData(size, size), sc = size / Math.max(RW, RH);
    const ox = (size - RW * sc) / 2, oy = (size - RH * sc) / 2, si = rgb('accent'), bg = rgb('bg');
    for (let px = 0; px < size; px++) for (let py = 0; py < size; py++) {
      const u = (px + 0.5 - ox) / sc - 0.5, v = (size - py - 0.5 - oy) / sc - 0.5;
      let val = -1;
      if (u >= 0 && v >= 0 && u <= RW - 1 && v <= RH - 1) {
        const a = Math.min(RW - 2, Math.floor(u)), b = Math.min(RH - 2, Math.floor(v)), fu = u - a, fv = v - b;
        val = (1 - fu) * ((1 - fv) * F[b + a * RH] + fv * F[b + 1 + a * RH]) + fu * ((1 - fv) * F[b + (a + 1) * RH] + fv * F[b + 1 + (a + 1) * RH]);
      }
      const t = Math.max(0, Math.min(1, 0.5 + val / (1.2 / sc * D))), q = 4 * (px + py * size);
      for (let k = 0; k < 3; k++) img.data[q + k] = Math.round(bg[k] + (si[k] - bg[k]) * t);
      img.data[q + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    g.strokeStyle = col('boxLine', 0.55); g.setLineDash([4, 4]); g.lineWidth = 1;
    g.strokeRect(ox + M * sc, oy + M * sc, w * sc, h * sc);
    return c;
  }
  function shareCard() {
    const W = 1200, H = 630, c = document.createElement('canvas'); c.width = W; c.height = H;
    const g = c.getContext('2d'), fam = getComputedStyle(document.body).fontFamily;
    const res = LEVELS.map(levelResult), n = res.filter(r => r.md).length;
    g.fillStyle = col('bg'); g.fillRect(0, 0, W, H);
    g.fillStyle = col('ink'); g.font = `600 40px ${fam}`; g.textBaseline = 'alphabetic';
    g.fillText('Photon Doodle', 48, 84);
    g.fillStyle = col('dim'); g.font = `18px ${fam}`;
    g.fillText(`${n} of ${LEVELS.length} levels with a medal`, 48, 118);
    const tw = 208, gap = 14, x0 = (W - (LEVELS.length * tw + (LEVELS.length - 1) * gap)) / 2, ty = 160;
    const tier = { g: [col('gold'), 'Gold'], s: [col('silver'), 'Silver'], b: [col('bronze'), 'Bronze'] };
    LEVELS.forEach((L, k) => {
      const x = x0 + k * (tw + gap), r = res[k];
      g.fillStyle = col('panel'); g.fillRect(x, ty, tw, 360);
      g.strokeStyle = r.md ? tier[r.md][0] : col('ink', 0.12); g.lineWidth = r.md ? 2 : 1; g.strokeRect(x + 0.5, ty + 0.5, tw - 1, 359);
      g.drawImage(thumb(L, r.entry, tw - 16), x + 8, ty + 8);
      g.fillStyle = col('ink'); g.font = `600 17px ${fam}`; g.fillText(L.title, x + 12, ty + tw + 30);
      if (r.md) {
        g.fillStyle = tier[r.md][0]; g.beginPath(); g.arc(x + 22, ty + tw + 62, 9, 0, 2 * Math.PI); g.fill();
        g.font = `600 15px ${fam}`; g.fillText(tier[r.md][1], x + 38, ty + tw + 67);
      } else { g.fillStyle = col('faint'); g.font = `15px ${fam}`; g.fillText(r.sc == null ? 'Not played yet' : 'No medal yet', x + 12, ty + tw + 67); }
      if (r.sc != null) { g.fillStyle = col('dim'); g.font = `15px ${fam}`; g.fillText(`${r.sc.toFixed(2)} dB`, x + 12, ty + tw + 96); }
      if (!r.entry && r.sc != null) { g.fillStyle = col('faint'); g.font = `12px ${fam}`; g.fillText('design not saved', x + 12, ty + tw + 120); }
    });
    g.fillStyle = col('faint'); g.font = `16px ${fam}`;
    g.fillText(SITE().replace(/^https?:\/\//, '').replace(/\/$/, ''), 48, H - 40);
    // the page's logo (single.html), bottom right, when it has loaded
    const logo = document.querySelector('.sp-brand .on-dark');
    if (logo && logo.complete && logo.naturalWidth) { const lh = 22, lw = lh * logo.naturalWidth / logo.naturalHeight; g.drawImage(logo, W - 48 - lw, H - 40 - lh + 4, lw, lh); }
    return c;
  }
  async function copyText(t) {
    try { await navigator.clipboard.writeText(t); return true; } catch (e) {
      const a = document.createElement('textarea'); a.value = t; a.style.position = 'fixed'; a.style.opacity = '0';
      document.body.appendChild(a); a.select();
      let ok = false; try { ok = document.execCommand('copy'); } catch (e2) { ok = false; }
      a.remove(); return ok;
    }
  }
  let cardCv = null;
  function openShare() {
    cardCv = shareCard();
    $('shImg').src = cardCv.toDataURL('image/png');
    $('shTxt').textContent = shareAllText();
    $('medalPop').classList.remove('show');
    $('sharePop').classList.add('show');
  }
  if ($('sharePop')) {
    $('shCopyText').onclick = async () => toast(await copyText(shareAllText()) ? 'Copied the text. Paste it anywhere.' : 'Copy failed: the browser blocked the clipboard');
    $('shCopyImg').onclick = async () => {
      try {
        const blob = await new Promise(r => cardCv.toBlob(r, 'image/png'));
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        toast('Copied the image. Paste it into a post or chat.');
      } catch (e) { toast('This browser cannot copy images: use Download'); }
    };
    $('shDownload').onclick = () => { const a = document.createElement('a'); a.href = cardCv.toDataURL('image/png'); a.download = 'photon-doodle.png'; a.click(); };
    $('shClose').onclick = () => $('sharePop').classList.remove('show');
    $('sharePop').onclick = e => { if (e.target === $('sharePop')) $('sharePop').classList.remove('show'); };
  }

  async function share() {
    if ($('sharePop')) { openShare(); return; }
    const t = shareText();
    if (!t) { toast('Finish a design first: there is no score on this level yet'); return; }
    let ok = false;
    try { await navigator.clipboard.writeText(t); ok = true; } catch (e) {
      const a = document.createElement('textarea'); a.value = t; a.style.position = 'fixed'; a.style.opacity = '0';
      document.body.appendChild(a); a.select();
      try { ok = document.execCommand('copy'); } catch (e2) { ok = false; }
      a.remove();
    }
    toast(ok ? 'Copied your result. Paste it anywhere.' : 'Copy failed: the browser blocked the clipboard');
  }

  // ------------------------------------------------------------- how to play
  const ONB = [
    ['Light on a chip', 'Light travels through silicon waveguides on a chip. A photonic circuit needs small parts that split, turn and sort that light. You design those parts.'],
    ['Draw silicon', 'Draw silicon inside the box. The field you see is Maxwell\'s equations solved for your shape, and it updates while you draw.'],
    ['Optimize', 'Optimize moves every edge of your silicon at once, in the direction that raises your score. One extra field solve, the adjoint, gives that direction everywhere. It improves the design you start from, so the starting shape is your job.'],
    ['Real fabrication', 'Fabs etch a little more or less than drawn. Your score is the worst of three etch cases, and silicon or gaps under 150 nm fail the fab check.'],
    ['Medals and the road ahead', 'Medals open the next part, and every new layout you find goes into your collection. After the parts, the light has to leave the chip and reach a fiber.'],
  ];
  // the single page (single.html) has no collection and no other games
  if (document.documentElement.dataset.page === 'single') ONB[4] = ['Medals', 'Each part has bronze, silver and gold. Optimize alone rarely reaches gold: the starting shape you draw decides how far it gets.'];
  let onbAt = 0;
  function onb(k) {
    onbAt = Math.max(0, Math.min(ONB.length - 1, k));
    $('onb').classList.add('show');
    $('onbStep').textContent = `How to play · ${onbAt + 1} of ${ONB.length}`;
    $('onbTitle').textContent = ONB[onbAt][0];
    $('onbText').textContent = ONB[onbAt][1];
    $('onbDots').innerHTML = ONB.map((_, i) => `<i class="${i === onbAt ? 'on' : ''}"></i>`).join('');
    $('onbBack').disabled = onbAt === 0;
    $('onbNext').textContent = onbAt === ONB.length - 1 ? 'Play' : 'Next';
  }
  function onbClose() {
    $('onb').classList.remove('show');
    try { localStorage.setItem('odg.component.onboarded', '1'); } catch (e) { /* private mode */ }
  }

  function onAssess(m) {
    asm = m;
    const L = LEVELS[li];
    const clean = m.fab.nThin + m.fab.nGap === 0;
    buildDrc(m.fab);
    if (optimizing) { hist.push(m.worst); if (hist.length > 400) hist.shift(); }
    const medal = clean ? award(L, m.worst, m.phi) : false;
    recordDex(L, m, clean, medal);
    updatePanel();
  }

  function updatePanel() {
    const L = LEVELS[li], m = st;
    if (!m) return;
    let shown = m.score, eligible = true, stale = false;
    if (L.rules) {
      if (asm) {
        shown = asm.worst;
        eligible = asm.fab.nThin + asm.fab.nGap === 0;
        stale = !optimizing && (asm.seq !== m.seq || asm.iter !== m.iter || pending.length > 0);
      } else { shown = null; stale = true; }
      // single page: while Optimize runs, the score is the best passing design
      // of the run (the one a pause keeps), so it only goes up
      if (window.CD_AUTO_ETCH && optimizing && asm) {
        if (eligible && (runBest == null || asm.worst > runBest)) runBest = asm.worst;
        shown = runBest; eligible = runBest != null;
      }
      renderFabInfo(L, stale);
    } else {
      award(L, m.score, m.phi);
      if (window.CD_AUTO_ETCH && optimizing) { if (runBest == null || m.score > runBest) runBest = m.score; shown = runBest; }
    }
    $('scoreV').textContent = shown == null ? '–' : shown.toFixed(2);
    $('scoreV').classList.toggle('stale', stale);
    $('ladFill').style.width = (shown == null ? 0 : ladderPos(L, shown)) + '%';
    // a medal once earned stays lit (the saved best), and a mark shows where
    // the best score sits while the current design is below it
    const bestv = best[bestKey(L)];
    for (let k = 0; k < 3; k++) $('tick' + k).classList.toggle('hit', (shown != null && eligible && shown >= L.medals[k]) || (bestv != null && bestv >= L.medals[k]));
    $('ladBest').style.display = bestv == null ? 'none' : '';
    if (bestv != null) { $('ladBest').style.left = ladderPos(L, bestv) + '%'; $('ladBest').title = `Your best: ${bestv.toFixed(2)} dB`; }
    if (window.CD_AUTO_ETCH && optimizing && L.rules && !robust && m.iter - optFrom >= window.CD_AUTO_ETCH) setRobust(true);
    $('iterV').textContent = m.iter ? `iteration ${m.iter}` + (window.CD_AUTO_ETCH && L.rules && optimizing ? (robust ? ' · all 3 etch cases' : ' · drawn shape') : '') : '';
    // port bars
    const bars = $('bars'); bars.innerHTML = '';
    const multi = L.lambdas.length > 1;
    const tgt = new Set(L.targets.map(t => t.lam + ':' + t.port));
    L.lambdas.forEach((lam, l) => {
      let sum = 0;
      L.ports.forEach((p, k) => {
        if (k === 0) return;
        const v = m.T[l][k]; sum += p.info ? 0 : v;
        const t = L.targets.find(t => t.lam === l && t.port === k);
        bars.appendChild(bar(p.name + (multi ? ` @${Math.round(lam * 1000)}` : ''), v, tgt.has(l + ':' + k), t ? t.share : null));
      });
      bars.appendChild(bar('reflected' + (multi ? ` @${Math.round(lam * 1000)}` : ''), m.R[l], false, null));
      bars.appendChild(bar('lost' + (multi ? ` @${Math.round(lam * 1000)}` : ''), Math.max(0, 1 - sum - m.R[l]), false, null));
    });
    drawSpark();
    const g = geo;
    $('stats').innerHTML =
      `FDFD ${g.nx}&times;${g.ny} = ${(g.nx * g.ny).toLocaleString()} unknowns, 50 nm cells<br>` +
      `refactor ${m.tf.toFixed(0)} ms, solves ${m.ts.toFixed(0)} ms` + (robust && optimizing ? ' (3 etch cases)' : '') +
      (optimizing ? `, ${itRate.toFixed(1)} steps/s` : '');
  }
  function caseName(dl) { return dl < 0 ? `${nm(-dl)} narrower` : dl > 0 ? `${nm(dl)} wider` : 'as drawn'; }
  function renderFabInfo(L, stale) {
    const el = $('fabInfo');
    if (!asm) { el.innerHTML = '<div class="drc">checking the etch cases…</div>'; return; }
    const w = asm.worst;
    const cells = asm.corners.map(c =>
      `<div class="cn${c.score === w ? ' worst' : ''}"><span class="k">${caseName(c.delta)}</span><span class="x">${c.score.toFixed(2)} dB</span></div>`).join('');
    const f = asm.fab, ok = f.nThin + f.nGap === 0;
    const parts = [];
    if (f.thinSpots) parts.push(`${f.thinSpots} thin spot${f.thinSpots > 1 ? 's' : ''}`);
    if (f.gapSpots) parts.push(`${f.gapSpots} narrow gap${f.gapSpots > 1 ? 's' : ''}`);
    const mf = nm(L.rules.minFeature);
    const drc = stale ? '<div class="drc">checking…</div>'
      : ok ? `<div class="drc ok">Fab check passed (${mf})</div>`
        : `<div class="drc bad">Not scored: ${parts.join(', ')} under ${mf}</div>`;
    // the single page says how to fix it (one fixed line, so nothing moves)
    const fix = !window.CD_AUTO_OPT ? '' : `<div class="drc fix">${stale || ok ? '' : f.gapSpots && f.thinSpots ? 'Draw or erase at the marked spots'
      : f.gapSpots ? 'Fill or widen the marked gap' : 'Thicken the marked spot'}</div>`;
    el.innerHTML = `<div class="corners">${cells}</div>${drc}${fix}`;
  }
  function bar(name, v, target, share) {
    const d = document.createElement('div'); d.className = 'bar' + (target ? ' tgt' : '');
    d.innerHTML = `<span class="nm">${name}</span><span class="tr"><i style="width:${Math.max(0, Math.min(1, v)) * 100}%"></i>` +
      (share != null ? `<span class="mk" style="left:${share * 100}%"></span>` : '') +
      `</span><span class="vv">${(100 * v).toFixed(v < 0.1 ? 2 : 1)}%</span>`;
    return d;
  }
  function drawSpark() {
    const c = $('spark'), r = c.getBoundingClientRect(), dpr = Math.min(2, devicePixelRatio || 1);
    c.width = r.width * dpr; c.height = r.height * dpr;
    const g = c.getContext('2d'); g.scale(dpr, dpr);
    const W = r.width, H = r.height;
    if (hist.length < 2) { g.fillStyle = col('faint'); g.font = '10px ' + getComputedStyle(document.body).fontFamily; g.fillText('score history appears while optimizing', 0, H / 2 + 3); return; }
    const L = LEVELS[li];
    let lo = Math.min(...hist, L.medals[0]), hi = Math.max(...hist, 0);
    lo = Math.max(lo, -25);
    const y = v => H - 3 - (H - 6) * (Math.max(lo, v) - lo) / (hi - lo || 1);
    const cols = [col('bronze'), col('silver'), col('gold')];
    L.medals.forEach((m, k) => { g.strokeStyle = cols[k]; g.globalAlpha = 0.35; g.beginPath(); g.moveTo(0, y(m)); g.lineTo(W, y(m)); g.stroke(); });
    g.globalAlpha = 1; g.strokeStyle = col('accent'); g.lineWidth = 1.5; g.beginPath();
    hist.forEach((v, k) => { const x = W * k / (hist.length - 1); k ? g.lineTo(x, y(v)) : g.moveTo(x, y(v)); });
    g.stroke();
  }
  function setSpec(on) {
    $('specBox').classList.toggle('show', on);
    $('specB').classList.toggle('on', on);
    if (on) { $('specNote').textContent = 'solving…'; requestSpec(); }
  }
  function drawSpectrum() {
    const c = $('plot');
    if (!$('specBox').classList.contains('show')) return;
    const r = c.getBoundingClientRect(), dpr = Math.min(2, devicePixelRatio || 1);
    c.width = r.width * dpr; c.height = r.height * dpr;
    const g = c.getContext('2d'); g.scale(dpr, dpr);
    const W = r.width, H = r.height, L = LEVELS[li];
    const pad = { l: 30, r: 8, t: 8, b: 20 };
    const sp = spec || specPart;
    if (!sp) return;
    const lams = sp.lams, n = lams.length;
    const x0 = lams[0], x1 = L.lambdas.length > 1 ? Math.max(...L.lambdas) + 0.08 : L.lambdas[0] + 0.08;
    const xs = v => pad.l + (W - pad.l - pad.r) * (v - (Math.min(...L.lambdas) - 0.08)) / (x1 - (Math.min(...L.lambdas) - 0.08));
    const ys = v => H - pad.b - (H - pad.t - pad.b) * v;
    g.font = '9px ' + getComputedStyle(document.body).fontFamily; g.fillStyle = col('faint'); g.strokeStyle = col('ink', 0.08);
    for (let v = 0; v <= 1.001; v += 0.25) { g.beginPath(); g.moveTo(pad.l, ys(v)); g.lineTo(W - pad.r, ys(v)); g.stroke(); g.fillText((v * 100) + '%', 2, ys(v) + 3); }
    const lo = Math.min(...L.lambdas) - 0.08;
    g.textAlign = 'center';
    for (let k = 0; k <= 4; k++) { const v = lo + (x1 - lo) * k / 4; g.fillText(Math.round(v * 1000), Math.min(W - 14, Math.max(pad.l + 10, xs(v))), H - 6); }
    g.textAlign = 'left';
    L.lambdas.forEach(lam => { g.strokeStyle = col('accent', 0.25); g.setLineDash([3, 3]); g.beginPath(); g.moveTo(xs(lam), pad.t); g.lineTo(xs(lam), H - pad.b); g.stroke(); g.setLineDash([]); });
    const palette = [col('accent'), col('series4'), col('good'), col('series3')];
    L.ports.forEach((p, k) => {
      if (k === 0) return;
      g.strokeStyle = palette[(k - 1) % palette.length]; g.lineWidth = p.info ? 1 : 1.8;
      g.setLineDash(p.info ? [4, 3] : []);
      g.beginPath();
      sp.rows.forEach((row, m) => { const X = xs(lams[m]), Y = ys(row[k]); m ? g.lineTo(X, Y) : g.moveTo(X, Y); });
      g.stroke(); g.setLineDash([]);
    });
    // this step's transmission at the design wavelengths (dots), and where
    // each target wants its port (rings at the top)
    if (st && st.T) L.lambdas.forEach((lam, l) => L.ports.forEach((p, k) => {
      if (k === 0 || p.info) return;
      const c = palette[(k - 1) % palette.length], X = xs(lam);
      if (L.targets.some(t => t.lam === l && t.port === k)) {
        g.strokeStyle = c; g.lineWidth = 1.2; g.beginPath(); g.arc(X, ys(1), 4, 0, 2 * Math.PI); g.stroke();
      }
      g.fillStyle = c; g.beginPath(); g.arc(X, ys(st.T[l][k]), 3, 0, 2 * Math.PI); g.fill();
    }));
    const key = L.ports.map((p, k) => k === 0 ? '' : `<span style="color:${palette[(k - 1) % palette.length]}">&#9644; ${p.name}</span>`).join(' ');
    $('specNote').innerHTML = key + (spec ? (L.lambdas.length > 1 ? '<br>rings: where each wavelength should go &middot; dots: now' : '') : ` &middot; solving ${n} wavelengths…`);
  }

  // ------------------------------------------------------------- fab check overlay
  function buildDrc(f) {
    if (!drcCv || drcCv.width !== f.W || drcCv.height !== f.H) { drcCv = document.createElement('canvas'); drcCv.width = f.W; drcCv.height = f.H; }
    const g = drcCv.getContext('2d'), img = g.createImageData(f.W, f.H), d = img.data;
    for (let a = 0; a < f.W; a++) for (let b = 0; b < f.H; b++) {
      const v = f.flags[b + a * f.H];
      if (!v) continue;
      const q = 4 * (a + (f.H - 1 - b) * f.W);
      const c = rgb(v === 1 ? 'drcThin' : 'drcGap'); d[q] = c[0]; d[q + 1] = c[1]; d[q + 2] = c[2];
      d[q + 3] = 235;
    }
    g.putImageData(img, 0, 0);
    // one ring per spot so small violations are easy to find
    drcSpots = [];
    const seen = new Uint8Array(f.W * f.H), stack = [];
    for (let s = 0; s < f.W * f.H; s++) {
      if (!f.flags[s] || seen[s]) continue;
      let sx = 0, sy = 0, n = 0, ax0 = 1e9, ax1 = -1e9, by0 = 1e9, by1 = -1e9;
      stack.push(s); seen[s] = 1;
      while (stack.length) {
        const q = stack.pop(), a = (q / f.H) | 0, b = q - a * f.H;
        sx += a; sy += b; n++;
        ax0 = Math.min(ax0, a); ax1 = Math.max(ax1, a); by0 = Math.min(by0, b); by1 = Math.max(by1, b);
        for (let da = -1; da <= 1; da++) for (let db = -1; db <= 1; db++) {
          const aa = a + da, bb = b + db;
          if (aa < 0 || bb < 0 || aa >= f.W || bb >= f.H) continue;
          const t = bb + aa * f.H;
          if (f.flags[t] && !seen[t]) { seen[t] = 1; stack.push(t); }
        }
      }
      const px = D / f.F;
      drcSpots.push({
        x: (f.ci0 + (sx / n + 0.5) / f.F) * D, y: (f.cj0 + (sy / n + 0.5) / f.F) * D,
        r: Math.max(0.09, 0.5 * Math.hypot(ax1 - ax0 + 1, by1 - by0 + 1) * px + 0.05),
      });
    }
  }

  // ------------------------------------------------------------- design collection
  function dexOf(L) { const k = bestKey(L); return dexAll[k] || (dexAll[k] = {}); }
  function labelOf(t) {
    const parts = [`${t.anchored} piece${t.anchored === 1 ? '' : 's'}`];
    if (t.islands) parts.push(`${t.islands} island${t.islands > 1 ? 's' : ''}`);
    if (t.holes) parts.push(`${t.holes} hole${t.holes > 1 ? 's' : ''}`);
    return parts.join(' · ');
  }
  function encPhi(p) {
    const [i0, i1, j0, j1] = geo.design, w = i1 - i0, h = j1 - j0;
    let s = '';
    for (let i = 0; i < w; i++) for (let j = 0; j < h; j++) {
      const q = Math.max(-127, Math.min(127, Math.round(p[(j0 + j) + (i0 + i) * geo.ny] / 0.0025)));
      s += String.fromCharCode(q & 255);
    }
    return btoa(s);
  }
  function decPhi(str) {
    const s = atob(str), a = new Float32Array(s.length);
    for (let k = 0; k < s.length; k++) { const c = s.charCodeAt(k); a[k] = (c > 127 ? c - 256 : c) * 0.0025; }
    return a;
  }
  function recordDex(L, m, clean, medalToasted) {
    const dx = dexOf(L), t = m.topo, key = `${t.anchored}/${t.islands}/${t.holes}`;
    if (m.worst < -3) { curKey = null; [...$('dex').children].forEach(c => c.classList.remove('cur')); return; }
    curKey = key;
    let e = dx[key];
    const isNew = !e;
    if (!e) e = dx[key] = { key, label: labelOf(t), clean: null, any: null, phi: null, cleanPhi: false };
    let changed = isNew;
    const firstClean = clean && e.clean == null;
    if (clean && (e.clean == null || m.worst > e.clean + 1e-3)) { e.clean = m.worst; e.phi = encPhi(m.phi); e.cleanPhi = true; changed = true; }
    if (e.any == null || m.worst > e.any + 1e-3) { e.any = m.worst; if (!e.cleanPhi) e.phi = encPhi(m.phi); changed = true; }
    // cap the list: drop the weakest families that never passed the fab check
    const es = Object.values(dx);
    if (es.length > 24) {
      es.sort((a, b) => ((a.clean != null) - (b.clean != null)) || ((a.clean ?? a.any) - (b.clean ?? b.any)));
      for (const x of es.slice(0, es.length - 24)) if (x.key !== key) delete dx[x.key];
    }
    if (firstClean && !medalToasted && Object.keys(dx).length > 1) toast(`New layout family: ${e.label}, ${m.worst.toFixed(2)} dB`);
    if (changed) { saveJSON('odg.component.dex.v1', dexAll); renderDex(); }
    else [...$('dex').children].forEach(c => c.classList.toggle('cur', c.dataset.key === key));
  }
  function drawThumb(c, str) {
    const [i0, i1, j0, j1] = geo ? geo.design : LEVELS[li].design, w = i1 - i0, h = j1 - j0, F = 2;
    const a = decPhi(str);
    c.width = w * F; c.height = h * F;
    const g = c.getContext('2d'), img = g.createImageData(w * F, h * F), d = img.data;
    const at = (i, j) => a[Math.min(h - 1, Math.max(0, j)) + Math.min(w - 1, Math.max(0, i)) * h], bgc = rgb('panel'), si = rgb('thumbSi');
    for (let x = 0; x < w * F; x++) for (let y = 0; y < h * F; y++) {
      const u = (x + 0.5) / F - 0.5, v = (y + 0.5) / F - 0.5, i = Math.floor(u), j = Math.floor(v), fu = u - i, fv = v - j;
      const p = (1 - fu) * ((1 - fv) * at(i, j) + fv * at(i, j + 1)) + fu * ((1 - fv) * at(i + 1, j) + fv * at(i + 1, j + 1));
      const s = LS.H(p, 0.02), q = 4 * (x + (h * F - 1 - y) * w * F);
      d[q] = bgc[0] + (si[0] - bgc[0]) * s; d[q + 1] = bgc[1] + (si[1] - bgc[1]) * s; d[q + 2] = bgc[2] + (si[2] - bgc[2]) * s; d[q + 3] = 255;
    }
    g.putImageData(img, 0, 0);
  }
  function renderDex() {
    const L = LEVELS[li], el = $('dex');
    if (!L.rules) return;
    const dx = dexOf(L);
    const es = Object.values(dx).sort((a, b) => ((b.clean != null) - (a.clean != null)) || ((b.clean ?? b.any) - (a.clean ?? a.any)));
    $('dexCount').textContent = es.length ? `${es.length} famil${es.length === 1 ? 'y' : 'ies'}` : '';
    el.innerHTML = '';
    if (!es.length) { el.innerHTML = '<div class="empty">Each layout you build shows up here.</div>'; return; }
    for (const e of es) {
      const b = document.createElement('button');
      b.className = 'card' + (e.key === curKey ? ' cur' : '');
      b.dataset.key = e.key;
      b.title = e.clean != null ? `${e.label}: best design that passes the fab check` : `${e.label}: no design of this family has passed the fab check yet`;
      const c = document.createElement('canvas');
      drawThumb(c, e.phi);
      b.appendChild(c);
      const sc = e.clean != null ? e.clean : e.any;
      b.insertAdjacentHTML('beforeend', `<div class="t">${e.label}</div><div class="s"><span>${sc.toFixed(2)}</span>` +
        (e.clean != null ? `<span class="medal ${medalOf(L, e.clean)}"></span>` : '<span class="drc">fails fab</span>') + '</div>');
      b.onclick = () => restore(e);
      el.appendChild(b);
    }
  }
  function restore(e) {
    if (!geo || !phi) return;
    pushUndo();
    const [i0, i1, j0, j1] = geo.design, h = j1 - j0, a = decPhi(e.phi), full = Float32Array.from(phi);
    for (let i = i0; i < i1; i++) for (let j = j0; j < j1; j++) full[j + i * geo.ny] = a[(j - j0) + (i - i0) * h];
    phi = full; structDirty = true; pending = [];
    worker.postMessage({ type: 'setPhi', phi: full, seq: ++seq, reinit: true });
  }

  // ------------------------------------------------------------- fab run view
  function setFab(on) {
    fabOpen = on;
    $('fabView').classList.toggle('show', on);
    $('fabB').classList.toggle('on', on);
    if (on) {
      $('fvTitle').textContent = 'Fab run: solving the three etch cases…';
      $('fvRow').innerHTML = '';
      worker.postMessage({ type: 'fab' });
    }
  }
  function renderFab(m) {
    if (!fabOpen || !geo) return;
    const L = LEVELS[li], { nx, ny, pml } = geo, amp = geo.amp[m.viewLam];
    const worst = Math.min(...m.corners.map(c => c.score));
    $('fvTitle').textContent = `Fab run: the same design after etching ${nm(L.rules.etch)} narrower, as drawn, and ${nm(L.rules.etch)} wider. |E|, brightened to show where light leaks.`;
    const row = $('fvRow'); row.innerHTML = '';
    const cw = nx - 2 * pml, ch = ny - 2 * pml;
    for (const c of m.corners) {
      const p = document.createElement('div'); p.className = 'fv-p' + (c.score === worst ? ' worst' : '');
      const can = document.createElement('canvas');
      p.appendChild(can);
      const ports = L.ports.map((q, k) => k === 0 || q.info ? '' : `${q.name} ${(100 * c.T[m.viewLam][k]).toFixed(1)}%`).filter(Boolean).join(' · ');
      p.insertAdjacentHTML('beforeend', `<div class="fv-l"><span>${caseName(c.delta)}</span><b>${c.score.toFixed(2)} dB</b></div><div class="fv-ports">${ports} · reflected ${(100 * c.R[m.viewLam]).toFixed(2)}%</div>`);
      row.appendChild(p);
      // field image at cell resolution, then scaled into the panel with the etched contour
      const o = document.createElement('canvas'); o.width = cw; o.height = ch;
      const og = o.getContext('2d'), img = og.createImageData(cw, ch), d = img.data;
      for (let i = pml; i < nx - pml; i++) for (let j = pml; j < ny - pml; j++) {
        const k = j + i * ny, q = 4 * ((i - pml) + (ny - pml - 1 - j) * cw);
        const v = Math.pow(Math.hypot(c.re[k], c.im[k]) / amp, 0.5) / 1.15;
        const t = 3 * Math.min(255, (255 * v) | 0);
        d[q] = LUT_FIRE[t]; d[q + 1] = LUT_FIRE[t + 1]; d[q + 2] = LUT_FIRE[t + 2]; d[q + 3] = 255;
      }
      og.putImageData(img, 0, 0);
      requestAnimationFrame(() => {
        const dpr = Math.min(2, devicePixelRatio || 1), W = can.clientWidth * dpr, H = W * ch / cw;
        can.width = W; can.height = H;
        const g = can.getContext('2d');
        g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
        g.drawImage(o, 0, 0, W, H);
        const sc = W / (cw * D), shifted = new Float32Array(m.phi.length);
        for (let k = 0; k < shifted.length; k++) shifted[k] = mask[k] ? m.phi[k] + c.delta : m.phi[k];
        const seg = LS.contour(shifted, nx, ny, D);
        g.strokeStyle = col('outline', 0.85); g.lineWidth = 1 * dpr; g.beginPath();
        for (let s = 0; s < seg.length; s += 4) {
          g.moveTo((seg[s] - pml * D) * sc, H - (seg[s + 1] - pml * D) * sc);
          g.lineTo((seg[s + 2] - pml * D) * sc, H - (seg[s + 3] - pml * D) * sc);
        }
        g.stroke();
      });
    }
  }

  // ------------------------------------------------------------- canvas
  function layout() {
    const r = cv.getBoundingClientRect(), dpr = Math.min(2, devicePixelRatio || 1);
    cv.width = Math.round(r.width * dpr); cv.height = Math.round(r.height * dpr);
    if (!geo) return;
    const p = geo.pml, cw = (geo.nx - 2 * p) * D, ch = (geo.ny - 2 * p) * D;
    const mx = 40 * dpr, myT = 50 * dpr, myB = 44 * dpr;
    const s = Math.min((cv.width - 2 * mx) / cw, (cv.height - myT - myB) / ch);
    map = { s, ox: (cv.width - cw * s) / 2, oy: myT + (cv.height - myT - myB - ch * s) / 2, x0: p * D, y1: (geo.ny - p) * D, dpr };
  }
  const toPx = (x, y) => [map.ox + (x - map.x0) * map.s, map.oy + (map.y1 - y) * map.s];
  const toUm = (px, py) => [map.x0 + (px - map.ox) / map.s, map.y1 - (py - map.oy) / map.s];

  function drawSens() {
    if (!sens || !geo) return;
    const { nx, ny } = geo, g = sensCv.getContext('2d'), img = g.createImageData(nx, ny), sp = rgb('sensPos'), sn = rgb('sensNeg');
    let mx = 0;
    for (let k = 0; k < sens.length; k++) mx = Math.max(mx, Math.abs(sens[k]));
    for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
      const k = j + i * ny, v = sens[k] / (mx || 1), q = 4 * (i + (ny - 1 - j) * nx);
      if (!mask[k] || v === 0) { img.data[q + 3] = 0; continue; }
      const a = Math.pow(Math.abs(v), 0.55), c = v > 0 ? sp : sn;
      img.data[q] = c[0]; img.data[q + 1] = c[1]; img.data[q + 2] = c[2];
      img.data[q + 3] = Math.round(220 * a);
    }
    g.putImageData(img, 0, 0);
  }
  function drawZones() {
    const { nx, ny } = geo, g = zoneCv.getContext('2d'), img = g.createImageData(nx, ny), d = img.data, kf = rgb('keepFill'), lf = rgb('lockFill');
    for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
      const k = j + i * ny, q = 4 * (i + (ny - 1 - j) * nx);
      const kp = LS.H(keepLS[k], 0.03), lk = LS.H(lockLS[k], 0.03);
      if (kp > 0) { d[q] = kf[0]; d[q + 1] = kf[1]; d[q + 2] = kf[2]; d[q + 3] = Math.round(120 * kp); }
      else if (lk > 0) { d[q] = lf[0]; d[q + 1] = lf[1]; d[q + 2] = lf[2]; d[q + 3] = Math.round(90 * lk); }
    }
    g.putImageData(img, 0, 0);
    zoneLines = { lock: LS.contour(lockLS, nx, ny, D), keep: LS.contour(keepLS, nx, ny, D) };
    zoneDirty = false;
  }

  let t0 = performance.now();
  // drawField: the field and the silicon. A skin with a field painter draws
  // them its own way, given F:
  //   game 'component', dpr, t (s), nx, ny, pml, d (cell size, um)
  //   re, im: Float32Array, cell (i, j) at j + i ny, y up; the animated field
  //     is (re c + im s) / amp, and the input mode's peak is 1
  //   c, s, amp, view ('wave' or 'intensity')
  //   phi: level set, > 0 in silicon; design: [i0, i1, j0, j1] cells
  //   rect: { x, y, w, h } device px covering cells pml..nx-pml by
  //     pml..ny-pml (the top edge is row ny - pml)
  //   cell: device px per cell; toPx(x, y): um to device px
  //   contour: silicon outline segments in um, [x0, y0, x1, y1, ...]
  //   level: the level id; ports: [{ name, a: [x, y], b: [x, y] (the port
  //     line's ends, um), input, info, T (power fraction, null for the input) }]
  // It returns true if it drew the silicon outline itself, or an object
  // { outline, ports, box } naming the parts it drew, which the game skips.
  function frame(now) {
    requestAnimationFrame(frame);
    if (!geo || !re || !st || !(map.s > 0)) { ctx.fillStyle = BG; ctx.fillRect(0, 0, cv.width, cv.height); return; }
    const { nx, ny, pml } = geo, amp = geo.amp[st.viewLam];
    const ph = 2 * Math.PI * 0.55 * (now - t0) / 1000;
    const c = Math.cos(ph), s = Math.sin(ph);
    const cw = (nx - 2 * pml), ch = (ny - 2 * pml), skin = SKINS.current;
    ctx.fillStyle = BG; ctx.fillRect(0, 0, cv.width, cv.height);
    let own = {};
    if (skin.field) {
      if (structDirty && phi) { contour = LS.contour(phi, nx, ny, D); structDirty = false; }
      const L = LEVELS[li];
      const ports = L.ports.map((p, k) => {
        const cc = 0.5 * (p.lo + p.hi) * D, a = (p.idx + 0.5) * D, half = 0.42;
        return { name: p.name, input: k === 0, info: !!p.info, T: k === 0 ? null : st.T[st.viewLam][k],
          a: p.axis === 'x' ? [a, cc - half] : [cc - half, a], b: p.axis === 'x' ? [a, cc + half] : [cc + half, a] };
      });
      // a clean canvas state for the painter, whatever the last frame left
      ctx.save();
      ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'low'; ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over'; ctx.setLineDash([]);
      const r = skin.field(ctx, {
        game: 'component', dpr: map.dpr, t: (now - t0) / 1000, nx, ny, pml, d: D, re, im, c, s, amp, view, phi,
        design: geo.design, rect: { x: map.ox, y: map.oy, w: cw * D * map.s, h: ch * D * map.s }, cell: D * map.s, toPx, contour, P: SKINS.current.palette,
        level: L.id, ports,
      });
      ctx.restore();
      own = r === true ? { outline: true } : (r || {});
    } else drawField(nx, ny, pml, amp, c, s, cw, ch);
    ctx.imageSmoothingEnabled = !skin.pixelOverlays;
    if (showSens && sens) { ctx.globalAlpha = 0.85; ctx.drawImage(sensCv, pml, pml, cw, ch, map.ox, map.oy, cw * D * map.s, ch * D * map.s); ctx.globalAlpha = 1; }
    if (zoneDirty) drawZones();
    ctx.drawImage(zoneCv, pml, pml, cw, ch, map.ox, map.oy, cw * D * map.s, ch * D * map.s);
    drawOverlay(now, own);
    if (showSens && sens) drawSensKey();
    if (skin.post) { ctx.save(); skin.post(ctx, cv.width, cv.height, (now - t0) / 1000, 'component'); ctx.restore(); }
  }
  // Lab's field: the field through the color map at cell resolution, the
  // silicon as a light tint, smoothed up to the canvas
  function drawField(nx, ny, pml, amp, c, s, cw, ch) {
    const d = offImg.data, ia = 1 / amp;
    const tint = rgb('siliconTint');
    for (let i = 0; i < nx; i++) {
      for (let j = 0; j < ny; j++) {
        const k = j + i * ny, q = 4 * (i + (ny - 1 - j) * nx);
        let r8, g8, b8;
        if (view === 'wave') {
          const v = (re[k] * c + im[k] * s) * ia;
          const t = Math.tanh(1.1 * v), m = 3 * ((127.5 + 127 * t) | 0);
          r8 = LUT_WAVE[m]; g8 = LUT_WAVE[m + 1]; b8 = LUT_WAVE[m + 2];
        } else {
          const v = Math.sqrt((re[k] * re[k] + im[k] * im[k])) * ia / 1.5;
          const m = 3 * Math.min(255, (255 * v) | 0);
          r8 = LUT_FIRE[m]; g8 = LUT_FIRE[m + 1]; b8 = LUT_FIRE[m + 2];
        }
        const h = phi ? LS.H(phi[k], 0.75 * D) * 0.2 : 0;
        d[q] = r8 + (tint[0] - r8) * h; d[q + 1] = g8 + (tint[1] - g8) * h; d[q + 2] = b8 + (tint[2] - b8) * h; d[q + 3] = 255;
      }
    }
    off.getContext('2d').putImageData(offImg, 0, 0);
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(off, pml, pml, cw, ch, map.ox, map.oy, cw * D * map.s, ch * D * map.s);
  }

  // the two colors of the sensitivity view, named in words
  function drawSensKey() {
    const dpr = map.dpr, f = `${10 * dpr}px ${getComputedStyle(document.body).fontFamily}`, x = map.ox + 10 * dpr, y = map.oy + 10 * dpr;
    ctx.font = f; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    const a = 'adding silicon helps', b = 'removing silicon helps', sw = 10 * dpr, gap = 6 * dpr;
    const w = sw + gap + ctx.measureText(a).width + 16 * dpr + sw + gap + ctx.measureText(b).width + 16 * dpr;
    ctx.fillStyle = col('bg', 0.82); ctx.fillRect(x - 6 * dpr, y - 9 * dpr, w, 18 * dpr);
    let px = x;
    for (const [name, txt] of [['sensPos', a], ['sensNeg', b]]) {
      ctx.fillStyle = col(name); ctx.fillRect(px, y - sw / 2, sw, sw); px += sw + gap;
      ctx.fillStyle = col('ink', 0.85); ctx.fillText(txt, px, y); px += ctx.measureText(txt).width + 16 * dpr;
    }
    ctx.textBaseline = 'alphabetic';
  }

  function drawOverlay(now, own) {
    const { dpr } = map, L = LEVELS[li], g = geo;
    // silicon boundary
    if (structDirty && phi) { contour = LS.contour(phi, g.nx, g.ny, D); structDirty = false; }
    ctx.save();
    ctx.beginPath();
    const [cx0, cy0] = toPx(g.pml * D, (g.ny - g.pml) * D), [cx1, cy1] = toPx((g.nx - g.pml) * D, g.pml * D);
    ctx.rect(cx0, cy0, cx1 - cx0, cy1 - cy0); ctx.clip();
    const segs = (arr, style, dash) => {
      if (!arr || !arr.length) return;
      ctx.strokeStyle = style; ctx.lineWidth = 1.4 * dpr; ctx.setLineDash(dash || []); ctx.beginPath();
      for (let k = 0; k < arr.length; k += 4) {
        const [ax, ay] = toPx(arr[k], arr[k + 1]), [bx, by] = toPx(arr[k + 2], arr[k + 3]);
        ctx.moveTo(ax, ay); ctx.lineTo(bx, by);
      }
      ctx.stroke(); ctx.setLineDash([]);
    };
    if (!own.outline) segs(contour, col('outline', 0.92));
    if (zoneLines) {
      segs(zoneLines.lock, col('lock', 0.85), [4 * dpr, 3 * dpr]);
      segs(zoneLines.keep, col('keep', 0.9), [4 * dpr, 3 * dpr]);
    }
    // fab check: violations in red (thin silicon) and amber (narrow gaps), one ring per spot
    if (L.rules && asm && drcCv && drcSpots.length) {
      const f = asm.fab, stale = st && (asm.seq !== st.seq || asm.iter !== st.iter) && !optimizing;
      const [ax, ay] = toPx(f.ci0 * D, (f.cj0 + f.H / f.F) * D), [bx, by] = toPx((f.ci0 + f.W / f.F) * D, f.cj0 * D);
      ctx.globalAlpha = stale ? 0.35 : 1;
      ctx.imageSmoothingEnabled = !SKINS.current.pixelOverlays;
      ctx.drawImage(drcCv, ax, ay, bx - ax, by - ay);
      const pulse = 0.55 + 0.45 * Math.sin(now / 260);
      ctx.strokeStyle = col('drc', (stale ? 0.3 : 0.9) * pulse); ctx.lineWidth = 1.5 * dpr;
      for (const sp of drcSpots) {
        const [px, py] = toPx(sp.x, sp.y);
        ctx.beginPath(); ctx.arc(px, py, sp.r * map.s, 0, 2 * Math.PI); ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
    ctx.restore();
    // frame of the simulated region and the design box
    ctx.strokeStyle = col('ink', 0.18); ctx.lineWidth = 1 * dpr; ctx.strokeRect(cx0, cy0, cx1 - cx0, cy1 - cy0);
    const [i0, i1, j0, j1] = g.design;
    const [dx0, dy0] = toPx(i0 * D, j1 * D), [dx1, dy1] = toPx(i1 * D, j0 * D);
    ctx.font = `${10 * dpr}px ${getComputedStyle(document.body).fontFamily}`;
    if (!own.box) {
    ctx.setLineDash([6 * dpr, 5 * dpr]); ctx.strokeStyle = col('boxLine', 0.55);
    ctx.strokeRect(dx0, dy0, dx1 - dx0, dy1 - dy0); ctx.setLineDash([]);
    ctx.fillStyle = col('boxLine', 0.7);
    ctx.fillText(`design region ${((i1 - i0) * D).toFixed(2)} µm${L.sym ? ' · ' + SYM_NOTE[L.sym] : ''}`, dx0 + 2 * dpr, dy0 - 6 * dpr);
    }
    // scale bar: 1 um, inside the bottom-left corner of the simulated region
    const [sb0x, sb0y] = toPx(g.pml * D + 0.15, g.pml * D + 0.15), sbw = 1 * map.s;
    ctx.strokeStyle = col('ink', 0.7); ctx.lineWidth = 2 * dpr;
    ctx.beginPath(); ctx.moveTo(sb0x, sb0y); ctx.lineTo(sb0x + sbw, sb0y); ctx.stroke();
    ctx.fillStyle = col('ink', 0.7); ctx.fillText('1 µm', sb0x + sbw + 6 * dpr, sb0y + 3 * dpr);
    // ports
    if (st && !own.ports) L.ports.forEach((p, k) => {
      const c = 0.5 * (p.lo + p.hi) * D, a = (p.idx + 0.5) * D;
      const half = 0.42;
      let A, B, lx, ly, align = 'left';
      if (p.axis === 'x') { A = toPx(a, c - half); B = toPx(a, c + half); lx = A[0]; ly = B[1] - 8 * dpr; align = k === 0 ? 'left' : 'right'; }
      else { A = toPx(c - half, a); B = toPx(c + half, a); lx = B[0] + 8 * dpr; ly = A[1] + 4 * dpr; }
      if (p.info && L.id === 'converter') return;
      ctx.strokeStyle = k === 0 ? col('portIn', 0.9) : col('port', 0.75); ctx.lineWidth = 2 * dpr;
      ctx.beginPath(); ctx.moveTo(A[0], A[1]); ctx.lineTo(B[0], B[1]); ctx.stroke();
      ctx.fillStyle = k === 0 ? col('portIn', 0.95) : col('port', 0.9);
      ctx.textAlign = align;
      let label = p.name;
      if (k > 0) {
        const l = st.viewLam;
        label += '  ' + (100 * st.T[l][k]).toFixed(1) + '%';
      }
      ctx.fillText(label, lx, ly);
      ctx.textAlign = 'left';
    });
    // brush cursor
    if (cursor) {
      const [px, py] = toPx(cursor[0], cursor[1]);
      const inside = cursor[0] >= i0 * D && cursor[0] <= i1 * D && cursor[1] >= j0 * D && cursor[1] <= j1 * D;
      let cc;
      if (tool === 'lock') cc = cursor.shift ? col('ink', 0.7) : col('lock', 0.95);
      else if (tool === 'keep') cc = cursor.shift ? col('ink', 0.7) : col('keepCursor', 0.95);
      else cc = (tool === 'add') !== cursor.shift ? col('good', 0.95) : col('erase', 0.95);
      ctx.strokeStyle = inside ? cc : col('ink', 0.25);
      ctx.lineWidth = 1.5 * dpr; ctx.beginPath(); ctx.arc(px, py, brushR * map.s, 0, 2 * Math.PI); ctx.stroke();
      // the brush's other symmetry images
      if (L.sym && inside) {
        ctx.globalAlpha = 0.45; ctx.setLineDash([3 * dpr, 3 * dpr]);
        for (const [qx, qy] of editSegs(cursor[0], cursor[1], cursor[0], cursor[1]).slice(1)) {
          const [ux, uy] = toPx(qx, qy);
          ctx.beginPath(); ctx.arc(ux, uy, brushR * map.s, 0, 2 * Math.PI); ctx.stroke();
        }
        ctx.setLineDash([]); ctx.globalAlpha = 1;
      }
    }
  }

  // ------------------------------------------------------------- editing
  // symmetric levels repeat every edit at all of its images, as the worker does
  const SYM_NOTE = { d2: 'mirrored across both guides', c4: 'same at every quarter turn', c4v: 'mirrored across both guides and both diagonals', my: 'mirrored top to bottom', adiag: 'mirrored across the diagonal' };
  const editSegs = (ax, ay, bx, by) => (LEVELS[li].sym ? LS.symSegments(LEVELS[li].design, D, LEVELS[li].sym, ax, ay, bx, by) : [[ax, ay, bx, by]]);
  function applyStroke(p) {
    if (!phi) return;
    for (const [ax, ay, bx, by] of editSegs(p.ax, p.ay, p.bx, p.by)) LS.stroke(phi, geo.nx, geo.ny, D, mask, ax, ay, bx, by, p.r, p.add);
  }
  function applyKeepLocal() {
    if (!anyKeep || !phi) return;
    for (let k = 0; k < phi.length; k++) if (mask[k] && keepLS[k] > -0.3) phi[k] = Math.min(phi[k], -keepLS[k]);
  }
  function pushUndo() { if (phi) { undo.push(Float32Array.from(phi)); if (undo.length > 40) undo.shift(); } }
  function sendStroke(ax, ay, bx, by, add) {
    const m = { type: 'stroke', ax, ay, bx, by, r: brushR, add, seq: ++seq };
    worker.postMessage(m); pending.push(m); applyStroke(m); applyKeepLocal(); structDirty = true;
  }
  function sendZone(ax, ay, bx, by) {
    const kind = drawing.zone, add = drawing.add;
    worker.postMessage({ type: 'zone', kind, ax, ay, bx, by, r: brushR, add });
    for (const [sx, sy, ex, ey] of editSegs(ax, ay, bx, by)) LS.stroke(kind === 'lock' ? lockLS : keepLS, geo.nx, geo.ny, D, mask, sx, sy, ex, ey, brushR, add);
    if (kind === 'keep') { anyKeep = true; applyKeepLocal(); structDirty = true; }
    zoneDirty = true;
    $('zonesClearB').style.display = '';
  }
  function evPt(e) {
    const r = cv.getBoundingClientRect();
    return toUm((e.clientX - r.left) * map.dpr, (e.clientY - r.top) * map.dpr);
  }
  cv.addEventListener('pointerdown', e => {
    if (!geo || !phi || e.button > 0) return;
    cv.setPointerCapture(e.pointerId);
    const [x, y] = evPt(e);
    if (tool === 'lock' || tool === 'keep') {
      drawing = { zone: tool, add: !e.shiftKey, last: [x, y] };
      sendZone(x, y, x, y);
      return;
    }
    pushUndo();
    drawing = { add: (tool === 'add') !== e.shiftKey, last: [x, y] };
    sendStroke(x, y, x, y, drawing.add);
  });
  cv.addEventListener('pointermove', e => {
    if (!geo) return;
    const [x, y] = evPt(e);
    cursor = [x, y]; cursor.shift = e.shiftKey;
    if (drawing) {
      const [lx, ly] = drawing.last;
      if (Math.hypot(x - lx, y - ly) > 0.01) {
        if (drawing.zone) sendZone(lx, ly, x, y); else sendStroke(lx, ly, x, y, drawing.add);
        drawing.last = [x, y];
      }
    }
  });
  const endStroke = () => {
    if (!drawing) return;
    const wasZone = drawing.zone, add = drawing.add;
    drawing = null;
    if (wasZone) return;
    emit('stroke', { add });
    const m = { type: 'strokeEnd', seq: ++seq };
    worker.postMessage(m); pending.push(m);
    // auto-optimize: finishing a stroke starts Optimize, and during a run it
    // goes back to the drawn shape for the next steps, so the edit is taken
    // up quickly
    if (window.CD_AUTO_OPT && !heldPause) {
      if (!optimizing) setOpt(true);
      else if (window.CD_AUTO_ETCH && LEVELS[li].rules) { optFrom = st ? st.iter : 0; if (robust) setRobust(false); }
    }
  };
  cv.addEventListener('pointerup', endStroke);
  cv.addEventListener('pointercancel', endStroke);
  cv.addEventListener('pointerleave', () => { cursor = null; });
  cv.addEventListener('wheel', e => {
    e.preventDefault();
    brushR = Math.max(0.05, Math.min(0.6, brushR * Math.exp(-e.deltaY * 0.0015)));
    $('brush').value = brushR; $('brushV').textContent = (brushR * 1000).toFixed(0) + ' nm';
  }, { passive: false });

  function doUndo() {
    if (!undo.length) return;
    phi = undo.pop(); structDirty = true; pending = [];
    worker.postMessage({ type: 'setPhi', phi: Float32Array.from(phi), seq: ++seq });
  }
  function setTool(t) {
    tool = t;
    [...$('toolSeg').children].forEach(b => b.classList.toggle('on', b.dataset.v === t));
  }
  function setView(v) { view = v; [...$('viewSeg').children].forEach(b => b.classList.toggle('on', b.dataset.v === v)); }
  function setSens(on) {
    showSens = on; $('sensB').classList.toggle('on', on);
    worker.postMessage({ type: 'sens', on });
  }
  function clearZones() {
    if (!geo) return;
    lockLS.fill(-1); keepLS.fill(-1); anyKeep = false; zoneDirty = true;
    $('zonesClearB').style.display = 'none';
    worker.postMessage({ type: 'zonesClear' });
  }

  // ------------------------------------------------------------- controls
  $('toolSeg').addEventListener('click', e => { const b = e.target.closest('button'); if (b) setTool(b.dataset.v); });
  $('viewSeg').addEventListener('click', e => { const b = e.target.closest('button'); if (b) setView(b.dataset.v); });
  $('targetRow').addEventListener('click', e => { const b = e.target.closest('button'); if (b) setRobust(b.dataset.v === 'worst'); });
  $('brush').addEventListener('input', () => { brushR = +$('brush').value; $('brushV').textContent = (brushR * 1000).toFixed(0) + ' nm'; });
  $('brushV').textContent = (brushR * 1000).toFixed(0) + ' nm';
  $('speed').addEventListener('input', sendParams);
  $('smooth').addEventListener('input', sendParams);
  $('optB').onclick = toggleOpt;
  $('undoB').onclick = doUndo;
  // the single page has no Clear zones button: Reset and Clear take the zones too
  const zonesToo = () => { if (document.documentElement.dataset.page === 'single') clearZones(); };
  $('resetB').onclick = () => { pushUndo(); hist = []; pending = []; zonesToo(); worker.postMessage({ type: 'reset', seq: ++seq }); };
  $('clearB').onclick = () => { pushUndo(); hist = []; pending = []; zonesToo(); worker.postMessage({ type: 'clear', seq: ++seq }); };
  $('zonesClearB').onclick = clearZones;
  $('sensB').onclick = () => setSens(!showSens);
  $('specB').onclick = () => setSpec(!$('specBox').classList.contains('show'));
  function setPane(side, show) {
    const app = $('app'), cls = side === 'l' ? 'nol' : 'nor';
    app.classList.toggle(cls, !show);
    $(side === 'l' ? 'ltab' : 'rtab').innerHTML = (side === 'l') === show ? '&lsaquo;' : '&rsaquo;';
    try { localStorage.setItem('odg.component.pane.' + side, show ? '1' : '0'); } catch (e) { /* private mode */ }
  }
  const paneShown = side => { try { return localStorage.getItem('odg.component.pane.' + side) !== '0'; } catch (e) { return true; } };
  $('ltab').onclick = () => setPane('l', $('app').classList.contains('nol'));
  $('rtab').onclick = () => setPane('r', $('app').classList.contains('nor'));
  setPane('l', paneShown('l')); setPane('r', paneShown('r'));
  new ResizeObserver(() => { layout(); if (st) drawSpark(); }).observe($('stage'));
  $('fabB').onclick = () => setFab(!fabOpen);
  $('fabClose').onclick = () => setFab(false);
  $('shareB').onclick = share;
  $('mpShare').onclick = share;
  $('mpGo').onclick = () => $('medalPop').classList.remove('show');
  // a page with its own guide (window.CD_GUIDE) opens that instead of the cards
  $('howB').onclick = () => (window.CD_GUIDE ? window.CD_GUIDE() : onb(0));
  $('onbBack').onclick = () => onb(onbAt - 1);
  $('onbNext').onclick = () => (onbAt === ONB.length - 1 ? onbClose() : onb(onbAt + 1));
  $('onbClose').onclick = onbClose;

  document.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT' && e.target.type !== 'range') return;
    const k = e.key.toLowerCase(), R = LEVELS[li].rules;
    if ($('onb').classList.contains('show') && !['escape', 'arrowright', 'arrowleft', 'enter'].includes(k)) return;
    if (k === ' ') { e.preventDefault(); toggleOpt(); }
    else if (k >= '1' && k <= String(LEVELS.length)) loadLevel(+k - 1);
    else if (k === 'b' || k === 'a') setTool('add');
    else if (k === 'e' || k === 'd') setTool('erase');
    else if (k === 'l') setTool('lock');
    else if (k === 'k') setTool('keep');
    else if (k === 'z') { e.preventDefault(); doUndo(); }
    else if (k === 'r' && !e.metaKey && !e.ctrlKey) $('resetB').onclick();
    else if (k === 'v') setView(view === 'wave' ? 'intensity' : 'wave');
    else if (k === 's') setSens(!showSens);
    else if (k === 'f' && R) setFab(!fabOpen);
    else if (k === 'w' && R) setRobust(!robust);
    else if (k === 'escape') { if ($('sharePop')) $('sharePop').classList.remove('show'); if ($('onb').classList.contains('show')) onbClose(); else if (fabOpen) setFab(false); $('medalPop').classList.remove('show'); }
    else if ($('onb').classList.contains('show') && (k === 'arrowright' || k === 'enter')) $('onbNext').onclick();
    else if ($('onb').classList.contains('show') && k === 'arrowleft') onb(onbAt - 1);
    else if (k === '[') { brushR = Math.max(0.05, brushR / 1.2); $('brush').value = brushR; $('brushV').textContent = (brushR * 1000).toFixed(0) + ' nm'; }
    else if (k === ']') { brushR = Math.min(0.6, brushR * 1.2); $('brush').value = brushR; $('brushV').textContent = (brushR * 1000).toFixed(0) + ' nm'; }
    if (cursor) cursor.shift = e.shiftKey;
  });
  document.addEventListener('keyup', e => { if (cursor) cursor.shift = e.shiftKey; });
  window.addEventListener('resize', () => { layout(); if (st) updatePanel(); });

  // read-only hook for scripted browser tests
  window.__cd = () => ({
    li, optimizing, robust,
    score: st && st.score, seq: st && st.seq, iter: st && st.iter,
    asm: asm && { worst: asm.worst, nominal: asm.nominal, seq: asm.seq, iter: asm.iter, topo: asm.topo, nThin: asm.fab.nThin, nGap: asm.fab.nGap },
    dex: document.querySelectorAll('#dex .card').length,
    client: (x, y) => { const r = cv.getBoundingClientRect(), [px, py] = toPx(x, y); return [r.left + px / map.dpr, r.top + py / map.dpr]; },
  });

  // a new skin: rebuild what holds its colors, then everything redraws
  SKINS.onChange(() => {
    skinColors(); zoneDirty = true;
    if (sens) drawSens();
    if (geo) { renderDex(); drawSpark(); if (spec) drawSpectrum(); if (asm && LEVELS[li].rules) buildDrc(asm.fab); }
    layout();
  });
  $('skinB').onclick = () => SKINS.picker($('skinB'));

  buildLevels();
  loadLevel(0);
  requestAnimationFrame(frame);
  let seen = false;
  try { seen = localStorage.getItem('odg.component.onboarded') === '1'; } catch (e) { seen = false; }
  if (!seen && !window.CD_GUIDE) onb(0);
})();
