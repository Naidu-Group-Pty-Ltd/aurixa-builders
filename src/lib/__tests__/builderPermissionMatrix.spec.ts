/**
 * The project permission matrix is the SAME answer, resolved concurrently.
 *
 * Measured on the live portal (portal-access-proof): every project-scoped
 * request took 10-11 s, because the matrix asked the database about 21 keys
 * one after another. The pure resolver keeps every question and every answer
 * and only stops waiting for one key before asking about the next.
 */
import { describe, expect, it } from 'vitest';
import { resolvePermissionMatrix } from '../../../supabase/functions/_shared/builderPermissionMatrix.pure';

const KEYS = ['organisation', 'projects', 'inventory', 'messages', 'tasks', 'audit', 'pricing', 'legal_status'];
const FORBIDDEN = new Set(['legal_status']);
const answer = (key: string, level: string) => (key.length + level.length) % 3 !== 0;

describe('resolvePermissionMatrix', () => {
  it('returns exactly the sequential answer, forbidden keys denied without asking', async () => {
    const asked: string[] = [];
    const matrix = await resolvePermissionMatrix(KEYS, FORBIDDEN, async (key, level) => {
      asked.push(`${key}:${level}`);
      return answer(key, level);
    });
    for (const key of KEYS) {
      if (FORBIDDEN.has(key)) {
        expect(matrix[key]).toEqual({ view: false, edit: false, delete: false });
        continue;
      }
      expect(matrix[key]).toEqual({ view: answer(key, 'view'), edit: answer(key, 'edit'), delete: answer(key, 'delete') });
    }
    expect(asked.some((a) => a.startsWith('legal_status'))).toBe(false);
    expect(asked).toHaveLength((KEYS.length - 1) * 3);
    expect(Object.keys(matrix)).toEqual(KEYS);
  });

  it('asks concurrently, and never more than the cap at once', async () => {
    let inFlight = 0; let peak = 0;
    const started = Date.now();
    await resolvePermissionMatrix(KEYS, FORBIDDEN, async () => {
      inFlight += 1; peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 40));
      inFlight -= 1;
      return true;
    }, { concurrency: 6 });
    expect(peak).toBe(6);
    // 21 questions, 6 at a time, 40 ms each: 4 rounds, not 7 sequential key rounds.
    expect(Date.now() - started).toBeLessThan(7 * 40);
  });

  it('an answer that is not true is a denial, and a thrown question fails the matrix as before', async () => {
    const matrix = await resolvePermissionMatrix(['projects'], new Set(),
      async (_k, level) => (level === 'edit' ? (null as unknown as boolean) : true));
    expect(matrix.projects).toEqual({ view: true, edit: false, delete: true });
    await expect(resolvePermissionMatrix(['projects'], new Set(), async () => { throw new Error('db'); }))
      .rejects.toThrow('db');
  });
});
