/* worker.js : physics thread for the component designer.
 *
 * Owns the level set phi (the design), the FDFD problems (one per
 * wavelength) and their twisted factorizations. Every iteration rasterizes
 * phi, refactors only the design columns, solves forward, and when needed
 * solves one adjoint per wavelength for dF/deps. Optimization moves the
 * boundary with the adjoint shape gradient (normal velocity = Delta eps *
 * dF/deps on the boundary, smoothed), then reinitializes phi to a signed
 * distance. Edits from the page are applied between iterations.
 *
 * Levels with fabrication rules (L.rules) are also solved at etch corners:
 * the design box etched rules.etch narrower and wider (phi -/+ etch), one
 * factorization per corner and wavelength. The score is the worst corner,
 * and the worst-case optimizer mode takes the smooth minimum over corners.
 * An assessment (all corners, the 150 nm width and gap check, the layout
 * class) goes to the page whenever the design settles, and every few steps
 * while optimizing.
 *
 * Levels with a sym group (see LS.SYM) keep the design symmetric: every
 * stroke and zone is applied at all of its images, the shape velocity (and
 * the sensitivity shown to the player) is averaged over the images of each
 * cell, and phi is re-averaged after each change to stop round-off drift.
 */
importScripts('engine/fdfd.js?v=6f8f303061', 'engine/levelset.js?v=1a18f655e6', 'levels.js?v=5e65ac2e17');

const { D, NC, NS, PML, LEVELS } = self.COMPONENT_LEVELS;
const EC = NC * NC, ES = NS * NS, DE = EC - ES;
const HW = 0.75 * D;               // smoothstep half-width for the boundary
const TAU = 0.5;                   // soft-min temperature of the objective (dB)
const ASSESS_EVERY = 6;            // nominal-mode optimization: assess every n steps
const EDGE = 0.2;                  // um: on fab-rule levels the fixed guides' profile at the box
                                   // edge carries into the box and blends into the design over this band

let S = null;
let pending = false, assessTimer = 0;

// the level's starting design: its init shapes, or only short stubs of the
// fixed guides inside the box when init is 'empty'
function startPhi(L, mask, phiFixed, phi, nx, ny) {
  const [i0, i1, j0, j1] = L.design, m = 0.25;
  for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
    const k = j + i * ny;
    if (!mask[k]) continue;
    const x = (i + 0.5) * D, y = (j + 0.5) * D;
    if (L.init === 'empty') {
      const inner = LS.sdBox(x, y, i0 * D + m, j0 * D + m, i1 * D - m, j1 * D - m);
      phi[k] = Math.min(phiFixed[k], -inner);
    } else phi[k] = LS.sdShapes(x, y, L.init);
  }
  LS.reinit(phi, nx, ny, D, mask);
}

