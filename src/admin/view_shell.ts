import { I } from "./icons";
import {
  SIDEBAR,
  SIDEBAR_CONTAINER,
  SIDEBAR_CONTENT,
  SIDEBAR_FOOTER,
  SIDEBAR_GAP,
  SIDEBAR_GROUP,
  SIDEBAR_GROUP_CONTENT,
  SIDEBAR_GROUP_LABEL,
  SIDEBAR_HEADER,
  SIDEBAR_INSET,
  SIDEBAR_INNER,
  SIDEBAR_MENU,
  SIDEBAR_MENU_BUTTON,
  SIDEBAR_MENU_BUTTON_LG,
  SIDEBAR_TRIGGER,
  SIDEBAR_MENU_ITEM,
  BREADCRUMB_ITEM,
  BREADCRUMB_LIST,
  BREADCRUMB_LINK,
  BREADCRUMB_PAGE,
  BREADCRUMB_SEPARATOR,
} from "./ui";

/** Page chrome: the shadcn sidebar skeleton — sidebar peer + inset main + the
 *  hidden-radio tab panels + the <md bottom nav.
 *
 *  There is no sign-in panel here. Authentication happens BEFORE this page is served
 *  (src/admin/login.ts → a signed HttpOnly cookie), so an unauthenticated visitor gets
 *  the login page instead of this markup. Nothing on this page is a secret, and the
 *  browser never holds a credential it could leak.
 *
 *  Tabs are HIDDEN RADIOS + CSS, not buttons: the .tab-radio inputs are the FIRST
 *  children of [data-slot="sidebar-wrapper"]; the sidebar, the inset and the bottom nav
 *  follow them as SIBLINGS, and the panels live inside the inset. Generated rules in
 *  styles.ts (`#tab-x:checked ~ [data-slot="sidebar-inset"] #panel-x` and the two nav
 *  fusions) reveal/ink the active tab — one rule group per tab, GENERATED, so a tab
 *  cannot exist with no way to be shown. Tabs work with JavaScript fully off; the
 *  script only adds hash deep links (/admin#providers), the breadcrumb sync, the
 *  collapse toggle (data-state/data-collapsible) and per-tab data refresh.
 *  STRUCTURE IS LOAD-BEARING: wrap the sidebar or the inset one div deeper and every
 *  general-sibling rule dies with JS on while the markup still contains every word a
 *  string test looks for — test/page_render.test.ts pins it. */

/** The console sections, in tab order. Keys stays the landing tab. */
export const TABS = ["keys", "providers"] as const;
type TabId = (typeof TABS)[number];

const TAB_LABELS: Record<TabId, string> = {
  keys: "API keys",
  providers: "Providers",
};

const TAB_GLYPHS: Record<TabId, string> = {
  keys: I.keyRound,
  providers: I.plug,
};

function radios(): string {
  return TABS.map(
    (t, i) =>
      '<input type="radio" name="tab" id="tab-' + t + '" class="tab-radio"' + (i === 0 ? " checked" : "") + ">",
  ).join("\n");
}

/** One sidebar row AND one bottom-nav cell per tab, both `<label for=tab-*>` over the
 *  same radio — the nav is two views of one state. The menu button's id is what the
 *  generated fusion rule (and the crumb sync) keys on; the name stays in the DOM so
 *  the control announces itself. */
function railItem(id: TabId): string {
  return (
    '<li data-slot="sidebar-menu-item" data-sidebar="menu-item" class="' + SIDEBAR_MENU_ITEM + '">' +
    '<label for="tab-' + id + '" id="lab-' + id + '" data-slot="sidebar-menu-button" data-sidebar="menu-button" ' +
    'data-size="default" title="' + TAB_LABELS[id] + '" class="' + SIDEBAR_MENU_BUTTON + ' cursor-pointer">' +
    TAB_GLYPHS[id] +
    "<span>" + TAB_LABELS[id] + "</span></label></li>"
  );
}

