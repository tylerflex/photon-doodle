/* levelset.js : level-set geometry for the component designer.
 *
 * phi is a signed distance (um) on the cell-centered grid: phi > 0 inside
 * silicon. Cell (i, j) center is ((i + 0.5) d, (j + 0.5) d); index j + i ny.
 * eps = epsLo + (epsHi - epsLo) H(phi), H a C1 smoothstep of half-width w,
 * which gives sub-cell boundary positions and a well-defined d eps / d phi.
 */
(function (g) {
  'use strict';
  const LS = {};

  // ------------------------------------------------------------ primitives (SDF, um)
  LS.sdCapsule = (px, py, ax, ay, bx, by, r) => {
    const vx = bx - ax, vy = by - ay, wx = px - ax, wy = py - ay;
    const L2 = vx * vx + vy * vy;
    const t = L2 > 0 ? Math.max(0, Math.min(1, (wx * vx + wy * vy) / L2)) : 0;
    const dx = wx - t * vx, dy = wy - t * vy;
    return r - Math.sqrt(dx * dx + dy * dy);          // positive inside
  };
  LS.sdBox = (px, py, x0, y0, x1, y1) => {
    const cx = 0.5 * (x0 + x1), cy = 0.5 * (y0 + y1);
    const hx = 0.5 * Math.abs(x1 - x0), hy = 0.5 * Math.abs(y1 - y0);
    const qx = Math.abs(px - cx) - hx, qy = Math.abs(py - cy) - hy;
    const out = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
    return -(out + Math.min(Math.max(qx, qy), 0));
  };
  // polygon [[x, y], ...], exact signed distance, positive inside
  LS.sdPoly = (px, py, P) => {
    let d = Infinity, s = 1;
    for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
      const ax = P[j][0], ay = P[j][1], bx = P[i][0], by = P[i][1];
      const ex = bx - ax, ey = by - ay, wx = px - ax, wy = py - ay;
      const t = Math.max(0, Math.min(1, (wx * ex + wy * ey) / (ex * ex + ey * ey)));
      const qx = wx - ex * t, qy = wy - ey * t;
      d = Math.min(d, qx * qx + qy * qy);
      const c1 = py >= ay, c2 = py < by, c3 = ex * wy > ey * wx;
      if ((c1 && c2 && c3) || (!c1 && !c2 && !c3)) s = -s;
    }
    return -s * Math.sqrt(d);
  };
  // shape list -> union SDF: shapes are {cap:[ax,ay,bx,by,r]} | {box:[x0,y0,x1,y1]} | {poly:[[x,y],...]}
  LS.sdShapes = (px, py, shapes) => {
    let v = -Infinity;
    for (const s of shapes) {
      let d;
      if (s.cap) d = LS.sdCapsule(px, py, ...s.cap);
      else if (s.box) d = LS.sdBox(px, py, ...s.box);
      else d = LS.sdPoly(px, py, s.poly);
      if (d > v) v = d;
    }
    return v;
  };

  // ------------------------------------------------------------ smooth step
  LS.H = (p, w) => {
    if (p <= -w) return 0;
    if (p >= w) return 1;
    const t = 0.5 * (p / w + 1);
    return t * t * (3 - 2 * t);
  };
  LS.dH = (p, w) => {
    if (p <= -w || p >= w) return 0;
    const t = 0.5 * (p / w + 1);
    return 6 * t * (1 - t) * 0.5 / w;
  };

  // eps and d eps / d phi
  LS.raster = (phi, lo, hi, w, eps, deps) => {
    const de = hi - lo;
    for (let k = 0; k < phi.length; k++) {
      eps[k] = lo + de * LS.H(phi[k], w);
      if (deps) deps[k] = de * LS.dH(phi[k], w);
    }
  };

  // ------------------------------------------------------------ editing
  // union (add = true) or subtract a capsule from phi on mask cells
  LS.stroke = (phi, nx, ny, d, mask, ax, ay, bx, by, r, add) => {
    const pad = r + 3 * d;
    const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - pad) / d)), i1 = Math.min(nx - 1, Math.ceil((Math.max(ax, bx) + pad) / d));
    const j0 = Math.max(0, Math.floor((Math.min(ay, by) - pad) / d)), j1 = Math.min(ny - 1, Math.ceil((Math.max(ay, by) + pad) / d));
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const k = j + i * ny;
      if (!mask[k]) continue;
      const s = LS.sdCapsule((i + 0.5) * d, (j + 0.5) * d, ax, ay, bx, by, r);
      phi[k] = add ? Math.max(phi[k], s) : Math.min(phi[k], -s);
    }
  };

  // ------------------------------------------------------------ box symmetry
  // Symmetry groups of the design box about its center:
  //   'd2'  mirrors across the two center lines (left matches right, top
  //         matches bottom)
  //   'c4'  the four quarter turns
  //   'c4v' both mirrors plus the two diagonal mirrors (and so the quarter
  //         turns): the box looks the same from all four sides, and one
  //         eighth of it is free
  //   'my'  one mirror across the horizontal center line (top matches bottom)
  //   'adiag' one mirror across the diagonal u = -v, which maps the left
  //         edge's center onto the top edge's center (a 90 degree bend)
  // Each element maps offsets (u, v) from the center to (a u + b v, c u + e v).
  // In cell indices the center is (ic, jc) = ((i0 + i1 - 1) / 2, (j0 + j1 - 1) / 2);
  // points in um map about ((i0 + i1) d / 2, (j0 + j1) d / 2).
  LS.SYM = {
    d2: [[1, 0, 0, 1], [-1, 0, 0, 1], [1, 0, 0, -1], [-1, 0, 0, -1]],
    c4: [[1, 0, 0, 1], [0, -1, 1, 0], [-1, 0, 0, -1], [0, 1, -1, 0]],
    c4v: [[1, 0, 0, 1], [0, -1, 1, 0], [-1, 0, 0, -1], [0, 1, -1, 0], [-1, 0, 0, 1], [1, 0, 0, -1], [0, 1, 1, 0], [0, -1, -1, 0]],
    my: [[1, 0, 0, 1], [1, 0, 0, -1]],
    adiag: [[1, 0, 0, 1], [0, -1, -1, 0]],
  };
  // every box cell's images, m = group size entries per cell (repeats kept, so
  // the plain mean over them projects onto symmetric arrays)
  LS.symOrbits = (box, ny, group) => {
    const G = LS.SYM[group], [i0, i1, j0, j1] = box;
    if (!G) throw new Error(`unknown symmetry ${group}`);
    if (G.some(g => g[1] !== 0) && i1 - i0 !== j1 - j0) throw new Error(`symmetry ${group} needs a square box`);
    const ic = (i0 + i1 - 1) / 2, jc = (j0 + j1 - 1) / 2, idx = new Int32Array(G.length * (i1 - i0) * (j1 - j0));
    let q = 0;
    for (let i = i0; i < i1; i++) for (let j = j0; j < j1; j++) {
      const u = i - ic, v = j - jc;
      for (const [a, b, c, e] of G) idx[q++] = (jc + c * u + e * v) + (ic + a * u + b * v) * ny;
    }
    return { idx, m: G.length };
  };
  // replace every box cell by the mean over its images (in place)
  LS.symAverage = (arr, orb) => {
    const { idx, m } = orb, cells = idx.length / m, mean = new Float64Array(cells);
    for (let c = 0, q = 0; c < cells; c++, q += m) { let s = 0; for (let r = 0; r < m; r++) s += arr[idx[q + r]]; mean[c] = s / m; }
    for (let c = 0, q = 0; c < cells; c++, q += m) arr[idx[q]] = mean[c];
  };
  // the images of the segment (ax, ay)-(bx, by) in um, the segment itself first
  LS.symSegments = (box, d, group, ax, ay, bx, by) => {
    const cx = 0.5 * (box[0] + box[1]) * d, cy = 0.5 * (box[2] + box[3]) * d;
    const map = (x, y, [a, b, c, e]) => [cx + a * (x - cx) + b * (y - cy), cy + c * (x - cx) + e * (y - cy)];
    return LS.SYM[group].map(g => [...map(ax, ay, g), ...map(bx, by, g)]);
  };

  // ------------------------------------------------------------ reinitialization
  // Rebuild phi as a signed distance to its zero contour (fast sweeping on
  // |grad d| = 1, seeded with first-order distances at interface cells).
  // Only mask cells are written; other cells provide boundary data.
  LS.reinit = (phi, nx, ny, d, mask) => {
    const N = nx * ny, INF = 1e9;
    const dist = new Float64Array(N).fill(INF);
    const fixed = new Uint8Array(N);
    for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
      const k = j + i * ny, p = phi[k];
      let near = false, best = INF;
      const nb = [[i - 1, j], [i + 1, j], [i, j - 1], [i, j + 1]];
      for (const [a, b] of nb) {
        if (a < 0 || b < 0 || a >= nx || b >= ny) continue;
        const q = phi[b + a * ny];
        if ((p > 0) !== (q > 0)) {
          near = true;
          // linear crossing along this axis
          const t = p / (p - q);
          best = Math.min(best, Math.abs(t) * d);
        }
      }
      if (near) {
        // first-order distance using the gradient magnitude (central where possible)
        const px = phi[j + Math.min(nx - 1, i + 1) * ny] - phi[j + Math.max(0, i - 1) * ny];
        const py = phi[Math.min(ny - 1, j + 1) + i * ny] - phi[Math.max(0, j - 1) + i * ny];
        const sx = (i > 0 && i < nx - 1) ? 2 * d : d, sy = (j > 0 && j < ny - 1) ? 2 * d : d;
        const gm = Math.hypot(px / sx, py / sy);
        const est = gm > 1e-9 ? Math.abs(p) / gm : best;
        dist[k] = Math.min(best, est);
        fixed[k] = 1;
      }
    }
    const upd = (i, j) => {
      const k = j + i * ny;
      if (fixed[k]) return;
      const a = Math.min(i > 0 ? dist[k - ny] : INF, i < nx - 1 ? dist[k + ny] : INF);
      const b = Math.min(j > 0 ? dist[k - 1] : INF, j < ny - 1 ? dist[k + 1] : INF);
      let v;
      if (Math.abs(a - b) >= d) v = Math.min(a, b) + d;
      else v = 0.5 * (a + b + Math.sqrt(2 * d * d - (a - b) * (a - b)));
      if (v < dist[k]) dist[k] = v;
    };
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) upd(i, j);
      for (let i = nx - 1; i >= 0; i--) for (let j = 0; j < ny; j++) upd(i, j);
      for (let i = nx - 1; i >= 0; i--) for (let j = ny - 1; j >= 0; j--) upd(i, j);
      for (let i = 0; i < nx; i++) for (let j = ny - 1; j >= 0; j--) upd(i, j);
    }
    for (let k = 0; k < N; k++) {
      if (!mask[k] || dist[k] >= INF) continue;
      phi[k] = phi[k] > 0 ? dist[k] : -dist[k];
    }
  };

  // ------------------------------------------------------------ smoothing
  // separable Gaussian (sigma in cells) restricted to mask, renormalized
  LS.blur = (src, nx, ny, sigma, mask) => {
    const R = Math.max(1, Math.ceil(3 * sigma));
    const ker = new Float64Array(2 * R + 1);
    for (let t = -R; t <= R; t++) ker[t + R] = Math.exp(-0.5 * t * t / (sigma * sigma));
    const tmp = new Float64Array(nx * ny), out = new Float64Array(nx * ny);
    for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
      const k = j + i * ny;
      if (!mask[k]) continue;
      let s = 0, ws = 0;
      for (let t = -R; t <= R; t++) {
        const jj = j + t;
        if (jj < 0 || jj >= ny || !mask[jj + i * ny]) continue;
        s += ker[t + R] * src[jj + i * ny]; ws += ker[t + R];
      }
      tmp[k] = ws > 0 ? s / ws : 0;
    }
    for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
      const k = j + i * ny;
      if (!mask[k]) continue;
      let s = 0, ws = 0;
      for (let t = -R; t <= R; t++) {
        const ii = i + t;
        if (ii < 0 || ii >= nx || !mask[j + ii * ny]) continue;
        s += ker[t + R] * tmp[j + ii * ny]; ws += ker[t + R];
      }
      out[k] = ws > 0 ? s / ws : 0;
    }
    return out;
  };

  // mean curvature times |grad phi| (central differences), for smoothing flow
  LS.curvFlow = (phi, nx, ny, d, mask, out) => {
    const r = out || new Float64Array(nx * ny);
    for (let i = 1; i < nx - 1; i++) for (let j = 1; j < ny - 1; j++) {
      const k = j + i * ny;
      if (!mask[k]) { r[k] = 0; continue; }
      const px = (phi[k + ny] - phi[k - ny]) / (2 * d), py = (phi[k + 1] - phi[k - 1]) / (2 * d);
      const pxx = (phi[k + ny] - 2 * phi[k] + phi[k - ny]) / (d * d);
      const pyy = (phi[k + 1] - 2 * phi[k] + phi[k - 1]) / (d * d);
      const pxy = (phi[k + ny + 1] - phi[k + ny - 1] - phi[k - ny + 1] + phi[k - ny - 1]) / (4 * d * d);
      const g2 = px * px + py * py;
      // kappa |grad phi| = (pxx py^2 - 2 px py pxy + pyy px^2) / |grad phi|^2
      r[k] = g2 > 1e-12 ? (pxx * py * py - 2 * px * py * pxy + pyy * px * px) / g2 : 0;
    }
    return r;
  };

  // ------------------------------------------------------------ fabrication check
  // Squared Euclidean distance transform (Felzenszwalb and Huttenlocher) of
  // a binary image, pixel p = b + a H: squared distance in pixels from p to
  // the nearest pixel with feat = 1, BIG where there is none.
  const BIG = 1e30;
  function edt1(f, n, d, v, z) {
    let k = -1;
    for (let q = 0; q < n; q++) {
      if (f[q] >= BIG) continue;
      if (k < 0) { k = 0; v[0] = q; z[0] = -BIG; z[1] = BIG; continue; }
      let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * (q - v[k]));
      while (s <= z[k]) { k--; s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * (q - v[k])); }
      k++; v[k] = q; z[k] = s; z[k + 1] = BIG;
    }
    if (k < 0) { d.fill(BIG, 0, n); return; }
    let j = 0;
    for (let q = 0; q < n; q++) { while (z[j + 1] < q) j++; d[q] = (q - v[j]) * (q - v[j]) + f[v[j]]; }
  }
  LS.edt = (feat, W, H) => {
    const out = new Float64Array(W * H), M = Math.max(W, H);
    const f = new Float64Array(M), d = new Float64Array(M), v = new Int32Array(M), z = new Float64Array(M + 1);
    for (let a = 0; a < W; a++) {
      for (let b = 0; b < H; b++) f[b] = feat[b + a * H] ? 0 : BIG;
      edt1(f, H, d, v, z);
      for (let b = 0; b < H; b++) out[b + a * H] = d[b];
    }
    for (let b = 0; b < H; b++) {
      for (let a = 0; a < W; a++) f[a] = out[b + a * H];
      edt1(f, W, d, v, z);
      for (let a = 0; a < W; a++) out[b + a * H] = d[a];
    }
    return out;
  };

  // Minimum width and minimum gap check on an F-times supersampled image of
  // phi > 0 over the design box plus M cells. A silicon pixel fails the width
  // rule when no disk of radius r that fits inside silicon comes within tol
  // of it (morphological opening); an oxide pixel fails the gap rule the
  // same way (closing). tol lets right-angle corners pass. flags: 1 thin, 2
  // gap; counts and spots (connected groups) are taken inside the box grown
  // by G cells, so corners where the design meets a fixed guide count too.
  // A disk center needs dOut >= r in pixel-center distances, so the binary
  // image passes widths down to r/d F pixels less one: 137.5 to 150 nm for a
  // 150 nm rule at F = 8.
  LS.fabCheck = (phi, nx, ny, d, box, r, tol, F = 8, M = 4, G = 2) => {
    const [i0, i1, j0, j1] = box;
    const ci0 = Math.max(0, i0 - M), ci1 = Math.min(nx, i1 + M);
    const cj0 = Math.max(0, j0 - M), cj1 = Math.min(ny, j1 + M);
    const W = (ci1 - ci0) * F, H = (cj1 - cj0) * F, n = W * H, hs = d / F;
    const sil = new Uint8Array(n), oxi = new Uint8Array(n), inBox = new Uint8Array(n);
    for (let a = 0; a < W; a++) {
      const u = ci0 + (a + 0.5) / F - 0.5;
      let ia = Math.floor(u), fu = u - ia;
      if (ia < 0) { ia = 0; fu = 0; } else if (ia > nx - 2) { ia = nx - 2; fu = 1; }
      const ci = ci0 + Math.floor(a / F);
      for (let b = 0; b < H; b++) {
        const w = cj0 + (b + 0.5) / F - 0.5;
        let jb = Math.floor(w), fw = w - jb;
        if (jb < 0) { jb = 0; fw = 0; } else if (jb > ny - 2) { jb = ny - 2; fw = 1; }
        const k = jb + ia * ny;
        const v = (1 - fu) * ((1 - fw) * phi[k] + fw * phi[k + 1]) + fu * ((1 - fw) * phi[k + ny] + fw * phi[k + ny + 1]);
        const p = b + a * H;
        if (v > 0) sil[p] = 1; else oxi[p] = 1;
        const cj = cj0 + Math.floor(b / F);
        if (ci >= i0 - G && ci < i1 + G && cj >= j0 - G && cj < j1 + G) inBox[p] = 1;
      }
    }
    const rS = r / hs, tS = tol / hs;
    const flags = new Uint8Array(n);
    const rule = (inside, outside, flag) => {
      const dOut = LS.edt(outside, W, H);
      const core = new Uint8Array(n), lim = rS * rS;
      for (let p = 0; p < n; p++) if (inside[p] && dOut[p] >= lim) core[p] = 1;
      const dCore = LS.edt(core, W, H), lim2 = (rS + tS) * (rS + tS);
      let cnt = 0;
      for (let p = 0; p < n; p++) if (inside[p] && inBox[p] && dCore[p] > lim2) { flags[p] = flag; cnt++; }
      return cnt;
    };
    const nThin = rule(sil, oxi, 1), nGap = rule(oxi, sil, 2);
    const spots = flag => {
      const seen = new Uint8Array(n), st = new Int32Array(n);
      let c = 0;
      for (let s = 0; s < n; s++) {
        if (flags[s] !== flag || seen[s]) continue;
        c++; let top = 0; st[top++] = s; seen[s] = 1;
        while (top) {
          const q = st[--top], a = (q / H) | 0, b = q - a * H;
          for (let da = -1; da <= 1; da++) for (let db = -1; db <= 1; db++) {
            const aa = a + da, bb = b + db;
            if (aa < 0 || bb < 0 || aa >= W || bb >= H) continue;
            const t = bb + aa * H;
            if (!seen[t] && flags[t] === flag) { seen[t] = 1; st[top++] = t; }
          }
        }
      }
      return c;
    };
    return { W, H, F, ci0, cj0, sil, flags, nThin, nGap, thinSpots: spots(1), gapSpots: spots(2) };
  };

  // Layout class of a binary image (pixel p = b + a H): 4-connected pieces of
  // silicon touching the image edge (anchored to the fixed guides), silicon
  // islands and oxide holes inside, each at least minArea pixels.
  LS.topology = (img, W, H, minArea) => {
    const n = W * H, seen = new Uint8Array(n), st = new Int32Array(n);
    let anchored = 0, islands = 0, holes = 0;
    for (let s = 0; s < n; s++) {
      if (seen[s]) continue;
      const v = img[s];
      let top = 0, size = 0, edge = false;
      st[top++] = s; seen[s] = 1;
      while (top) {
        const q = st[--top], a = (q / H) | 0, b = q - a * H;
        size++;
        if (a === 0 || b === 0 || a === W - 1 || b === H - 1) edge = true;
        if (a > 0 && !seen[q - H] && img[q - H] === v) { seen[q - H] = 1; st[top++] = q - H; }
        if (a < W - 1 && !seen[q + H] && img[q + H] === v) { seen[q + H] = 1; st[top++] = q + H; }
        if (b > 0 && !seen[q - 1] && img[q - 1] === v) { seen[q - 1] = 1; st[top++] = q - 1; }
        if (b < H - 1 && !seen[q + 1] && img[q + 1] === v) { seen[q + 1] = 1; st[top++] = q + 1; }
      }
      if (v) { if (edge) anchored++; else if (size >= minArea) islands++; }
      else if (!edge && size >= minArea) holes++;
    }
    return { anchored, islands, holes };
  };

  // Morphological opening then closing of the silicon by radius r on mask
  // cells, by signed-distance shifts with reinitialization in between.
  LS.openClose = (phi, nx, ny, d, mask, r) => {
    for (const s of [-r, 2 * r, -r]) {
      for (let k = 0; k < phi.length; k++) if (mask[k]) phi[k] += s;
      LS.reinit(phi, nx, ny, d, mask);
    }
  };

  // ------------------------------------------------------------ contour
  // marching squares on cell centers -> Float32Array of segments (um)
  LS.contour = (phi, nx, ny, d) => {
    const segs = [];
    const P = (i, j) => phi[j + i * ny];
    for (let i = 0; i < nx - 1; i++) for (let j = 0; j < ny - 1; j++) {
      const a = P(i, j), b = P(i + 1, j), c = P(i + 1, j + 1), e = P(i, j + 1);
      const code = (a > 0 ? 1 : 0) | (b > 0 ? 2 : 0) | (c > 0 ? 4 : 0) | (e > 0 ? 8 : 0);
      if (code === 0 || code === 15) continue;
      const x0 = (i + 0.5) * d, y0 = (j + 0.5) * d;
      const pt = (va, vb, xa, ya, xb, yb) => {
        const t = va / (va - vb);
        return [xa + (xb - xa) * t, ya + (yb - ya) * t];
      };
      const B = () => pt(a, b, x0, y0, x0 + d, y0);          // bottom edge
      const Rr = () => pt(b, c, x0 + d, y0, x0 + d, y0 + d); // right edge
      const T = () => pt(e, c, x0, y0 + d, x0 + d, y0 + d);  // top edge
      const Lf = () => pt(a, e, x0, y0, x0, y0 + d);         // left edge
      const add = (p, q) => segs.push(p[0], p[1], q[0], q[1]);
      switch (code) {
        case 1: case 14: add(Lf(), B()); break;
        case 2: case 13: add(B(), Rr()); break;
        case 3: case 12: add(Lf(), Rr()); break;
        case 4: case 11: add(Rr(), T()); break;
        case 6: case 9: add(B(), T()); break;
        case 7: case 8: add(Lf(), T()); break;
        case 5: {   // saddle: decide with the center value
          const m = 0.25 * (a + b + c + e);
          if (m > 0) { add(Lf(), T()); add(B(), Rr()); } else { add(Lf(), B()); add(Rr(), T()); }
          break;
        }
        case 10: {
          const m = 0.25 * (a + b + c + e);
          if (m > 0) { add(Lf(), B()); add(Rr(), T()); } else { add(Lf(), T()); add(B(), Rr()); }
          break;
        }
      }
    }
    return Float32Array.from(segs);
  };

  g.LS = LS;
})(typeof self !== 'undefined' ? self : globalThis);