function setup(levelIndex) {
  const L = LEVELS[levelIndex];
  const nx = L.nx, ny = L.ny, N = nx * ny;
  const [i0, i1, j0, j1] = L.design;
  const mask = new Uint8Array(N);
  for (let i = i0; i < i1; i++) for (let j = j0; j < j1; j++) mask[j + i * ny] = 1;
  const phiFixed = new Float64Array(N), phi = new Float64Array(N);
  for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
    const k = j + i * ny;
    phiFixed[k] = LS.sdShapes((i + 0.5) * D, (j + 0.5) * D, L.fixed);
    phi[k] = phiFixed[k];
  }
  startPhi(L, mask, phiFixed, phi, nx, ny);
  const orbits = L.sym ? LS.symOrbits(L.design, ny, L.sym) : null;
  if (orbits) LS.symAverage(phi, orbits);
  const R = L.rules || null;
  // the profile of the fixed geometry just outside the nearest box edge,
  // extruded inward, and a weight that is 1 at the edge and 0 at EDGE
  const edgeW = new Float64Array(N), edgePhi = new Float64Array(N);
  if (R) for (let i = i0; i < i1; i++) for (let j = j0; j < j1; j++) {
    const x = (i + 0.5) * D, y = (j + 0.5) * D;
    const ds = [x - i0 * D, i1 * D - x, y - j0 * D, j1 * D - y];
    const e = ds.indexOf(Math.min(...ds)), t = Math.min(1, ds[e] / EDGE), k = j + i * ny;
    edgeW[k] = 1 - t * t * (3 - 2 * t);
    const o = [j + (i0 - 1) * ny, j + i1 * ny, (j0 - 1) + i * ny, j1 + i * ny][e];
    edgePhi[k] = phiFixed[o];
  }
  // where two box edges are equally near, rounding picks one of them, and a
  // cell and its mirror image can pick differently: average over the images
  if (R && orbits) { LS.symAverage(edgeW, orbits); LS.symAverage(edgePhi, orbits); }
  const deltas = R ? [-R.etch, 0, R.etch] : [0];
  const nom = deltas.indexOf(0);
  const epsC = deltas.map(() => new Float64Array(N)), depsC = deltas.map(() => new Float64Array(N));
  const eps = epsC[nom], deps = depsC[nom];
  LS.raster(phi, ES, EC, HW, eps, deps);

  const probs = [], solvers = [], ports = [], src = [], P0 = [];
  for (const lam of L.lambdas) {
    const prob = new FDFD.Problem({
      x: { n: nx, d: D }, y: { n: ny, d: D }, lambda: lam,
      pml: { x0: PML, x1: PML, y0: PML, y1: PML }, nref: NS,
    });
    probs.push(prob);
    // one factorization per etch corner, so every corner's adjoint can reuse it
    solvers.push(deltas.map(() => prob.twistedSolver(i0, i1)));
    // port modes from the fixed geometry (port lines lie outside the design)
    const pms = L.ports.map(p => prob.portMode(p, eps));
    ports.push(pms);
    const pin = pms[0];
    src.push(prob.sourceVec(pin));
    P0.push(prob.modalPower(pin, pin.G));
    if (L.ports[0].ref != null) {
      pin.refPm = prob.portMode(Object.assign({}, L.ports[0], { idx: L.ports[0].ref }), eps);
    }
  }
  S = {
    li: levelIndex, L, nx, ny, N, mask, phiFixed, phi, eps, deps, epsC, depsC,
    probs, solvers, ports, src, P0, rules: R, deltas, nom, robust: false,
    optimizing: false, alpha: 0.4 * D, alphaMax: 0.6 * D, speed: 0.6, smooth: L.smooth ?? 0.3, sigma: 1.2, bestF: null, stall: 0,
    iter: 0, lastF: null, dirty: true, wantSens: false, viewLam: L.lambdas.length - 1,
    seq: 0, hist: [],
    lockLS: new Float64Array(N).fill(-1), keepLS: new Float64Array(N).fill(-1), anyKeep: false, 
    drawing: false, assessDue: !!R, sinceAssess: 0, assessId: 0, lastRes: null,
    edgeW, edgePhi, orbits,
  };
  applyEdge();
  LS.raster(phi, ES, EC, HW, eps, deps);
  // incident field peak, for a fixed display gain
  const amp = ports.map(pms => {
    const pm = pms[0];
    let m = 0; for (const v of pm.phi) m = Math.max(m, Math.abs(v));
    return Math.sqrt(FDFD.cabs2(pm.G)) * m;
  });
  self.postMessage({
    type: 'level', li: levelIndex, nx, ny, d: D, pml: PML, design: L.design,
    lambdas: L.lambdas, amp, deltas,
    neff: ports.map(pms => pms.map(pm => pm.neff)),
  });
  schedule();
}

// eps (and d eps / d phi) of etch corner c: phi shifted by deltas[c] inside the box
function rasterCorner(c, withDeps) {
  const { phi, mask, N } = S, dl = S.deltas[c], eps = S.epsC[c], deps = S.depsC[c];
  for (let k = 0; k < N; k++) {
    const p = mask[k] ? phi[k] + dl : phi[k];
    eps[k] = ES + DE * LS.H(p, HW);
    if (withDeps) deps[k] = DE * LS.dH(p, HW);
  }
}

