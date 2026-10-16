/** Static shadcn/ui-style class vocabulary — the cva strings a React consumer gets from
 *  `buttonVariants({variant})`, hand-applied because this console is server-rendered
 *  HTML, not React.
 *
 *  Rules:
 *  - The strings follow the shadcn/ui component sources; do not retype them from memory
 *    or "improve" them — re-diff against upstream shadcn/ui when you change one.
 *  - Every element also carries the data-slot / data-variant / data-size attributes
 *    the React components emit — theme.css keys on some of them (focus rings,
 *    [data-sidebar="menu-button"][data-active]).
 *  - ONE CTA per view
 *    ("Generate" on keys): class `bg-cta text-cta-foreground hover:bg-cta/90` — the
 *    amber is load-bearing scarcity: keep to one CTA per view.
 *  - NO backticks and no ${} may survive into any string that lands inside the page's
 *    template literals — test/page_render pins it. */

// ── Button ────────────────────────────────────────
export const BTN =
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-md text-sm font-medium whitespace-nowrap transition-all outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4";

export const BTN_VARIANTS: Record<string, string> = {
  default: "bg-primary text-primary-foreground hover:bg-primary/90",
  destructive:
    "bg-destructive text-white hover:bg-destructive/90 focus-visible:ring-destructive/20 dark:bg-destructive/60 dark:focus-visible:ring-destructive/40",
  outline:
    "border bg-background shadow-xs hover:bg-accent hover:text-accent-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50",
  secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
  ghost: "hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50",
  link: "text-primary underline-offset-4 hover:underline",
  // The theme's reserved amber — the ONE loud action per view.
  cta: "bg-cta text-cta-foreground hover:bg-cta/90",
};

export const BTN_SIZES: Record<string, string> = {
  default: "h-9 px-4 py-2 has-[>svg]:px-3",
  xs: "h-6 gap-1 rounded-md px-2 text-xs has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3",
  sm: "h-8 gap-1.5 rounded-md px-3 has-[>svg]:px-2.5",
  lg: "h-10 rounded-md px-6 has-[>svg]:px-4",
  icon: "size-9",
  "icon-xs": "size-6 rounded-md [&_svg:not([class*='size-'])]:size-3",
  "icon-sm": "size-8",
  "icon-lg": "size-10",
};

// ── Badge  ──────────────────────────────────────────
export const BADGE =
  "inline-flex w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-full border border-transparent px-2 py-0.5 text-xs font-medium whitespace-nowrap transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&>svg]:pointer-events-none [&>svg]:size-3";

export const BADGE_VARIANTS: Record<string, string> = {
  default: "bg-primary text-primary-foreground [a&]:hover:bg-primary/90",
  secondary: "bg-secondary text-secondary-foreground [a&]:hover:bg-secondary/90",
  destructive:
    "bg-destructive text-white focus-visible:ring-destructive/20 dark:bg-destructive/60 dark:focus-visible:ring-destructive/40 [a&]:hover:bg-destructive/90",
  outline: "border-border text-foreground [a&]:hover:bg-accent [a&]:hover:text-accent-foreground",
};

export interface BadgeTone {
  classes: string;
  variant: string;
}
export interface BadgeToneMap {
  success: BadgeTone;
  danger: BadgeTone;
  warning: BadgeTone;
  secondary: BadgeTone;
  [tone: string]: BadgeTone | undefined;
}

/** The tone map every status word resolves through (client_core's chip() mirrors it):
 *  ok → success pair, danger → destructive, warn → warning, muted → secondary.
 *  theme.css registers --success/--warning, so the utilities exist even though the
 *  stock cva has no such variants — data-variant records the tone for the tests. */
export const BADGE_TONES: BadgeToneMap = {
  success: { classes: "bg-success text-success-foreground", variant: "success" },
  danger: { classes: "bg-destructive text-white", variant: "destructive" },
  warning: { classes: "bg-warning text-warning-foreground", variant: "warning" },
  secondary: { classes: "bg-secondary text-secondary-foreground", variant: "secondary" },
};

