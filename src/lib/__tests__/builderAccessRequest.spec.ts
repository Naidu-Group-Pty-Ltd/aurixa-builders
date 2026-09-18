/**
 * The unattended access-request pipeline: apply → organisation → invitation.
 *
 * This is the only operation on `builder-network-admin` that runs with nobody
 * watching and no operator decision in it, so the properties that make it safe
 * cannot be things somebody remembers — they have to be checkable, and these
 * are what a reviewer would otherwise have to re-derive from four hundred
 * lines of handler.
 *
 * Every assertion below pins a property that, if it broke, would break
 * SILENTLY: the pipeline would keep answering `success: true` while doing
 * something it must not.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  APPLICATION_WINDOW_HOURS,
  organisationFromRequest,
  readAccessRequest,
} from "../../../supabase/functions/_shared/builderAccessRequest.pure.ts";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

/**
 * Source with its comments removed.
 *
 * Every assertion about what the handler DOES is taken against this. A prose
 * comment explaining why there is deliberately no unique index satisfies a
 * naive scan for one, and the header of this very file would satisfy several
 * others — measuring your own documentation is a bug this repository has
 * shipped before.
 */
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*(\/\/|--).*$/gm, "");

const HANDLER = read("supabase/functions/builder-network-admin/index.ts");
const MIGRATION = read("supabase/migrations/20260918100500_builder_access_requests.sql");

/** The operation's own body, so an assertion cannot be satisfied elsewhere. */
const OPERATION = (() => {
  const start = HANDLER.indexOf("if (operation === 'submit_access_request')");
  const end = HANDLER.indexOf("if (operation === 'list_access_requests')");
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return HANDLER.slice(start, end);
})();

/** The operation's executable code alone. */
const CODE = stripComments(OPERATION);
const MIGRATION_CODE = stripComments(MIGRATION);

const application = {
  legal_name: "  Hawthorn Homes Pty Ltd ",
  contact_name: "Jo Rivera",
  contact_email: "Jo@Example.COM",
  org_type: "builder",
};

describe("what an application must say", () => {
  it("requires only a name, a type, a person and an address", () => {
    // Asking a lead for an ACN and a postcode before they are allowed to
    // express interest is how an application form stops being answered. The
    // four that are mandatory are mandatory because the columns are NOT NULL.
    const result = readAccessRequest({ ...application });
    expect(result.ok).toBe(true);
  });

  it("refuses each missing mandatory field by name", () => {
    const cases: Array<[keyof typeof application, string]> = [
      ["legal_name", "a_legal_name_is_required"],
      ["contact_name", "a_contact_name_is_required"],
      ["contact_email", "a_valid_email_is_required"],
      ["org_type", "an_organisation_type_is_required"],
    ];
    for (const [field, error] of cases) {
      const body: Record<string, unknown> = { ...application };
      delete body[field];
      const result = readAccessRequest(body);
      expect(result.ok, field).toBe(false);
      expect(result.ok === false && result.error, field).toBe(error);
    }
  });

  it("normalises the address it will write to, so a reapplication collides", () => {
    // The window is keyed on `contact_email`. If `Jo@Example.COM` and
    // `jo@example.com` were stored as two addresses, the one-a-day rule would
    // be one a day per SPELLING, which is no rule at all.
    const result = readAccessRequest({ ...application });
    expect(result.ok && result.fields.contact_email).toBe("jo@example.com");
  });

  it("trims what it stores, so a padded name is the same name", () => {
    const result = readAccessRequest({ ...application });
    expect(result.ok && result.fields.legal_name).toBe("Hawthorn Homes Pty Ltd");
  });

  it("refuses a shape the column CHECK would refuse, before the column sees it", () => {
    // A value the table rejects comes back as an unattributed 500 that names
    // no field. That is exactly what happened to an operator on 18 Sep 2026,
    // and it is why these are refused here.
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ abn: "123" }, "abn_must_be_11_digits"],
      [{ acn: "12345678901" }, "acn_must_be_9_digits"],
      [{ postcode: "31" }, "postcode_must_be_4_digits"],
      [{ state: "Victoria" }, "state_is_not_an_australian_state"],
      [{ org_type: "architect" }, "org_type_is_not_recognised"],
      [{ contact_email: "jo@" }, "a_valid_email_is_required"],
    ];
    for (const [patch, error] of cases) {
      const result = readAccessRequest({ ...application, ...patch });
      expect(result.ok, JSON.stringify(patch)).toBe(false);
      expect(result.ok === false && result.error, JSON.stringify(patch)).toBe(error);
    }
  });

  it("accepts a registration number written the way people write it", () => {
    // "12 345 678 901" and "12345678901" are the same number. Refusing the
    // spaced form would refuse the way it is printed on every invoice.
    const result = readAccessRequest({ ...application, abn: "12 345 678 901", acn: "123-456-789" });
    expect(result.ok && result.fields.abn).toBe("12345678901");
    expect(result.ok && result.fields.acn).toBe("123456789");
  });

  it("reads an omitted optional field as absent rather than empty", () => {
    const result = readAccessRequest({ ...application, trading_name: "   " });
    expect(result.ok && result.fields.trading_name).toBeNull();
  });
});

