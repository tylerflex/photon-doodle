/* fdfd.js : 2D frequency-domain solver shared by the optical design games.
 *
 * Plain script, no dependencies. Loads in a page, in a Web Worker
 * (importScripts) and in Node (tests), and exports globalThis.FDFD.
 *
 * Physics and conventions
 *  - Out-of-plane field u (E along the axis normal to the simulation plane),
 *    time dependence e^{-i w t}, lengths in um, k0 = 2 pi / lambda.
 *  - Equation (1/sx) d/dx((1/sx) du/dx) + (1/sy) d/dy((1/sy) du/dy)
 *    + k0^2 eps u = f, with stretched-coordinate PML s = 1 + i sigma(d).
 *  - Cell-centered unknowns on a rectilinear (optionally nonuniform) grid.
 *    Row (i, j) is multiplied by sx_i sy_j dx_i dy_j, which makes the matrix
 *    complex symmetric (A = A^T). The adjoint system is the forward system,
 *    so one factorization serves forward and adjoint solves.
 *  - Unknown (i, j) has index k = j + i * ny: the matrix is banded with
 *    half-bandwidth ny. Factorization is banded LDL^T without pivoting.
 *  - Complex vectors are interleaved Float64Arrays [re0, im0, re1, im1, ...].
 *
 * Mode normalization: a port mode phi is real with sum(phi^2 h) = 1. A unit
 * line source f = phi on one grid line launches the mode both ways with
 * modal amplitude G = h^2 / (2 i sin(theta)), cos(theta) = 1 - beta^2 h^2 / 2
 * (exact for the discrete equations). Modal power is |a|^2 sin(theta) / h.
 */