// forward solve of corner c at every wavelength, with port powers and scores
function solveCorner(c, withDeps) {
  const { L, solvers, probs, ports, src, P0 } = S;
  rasterCorner(c, withDeps);
  const nl = L.lambdas.length;
  const T = [], R = [], A = [], U = [];
  let tf = 0, ts = 0;
  for (let l = 0; l < nl; l++) {
    const t0 = FDFD.now();
    solvers[l][c].setEps(S.epsC[c]);
    const t1 = FDFD.now();
    const u = solvers[l][c].solve(src[l]);
    ts += FDFD.now() - t1; tf += t1 - t0;
    U.push(u);
    const pms = ports[l];
    const Tl = [], Al = [];
    for (let p = 0; p < pms.length; p++) {
      if (p === 0) { Tl.push(1); Al.push([0, 0]); continue; }
      const a = probs[l].overlap(pms[p], u);
      Al.push(a);
      Tl.push(probs[l].modalPower(pms[p], a) / P0[l]);
    }
    const pin = pms[0];
    let Rl = 0;
    if (pin.refPm) {
      const ab = probs[l].overlap(pin.refPm, u);
      const inc = FDFD.cmul(pin.G, FDFD.cexp(pin.theta * Math.abs(pin.idx - pin.refPm.idx)));
      Rl = FDFD.cabs2([ab[0] - inc[0], ab[1] - inc[1]]) / FDFD.cabs2(pin.G);
    }
    T.push(Tl); R.push(Rl); A.push(Al);
  }
  // per-target scores 10 log10(T / share); the level score is the worst
  const sc = L.targets.map(t => 10 * Math.log10(Math.max(1e-6, T[t.lam][t.port] / t.share)));
  return { c, T, R, A, U, sc, score: Math.min(...sc), tf, ts };
}

// forward solves of corners cs (and adjoints when grad); the objective is a
// smooth minimum (temperature TAU dB) over every corner and target score, so
// the optimizer pushes the worst port of the worst corner like the score
function evaluate(grad, cs) {
  cs = cs || (S.robust ? S.deltas.map((_, c) => c) : [S.nom]);
  const { L, probs, ports, solvers, P0, N } = S;
  const res = cs.map(c => solveCorner(c, grad));
  let tf = 0, ts = 0;
  for (const r of res) { tf += r.tf; ts += r.ts; }
  const flat = [];
  res.forEach((r, ri) => r.sc.forEach((v, ti) => flat.push({ ri, ti, v })));
  const worst = Math.min(...flat.map(f => f.v));
  const ex = flat.map(f => Math.exp(-(f.v - worst) / TAU));
  const Z = ex.reduce((a, b) => a + b, 0);
  const Fv = worst - TAU * Math.log(Z);
  let g = null, gphi = null;
  if (grad) {
    g = new Float64Array(N); gphi = new Float64Array(N);
    const nt = L.targets.length;
    res.forEach((r, ri) => {
      const gc = new Float64Array(N);
      for (let l = 0; l < L.lambdas.length; l++) {
        const rhs = new Float64Array(2 * N);
        let any = false;
        L.targets.forEach((t, ti) => {
          if (t.lam !== l) return;
          const w = ex[ri * nt + ti] / Z;
          const pm = ports[l][t.port], a = r.A[l][t.port];
          // dF/dT = w 10 / (ln 10 T), dT = 2 Re(conj(a) da) (sin/h) / P0
          const dFdT = w * 10 / Math.LN10 / Math.max(1e-6, r.T[l][t.port]);
          const s = dFdT * 2 * (pm.sin / pm.hp) / P0[l];
          probs[l].addOverlapVec(pm, [s * a[0], -s * a[1]], rhs);
          any = true;
        });
        if (!any) continue;
        const t1 = FDFD.now();
        const lam = solvers[l][r.c].solve(rhs);
        ts += FDFD.now() - t1;
        probs[l].gradEps(r.U[l], lam, gc);
      }
      const dp = S.depsC[r.c];
      for (let k = 0; k < N; k++) { g[k] += gc[k]; gphi[k] += gc[k] * dp[k]; }
    });
  }
  const nr = res.find(r => r.c === S.nom) || res[0];
  return {
    T: nr.T, R: nr.R, U: nr.U, F: Fv, score: nr.score, g, gphi, tf, ts, corners: res,
    worst: cs.length === S.deltas.length ? worst : null,
  };
}