function bottomItem(id: TabId): string {
  return (
    '<label for="tab-' + id + '" title="' + TAB_LABELS[id] + '" ' +
    'class="flex flex-1 flex-col items-center justify-center gap-1 py-2 text-[0.65rem] font-medium text-muted-foreground cursor-pointer select-none">' +
    TAB_GLYPHS[id] +
    "<span>" + TAB_LABELS[id] + "</span></label>"
  );
}

const SIDEBAR_MARKUP =
  '<div data-slot="sidebar" class="' + SIDEBAR + '" data-state="expanded" data-collapsible="" data-variant="sidebar" data-side="left">\n' +
  '<div data-slot="sidebar-gap" class="' + SIDEBAR_GAP + '"></div>\n' +
  '<div data-slot="sidebar-container" class="' + SIDEBAR_CONTAINER + '">\n' +
  '<div data-sidebar="sidebar" data-slot="sidebar-inner" class="' + SIDEBAR_INNER + '">\n' +

  // Header: the brand lockup, a menu row over an avatar tile + wordmark. In the icon rail the tile's
  // size-8! + the row's overflow-hidden leave only the mark (the lg p-0! makes it fill).
  '<div data-slot="sidebar-header" data-sidebar="header" class="' + SIDEBAR_HEADER + '">\n' +
  '<ul data-slot="sidebar-menu" data-sidebar="menu" class="' + SIDEBAR_MENU + '">' +
  '<li data-slot="sidebar-menu-item" data-sidebar="menu-item" class="' + SIDEBAR_MENU_ITEM + '">' +
  '<a data-slot="sidebar-menu-button" data-sidebar="menu-button" data-size="lg" class="' + SIDEBAR_MENU_BUTTON_LG + '" href="/admin">' +
  '<div aria-hidden="true" class="flex aspect-square size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground font-mono text-base font-bold">n</div>' +
  '<div class="grid flex-1 text-left text-sm leading-tight"><span class="truncate font-medium">nexus<span class="font-normal text-sidebar-foreground/60">-gateway</span></span></div>' +
  "</a></li></ul>\n</div>\n" +

  // Content: the one "Console" group.
  '<div data-slot="sidebar-content" data-sidebar="content" class="' + SIDEBAR_CONTENT + '">\n' +
  '<div data-slot="sidebar-group" data-sidebar="group" class="' + SIDEBAR_GROUP + '">\n' +
  '<div data-slot="sidebar-group-label" data-sidebar="group-label" class="' + SIDEBAR_GROUP_LABEL + '">Console</div>\n' +
  '<div data-slot="sidebar-group-content" data-sidebar="group-content" class="' + SIDEBAR_GROUP_CONTENT + '">\n' +
  '<ul data-slot="sidebar-menu" data-sidebar="menu" class="' + SIDEBAR_MENU + '">\n' +
  TABS.map(railItem).join("\n") +
  "\n</ul>\n</div>\n</div>\n</div>\n" +

  // Footer: who is signed in, and the way out — an lg account row and a default-size
  // Sign out row. In the icon rail the tile's size-8! and the default row's p-2! leave only
  // the tile / the centred glyph: the text clips (truncate gives the span a zero minimum).
  '<div data-slot="sidebar-footer" data-sidebar="footer" class="' + SIDEBAR_FOOTER + '">\n' +
  '<ul data-slot="sidebar-menu" data-sidebar="menu" class="' + SIDEBAR_MENU + '">\n' +
  '<li data-slot="sidebar-menu-item" data-sidebar="menu-item" class="' + SIDEBAR_MENU_ITEM + '">' +
  '<div data-slot="sidebar-menu-button" data-sidebar="menu-button" data-size="lg" title="Signed in operator" class="' + SIDEBAR_MENU_BUTTON_LG + '">' +
  '<div class="flex aspect-square size-8 items-center justify-center rounded-lg bg-muted text-sm font-medium">n</div>' +
  '<div class="grid flex-1 text-left text-sm leading-tight"><span class="truncate font-mono" id="who">&nbsp;</span></div></div></li>\n' +
  '<li data-slot="sidebar-menu-item" data-sidebar="menu-item" class="' + SIDEBAR_MENU_ITEM + '">' +
  '<button type="button" id="outBtn" data-slot="sidebar-menu-button" data-sidebar="menu-button" data-size="default" title="Sign out" class="' + SIDEBAR_MENU_BUTTON + '">' +
  I.logOut + '<span class="truncate">Sign out</span></button></li>\n' +
  "</ul>\n</div>\n" +

  "</div>\n</div>\n</div>";

