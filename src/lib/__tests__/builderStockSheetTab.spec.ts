/**
 * WHICH TAB OF A GOOGLE SHEET AN IMPORT READS, PINNED.
 *
 * THE DEFECT THESE PIN. Measured 18 September 2026 on the reported document
 * `1bPh8W2Bujp…`: `gviz/tq` with NO gid and `gviz/tq` for the impossible gid
 * 4294967290 returned byte-identical payloads — a HIDDEN "VERV AGENT PORTAL"
 * brochure page of eight placeholder rows — while the tab a person opening
 * that link sees, "STOCKLIST V002" (gid 0), holds all 47 properties. The
 * substitution guard existed and was skipped for exactly this case, on the
 * premise that a gid-less link "asked for no particular tab". A builder
 * pasted the address Google's own Share button gave them and the import
 * replaced their stock list with a page they cannot open.
 *
 * The rules below are what stop that recurring. They are about the DECISION —
 * which tab, proven how — not about any one document.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  googleSheetsReadAttempts,
  googleSheetsRef,
  resolveSheetsPayload,
  resolveSheetsTab,
  SENTINEL_GID,
  sentinelReadUrl,
  tabPlanNeedsProbe,
  type SheetsTab,
} from '../../../supabase/functions/_shared/builderStock/googleSheetsSource.pure';
import {
  htmlViewDocumentUrl,
  htmlViewSheetUrl,
  parseHtmlViewTabs,
} from '../../../supabase/functions/_shared/builderStock/googleSheetsHtmlGrid.pure';

const ROOT = join(__dirname, '..', '..', '..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');
const SHARED = 'supabase/functions/_shared/builderStock';

const DOC = '1bPh8W2Bujp8DHpNknSv6h0LkiVnsxrIqN66PpvWfI4c';

/**
 * The page switcher exactly as Google renders it, trimmed to the two calls
 * that matter. Escapes (`\/`, `\x3d`) are the real ones: this is JavaScript
 * string escaping inside an inline script, not HTML escaping, and a parser
 * that assumed the latter read nothing.
 */
const REAL_SWITCHER = `
  var gidMatch = /gid=(-?[0-9]+)/.exec(window.location.hash); var gid = gidMatch ? gidMatch[1] : null;
  var items = [];
  items.push({name: "STOCKLIST V002", pageUrl: "https:\\/\\/docs.google.com\\/spreadsheets\\/d\\/${DOC}\\/htmlview\\/sheet?headers\\x3dtrue&gid=0", gid: "0",initialSheet: ("0" == gid)});
  items.push({name: "Havenwood MERNDA", pageUrl: "https:\\/\\/docs.google.com\\/spreadsheets\\/d\\/${DOC}\\/htmlview\\/sheet?headers\\x3dtrue&gid=1140012797", gid: "1140012797",initialSheet: ("1140012797" == gid)});
`;

const SHARE_LINK = `https://docs.google.com/spreadsheets/d/${DOC}/edit?usp=sharing`;
const ADDRESS_BAR_LINK = `https://docs.google.com/spreadsheets/d/${DOC}/edit?gid=0#gid=0`;

const tabsOf = (html: string): SheetsTab[] => parseHtmlViewTabs(html);
const planFor = (url: string, tabs: SheetsTab[]) =>
  resolveSheetsTab({ ref: googleSheetsRef(url)!, tabs });

describe('the document says which tabs it has', () => {
  it('reads the visible tabs, in the order a person sees them', () => {
    expect(tabsOf(REAL_SWITCHER)).toEqual([
      { gid: '0', name: 'STOCKLIST V002' },
      { gid: '1140012797', name: 'Havenwood MERNDA' },
    ]);
  });

  it('an unreadable switcher is an ABSENCE, never a throw', () => {
    // The caller falls back from an empty list; a throw would refuse
    // documents whose data reads perfectly well.
    for (const payload of ['', '<html>no switcher here</html>', '{"items":[]}']) {
      expect(parseHtmlViewTabs(payload)).toEqual([]);
    }
  });

  it('the tab list is on the document page, not on a single grid', () => {
    // `/htmlview/sheet?gid=N` renders one grid and carries no switcher, which
    // is why the two URLs are different functions.
    expect(htmlViewDocumentUrl(DOC)).toBe(
      `https://docs.google.com/spreadsheets/d/${DOC}/htmlview`);
    expect(htmlViewSheetUrl(DOC, '0')).toContain('/htmlview/sheet?gid=0');
  });
});

describe('a link that names no tab', () => {
  it('resolves to the FIRST VISIBLE tab — not to whatever gviz defaults to', () => {
    const plan = planFor(SHARE_LINK, tabsOf(REAL_SWITCHER));
    expect(plan.gid).toBe('0');
    expect(plan.authority).toBe('first_visible');
  });

  it('names gid 0 when the switcher cannot be read, and then owes a probe', () => {
    const plan = planFor(SHARE_LINK, []);
    expect(plan.gid).toBe('0');
    expect(plan.authority).toBe('assumed_first');
    expect(tabPlanNeedsProbe(plan)).toBe(true);
  });
});

