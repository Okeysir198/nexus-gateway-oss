/** Brand data-URIs. The favicons are %-encoded SVG so the brand hex rides as
 *  %23… — deliberately in their OWN module, apart from the styled
 *  views: these are the only literal colours in the repo's UI layer, and
 *  they are the brand mark itself (a token role cannot draw a favicon — there
 *  is no CSS context to resolve one in). */

/** Console + sign-in favicon: the brand tile. */
export const FAVICON =
  "data:image/svg+xml," +
  "%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E" +
  "%3Crect width='16' height='16' rx='4' fill='%23171717'/%3E%3C/svg%3E";
