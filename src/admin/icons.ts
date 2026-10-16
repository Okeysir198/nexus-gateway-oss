/** Inline SVG glyphs — a hand-inlined slice of lucide (path data verbatim from
 *  lucide-react's icon nodes). 24-box, 2-unit
 *  stroke, currentColor: the colour comes from the text the glyph sits in, so it
 *  themes for free and never carries a fill.
 *
 *  Everything here lands inside ONE template literal at assembly (the nav markup and
 *  the view scripts), so the "no backtick survives into the output" rule applies —
 *  icon() interpolates at module-eval time, and its output carries only double
 *  quotes. test/page_render pins the integrity of the strings that embed these. */

function icon(paths: string, size = 16): string {
  return (
    '<svg class="ic" width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" ' +
    'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ' +
    'aria-hidden="true" focusable="false">' + paths + "</svg>"
  );
}

/** The set the views + shell actually use. Names follow lucide's. */
export const I = {
  // Sidebar trigger (shadcn SidebarTrigger's PanelLeftIcon).
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
  // Providers — a plug: what you wire the gateway's routes to.
  plug: icon('<path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/><path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z"/>'),
  // Operators.
  users: icon(
    '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><path d="M16 3.128a4 4 0 0 1 0 7.744"/>' +
    '<path d="M22 21v-2a4 4 0 0 0-3-3.87"/><circle cx="9" cy="7" r="4"/>',
  ),
  plus: icon('<path d="M5 12h14"/><path d="M12 5v14"/>'),
  x: icon('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
  check: icon('<path d="M20 6 9 17l-5-5"/>'),
  chevronRight: icon('<path d="m9 18 6-6-6-6"/>'),
  chevronDown: icon('<path d="m6 9 6 6 6-6"/>'),
  triangleAlert: icon(
    '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  ),
  copy: icon('<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>'),
  refreshCw: icon(
    '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/>' +
    '<path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
  ),
  externalLink: icon(
    '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  ),
  loaderCircle: icon('<path d="M21 12a9 9 0 1 1-6.219-8.56"/>'),
  fileText: icon(
    '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>' +
    '<path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>',
  ),
};