// near the box edge the design follows the fixed guides' profile, so every
// port enters the box straight and meets the design without a step
function applyEdge() {
  if (!S.rules) return;
  const { phi, edgeW, edgePhi, N } = S;
  for (let k = 0; k < N; k++) { const w = edgeW[k]; if (w > 0) phi[k] = (1 - w) * phi[k] + w * edgePhi[k]; }
}

// symmetric levels: average an array over each cell's images, and the
// images of an edit segment
function applySym(a = S.phi) { if (S.orbits) LS.symAverage(a, S.orbits); }
const editSegs = m => (S.orbits ? LS.symSegments(S.L.design, D, S.L.sym, m.ax, m.ay, m.bx, m.by) : [[m.ax, m.ay, m.bx, m.by]]);

// keep-out zones hold oxide: phi <= -(signed distance into the zone)
function applyKeep() {
  if (!S.anyKeep) return;
  const { phi, mask, keepLS, N } = S;
  for (let k = 0; k < N; k++) if (mask[k] && keepLS[k] > -0.3) phi[k] = Math.min(phi[k], -keepLS[k]);
}

// keep the best design of an Optimize run (on fab-rule levels, the best that
// passes the fab check): the optimizer wobbles a little from step to step and
// may pass through designs that fail the check, so when the run stops on a
// worse or failing design, the best one comes back. Any edit starts over.
function keepBest(worst, clean) {
  if (S.optimizing && clean && (!S.keep || worst > S.keep.worst)) S.keep = { phi: Float64Array.from(S.phi), worst };
}
function restoreBest() {
  const k = S.keep;
  S.keep = null;
  if (!k) return;
  // the design now: does it fail the fab check, and how does it score (the
  // latest assessment on fab-rule levels, the latest solve otherwise)
  let failing = false, now = S.lastRes ? S.lastRes.score : -Infinity;
  if (S.rules) {
    const fc = LS.fabCheck(S.phi, S.nx, S.ny, D, S.L.design, S.rules.minFeature / 2, S.rules.cornerTol);
    failing = fc.nThin + fc.nGap > 0;
    now = S.lastWorst ?? -Infinity;
  }
  if (!failing && now >= k.worst - 1e-3) return;
  S.phi.set(k.phi);
  S.dirty = true; S.lastF = null; S.bestF = null;
  self.postMessage({ type: 'restored', li: S.li, worst: k.worst, failing });
}