(function (g) {
  'use strict';
  const FDFD = {};

  // ------------------------------------------------------------- axes
  // spec: { n, d, x0 } for a uniform axis, or { edges: [...] }.
  function makeAxis(spec) {
    let e;
    if (spec.edges) e = Float64Array.from(spec.edges);
    else {
      e = new Float64Array(spec.n + 1);
      for (let i = 0; i <= spec.n; i++) e[i] = (spec.x0 || 0) + i * spec.d;
    }
    const n = e.length - 1;
    const w = new Float64Array(n), c = new Float64Array(n), h = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) { w[i] = e[i + 1] - e[i]; c[i] = 0.5 * (e[i] + e[i + 1]); }
    // h[i] = distance between centers i-1 and i (face i); ghost spacing at the ends
    h[0] = w[0]; h[n] = w[n - 1];
    for (let i = 1; i < n; i++) h[i] = c[i] - c[i - 1];
    return { n, e, w, c, h };
  }
  FDFD.makeAxis = makeAxis;

  // Nonuniform edges from segments [{ L, d }]: each segment of length L is cut
  // into round(L / d) equal cells, so interfaces between segments land on edges.
  FDFD.segmentEdges = function (x0, segs) {
    const e = [x0];
    let x = x0;
    for (const s of segs) {
      const m = Math.max(1, Math.round(s.L / s.d));
      const d = s.L / m;
      for (let k = 0; k < m; k++) { x += d; e.push(x); }
    }
    return e;
  };

  // ------------------------------------------------------------- problem
  // o: { x: axis spec, y: axis spec, lambda, pml: { x0, x1, y0, y1 } (cells),
  //      nref (index used to size the PML), R (target PML reflection) }
  class Problem {
    constructor(o) {
      const X = this.X = makeAxis(o.x), Y = this.Y = makeAxis(o.y);
      const nx = this.nx = X.n, ny = this.ny = Y.n;
      this.N = nx * ny;
      this.lambda = o.lambda;
      this.k0 = 2 * Math.PI / o.lambda;
      const p = o.pml || {};
      this.pml = { x0: p.x0 || 0, x1: p.x1 || 0, y0: p.y0 || 0, y1: p.y1 || 0 };
      const kref = this.k0 * (o.nref || 1);
      const R = o.R || 1e-8, m = 3;
      // stretch s = 1 + i sigma(d), sigma = smax (d/L)^m, round-trip loss R
      const stretch = (ax, n0, n1) => {
        const sc = new Float64Array(2 * ax.n), sf = new Float64Array(2 * (ax.n + 1));
        const a = ax.e[n0], b = ax.e[ax.n - n1];
        const L0 = a - ax.e[0], L1 = ax.e[ax.n] - b;
        const sig = x => {
          if (x < a && L0 > 0) { const d = (a - x) / L0; return (m + 1) * Math.log(1 / R) / (2 * kref * L0) * d * d * d; }
          if (x > b && L1 > 0) { const d = (x - b) / L1; return (m + 1) * Math.log(1 / R) / (2 * kref * L1) * d * d * d; }
          return 0;
        };
        for (let i = 0; i < ax.n; i++) { sc[2 * i] = 1; sc[2 * i + 1] = sig(ax.c[i]); }
        for (let i = 0; i <= ax.n; i++) { sf[2 * i] = 1; sf[2 * i + 1] = sig(ax.e[i]); }
        return { sc, sf };
      };
      const SX = stretch(X, this.pml.x0, this.pml.x1), SY = stretch(Y, this.pml.y0, this.pml.y1);
      this.sxc = SX.sc; this.sxf = SX.sf; this.syc = SY.sc; this.syf = SY.sf;
      this._assemble();
    }

    idx(i, j) { return j + i * this.ny; }

    // couplings cx (i,j)-(i+1,j), cy (i,j)-(i,j+1), base diagonal, eps weight w
    _assemble() {
      const { nx, ny, N, X, Y, sxc, sxf, syc, syf } = this;
      const cx = this.cx = new Float64Array(2 * N);
      const cy = this.cy = new Float64Array(2 * N);
      const base = this.base = new Float64Array(2 * N);
      const w = this.w = new Float64Array(2 * N);
      // a / (s * h) with s complex: returns [re, im]
      const div = (ar, ai, sr, si, h) => {
        const den = (sr * sr + si * si) * h;
        return [(ar * sr + ai * si) / den, (ai * sr - ar * si) / den];
      };
      for (let i = 0; i < nx; i++) {
        for (let j = 0; j < ny; j++) {
          const k = j + i * ny;
          // numerators: x-couplings carry sy_j dy_j, y-couplings carry sx_i dx_i
          const nxr = syc[2 * j] * Y.w[j], nxi = syc[2 * j + 1] * Y.w[j];
          const nyr = sxc[2 * i] * X.w[i], nyi = sxc[2 * i + 1] * X.w[i];
          const xm = div(nxr, nxi, sxf[2 * i], sxf[2 * i + 1], X.h[i]);
          const xp = div(nxr, nxi, sxf[2 * (i + 1)], sxf[2 * (i + 1) + 1], X.h[i + 1]);
          const ym = div(nyr, nyi, syf[2 * j], syf[2 * j + 1], Y.h[j]);
          const yp = div(nyr, nyi, syf[2 * (j + 1)], syf[2 * (j + 1) + 1], Y.h[j + 1]);
          if (i < nx - 1) { cx[2 * k] = xp[0]; cx[2 * k + 1] = xp[1]; }
          if (j < ny - 1) { cy[2 * k] = yp[0]; cy[2 * k + 1] = yp[1]; }
          base[2 * k] = -(xm[0] + xp[0] + ym[0] + yp[0]);
          base[2 * k + 1] = -(xm[1] + xp[1] + ym[1] + yp[1]);
          // w = k0^2 sx sy dx dy
          const ar = sxc[2 * i], ai = sxc[2 * i + 1], br = syc[2 * j], bi = syc[2 * j + 1];
          const a2 = this.k0 * this.k0 * X.w[i] * Y.w[j];
          w[2 * k] = a2 * (ar * br - ai * bi); w[2 * k + 1] = a2 * (ar * bi + ai * br);
        }
      }
    }

    // diagonal entry for unknown k given eps
    diag(k, eps) {
      return [this.base[2 * k] + this.w[2 * k] * eps, this.base[2 * k + 1] + this.w[2 * k + 1] * eps];
    }

    // dF/deps_k = -Re(w_k lam_k u_k)  for F real, dF = Re(sum gamma . da),
    // lam = A^{-1} (adjoint source). w already contains k0^2.
    gradEps(u, lam, out) {
      const N = this.N, w = this.w;
      const g = out || new Float64Array(N);
      for (let k = 0; k < N; k++) {
        const ur = u[2 * k], ui = u[2 * k + 1], lr = lam[2 * k], li = lam[2 * k + 1];
        const pr = ur * lr - ui * li, pi = ur * li + ui * lr;
        g[k] -= w[2 * k] * pr - w[2 * k + 1] * pi;
      }
      return g;
    }

    fullSolver() { return new FullSolver(this); }
    // only columns [c1, c2) may change eps; c2 < nx
    twistedSolver(c1, c2) { return new TwistedSolver(this, c1, c2); }

    // ---------------------------------------------------------- ports
    // port: { axis: 'x' (line at column idx, spans rows lo..hi-1) | 'y',
    //         idx, lo, hi, order }
    // Computes the mode on the line from eps and stores the discrete
    // propagation constant for the grid spacing normal to the line.
    portMode(port, eps) {
      const { nx, ny, X, Y } = this;
      const n = port.hi - port.lo;
      const e = new Float64Array(n), h = new Float64Array(n);
      for (let m = 0; m < n; m++) {
        const k = port.axis === 'x' ? (port.lo + m) + port.idx * ny : port.idx + (port.lo + m) * ny;
        e[m] = eps[k];
        h[m] = port.axis === 'x' ? Y.w[port.lo + m] : X.w[port.lo + m];
      }
      const md = FDFD.mode(e, h, this.k0, port.order || 0);
      const hp = port.axis === 'x' ? X.w[port.idx] : Y.w[port.idx];
      const c = 1 - md.beta2 * hp * hp / 2;
      const theta = Math.acos(Math.max(-1, Math.min(1, c)));
      const pm = Object.assign({}, port, md, {
        hp, theta, sin: Math.sin(theta),
        // modal amplitude launched by a unit line source: h^2 / (2 i sin)
        G: [0, -hp * hp / (2 * Math.sin(theta))],
        h,
      });
      pm.ks = new Int32Array(n);
      for (let m = 0; m < n; m++) {
        pm.ks[m] = port.axis === 'x' ? (port.lo + m) + port.idx * ny : port.idx + (port.lo + m) * ny;
      }
      return pm;
    }

    // right-hand side of a unit mode line source on port pm (scaled rows)
    sourceVec(pm, amp, out) {
      const f = out || new Float64Array(2 * this.N);
      const ar = amp ? amp[0] : 1, ai = amp ? amp[1] : 0;
      for (let m = 0; m < pm.ks.length; m++) {
        const s = pm.phi[m] * pm.hp * pm.h[m];
        f[2 * pm.ks[m]] += ar * s; f[2 * pm.ks[m] + 1] += ai * s;
      }
      return f;
    }

    // modal amplitude a = sum phi u h on the port line
    overlap(pm, u) {
      let ar = 0, ai = 0;
      for (let m = 0; m < pm.ks.length; m++) {
        const s = pm.phi[m] * pm.h[m];
        ar += s * u[2 * pm.ks[m]]; ai += s * u[2 * pm.ks[m] + 1];
      }
      return [ar, ai];
    }

    // add coef * c_pm (the overlap functional's vector) into an adjoint source
    addOverlapVec(pm, coef, out) {
      for (let m = 0; m < pm.ks.length; m++) {
        const s = pm.phi[m] * pm.h[m];
        out[2 * pm.ks[m]] += coef[0] * s; out[2 * pm.ks[m] + 1] += coef[1] * s;
      }
      return out;
    }

    // modal power of amplitude a in port pm
    modalPower(pm, a) { return (a[0] * a[0] + a[1] * a[1]) * pm.sin / pm.hp; }
  }
  FDFD.Problem = Problem;

  // ------------------------------------------------------------- mode solver
  // Real symmetric 1D eigenproblem on a line with cell sizes h (Dirichlet
  // ends): K u = beta^2 M u, M = diag(h). Returns the (order)-th mode counted
  // from the largest beta^2. Bisection with Sturm counts, then inverse iteration.
  FDFD.mode = function (eps, h, k0, order) {
    const n = eps.length;
    const hh = new Float64Array(n + 1);
    hh[0] = h[0]; hh[n] = h[n - 1];
    for (let j = 1; j < n; j++) hh[j] = 0.5 * (h[j - 1] + h[j]);
    const a = new Float64Array(n), b = new Float64Array(n);  // T diag, T offdiag (j, j+1)
    for (let j = 0; j < n; j++) {
      a[j] = (-(1 / hh[j] + 1 / hh[j + 1]) + k0 * k0 * eps[j] * h[j]) / h[j];
      if (j < n - 1) b[j] = (1 / hh[j + 1]) / Math.sqrt(h[j] * h[j + 1]);
    }
    const countBelow = x => {
      let c = 0, d = 1;
      for (let j = 0; j < n; j++) {
        d = (a[j] - x) - (j > 0 ? b[j - 1] * b[j - 1] / d : 0);
        if (d === 0) d = -1e-300;
        if (d < 0) c++;
      }
      return c;
    };
    let lo = Infinity, hi = -Infinity;
    for (let j = 0; j < n; j++) {
      const r = (j > 0 ? Math.abs(b[j - 1]) : 0) + (j < n - 1 ? Math.abs(b[j]) : 0);
      lo = Math.min(lo, a[j] - r); hi = Math.max(hi, a[j] + r);
    }
    const m = order || 0;
    for (let it = 0; it < 200; it++) {
      const x = 0.5 * (lo + hi);
      if (n - countBelow(x) >= m + 1) lo = x; else hi = x;
      if (hi - lo < 1e-14 * Math.max(1, Math.abs(hi))) break;
    }
    const lam = 0.5 * (lo + hi);
    // inverse iteration with a tiny shift (Thomas algorithm)
    let v = new Float64Array(n);
    for (let j = 0; j < n; j++) v[j] = 1 + 0.01 * Math.sin(1.3 * j + 0.7);
    const shift = lam + 1e-10 * Math.max(1, Math.abs(lam));
    const cp = new Float64Array(n), dp = new Float64Array(n);
    for (let it = 0; it < 4; it++) {
      let den = a[0] - shift;
      if (den === 0) den = 1e-300;
      cp[0] = (n > 1 ? b[0] : 0) / den; dp[0] = v[0] / den;
      for (let j = 1; j < n; j++) {
        den = (a[j] - shift) - b[j - 1] * cp[j - 1];
        if (den === 0) den = 1e-300;
        cp[j] = (j < n - 1 ? b[j] : 0) / den;
        dp[j] = (v[j] - b[j - 1] * dp[j - 1]) / den;
      }
      const x = new Float64Array(n);
      x[n - 1] = dp[n - 1];
      for (let j = n - 2; j >= 0; j--) x[j] = dp[j] - cp[j] * x[j + 1];
      let s = 0;
      for (let j = 0; j < n; j++) s += x[j] * x[j];
      s = Math.sqrt(s);
      for (let j = 0; j < n; j++) x[j] /= s;
      v = x;
    }
    const phi = new Float64Array(n);
    let s = 0, big = 0, bigj = 0;
    for (let j = 0; j < n; j++) {
      phi[j] = v[j] / Math.sqrt(h[j]);
      s += phi[j] * phi[j] * h[j];
      if (Math.abs(phi[j]) > big) { big = Math.abs(phi[j]); bigj = j; }
    }
    const sg = (phi[bigj] < 0 ? -1 : 1) / Math.sqrt(s);
    for (let j = 0; j < n; j++) phi[j] *= sg;
    return { beta2: lam, neff: Math.sqrt(Math.max(0, lam)) / k0, phi };
  };

  // ------------------------------------------------------------- band LDL^T
  // Upper band storage: entry (r, r+o), o = 0..b, at a[2 (r W + o)], W = b+1.
  // After factor(k0, k1): pivot rows hold d_k at o = 0 and L_{k+o,k} at o > 0.
  class Band {
    constructor(N, b) {
      this.N = N; this.b = b; this.W = b + 1;
      this.a = new Float64Array(2 * N * this.W);
      this.U = new Float64Array(4 * 2 * (4 + b));
    }
    // Blocked right-looking LDL^T over pivots [k0, k1), four pivots at a
    // time: the pivots are factored against each other first, then the
    // trailing rows take one rank-4 update, so each trailing entry is loaded
    // and stored once per four pivots (1.5x faster than one at a time in V8).
    factor(k0, k1) {
      const a = this.a, W = this.W, b = this.b, N = this.N;
      const NB = 4, st = 2 * (NB + b), U = this.U;
      let k = k0;
      while (k < k1) {
        const nb = Math.min(NB, k1 - k);
        U.fill(0);
        // U row j holds pivot k+j's unscaled band row, aligned so that
        // U[j][m] is column k + m
        for (let j = 0; j < nb; j++) {
          const p = k + j, pb = 2 * p * W;
          const dr = a[pb], di = a[pb + 1], den = dr * dr + di * di;
          if (!(den > 0)) throw new Error('FDFD: zero pivot at ' + p);
          const ir = dr / den, ii = -di / den;
          const omax = Math.min(b, N - 1 - p);
          const ub = j * st + 2 * j;
          for (let o = 0; o <= omax; o++) { U[ub + 2 * o] = a[pb + 2 * o]; U[ub + 2 * o + 1] = a[pb + 2 * o + 1]; }
          const o1max = Math.min(omax, nb - 1 - j);
          for (let o1 = 1; o1 <= o1max; o1++) {
            const ar = U[ub + 2 * o1], ai = U[ub + 2 * o1 + 1];
            const lr = ar * ir - ai * ii, li = ar * ii + ai * ir;
            let q = 2 * ((p + o1) * W);
            for (let o2 = o1; o2 <= omax; o2++, q += 2) {
              const ur = U[ub + 2 * o2], ui = U[ub + 2 * o2 + 1];
              a[q] -= lr * ur - li * ui; a[q + 1] -= lr * ui + li * ur;
            }
          }
          for (let o = 1; o <= omax; o++) {
            const ar = U[ub + 2 * o], ai = U[ub + 2 * o + 1];
            a[pb + 2 * o] = ar * ir - ai * ii; a[pb + 2 * o + 1] = ar * ii + ai * ir;
          }
        }
        // trailing rank-nb update of rows k+nb .. k+nb-1+b
        const rEnd = Math.min(N - 1, k + nb - 1 + b);
        const mEnd = Math.min(nb - 1 + b, N - 1 - k);
        for (let r = k + nb; r <= rEnd; r++) {
          let l0r = 0, l0i = 0, l1r = 0, l1i = 0, l2r = 0, l2i = 0, l3r = 0, l3i = 0, o, s;
          o = r - k; if (o <= b) { s = 2 * (k * W + o); l0r = a[s]; l0i = a[s + 1]; }
          if (nb > 1) { o = r - k - 1; if (o <= b) { s = 2 * ((k + 1) * W + o); l1r = a[s]; l1i = a[s + 1]; } }
          if (nb > 2) { o = r - k - 2; if (o <= b) { s = 2 * ((k + 2) * W + o); l2r = a[s]; l2i = a[s + 1]; } }
          if (nb > 3) { o = r - k - 3; if (o <= b) { s = 2 * ((k + 3) * W + o); l3r = a[s]; l3i = a[s + 1]; } }
          let q = 2 * (r * W), m = r - k;
          const u0 = 2 * m, u1 = st + 2 * m, u2 = 2 * st + 2 * m, u3 = 3 * st + 2 * m;
          for (let t = 0; m <= mEnd; m++, t += 2, q += 2) {
            const ar = U[u0 + t], ai = U[u0 + t + 1], br = U[u1 + t], bi = U[u1 + t + 1];
            const cr = U[u2 + t], ci = U[u2 + t + 1], er = U[u3 + t], ei = U[u3 + t + 1];
            a[q] -= (l0r * ar - l0i * ai) + (l1r * br - l1i * bi) + (l2r * cr - l2i * ci) + (l3r * er - l3i * ei);
            a[q + 1] -= (l0r * ai + l0i * ar) + (l1r * bi + l1i * br) + (l2r * ci + l2i * cr) + (l3r * ei + l3i * er);
          }
        }
        k += nb;
      }
    }
    // x index of band row k: base + stride * k (stride 2 natural, -2 reversed)
    fwd(x, k0, k1, base, stride) {
      const a = this.a, W = this.W, b = this.b, N = this.N;
      for (let k = k0; k < k1; k++) {
        const px = base + stride * k;
        const yr = x[px], yi = x[px + 1];
        if (yr === 0 && yi === 0) continue;
        const omax = Math.min(b, N - 1 - k), kb = 2 * k * W;
        for (let o = 1; o <= omax; o++) {
          const lr = a[kb + 2 * o], li = a[kb + 2 * o + 1];
          const q = px + stride * o;
          x[q] -= lr * yr - li * yi;
          x[q + 1] -= lr * yi + li * yr;
        }
      }
    }
    diag(x, k0, k1, base, stride) {
      const a = this.a, W = this.W;
      for (let k = k0; k < k1; k++) {
        const px = base + stride * k, kb = 2 * k * W;
        const dr = a[kb], di = a[kb + 1], den = dr * dr + di * di;
        const xr = x[px], xi = x[px + 1];
        x[px] = (xr * dr + xi * di) / den;
        x[px + 1] = (xi * dr - xr * di) / den;
      }
    }
    back(x, k0, k1, base, stride) {
      const a = this.a, W = this.W, b = this.b, N = this.N;
      for (let k = k1 - 1; k >= k0; k--) {
        const px = base + stride * k;
        const omax = Math.min(b, N - 1 - k), kb = 2 * k * W;
        let sr = 0, si = 0;
        for (let o = 1; o <= omax; o++) {
          const lr = a[kb + 2 * o], li = a[kb + 2 * o + 1];
          const q = px + stride * o;
          const xr = x[q], xi = x[q + 1];
          sr += lr * xr - li * xi; si += lr * xi + li * xr;
        }
        x[px] -= sr; x[px + 1] -= si;
      }
    }
  }
  FDFD.Band = Band;

  // fill band rows [r0, r1) of a natural-order band with the matrix of prob
  // (entries limited to columns < band.N), eps on the diagonal
  function fillNatural(band, prob, eps, r0, r1) {
    const { ny, base, w, cx, cy } = prob;
    const a = band.a, W = band.W, Nb = band.N;
    a.fill(0, 2 * r0 * W, 2 * r1 * W);
    for (let k = r0; k < r1; k++) {
      const kb = 2 * k * W, e = eps[k];
      a[kb] = base[2 * k] + w[2 * k] * e; a[kb + 1] = base[2 * k + 1] + w[2 * k + 1] * e;
      if (k + 1 < Nb && (k % ny) !== ny - 1) { a[kb + 2] = cy[2 * k]; a[kb + 3] = cy[2 * k + 1]; }
      if (k + ny < Nb) { a[kb + 2 * ny] = cx[2 * k]; a[kb + 2 * ny + 1] = cx[2 * k + 1]; }
    }
  }
  // reversed order: band row r is unknown k = N - 1 - r; entry (r, r+o) is
  // A(k, k-o)
  function fillReversed(band, prob, eps, r0, r1) {
    const { ny, N, base, w, cx, cy } = prob;
    const a = band.a, W = band.W, Nb = band.N;
    a.fill(0, 2 * r0 * W, 2 * r1 * W);
    for (let r = r0; r < r1; r++) {
      const k = N - 1 - r, kb = 2 * r * W, e = eps[k];
      a[kb] = base[2 * k] + w[2 * k] * e; a[kb + 1] = base[2 * k + 1] + w[2 * k + 1] * e;
      if (r + 1 < Nb && (k % ny) !== 0) { a[kb + 2] = cy[2 * (k - 1)]; a[kb + 3] = cy[2 * (k - 1) + 1]; }
      if (r + ny < Nb) { a[kb + 2 * ny] = cx[2 * (k - ny)]; a[kb + 2 * ny + 1] = cx[2 * (k - ny) + 1]; }
    }
  }

  // ------------------------------------------------------------- solvers
  class FullSolver {
    constructor(prob) {
      this.prob = prob;
      this.band = new Band(prob.N, prob.ny);
    }
    setEps(eps) {
      const t0 = now();
      fillNatural(this.band, this.prob, eps, 0, this.prob.N);
      this.band.factor(0, this.prob.N);
      this.tFactor = now() - t0;
    }
    solve(f) {
      const x = Float64Array.from(f), N = this.prob.N, B = this.band;
      B.fwd(x, 0, N, 0, 2); B.diag(x, 0, N, 0, 2); B.back(x, 0, N, 0, 2);
      return x;
    }
  }
  FDFD.FullSolver = FullSolver;

  // Twisted factorization for problems where eps changes only in columns
  // [c1, c2). Unknowns split into T = columns [0, c2), window W = column c2,
  // B = columns (c2, nx). T is factored from the top (the left exterior
  // [0, c1) once, then only the variable columns on each update), B from the
  // bottom (once), and the Schur complement on W is factored densely:
  //   S = A_WW - A_WT A_TT^-1 A_TW - A_WB A_BB^-1 A_BW.
  class TwistedSolver {
    constructor(prob, c1, c2) {
      if (c2 >= prob.nx) throw new Error('TwistedSolver: c2 must be < nx');
      this.prob = prob; this.c1 = c1; this.c2 = c2;
      const ny = prob.ny, N = prob.N;
      this.b = ny; this.t = c2 * ny;
      this.top = new Band(this.t + ny, ny);
      this.bot = new Band(N - this.t, ny);
      this.S = new Float64Array(2 * ny * ny);
      this.Wbot = null; this.Aww = null; this.ckpt = null;
      this.ready = false;
    }
    _init(eps) {
      const { prob, top, bot, b, t } = this;
      const N = prob.N, ny = prob.ny, Nbot = N - t;
      // bottom: reversed rows [0, Nbot), pivots [0, Nbot - b)
      fillReversed(bot, prob, eps, 0, Nbot);
      bot.factor(0, Nbot - b);
      // W block from the bottom sweep, as a dense natural-index matrix
      this.Wbot = new Float64Array(2 * b * b);
      for (let p = 0; p < b; p++) {
        const r = Nbot - 1 - p;
        for (let o = 0; o <= p; o++) {
          const q = p - o, src = 2 * (r * bot.W + o);
          this._set(this.Wbot, p, q, bot.a[src], bot.a[src + 1]);
        }
      }
      // A_WW (natural, unswept): W is one full column, so it is tridiagonal
      this.Aww = new Float64Array(2 * b * b);
      for (let p = 0; p < b; p++) {
        const k = t + p;
        this._set(this.Aww, p, p, prob.base[2 * k] + prob.w[2 * k] * eps[k],
          prob.base[2 * k + 1] + prob.w[2 * k + 1] * eps[k]);
        if (p < b - 1) this._set(this.Aww, p, p + 1, prob.cy[2 * k], prob.cy[2 * k + 1]);
      }
      // top exterior once, then checkpoint the partially updated rows as deltas
      const k1 = this.c1 * ny;
      fillNatural(top, prob, eps, 0, t + b);
      if (k1 > 0) {
        const raw = new Float64Array(2 * b * top.W);
        raw.set(top.a.subarray(2 * k1 * top.W, 2 * (k1 + b) * top.W));
        top.factor(0, k1);
        const after = top.a.subarray(2 * k1 * top.W, 2 * (k1 + b) * top.W);
        this.ckpt = new Float64Array(raw.length);
        for (let m = 0; m < raw.length; m++) this.ckpt[m] = after[m] - raw[m];
        // pivots [0, k1) stay factored for good: save them
        this.topExterior = top.a.slice(0, 2 * k1 * top.W);
      }
      this.ready = true;
    }
    _set(M, p, q, re, im) {
      const b = this.b;
      M[2 * (p * b + q)] = re; M[2 * (p * b + q) + 1] = im;
      M[2 * (q * b + p)] = re; M[2 * (q * b + p) + 1] = im;
    }
    setEps(eps) {
      const t0 = now();
      if (!this.ready) this._init(eps);
      const { prob, top, b, t } = this;
      const ny = prob.ny, k1 = this.c1 * ny;
      // refill and refactor the variable part of T
      if (k1 > 0) top.a.set(this.topExterior, 0);
      fillNatural(top, prob, eps, k1, t + b);
      if (k1 > 0) {
        const off = 2 * k1 * top.W, ck = this.ckpt;
        for (let m = 0; m < ck.length; m++) top.a[off + m] += ck[m];
      }
      top.factor(k1, t);
      // S = Wtop + Wbot - Aww, then dense LDL^T
      const S = this.S, Wb = this.Wbot, Aw = this.Aww;
      for (let p = 0; p < b; p++) for (let o = 0; o + p < b; o++) {
        const src = 2 * ((t + p) * top.W + o), q = p + o;
        const m = 2 * (p * b + q);
        const re = top.a[src] + Wb[m] - Aw[m], im = top.a[src + 1] + Wb[m + 1] - Aw[m + 1];
        this._set(S, p, q, re, im);
      }
      denseLDL(S, b);
      this.tFactor = now() - t0;
    }
    solve(f) {
      const { prob, top, bot, b, t } = this;
      const N = prob.N, Nbot = N - t;
      const x = Float64Array.from(f);
      const rb = 2 * (N - 1);
      top.fwd(x, 0, t, 0, 2);
      bot.fwd(x, 0, Nbot - b, rb, -2);
      top.diag(x, 0, t, 0, 2);
      bot.diag(x, 0, Nbot - b, rb, -2);
      denseSolve(this.S, b, x, 2 * t);
      top.back(x, 0, t, 0, 2);
      bot.back(x, 0, Nbot - b, rb, -2);
      return x;
    }
  }
  FDFD.TwistedSolver = TwistedSolver;

  // dense complex-symmetric LDL^T in place (full storage, lower part used)
  function denseLDL(S, n) {
    for (let k = 0; k < n; k++) {
      const kk = 2 * (k * n + k);
      const dr = S[kk], di = S[kk + 1], den = dr * dr + di * di;
      if (!(den > 0)) throw new Error('FDFD: zero pivot in window');
      const ir = dr / den, ii = -di / den;
      for (let i = k + 1; i < n; i++) {
        const ik = 2 * (i * n + k);
        const ar = S[ik], ai = S[ik + 1];
        const lr = ar * ir - ai * ii, li = ar * ii + ai * ir;
        for (let j = k + 1; j <= i; j++) {
          const jk = 2 * (j * n + k), ij = 2 * (i * n + j);
          const ur = S[jk], ui = S[jk + 1];
          S[ij] -= lr * ur - li * ui; S[ij + 1] -= lr * ui + li * ur;
        }
      }
      for (let i = k + 1; i < n; i++) {
        const ik = 2 * (i * n + k);
        const ar = S[ik], ai = S[ik + 1];
        S[ik] = ar * ir - ai * ii; S[ik + 1] = ar * ii + ai * ir;
      }
    }
  }
  // solve with the factored S on the slice x[off .. off + 2n)
  function denseSolve(S, n, x, off) {
    for (let k = 0; k < n; k++) {
      const yr = x[off + 2 * k], yi = x[off + 2 * k + 1];
      for (let i = k + 1; i < n; i++) {
        const ik = 2 * (i * n + k), lr = S[ik], li = S[ik + 1];
        x[off + 2 * i] -= lr * yr - li * yi; x[off + 2 * i + 1] -= lr * yi + li * yr;
      }
    }
    for (let k = 0; k < n; k++) {
      const kk = 2 * (k * n + k), dr = S[kk], di = S[kk + 1], den = dr * dr + di * di;
      const xr = x[off + 2 * k], xi = x[off + 2 * k + 1];
      x[off + 2 * k] = (xr * dr + xi * di) / den; x[off + 2 * k + 1] = (xi * dr - xr * di) / den;
    }
    for (let k = n - 1; k >= 0; k--) {
      let sr = 0, si = 0;
      for (let i = k + 1; i < n; i++) {
        const ik = 2 * (i * n + k), lr = S[ik], li = S[ik + 1];
        const xr = x[off + 2 * i], xi = x[off + 2 * i + 1];
        sr += lr * xr - li * xi; si += lr * xi + li * xr;
      }
      x[off + 2 * k] -= sr; x[off + 2 * k + 1] -= si;
    }
  }

  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  FDFD.now = now;

  // complex helpers for callers
  FDFD.cabs2 = a => a[0] * a[0] + a[1] * a[1];
  FDFD.cmul = (a, b) => [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]];
  FDFD.cdiv = (a, b) => {
    const d = b[0] * b[0] + b[1] * b[1];
    return [(a[0] * b[0] + a[1] * b[1]) / d, (a[1] * b[0] - a[0] * b[1]) / d];
  };
  FDFD.cexp = th => [Math.cos(th), Math.sin(th)];

  g.FDFD = FDFD;
})(typeof self !== 'undefined' ? self : globalThis);