// ── Card  ────────────────────────────────────────────
export const CARD = "flex flex-col gap-6 rounded-xl border bg-card py-6 text-card-foreground shadow-sm";
export const CARD_HEADER =
  "@container/card-header grid auto-rows-min grid-rows-[auto_auto] items-start gap-2 px-6 has-data-[slot=card-action]:grid-cols-[1fr_auto] [.border-b]:pb-6";
export const CARD_TITLE = "leading-none font-semibold";
export const CARD_DESCRIPTION = "text-sm text-muted-foreground";
export const CARD_ACTION = "col-start-2 row-span-2 row-start-1 self-start justify-self-end";
export const CARD_CONTENT = "px-6";
export const CARD_FOOTER = "flex items-center px-6 [.border-t]:pt-6";

// ── Input  ──────────────────────────────────────────
export const INPUT =
  "h-9 w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-1 text-base shadow-xs transition-[color,box-shadow] outline-none selection:bg-primary selection:text-primary-foreground file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm dark:bg-input/30 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40";

// ── Label  ──────────────────────────────────────────
export const LABEL =
  "flex items-center gap-2 text-sm leading-none font-medium select-none group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:opacity-50 peer-disabled:cursor-not-allowed peer-disabled:opacity-50";

// ── Native select  ──────────────────────────
export const NATIVE_SELECT_WRAPPER = "group/native-select relative w-fit has-[select:disabled]:opacity-50";
export const NATIVE_SELECT =
  "h-9 w-full min-w-0 appearance-none rounded-md border border-input bg-transparent px-3 py-2 pr-9 text-sm shadow-xs transition-[color,box-shadow] outline-none selection:bg-primary selection:text-primary-foreground placeholder:text-muted-foreground disabled:pointer-events-none disabled:cursor-not-allowed data-[size=sm]:h-8 data-[size=sm]:py-1 dark:bg-input/30 dark:hover:bg-input/50 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40";
export const NATIVE_SELECT_ICON =
  "pointer-events-none absolute top-1/2 right-3.5 size-4 -translate-y-1/2 text-muted-foreground opacity-50 select-none";

// ── Table  ──────────────────────────────────────────
export const TABLE_CONTAINER = "relative w-full overflow-x-auto";
export const TABLE = "w-full caption-bottom text-sm";
export const TABLE_HEADER = "[&_tr]:border-b";
export const TABLE_BODY = "[&_tr:last-child]:border-0";
export const TABLE_ROW =
  "border-b transition-colors hover:bg-muted/50 has-aria-expanded:bg-muted/50 data-[state=selected]:bg-muted";
export const TABLE_HEAD =
  "h-10 px-2 text-left align-middle font-medium whitespace-nowrap text-foreground [&:has([role=checkbox])]:pr-0 [&>[role=checkbox]]:translate-y-[2px]";
export const TABLE_CELL =
  "p-2 align-middle whitespace-nowrap [&:has([role=checkbox])]:pr-0 [&>[role=checkbox]]:translate-y-[2px]";

// ── Empty  ──────────────────────────────────────────
export const EMPTY =
  "flex min-w-0 flex-1 flex-col items-center justify-center gap-6 rounded-lg border-dashed p-6 text-center text-balance md:p-12";
export const EMPTY_TITLE = "text-lg font-medium tracking-tight";
export const EMPTY_DESCRIPTION =
  "text-sm/relaxed text-muted-foreground [&>a]:underline [&>a]:underline-offset-4 [&>a:hover]:text-primary";

// ── Breadcrumb  ────────────────────────────────
export const BREADCRUMB_LIST =
  "flex flex-wrap items-center gap-1.5 text-sm break-words text-muted-foreground sm:gap-2.5";
export const BREADCRUMB_ITEM = "inline-flex items-center gap-1.5";
export const BREADCRUMB_LINK = "transition-colors hover:text-foreground";
export const BREADCRUMB_PAGE = "font-normal text-foreground";
export const BREADCRUMB_SEPARATOR = "[&>svg]:size-3.5";

// ── Sidebar  — the skeleton strings the shell uses.
//    The mobile Sheet/Tooltip React machinery has no server-rendered twin: below md
//    this console shows the bottom nav instead. ────────────────────────────────────
export const SIDEBAR =
  "group peer hidden text-sidebar-foreground md:block";
