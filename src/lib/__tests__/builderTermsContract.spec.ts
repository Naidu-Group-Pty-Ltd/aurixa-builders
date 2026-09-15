/**
 * The terms contract after restoration (remediation of the extraction's
 * terms regressions), pinned at the source.
 *
 * What broke and must never re-break: the runtime named the clone's
 * `portal_terms_*` tables after the squash renamed them; a failed
 * governance read was reported as `success: true, terms: null`; the
 * acceptance RPC was called with an `_acknowledgements` argument the
 * database function did not take; and no agreement was seeded at all.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  REQUIRED_TERMS_ACKNOWLEDGEMENTS,
  PORTAL_TERMS_ACKNOWLEDGEMENTS as SERVER_PORTAL_ACKNOWLEDGEMENTS,
} from '../../../supabase/functions/_shared/portalAgreement';
import { PORTAL_TERMS_ACKNOWLEDGEMENTS as CLIENT_PORTAL_ACKNOWLEDGEMENTS } from '../portalAgreement';

const REPO_ROOT = join(__dirname, '..', '..', '..');
const read = (p: string) => readFileSync(join(REPO_ROOT, p), 'utf8');
/** Source with comments removed, so prose cannot satisfy — or break — a rule. */
const readCode = (p: string) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

const TERMS_MIGRATION = 'supabase/migrations/20260915100000_terms_contract_restoration.sql';

describe('the governance reads name the network tables and surface failure', () => {
  it('session resolution reads builder_terms_* and throws on a failed read', () => {
    const gate = readCode('supabase/functions/_shared/builderPortalAuth.ts');
    expect(gate).toContain("from('builder_terms_versions')");
    expect(gate).toContain("from('builder_terms_acceptances')");
    // The error is bound and thrown, never destructured away.
    expect(gate).toContain('termsError');
    expect(gate).toMatch(/current terms lookup failed/);
    expect(gate).toMatch(/terms acceptance lookup failed/);
  });

  it('get_governance never answers success over a failed read', () => {
    const verify = readCode('supabase/functions/builder-portal-verify/index.ts');
    expect(verify).toContain("from('builder_terms_versions')");
    // The failure branch exists and answers 503 with success: false.
    expect(verify).toMatch(/Governance state could not be read/);
    expect(verify).toMatch(/success:\s*false[\s\S]{0,120}503/);
  });
});

describe('the acceptance contract', () => {
  it('the runtime sends the acknowledgments to the RPC', () => {
    const verify = readCode('supabase/functions/builder-portal-verify/index.ts');
    const call = verify.slice(verify.indexOf("rpc('builder_accept_current_terms'"));
    expect(call).toContain('_acknowledgements: acknowledgements');
  });

  it('the migration ports the five-argument function over the renamed tables', () => {
    const migration = read(TERMS_MIGRATION);
    expect(migration).toMatch(/DROP FUNCTION IF EXISTS public\.builder_accept_current_terms\(uuid, uuid, text, text\)/);
    expect(migration).toMatch(/_acknowledgements jsonb DEFAULT NULL/);
    expect(migration).toMatch(/INSERT INTO public\.builder_terms_acceptances\(\s*terms_version_id, portal, builder_user_id, acknowledgements/);
    expect(migration).not.toMatch(/\bportal_terms_versions\b/);
    expect(migration).not.toMatch(/\bportal_terms_acceptances\b/);
  });

  it('the acceptance table gains the acknowledgment history column', () => {
    expect(read(TERMS_MIGRATION)).toMatch(
      /ALTER TABLE public\.builder_terms_acceptances\s+ADD COLUMN IF NOT EXISTS acknowledgements jsonb/,
    );
  });
});

describe('the agreement itself', () => {
  const migration = read(TERMS_MIGRATION);

  it('seeds the 2026-08-07 agreement with the pinned document hash', () => {
    expect(migration).toContain("'2026-08-07'");
    expect(migration).toContain(
      'Portal Access, Confidentiality, Privacy and AML/CTF Compliance Passport Agreement');
    // The sha256 of the prime cascade's $md$ literal — a retyped word cannot
    // ship as the same version.
    expect(migration).toContain('f5612fc2daef61ef645b43465005f411cd85979c8687cfb023f358c615e00af5');
  });

  it('carries every mandatory acknowledgment and not the withdrawn fifth', () => {
    // The DOCUMENT, not the migration file — the file legitimately quotes
    // the withdrawn heading inside its own refusal assertion.
    const document = migration.match(/\$md\$([\s\S]*?)\$md\$/)?.[1] ?? '';
    expect(document.length).toBeGreaterThan(10_000);
    for (const heading of [
      'Global confidentiality and privacy',
      'Authority and binding acceptance',
      'Portal access',
      'Binding AML/CTF arrangement',
    ]) {
      expect(document).toContain(heading);
    }
    expect(document).not.toContain('Independent AML/CTF responsibility');
  });

  it('derives document_hash by trigger, never from the caller', () => {
    expect(migration).toMatch(/set_builder_terms_document_hash/);
    expect(migration).toMatch(/BEFORE INSERT OR UPDATE ON public\.builder_terms_versions/);
  });
});

describe('one agreement, one acknowledgment list, both sides', () => {
  it('the four required keys are the four the pages render, in order', () => {
    expect(SERVER_PORTAL_ACKNOWLEDGEMENTS.map((a) => a.key))
      .toEqual([...REQUIRED_TERMS_ACKNOWLEDGEMENTS]);
    expect(CLIENT_PORTAL_ACKNOWLEDGEMENTS.map((a) => a.key))
      .toEqual([...REQUIRED_TERMS_ACKNOWLEDGEMENTS]);
  });

  it('the seeded document asks exactly the statements the pages assert', () => {
    const migration = read(TERMS_MIGRATION);
    for (const acknowledgement of SERVER_PORTAL_ACKNOWLEDGEMENTS) {
      expect(migration).toContain(acknowledgement.statement);
    }
  });
});
