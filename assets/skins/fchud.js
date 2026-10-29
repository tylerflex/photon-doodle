/* fchud.js : HUD in Flexcompute's colors (generated from hud.js and hud.css).
 * Lines and glow in brand light green #61B29C, primary actions filled with
 * Flexcompute green #00643C, neutrals from the brand greys, waves unchanged.
 *
 * HUD: Lab as a sci-fi heads-up display.
 *
 * Lab's layout, field painter and blue-red wave colors, on a dark navy
 * ground with thin cyan line work: corner brackets on the stage and the
 * panel sections (hud.css), cyan readouts in Chakra Petch and JetBrains
 * Mono, the medal ladder as an XP bar, and Optimize as the one lit button.
 * The only motion is a slow glow on Optimize while it runs (hud.css).
 * No field painter and no overlay: the field is Lab's.
 */
(function () {
  'use strict';
  SKINS.register({
    id: 'fchud',
    name: 'HUD Flexcompute',
    palette: {
      bg: '#070908', panel: '#0c100e', ink: '#eef1ef', dim: '#9aa6a0', faint: '#64736c',
      accent: '#61b29c', good: '#7fd3b5', bad: '#ff6b78', warn: '#fc7a4c',
      gold: '#ffd25e', silver: '#d4dad7', bronze: '#d99060',
      outline: '#e9f2ee', boxLine: '#61b29c', port: '#dbe6e1', portIn: '#7fd3b5',
      lock: '#6db5dd', lockFill: '#6db5dd', keep: '#ff7f74', keepFill: '#ff6e64',
      // coupler and Ring Lock grounds a shade toward navy
      oxide: '#0b100e', substrate: '#121815', core: '#16201c', pad: '#26302b', heaterCold: '#64736c',
      plot: '#61b29c', handle: '#61b29c', light: '#61b29c', ring1: '#61b29c',
    },
    fonts: {
      mono: '"JetBrains Mono", "SF Mono", ui-monospace, Menlo, monospace',
      sans: '"Chakra Petch", "JetBrains Mono", ui-monospace, sans-serif',
      serif: '"Chakra Petch", "JetBrains Mono", sans-serif',
    },
  });
})();