export const SIDEBAR_GAP =
  "relative w-(--sidebar-width) bg-transparent transition-[width] duration-200 ease-linear group-data-[collapsible=icon]:w-(--sidebar-width-icon)";
export const SIDEBAR_CONTAINER =
  "fixed inset-y-0 z-10 hidden h-svh w-(--sidebar-width) transition-[left,right,width] duration-200 ease-linear md:flex left-0 group-data-[collapsible=icon]:w-(--sidebar-width-icon) group-data-[side=left]:border-r";
export const SIDEBAR_INNER = "flex h-full w-full flex-col bg-sidebar";
export const SIDEBAR_HEADER = "flex flex-col gap-2 p-2";
export const SIDEBAR_FOOTER = "flex flex-col gap-2 p-2";
export const SIDEBAR_CONTENT =
  "flex min-h-0 flex-1 flex-col gap-2 overflow-auto group-data-[collapsible=icon]:overflow-hidden";
export const SIDEBAR_GROUP = "relative flex w-full min-w-0 flex-col p-2";
export const SIDEBAR_GROUP_LABEL =
  "flex h-8 shrink-0 items-center rounded-md px-2 text-xs font-medium text-sidebar-foreground/70 ring-sidebar-ring outline-hidden transition-[margin,opacity] duration-200 ease-linear focus-visible:ring-2 [&>svg]:size-4 [&>svg]:shrink-0 group-data-[collapsible=icon]:-mt-8 group-data-[collapsible=icon]:opacity-0";
export const SIDEBAR_GROUP_CONTENT = "w-full text-sm";
export const SIDEBAR_MENU = "flex w-full min-w-0 flex-col gap-1";
export const SIDEBAR_MENU_ITEM = "group/menu-item relative";
/** The cva BASE of sidebar-menu-button, before the size variant. The two exported
 *  constants below append the stock size suffixes verbatim (preview/src/ui/sidebar.tsx:
 *  size.default = "h-8 text-sm", size.lg = "h-12 text-sm group-data-[collapsible=icon]:p-0!"). */
const SIDEBAR_MENU_BUTTON_BASE =
  "peer/menu-button flex w-full items-center gap-2 overflow-hidden rounded-md p-2 text-left text-sm ring-sidebar-ring outline-hidden transition-[width,height,padding] group-has-data-[sidebar=menu-action]/menu-item:pr-8 group-data-[collapsible=icon]:size-8! group-data-[collapsible=icon]:p-2! hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 active:bg-sidebar-accent active:text-sidebar-accent-foreground disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 data-[active=true]:bg-sidebar-accent data-[active=true]:font-medium data-[active=true]:text-sidebar-accent-foreground data-[state=open]:hover:bg-sidebar-accent data-[state=open]:hover:text-sidebar-accent-foreground [&>span:last-child]:truncate [&>svg]:size-4 [&>svg]:shrink-0";
export const SIDEBAR_MENU_BUTTON = SIDEBAR_MENU_BUTTON_BASE + " h-8 text-sm";
// tw-merge equivalence, by hand: React's cva+tw-merge drops the base's collapsed
// p-2! when size.lg adds p-0!; emitted raw, both compile and Tailwind sorts p-0
// before p-2, so p-2! would win — collapsed, the 32px brand/avatar tiles clip.
export const SIDEBAR_MENU_BUTTON_LG =
  SIDEBAR_MENU_BUTTON_BASE.replace(" group-data-[collapsible=icon]:p-2!", "") +
  " h-12 text-sm group-data-[collapsible=icon]:p-0!";
// The stock SidebarTrigger: ghost icon button, size-7 overriding icon's size-9
// (emitted raw, no tw-merge — the icon size must not ride along).
export const SIDEBAR_TRIGGER = BTN + " " + BTN_VARIANTS.ghost + " size-7";
export const SIDEBAR_INSET =
  "relative flex w-full flex-1 flex-col bg-background md:peer-data-[variant=inset]:m-2 md:peer-data-[variant=inset]:ml-0 md:peer-data-[variant=inset]:rounded-xl md:peer-data-[variant=inset]:shadow-sm md:peer-data-[variant=inset]:peer-data-[state=collapsed]:ml-2";