describe("what an accepted application creates", () => {
  it("carries no lifecycle field of its own", () => {
    // The organisation is born UNAPPROVED and the caller says so explicitly.
    // A `status` in here would let an application choose its own standing,
    // which is the one thing the automation must not reach.
    const result = readAccessRequest({ ...application });
    expect(result.ok).toBe(true);
    const organisation = result.ok ? organisationFromRequest(result.fields) : {};
    for (const key of ["status", "is_active", "activated_at", "approved_at", "id"]) {
      expect(Object.keys(organisation), key).not.toContain(key);
    }
  });

  it("records that no human typed it", () => {
    const result = readAccessRequest({ ...application });
    const organisation = result.ok ? organisationFromRequest(result.fields) : {};
    expect(String(organisation.notes)).toContain("access request");
    expect(String(organisation.notes)).toContain("Jo Rivera");
  });

  it("is created pending activation and inactive", () => {
    // Stated in the handler rather than in the projection, so this checks
    // the handler.
    expect(OPERATION).toContain("status: 'pending_activation'");
    expect(OPERATION).toContain("is_active: false");
  });

  it("never approves, activates or edits anything", () => {
    // Automation reaches the paperwork, never the vetting — and never an
    // organisation that already exists, or anyone could rewrite a live
    // builder's details by applying in their name.
    for (const forbidden of ["approve_organisation", ".upsert(", "onConflict:"]) {
      expect(CODE, forbidden).not.toContain(forbidden);
    }
    // The only `.update()` calls are on the application row itself and on the
    // owner account this operation just created.
    expect(CODE).not.toMatch(/from\('builder_organisations'\)\s*\n?\s*\.update\(/);
  });
});

describe("what makes an unattended public pipeline safe", () => {
  it("allows one application per address per window", () => {
    // Without this the same mailbox could be applied for repeatedly and each
    // attempt would send it mail — under the network's own verified sending
    // domain. There is no CAPTCHA on this surface, which is why it is not
    // optional.
    expect(APPLICATION_WINDOW_HOURS).toBe(24);
    expect(CODE).toContain("APPLICATION_WINDOW_HOURS");
    expect(CODE).toMatch(/\.eq\('contact_email', fields\.contact_email\)/);
    // The refusal has to be REACHED BY the count, not merely present beside
    // it: a guard rewritten to `if (false)` keeps every literal in place and
    // opens the pipeline to one mailbox being mailed without limit.
    expect(CODE).toMatch(
      /if\s*\(\(?\s*recent[\s\S]{0,40}\)\s*\{[\s\S]{0,240}an_application_for_that_address_is_already_with_us/,
    );
  });

  it("keeps a second attempt rather than erasing it", () => {
    // A repeat application is EVIDENCE — usually that the first invitation
    // never arrived. A unique index would delete exactly the signal an
    // operator needs, so the window is read at submit.
    expect(MIGRATION_CODE).not.toMatch(/unique[^\n]*contact_email/i);
  });

  it("writes only to the address on the application", () => {
    // There is no field for a third party, so this cannot be pointed at
    // somebody else's mailbox. That is what keeps it from being an open relay.
    const sends = [...CODE.matchAll(/^\s*to:\s*([^,\n]+),/gm)].map(([, value]) => value.trim());
    expect(sends.length).toBeGreaterThan(0);
    for (const target of sends) expect(target).toBe("fields.contact_email");
  });

  it("never answers with the invitation link", () => {
    // This answers a public page. The link is the credential; an operator who
    // needs to hand it over re-mints it from the console, which is an
    // authenticated act.
    const answer = CODE.slice(CODE.lastIndexOf("return json({"));
    expect(answer).not.toContain("invite_url");
    expect(answer).not.toContain("minted");
  });

  it("refuses a collision and records it, never merging into what it hit", () => {
    expect(CODE).toContain("readOrganisationConflict");
    expect(OPERATION).toMatch(/settle\('refused'/);
  });

  it("refuses a withdrawn account rather than reviving it", () => {
    // Bootstrapping a new organisation is not a way around a revocation.
    expect(OPERATION).toContain("that_account_has_been_withdrawn");
  });

  it("attaches an established account rather than re-minting its credential", () => {
    // Someone who already has a password keeps it. Minting a fresh invitation
    // for an existing account is a password reset anybody could trigger by
    // typing that person's address into a public form.
    expect(OPERATION).toMatch(/password_hash \|\| [^\n]*invite_accepted_at/);
    expect(OPERATION).toContain("established ? null : await mintBuilderInvite()");
  });

  it("is reachable only behind the same federation check as every other operation", () => {
    // MC signs the assertion server-side; the applicant's browser never
    // speaks to this function. A bypass here would be a public door onto the
    // network's admin API.
    const preamble = HANDLER.slice(0, HANDLER.indexOf("if (operation === "));
    expect(preamble).toMatch(/verif|assert/i);
    expect(CODE).not.toMatch(/\bskip\b|\bbypass\b|anon|service_role/i);
  });
});

describe("an outcome nobody watched is still recorded", () => {
  it("records the application BEFORE it tries to act on it", () => {
    // A failure half way through leaves evidence rather than nothing. An
    // unattended pipeline whose failures are invisible is one nobody can
    // debug from the outside, which is precisely where this started.
    const insertAt = CODE.indexOf("from('builder_access_requests')");
    const orgAt = CODE.indexOf("from('builder_organisations')");
    expect(insertAt).toBeGreaterThan(-1);
    expect(orgAt).toBeGreaterThan(insertAt);
  });

  it("settles every failure path with a reason", () => {
    // The table's own `outcome_reasoned` CHECK refuses a closed application
    // with no detail, so a path that forgot would fail loudly rather than
    // storing a status nobody can explain.
    expect(MIGRATION_CODE).toContain("outcome_reasoned");
    expect(MIGRATION_CODE).toMatch(/status = 'received' or outcome_detail is not null/);
  });

  it("stores whether the invitation actually sent", () => {
    // "We created the organisation but could not write to you" is a state an
    // operator must be able to see, which is why it is stored rather than
    // only returned.
    expect(MIGRATION_CODE).toContain("invite_sent");
    expect(OPERATION).toContain("invite_sent: emailOutcome.sent");
  });

  it("cannot be unwound by the send failing", () => {
    // The send is last and settles rather than throwing. A mail failure that
    // rolled back the organisation would leave the applicant with neither.
    const sendAt = CODE.indexOf("sendBuilderEmail");
    const settleAt = CODE.lastIndexOf("await settle(");
    expect(sendAt).toBeGreaterThan(-1);
    expect(settleAt).toBeGreaterThan(sendAt);
  });

  it("keeps the table private to the service role", () => {
    // Nothing but the admin function may read applications: they carry a
    // person's name, address, phone number and their business's numbers.
    expect(MIGRATION_CODE).toMatch(/enable row level security/i);
    expect(MIGRATION_CODE).not.toMatch(/create policy/i);
  });

  it("carries the row_version the touch trigger writes", () => {
    // `builder_touch_row()` sets `row_version`, so a table on that trigger
    // without the column raises 42703 on every update — which here would mean
    // every settle failing and every outcome lost.
    expect(MIGRATION_CODE).toMatch(/row_version\s+bigint/i);
    expect(MIGRATION).toContain("builder_touch_row");
  });
});
