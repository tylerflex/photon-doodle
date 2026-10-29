/* levels.js : level definitions for the component designer.
 * Shared by the page (drawing, labels) and the worker (physics).
 *
 * Grid: d = 50 nm cells, cell (i, j) centered at ((i + 0.5) d, (j + 0.5) d).
 * Material: 2D effective-index model of 220 nm SOI, core n = 2.85 in SiO2
 * n = 1.44. Waveguides are 0.45 um wide. PML is 12 cells on every side.
 * design: [i0, i1, j0, j1) cell ranges where silicon can be drawn.
 * ports: axis 'x' = line at column idx spanning rows [lo, hi); axis 'y' =
 * line at row idx spanning columns [lo, hi). The input port also has a
 * reflection monitor at column ref, between the PML and the source.
 * targets: objective sum of log T, score = min 10 log10(T / share).
 * init: starting shapes, or 'empty' for only short stubs of the fixed guides.
 * rules (fabrication): the score is the worst of the design etched etch um
 * narrower, as drawn, and etch um wider; designs with silicon or gaps
 * narrower than minFeature do not score; cornerTol lets right-angle corners
 * pass the width check. When an Optimize run stops on a design that fails
 * the check, the best passing design of the run comes back. sketch: a hand-drawn-style start used only by the
 * calibration runs (tests/sweep_levels.mjs).
 * smooth: the level's default curvature smoothing (else 0.3).
 * sym: a symmetry group of the box about its center (LS.SYM: 'd2' the two
 * center-line mirrors, 'c4' quarter turns, 'c4v' both mirrors and both
 * diagonals, so the box looks the same from all four sides; 'my' top to
 * bottom, 'adiag' across the diagonal that maps a bend's input onto its
 * output); the box, guides
 * and grid must be centered for this. Strokes and zones are repeated at all
 * images and the optimizer's velocity is averaged over them, which is the
 * exact gradient on symmetric designs.
 */
