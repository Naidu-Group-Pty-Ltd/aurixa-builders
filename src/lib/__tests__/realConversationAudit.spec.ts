import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error — a plain .mjs module shared with the ops scripts
import { MARKER_RE, conversationRowsSql, proofDataFindings } from '../../../scripts/ops/realConversationAudit.pure.mjs';

/**
 * WHAT THE CLEANUP AUDIT ASKS OF A REAL CONVERSATION
 * (scripts/ops/realConversationAudit.pure.mjs, used by step6-proof-audit.mjs).
 *
 * It used to require that real conversation 0c07fd71 held exactly three
 * messages and 45e16763 none. Real people kept talking, and the audit called
 * their messages residue. What it must ask instead is whether a real
 * conversation holds anything a proof wrote: a message or a participant that
 * carries a proof marker, that a proof identity wrote or is, or whose author
 * no longer exists on the side that records who wrote it. However many genuine
 * messages there are.
 */

type Row = {
  db: 'cc' | 'net'; kind: 'message' | 'participant'; ref: string; conversation: string; side: string;
  marker: boolean; local: 'none' | 'present' | 'missing'; local_marker: boolean;
};

// A genuine conversation as both sides record it. Each side knows who wrote
// its own side's messages; the other side's copy carries a display name only.
const genuineMessage = (n: number, over: Partial<Row> = {}): Row[] => [
  { db: 'cc', kind: 'message', ref: `c${n}000000`.slice(0, 8), conversation: '0c07fd71', side: 'command_centre',
    marker: false, local: 'present', local_marker: false, ...over },
  { db: 'net', kind: 'message', ref: `c${n}000000`.slice(0, 8), conversation: '0c07fd71', side: 'command_centre',
    marker: false, local: 'none', local_marker: false, ...over },
];
const genuinePeople: Row[] = [
  { db: 'cc', kind: 'participant', ref: 'aaaa0001', conversation: '0c07fd71', side: 'command_centre', marker: false, local: 'present', local_marker: false },
  { db: 'cc', kind: 'participant', ref: 'bbbb0002', conversation: '0c07fd71', side: 'builder', marker: false, local: 'none', local_marker: false },
  { db: 'net', kind: 'participant', ref: 'aaaa0001', conversation: '0c07fd71', side: 'command_centre', marker: false, local: 'none', local_marker: false },
  { db: 'net', kind: 'participant', ref: 'bbbb0002', conversation: '0c07fd71', side: 'builder', marker: false, local: 'present', local_marker: false },
];
const conversationOf = (messages: number) => [
  ...genuinePeople,
  ...Array.from({ length: messages }, (_, i) => genuineMessage(i + 1)).flat(),
];

describe('proof data in a real conversation', () => {
  it('is none in a genuine conversation, however many messages it holds', () => {
    for (const messages of [0, 3, 7, 40]) expect(proofDataFindings(conversationOf(messages))).toEqual([]);
  });

  it('includes a message that carries a proof marker', () => {
    const findings = proofDataFindings([...conversationOf(7), ...genuineMessage(9, { marker: true })]);
    expect(findings.map((f: { ref: string }) => f.ref)).toEqual(['c9000000', 'c9000000']);
    expect(findings[0].reasons.join(' ')).toMatch(/marker/);
  });

  it('includes a message a proof identity wrote, even when the message itself carries no marker', () => {
    const findings = proofDataFindings([
      ...conversationOf(7),
      { db: 'cc', kind: 'message', ref: 'dead0001', conversation: '0c07fd71', side: 'command_centre',
        marker: false, local: 'present', local_marker: true },
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ db: 'cc', kind: 'message', ref: 'dead0001', conversation: '0c07fd71' });
    expect(findings[0].reasons.join(' ')).toMatch(/proof identity/);
  });

  it('includes a message whose author no longer exists on the side that records it — what a proof leaves once its user is removed', () => {
    // The Command Centre keeps a dangling id; the network sets it to NULL.
    const findings = proofDataFindings([
      ...conversationOf(3),
      { db: 'cc', kind: 'message', ref: 'dead0002', conversation: '0c07fd71', side: 'command_centre',
        marker: false, local: 'missing', local_marker: false },
      { db: 'net', kind: 'message', ref: 'dead0003', conversation: '0c07fd71', side: 'builder',
        marker: false, local: 'none', local_marker: false },
    ]);
    expect(findings.map((f: { ref: string }) => f.ref)).toEqual(['dead0002', 'dead0003']);
    for (const f of findings) expect(f.reasons.join(' ')).toMatch(/no longer exists/);
  });

  it('never counts the other side\'s copy as residue for having no author of its own', () => {
    const otherSide = conversationOf(7).filter((r) => r.local === 'none');
    expect(otherSide.length).toBeGreaterThan(0);
    expect(proofDataFindings(otherSide)).toEqual([]);
  });

  it('includes a participant who is a proof identity, or who no longer exists', () => {
    const findings = proofDataFindings([
      ...conversationOf(0),
      { db: 'net', kind: 'participant', ref: 'dead0004', conversation: '45e16763', side: 'builder',
        marker: false, local: 'present', local_marker: true },
      { db: 'cc', kind: 'participant', ref: 'dead0005', conversation: '45e16763', side: 'command_centre',
        marker: false, local: 'missing', local_marker: false },
    ]);
    expect(findings.map((f: { ref: string }) => f.ref)).toEqual(['dead0004', 'dead0005']);
  });

  it('names a finding by ids and reasons only, never by a body or a name', () => {
    const [finding] = proofDataFindings(genuineMessage(9, { marker: true }).slice(0, 1));
    expect(Object.keys(finding).sort()).toEqual(['conversation', 'db', 'kind', 'reasons', 'ref', 'side']);
  });
});