// move the boundary along the adjoint shape gradient
function step(res) {
  const { nx, ny, mask, phi, lockLS } = S;
  // step size: cut on a drop, grow slowly otherwise, and cut when the best
  // objective has not improved for 20 steps (stops two-port oscillation)
  if (S.lastF != null) {
    if (res.F < S.lastF - 0.02) S.alpha = Math.max(0.05 * D, S.alpha * 0.6);   // F in dB
    else S.alpha = Math.min(S.alphaMax, S.alpha * 1.06);
  }
  if (S.bestF == null || res.F > S.bestF + 1e-3) { S.bestF = res.F; S.stall = 0; }
  else if (++S.stall >= 20) { S.alphaMax = Math.max(0.05 * D, S.alphaMax * 0.7); S.alpha = Math.min(S.alpha, S.alphaMax); S.stall = 0; }
  S.lastF = res.F;
  const V = LS.blur(res.g, nx, ny, S.sigma, mask);
  applySym(V);
  const band = 3 * D;
  let vmax = 0;
  for (let k = 0; k < S.N; k++) if (mask[k] && Math.abs(phi[k]) < band && !(lockLS[k] > 0)) vmax = Math.max(vmax, Math.abs(V[k]));
  if (!(vmax > 0)) return;
  const curv = LS.curvFlow(phi, nx, ny, D, mask);
  const beta = S.smooth * 0.25 * D * D;   // curvature smoothing coefficient (um^2)
  // worst-etch mode takes half-size steps under a cap that adapts to the
  // etch cases: they are only 10 nm apart, and a step that overshoots makes
  // the worst case flip between the narrower and the wider etch. Each flip
  // cuts the cap by 30%; while the same case stays worst it grows 5% a step
  // (15 nm to start, 2.5 to 20 nm)
  if (S.robust && res.corners && res.corners.length > 1) {
    const sc = res.corners.map(c => c.score), w = sc.indexOf(Math.min(...sc));
    if (S.capR == null) S.capR = 0.3 * D;
    if (S.lastWorstC != null && w !== S.lastWorstC) S.capR = Math.max(0.05 * D, S.capR * 0.7);
    else S.capR = Math.min(0.4 * D, S.capR * 1.05);
    S.lastWorstC = w;
  }
  const a = S.robust ? Math.min(0.5 * S.alpha, S.capR ?? 0.3 * D) : S.alpha;
  for (let k = 0; k < S.N; k++) {
    if (!mask[k] || Math.abs(phi[k]) >= band || lockLS[k] > 0) continue;
    phi[k] += a * V[k] / vmax + beta * curv[k];
  }
  S.iter++;
  if (S.iter % 4 === 0) LS.reinit(phi, nx, ny, D, mask);
  applySym();
  applyEdge(); applyKeep();
}

function post(res) {
  const l = S.viewLam, u = res.U[l], N = S.N;
  const re = new Float32Array(N), im = new Float32Array(N);
  for (let k = 0; k < N; k++) { re[k] = u[2 * k]; im[k] = u[2 * k + 1]; }
  const phi = Float32Array.from(S.phi);
  const msg = {
    type: 'state', li: S.li, seq: S.seq, phi, re, im, viewLam: l,
    T: res.T, R: res.R, F: res.F, score: res.score, worst: res.worst, iter: S.iter,
    optimizing: S.optimizing, robust: S.robust, tf: res.tf, ts: res.ts, alpha: S.alpha,
  };
  const tr = [phi.buffer, re.buffer, im.buffer];
  if (res.g && S.wantSens) {
    const gs = new Float32Array(N), g = S.orbits ? Float64Array.from(res.g) : res.g;
    applySym(g);
    for (let k = 0; k < N; k++) gs[k] = S.mask[k] ? g[k] : 0;
    msg.sens = gs; tr.push(gs.buffer);
  }
  self.postMessage(msg, tr);
}

// every etch corner of the current design (reusing corners already solved
// for it), the minimum width and gap check, and the layout class
function assess(res) {
  const R = S.rules;
  const have = new Map();
  if (res) for (const r of res.corners) have.set(r.c, r);
  const cs = S.deltas.map((_, c) => have.get(c) || solveCorner(c, false));
  const worst = Math.min(...cs.map(r => r.score));
  const fc = LS.fabCheck(S.phi, S.nx, S.ny, D, S.L.design, R.minFeature / 2, R.cornerTol);
  const topo = LS.topology(fc.sil, fc.W, fc.H, fc.F * fc.F);
  keepBest(worst, fc.nThin + fc.nGap === 0);
  S.lastWorst = worst;
  const phi = Float32Array.from(S.phi);
  self.postMessage({
    type: 'assess', li: S.li, seq: S.seq, iter: S.iter, id: ++S.assessId, phi,
    nominal: cs[S.nom].score, worst,
    corners: cs.map(r => ({ delta: S.deltas[r.c], score: r.score, T: r.T })),
    fab: {
      W: fc.W, H: fc.H, F: fc.F, ci0: fc.ci0, cj0: fc.cj0, flags: fc.flags,
      nThin: fc.nThin, nGap: fc.nGap, thinSpots: fc.thinSpots, gapSpots: fc.gapSpots,
    },
    topo,
  }, [phi.buffer, fc.flags.buffer]);
}