(function (g) {
  'use strict';
  const D = 0.05, W = 0.45, H = W / 2;
  const c = n => (n + 0.5) * D;
  const FAB = { etch: 0.01, minFeature: 0.15, cornerTol: 0.035 };

  // 90 degree bend in an s x s cell box: in from the left at mid-height, out
  // through the top at mid-width; init is the L that follows both guides
  function makeBend(s) {
    const i0 = 28, j0 = 22, i1 = i0 + s, j1 = j0 + s, h = (s - 1) / 2, jc = j0 + h, ic = i0 + h;
    return {
      nx: i1 + 22, ny: j1 + 28, design: [i0, i1, j0, j1], lambdas: [1.55],
      fixed: [
        { box: [-1, c(jc) - H, c(ic), c(jc) + H] },
        { box: [c(ic) - H, c(jc), c(ic) + H, (j1 + 40) * D] },
      ],
      init: [
        { cap: [1.0, c(jc), c(ic), c(jc), H] },
        { cap: [c(ic), c(jc), c(ic), (j1 + 6) * D, H] },
      ],
      // quarter circle from the input to the output, as a player would draw it
      sketch: Array.from({ length: 12 }, (_, q) => {
        const R = c(ic) - i0 * D, a0 = -Math.PI / 2 + Math.PI / 2 * q / 12, a1 = -Math.PI / 2 + Math.PI / 2 * (q + 1) / 12;
        const ox = i0 * D, oy = c(jc) + R;
        return { cap: [ox + R * Math.cos(a0), oy + R * Math.sin(a0), ox + R * Math.cos(a1), oy + R * Math.sin(a1), H] };
      }),
      ports: [
        { name: 'in', role: 'in', axis: 'x', idx: 15, ref: 13, lo: jc - 20, hi: jc + 21 },
        { name: 'out', axis: 'y', idx: j1 + 12, lo: ic - 20, hi: ic + 21 },
      ],
      targets: [{ port: 1, lam: 0, share: 1 }],
    };
  }

  const LEVELS = [
    {
      id: 'splitter', title: 'Splitter', v: 1,
      goal: 'Split the input equally between the two output ports. The box starts empty: draw the connection, then optimize. Whatever you draw is mirrored top to bottom.',
      nx: 107, ny: 95, design: [28, 79, 22, 73], lambdas: [1.55], sym: 'my', rules: FAB,
      fixed: [
        { box: [-1, c(47) - H, c(53), c(47) + H] },
        { box: [c(53), c(29) - H, 7, c(29) + H] },
        { box: [c(53), c(65) - H, 7, c(65) + H] },
      ],
      init: 'empty',
      sketch: [
        { cap: [1.0, c(47), 2.1, c(47), H] },
        { cap: [2.1, c(47), 4.3, c(65), H] },
        { cap: [2.1, c(47), 4.3, c(29), H] },
      ],
      ports: [
        { name: 'in', role: 'in', axis: 'x', idx: 15, ref: 13, lo: 27, hi: 68 },
        { name: 'top', axis: 'x', idx: 91, lo: 53, hi: 78 },
        { name: 'bottom', axis: 'x', idx: 91, lo: 17, hi: 42 },
      ],
      targets: [{ port: 1, lam: 0, share: 0.5 }, { port: 2, lam: 0, share: 0.5 }],
      // calibration (tests/calibrate_fab.mjs ... two100, 2026-10-23, with the
      // top-bottom mirror; the single page's Optimize: 100 steps as drawn,
      // then all 3 etch cases): the empty box never ends clean, an MMI block
      // -3.4 dB, random starts -0.14 to -2.9, a long Y -0.16, drawn Ys
      // -0.083 to -0.10 (with the adaptive step cap in the etch phase; 600
      // steps change these by under 0.01). Gold needs the better Y (a trunk
      // before the fork, -0.083); a quick Y earns silver
      medals: [-0.25, -0.12, -0.085],
    },
    Object.assign(makeBend(31), {
      id: 'bend', title: 'Bend', v: 1, rules: FAB, sym: 'adiag',
      goal: 'Turn the light 90 degrees, from the left port up to the top port, inside a 1.55 µm box. Whatever you draw is mirrored across the diagonal, so the bend looks the same from both ports.',
      // calibration: the L start stalls at -4.4 dB, the empty box or a drawn arc reach
      // -0.62, an arc plus a separate strip outside the corner reaches -0.21
      medals: [-0.7, -0.45, -0.25],
    }),
    {
      id: 'crossing', title: 'Crossing', v: 1,
      goal: 'Let the left-right guide cross the vertical guide with the least loss into the through port. A crossing has to work from all four ports, so the box looks the same from each: whatever you draw is mirrored across both guides and both diagonals. The box starts empty.',
      nx: 107, ny: 107, design: [28, 79, 28, 79], lambdas: [1.55], sym: 'c4v', rules: FAB,
      // smoothing 0.2: at 0.05 or 0.1 the optimizer leaves gaps under 150 nm,
      // and the plain cross, optimized as drawn then on the worst etch case,
      // never passes the fab check again; at 0.2 every start ends clean and
      // slides at most 0.05 dB after its peak, then holds
      smooth: 0.2,
      fixed: [
        { box: [-1, c(53) - H, 7, c(53) + H] },
        { box: [c(53) - H, -1, c(53) + H, 7] },
      ],
      // the box starts empty (2026-10-29: a plain-cross start gave a medal
      // for one click); the plain cross is the sketch: drawn and optimized it
      // earns bronze, while from the empty box the optimizer never joins the
      // four guides (-1.4 dB)
      init: 'empty',
      sketch: [
        { box: [1.0, c(53) - H, 4.4, c(53) + H] },
        { box: [c(53) - H, 1.0, c(53) + H, 4.4] },
      ],
      ports: [
        { name: 'in', role: 'in', axis: 'x', idx: 15, ref: 13, lo: 33, hi: 74 },
        { name: 'through', axis: 'x', idx: 91, lo: 33, hi: 74 },
        { name: 'up', axis: 'y', idx: 91, lo: 33, hi: 74, info: true },
        { name: 'down', axis: 'y', idx: 15, lo: 33, hi: 74, info: true },
      ],
      targets: [{ port: 1, lam: 0, share: 1 }],
      // calibration (tests/calibrate_fab.mjs crossing, 2026-10-21, mirror
      // symmetry): the plain cross optimizes to -0.22 dB as drawn and -0.20 to
      // -0.185 with worst etch, the empty box to -1.4, widened centers to -0.19,
      // random symmetric starts to -2.4 to -3.1; arms widened to 1.2 um plus an
      // island on each diagonal reach -0.12. 2026-10-29, the single page's
      // Optimize (100 steps as drawn, then all 3 etch cases with the adaptive
      // step cap): plain cross -0.205, wide or tapered arms -0.18 to -0.19,
      // wide arms plus islands -0.119, the empty box -1.36
      medals: [-0.3, -0.2, -0.15],
    },
    {
      id: 'converter', title: 'Mode converter',
      goal: 'Convert the fundamental mode into the odd (TE1) mode of the wide output guide. An odd mode needs an asymmetric device. The box starts empty.',
      nx: 107, ny: 95, design: [28, 79, 22, 73], lambdas: [1.55],
      fixed: [
        { box: [-1, c(47) - H, c(53), c(47) + H] },
        { box: [c(53), c(47) - 0.5, 7, c(47) + 0.5] },
      ],
      // the box starts empty (2026-10-29: the old start, a taper with a bump,
      // reached gold by itself). 600-step Optimize runs: empty -0.49 dB, a
      // straight guide -0.085, an offset guide -0.059, a guide split in two
      // with a bump -0.034
      init: 'empty',
      ports: [
        { name: 'in', role: 'in', axis: 'x', idx: 15, ref: 13, lo: 27, hi: 68 },
        { name: 'TE1', axis: 'x', idx: 91, lo: 25, hi: 70, order: 1 },
        { name: 'TE0', axis: 'x', idx: 91, lo: 25, hi: 70, order: 0, info: true },
      ],
      targets: [{ port: 1, lam: 0, share: 1 }],
      medals: [-0.12, -0.07, -0.04],
    },
    {
      id: 'demux', title: 'Wavelength demux',
      goal: 'Send 1310 nm to the top port and 1550 nm to the bottom port.',
      nx: 107, ny: 95, design: [28, 79, 22, 73], lambdas: [1.31, 1.55],
      fixed: [
        { box: [-1, c(47) - H, c(53), c(47) + H] },
        { box: [c(53), c(29) - H, 7, c(29) + H] },
        { box: [c(53), c(65) - H, 7, c(65) + H] },
      ],
      init: [
        { cap: [1.0, c(47), 2.1, c(47), H] },
        { cap: [2.1, c(47), 4.3, c(65), H] },
        { cap: [2.1, c(47), 4.3, c(29), H] },
      ],
      ports: [
        { name: 'in', role: 'in', axis: 'x', idx: 15, ref: 13, lo: 27, hi: 68 },
        { name: 'top', axis: 'x', idx: 91, lo: 53, hi: 78 },
        { name: 'bottom', axis: 'x', idx: 91, lo: 17, hi: 42 },
      ],
      targets: [{ port: 1, lam: 0, share: 1 }, { port: 2, lam: 1, share: 1 }],
      medals: [-3.0, -1.8, -1.0],
    },
  ];

  g.COMPONENT_LEVELS = { D, NC: 2.85, NS: 1.44, PML: 12, LEVELS, FAB, makeBend };
})(typeof self !== 'undefined' ? self : globalThis);
