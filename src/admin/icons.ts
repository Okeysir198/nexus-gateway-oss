/** Inline SVG glyphs: a hand-inlined slice of lucide (path data verbatim from its icon
 *  nodes). 24-unit box, 2-unit stroke, currentColor: the colour comes from the text the
 *  glyph sits in, so it themes for free and never carries a fill.
 *
 *  These land inside the page's template literals at assembly, so no backtick may
 *  survive into the output; icon() interpolates at module-eval time and its output
 *  carries only double quotes. test/page_render pins the integrity of these strings. */

function icon(paths: string, size = 16): string {
  return (
    '<svg class="ic" width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" ' +
    'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ' +
    'aria-hidden="true" focusable="false">' + paths + "</svg>"
  );
}

/** Only the glyphs the shell and views use. Names follow lucide's. */
export const I = {
  // Sidebar trigger.
  panelLeft: icon('<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/>'),
  // Theme toggle. The script shows exactly one at a time by flipping .is-dark
  // on the button: sun = the light mode a click WOULD bring, moon = dark.
  sun: icon(
    '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/>' +
    '<path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/>' +
    '<path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
  ),
  moon: icon(
    '<path d="M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401"/>',
  ),
  // Sign out.
  logOut: icon('<path d="m16 17 5-5-5-5"/><path d="M21 12H9"/><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>'),
  // API keys — key-round.
  keyRound: icon(
    '<path d="M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z"/>' +
    '<circle cx="16.5" cy="7.5" r=".5" fill="currentColor"/>',
  ),
  // Providers.
  plug: icon('<path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/><path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z"/>'),
  eye: icon('<path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/>'),
  eyeOff: icon(
    '<path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49"/>' +
    '<path d="M14.084 14.158a3 3 0 0 1-4.242-4.242"/>' +
    '<path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143"/>' +
    '<path d="m2 2 20 20"/>',
  ),
  chevronRight: icon('<path d="m9 18 6-6-6-6"/>'),
  chevronDown: icon('<path d="m6 9 6 6 6-6"/>'),
};