describe('every read names a tab', () => {
  /*
   * THE RULE THAT MAKES THE PROBE MEANINGFUL AT ALL. A gid-less request is
   * indistinguishable from a request for a gid that does not exist — Google
   * answers both with the document's first SHEET, hidden sheets included — so
   * a reader that omits the gid has no question the sentinel can answer.
   */
  it('no attempt is ever built without a gid, whatever the link said', () => {
    for (const tabs of [tabsOf(REAL_SWITCHER), []]) {
      for (const url of [SHARE_LINK, ADDRESS_BAR_LINK]) {
        for (const attempt of googleSheetsReadAttempts(planFor(url, tabs))) {
          expect(attempt.url).toMatch(/[?&]gid=\d+(&|$)/);
        }
      }
    }
  });

  it('the hyperlink read names the SAME tab as the data read', () => {
    // These were two different answers: this module dropped the gid while
    // `htmlViewSheetUrl` defaulted it to 0, so the links of one tab were
    // matched against the rows of another and lent nothing.
    const plan = planFor(SHARE_LINK, tabsOf(REAL_SWITCHER));
    const gviz = googleSheetsReadAttempts(plan)
      .find((attempt) => attempt.endpoint === 'gviz_csv')!;
    expect(gviz.url).toContain(`gid=${plan.gid}`);
    expect(htmlViewSheetUrl(plan.spreadsheetId, plan.gid)).toContain(`gid=${plan.gid}`);
  });

  it('the sentinel asks the same endpoint for a tab that cannot exist', () => {
    const plan = planFor(SHARE_LINK, []);
    for (const attempt of googleSheetsReadAttempts(plan)) {
      expect(sentinelReadUrl(plan, attempt)).toContain(`gid=${SENTINEL_GID}`);
    }
  });
});

describe('what the probe is still for', () => {
  const STOCKLIST = '"","[VG] MASTER STOCKLIST Contract Type","Lot #"\n"","2-Part","310"';
  const SUBSTITUTE = '"","VERV AGENT PORTAL","",""\n"","MARKETING BROCHURES","",""';
  const gvizFor = (url: string, tabs: SheetsTab[]) => {
    const plan = planFor(url, tabs);
    return {
      plan,
      attempt: googleSheetsReadAttempts(plan)
        .find((entry) => entry.endpoint === 'gviz_csv')!,
    };
  };

  it('refuses a substituted payload where the tab was only assumed', () => {
    const { plan, attempt } = gvizFor(SHARE_LINK, []);
    expect(tabPlanNeedsProbe(plan)).toBe(true);
    const resolved = resolveSheetsPayload({
      plan, attempt, body: SUBSTITUTE, sentinelBody: SUBSTITUTE,
    });
    expect(resolved.ok).toBe(false);
    expect(resolved.ok === false && resolved.reason).toBe('gid_unresolved');
  });

  it('accepts a real tab that differs from the substitute', () => {
    const { plan, attempt } = gvizFor(SHARE_LINK, []);
    const resolved = resolveSheetsPayload({
      plan, attempt, body: STOCKLIST, sentinelBody: SUBSTITUTE,
    });
    expect(resolved.ok).toBe(true);
    expect(resolved.ok === true && resolved.csv).toBe(STOCKLIST);
  });

  /*
   * A SINGLE-TAB DOCUMENT IS NOT A SUBSTITUTION. Google serves the only sheet
   * for an impossible gid too, so the two bodies match for a reason that is
   * not a fault. The tab list settles it, and insisting on the probe anyway
   * would refuse every one-tab stock list in the fleet.
   */
  it('never refuses a one-tab document the switcher has already settled', () => {
    const oneTab: SheetsTab[] = [{ gid: '0', name: 'Stock' }];
    for (const url of [SHARE_LINK, ADDRESS_BAR_LINK]) {
      const { plan, attempt } = gvizFor(url, oneTab);
      expect(tabPlanNeedsProbe(plan)).toBe(false);
      const resolved = resolveSheetsPayload({
        plan, attempt, body: STOCKLIST, sentinelBody: STOCKLIST,
      });
      expect(resolved.ok).toBe(true);
    }
  });

  /*
   * A gid the switcher does not list is NOT refused outright: the switcher
   * lists only VISIBLE tabs, and a builder may hold a link to one that is
   * hidden today. It falls to the probe, which can still resolve it.
   */
  it('lets an unlisted gid be decided by the probe rather than refused', () => {
    const plan = planFor(
      `https://docs.google.com/spreadsheets/d/${DOC}/edit#gid=99`,
      tabsOf(REAL_SWITCHER));
    expect(plan.gid).toBe('99');
    expect(plan.authority).toBe('named_unlisted');
    expect(tabPlanNeedsProbe(plan)).toBe(true);
  });

  it('an empty payload is empty, whatever the tab was', () => {
    const { plan, attempt } = gvizFor(ADDRESS_BAR_LINK, tabsOf(REAL_SWITCHER));
    const resolved = resolveSheetsPayload({
      plan, attempt, body: '   \n  ', sentinelBody: null,
    });
    expect(resolved.ok === false && resolved.reason).toBe('empty');
  });
});

describe('the fetcher keeps the rule', () => {
  const source = () => read(`${SHARED}/fetchSource.ts`);

  it('resolves the tab before it reads anything, and reads the switcher to do it', () => {
    const code = source();
    expect(code).toContain('resolveSheetsTab({ ref, tabs: await fetchSheetTabs(ref) })');
    expect(code).toContain('htmlViewDocumentUrl(');
  });

  it('builds every spreadsheet URL from the plan, never from the raw link', () => {
    const code = source();
    // The hyperlink half used to read `ref.gid`, which was null for a
    // gid-less link — the two halves of one reader disagreeing.
    expect(code).toContain('htmlViewSheetUrl(plan.spreadsheetId, plan.gid)');
    expect(code).not.toContain('htmlViewSheetUrl(ref.spreadsheetId, ref.gid)');
    expect(code).toContain('googleSheetsReadAttempts(plan)');
    expect(code).toContain('sentinelReadUrl(plan, attempt)');
  });

  it('probes on the plan, never on whether the LINK carried a gid', () => {
    const code = source();
    expect(code).toContain('tabPlanNeedsProbe(plan)');
    // The test that let the substituted read through.
    expect(code).not.toContain("ref.gid !== null");
  });
});