/** The inset header: trigger, separator, breadcrumb, theme toggle. The account controls
 *  live in the sidebar footer (single ids, who/outBtn, one writer each). */
const INSET_HEADER =
  // px-4 rides the header itself so the ml-auto spacer can reach the right edge; an
  // inner wrapper would size to its content and strand the theme toggle beside the crumb.
  '<header class="flex h-16 shrink-0 items-center gap-2 px-4 transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-12">\n' +
  '<button type="button" id="sidebar-toggle" data-slot="button" data-sidebar="trigger" aria-expanded="true" ' +
  'aria-label="Collapse navigation" title="Collapse navigation" class="' + SIDEBAR_TRIGGER + ' -ml-1">' +
  I.panelLeft + '<span class="sr-only">Toggle Sidebar</span></button>\n' +
  '<div data-slot="separator" data-orientation="vertical" role="none" class="shrink-0 bg-border data-[orientation=horizontal]:h-px data-[orientation=horizontal]:w-full data-[orientation=vertical]:h-4 data-[orientation=vertical]:w-px mr-2"></div>\n' +
  '<nav aria-label="Location" data-slot="breadcrumb">\n' +
  '<ol data-slot="breadcrumb-list" class="' + BREADCRUMB_LIST + '">\n' +
  '<li data-slot="breadcrumb-item" class="' + BREADCRUMB_ITEM + '">' +
  '<span data-slot="breadcrumb-link" class="' + BREADCRUMB_LINK + '">Console</span></li>\n' +
  '<li data-slot="breadcrumb-separator" role="presentation" aria-hidden="true" class="' + BREADCRUMB_SEPARATOR + '">' +
  I.chevronRight + "</li>\n" +
  '<li data-slot="breadcrumb-item" class="' + BREADCRUMB_ITEM + '">' +
  '<span data-slot="breadcrumb-page" role="link" aria-disabled="true" aria-current="page" class="' + BREADCRUMB_PAGE +
  '" id="crumb-here">API keys</span></li>\n' +
  "</ol>\n</nav>\n" +
  '<span class="ml-auto"></span>\n' +
  '<button type="button" id="theme-toggle" data-slot="button" data-variant="ghost" data-size="icon-sm" ' +
  'aria-label="Switch colour theme" title="Switch colour theme" class="size-7 inline-flex shrink-0 items-center justify-center gap-2 rounded-md text-sm font-medium whitespace-nowrap transition-all outline-none hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50 focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*=\'size-\'])]:size-4">' +
  '<span class="ic-sun inline-flex">' + I.sun + '</span><span class="ic-moon inline-flex">' + I.moon + "</span></button>\n" +
  "</header>";

export const SHELL_TOP =
  '<div data-slot="sidebar-wrapper" class="group/sidebar-wrapper flex min-h-svh w-full has-data-[variant=inset]:bg-sidebar">\n' +
  radios() + "\n" +
  SIDEBAR_MARKUP + "\n" +
  '<main data-slot="sidebar-inset" class="' + SIDEBAR_INSET + '">\n' +
  INSET_HEADER + "\n" +
  // Content wrapper: the tab panels sit inside it, still descendants of the inset, which
  // is all the generated reveal rules need.
  '<div class="flex flex-1 flex-col gap-4 p-4 pt-0">\n';

export const SHELL_BOTTOM =
  "</div>\n" +
  "</main>\n" +
  '<nav class="bottom-nav fixed inset-x-0 bottom-0 z-40 flex border-t bg-card md:hidden" aria-label="Console sections">\n' +
  TABS.map(bottomItem).join("\n") +
  "\n</nav>\n</div>\n" +
  '<div id="toasts" aria-live="polite" class="fixed bottom-4 right-4 z-50 flex w-72 flex-col gap-2"></div>\n' +
  '<div id="modalMount"></div>';