describe('the markers the proofs write', () => {
  const marker = new RegExp(MARKER_RE);

  it('recognise every identity and message a proof writes', () => {
    for (const written of [
      'smoke-rollout-message-speed-builder-mf3k2a@example.com', // a proof builder's email
      'smoke-rollout-message-speed-owner-mf3k2a', // a proof staff member's username
      'Smoke Rollout message-speed mf3k2a', // a proof organisation
      'smoke-rollout message-speed mf3k2a popup', // a proof message
      'A signed proof message', 'Private Chat Proof', 'Messaging Proof Street', 'proof_no_access',
    ]) expect(marker.test(written), written).toBe(true);
  });

  it('never match what a customer writes', () => {
    for (const genuine of [
      'Could you send proof of identity?', 'Proof of funds attached', 'Proofing the brochure today',
      'The smoke alarm rollout is next week', 'Lot 12 is still available',
    ]) expect(marker.test(genuine), genuine).toBe(false);
  });
});

describe('the statement that reads a conversation', () => {
  it('is one read-only SELECT per side over its messages and participants, joined to that side\'s own users', () => {
    const cc = conversationRowsSql('cc', ['0c07fd71']);
    const net = conversationRowsSql('net', ['0c07fd71']);
    for (const sql of [cc, net]) {
      expect(sql.trim()).toMatch(/^select\b/i);
      expect(sql).not.toContain(';');
    }
    expect(cc).toMatch(/builder_network_messages/);
    expect(cc).toMatch(/builder_network_conversation_participants/);
    expect(cc).toMatch(/custom_users/);
    expect(net).toMatch(/builder_agency_messages/);
    expect(net).toMatch(/builder_agency_conversation_participants/);
    expect(net).toMatch(/builder_portal_users/);
  });

  it('reads the conversations it is given and no other, by id prefix or whole id', () => {
    const sql = conversationRowsSql('cc', ['0c07fd71', '45e16763-1111-4111-8111-111111111111']);
    expect(sql).toContain("LIKE '0c07fd71%'");
    expect(sql).toContain("LIKE '45e16763-1111-4111-8111-111111111111%'");
    expect(sql.match(/ LIKE '/g)).toHaveLength(4); // messages and participants, two conversations each
  });

  it('refuses anything that is not a conversation id, and refuses to read nothing', () => {
    expect(() => conversationRowsSql('cc', ["0c07fd71' OR true --"])).toThrow();
    expect(() => conversationRowsSql('cc', ['0c07fd7'])).toThrow();
    expect(() => conversationRowsSql('cc', [])).toThrow();
    expect(() => conversationRowsSql('elsewhere', ['0c07fd71'])).toThrow();
  });
});

describe('the cleanup audit', () => {
  const audit = readFileSync(join(__dirname, '..', '..', '..', 'scripts', 'ops', 'step6-proof-audit.mjs'), 'utf8');

  it('no longer pins how many messages a real conversation holds', () => {
    expect(audit).not.toMatch(/\.messages\s*===\s*\d/);
  });

  it('asks instead whether a real conversation holds proof data, on both sides', () => {
    expect(audit).toMatch(/conversationRowsSql\('cc', REAL_CONVERSATIONS\)/);
    expect(audit).toMatch(/conversationRowsSql\('net', REAL_CONVERSATIONS\)/);
    expect(audit).toMatch(/proofDataFindings\(/);
  });

  it('keeps one list of proof markers, shared with the check', () => {
    expect(audit).not.toMatch(/const MARKER_RE\s*=/);
  });
});