function run() {
  pending = false;
  if (!S) return;
  if (S.dirty || S.optimizing) {
    S.dirty = false;
    // worst-case mode solves every corner only while optimizing or showing
    // its gradient; edits are previewed at the nominal design
    const grad = S.optimizing || S.wantSens;
    const res = evaluate(grad, S.robust && grad ? S.deltas.map((_, c) => c) : [S.nom]);
    S.lastRes = res;
    if (!S.rules) keepBest(res.score, true);
    post(res);
    if (S.rules) {
      if (S.optimizing) {
        // worst-case mode already solved every corner, so its assessment is cheap
        if (res.worst != null || ++S.sinceAssess >= ASSESS_EVERY) { assess(res); S.sinceAssess = 0; S.assessDue = false; }
      } else S.assessDue = true;
    }
    if (S.optimizing) { step(res); S.dirty = true; }
    schedule();
  }
  if (S.rules && S.assessDue && !S.optimizing && !S.drawing && !assessTimer) {
    assessTimer = setTimeout(() => {
      assessTimer = 0;
      if (!S || S.dirty || S.optimizing || S.drawing || !S.assessDue) return;
      S.assessDue = false;
      assess(S.lastRes);
    }, 40);
  }
}
function schedule() {
  if (!pending) { pending = true; setTimeout(run, 0); }
}

// fields of every etch corner, for the fab-run view
function fabRun() {
  const l = S.viewLam;
  const out = S.deltas.map((dl, c) => {
    const r = solveCorner(c, false), u = r.U[l];
    const re = new Float32Array(S.N), im = new Float32Array(S.N);
    for (let k = 0; k < S.N; k++) { re[k] = u[2 * k]; im[k] = u[2 * k + 1]; }
    return { delta: dl, score: r.score, T: r.T, R: r.R, re, im };
  });
  self.postMessage({ type: 'fab', li: S.li, seq: S.seq, viewLam: l, phi: Float32Array.from(S.phi), corners: out });
}

// Port transmission over wavelength for a design (phi, or the current one).
// The page runs this in a second worker so the live spectrum never slows the
// optimizer; one wavelength per task, and a newer request (seq) cancels the
// rest of an older sweep.
let specSeq = 0;
function spectrum(phi, seq = ++specSeq, n) {
  const { L, nx, ny } = S;
  if (phi) S.phi.set(phi);
  LS.raster(S.phi, ES, EC, HW, S.eps, S.deps);
  const eps = Float64Array.from(S.eps);
  const lo = Math.min(...L.lambdas) - 0.08, hi = Math.max(...L.lambdas) + 0.08;
  n = n || (L.lambdas.length > 1 ? 21 : 13);
  const lams = [], rows = [];
  // mode windows see only the fixed waveguides
  const fixedEps = new Float64Array(S.N);
  LS.raster(S.phiFixed, ES, EC, HW, fixedEps, null);
  const one = m => {
    if (seq !== specSeq) return;
    const lam = lo + (hi - lo) * m / (n - 1);
    const prob = new FDFD.Problem({
      x: { n: nx, d: D }, y: { n: ny, d: D }, lambda: lam,
      pml: { x0: PML, x1: PML, y0: PML, y1: PML }, nref: NS,
    });
    const pms = L.ports.map(p => prob.portMode(p, fixedEps));
    const sol = prob.fullSolver();
    sol.setEps(eps);
    const u = sol.solve(prob.sourceVec(pms[0]));
    const P0 = prob.modalPower(pms[0], pms[0].G);
    const row = pms.map((pm, p) => p === 0 ? null : prob.modalPower(pm, prob.overlap(pm, u)) / P0);
    lams.push(lam); rows.push(row);
    self.postMessage({ type: 'spectrum', li: S.li, seq, lams, rows, done: m === n - 1 });
    if (m < n - 1) setTimeout(() => one(m + 1), 0);
  };
  one(0);
}

const restartOpt = () => { S.capR = null; S.lastWorstC = null; S.lastF = null; S.bestF = null; S.alphaMax = S.speed * D; S.alpha = Math.min(S.alpha, S.alphaMax); };

self.onmessage = e => {
  const m = e.data;
  if (m.type === 'level') { setup(m.li); return; }
  if (!S) return;
  switch (m.type) {
    case 'stroke':
      S.keep = null;
      for (const [ax, ay, bx, by] of editSegs(m)) LS.stroke(S.phi, S.nx, S.ny, D, S.mask, ax, ay, bx, by, m.r, m.add);
      applySym(); applyEdge(); applyKeep();
      S.seq = m.seq; S.dirty = true; S.drawing = true;
      break;
    case 'strokeEnd':
      LS.reinit(S.phi, S.nx, S.ny, D, S.mask);
      applySym(); applyEdge(); applyKeep();
      S.seq = m.seq; S.dirty = true; S.drawing = false; S.alphaMax = S.speed * D; S.lastF = null; S.bestF = null;
      break;
    case 'setPhi':
      S.keep = null;
      for (let k = 0; k < S.N; k++) if (S.mask[k]) S.phi[k] = m.phi[k];
      if (m.reinit) LS.reinit(S.phi, S.nx, S.ny, D, S.mask);
      applySym(); applyEdge(); applyKeep();
      S.seq = m.seq; S.dirty = true; S.lastF = null; S.bestF = null;
      break;
    case 'reset':
      S.keep = null;
      startPhi(S.L, S.mask, S.phiFixed, S.phi, S.nx, S.ny);
      applySym(); applyEdge(); applyKeep();
      S.iter = 0; S.seq = m.seq; S.dirty = true; S.lastF = null; S.bestF = null; S.alpha = 0.4 * D; S.alphaMax = S.speed * D;
      break;
    case 'clear': {
      S.keep = null;
      startPhi(Object.assign({}, S.L, { init: 'empty' }), S.mask, S.phiFixed, S.phi, S.nx, S.ny);
      applySym(); applyEdge(); applyKeep();
      S.iter = 0; S.seq = m.seq; S.dirty = true; S.lastF = null; S.bestF = null;
      break;
    }
    case 'zone': {
      // lock (the optimizer leaves these cells alone) or keep-out (no silicon)
      const z = m.kind === 'lock' ? S.lockLS : S.keepLS;
      for (const [ax, ay, bx, by] of editSegs(m)) LS.stroke(z, S.nx, S.ny, D, S.mask, ax, ay, bx, by, m.r, m.add);
      applySym(z);
      if (m.kind === 'keep') { S.anyKeep = true; applyEdge(); applyKeep(); S.dirty = true; }
      break;
    }
    case 'zonesClear':
      S.lockLS.fill(-1); S.keepLS.fill(-1); S.anyKeep = false;
      break;
    case 'opt':
      if (!m.on && S.optimizing) restoreBest();
      S.optimizing = m.on;
      if (m.on) { restartOpt(); S.keep = null; }
      S.dirty = true;
      break;
    case 'robust':
      S.robust = !!m.on && !!S.rules;
      restartOpt();
      S.dirty = true;
      break;
    case 'params':
      if (m.speed != null) { S.speed = m.speed; S.alphaMax = m.speed * D; S.alpha = Math.min(S.alpha, S.alphaMax); }
      if (m.smooth != null) S.smooth = m.smooth;
      if (m.sigma != null) S.sigma = m.sigma;
      break;
    case 'sens': S.wantSens = m.on; S.dirty = true; break;
    case 'view': S.viewLam = m.lam; S.dirty = true; break;
    case 'spectrum': spectrum(m.phi, ++specSeq, m.n); break;
    case 'fab': if (S.rules) fabRun(); break;
  }
  schedule();
};
