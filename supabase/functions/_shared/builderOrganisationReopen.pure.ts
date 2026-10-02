/**
 * Where a closed organisation goes back to when an operator reopens it.
 *
 * Reopening never makes an organisation MORE than it was:
 *
 *  * One that had been approved (`activated_at` is set) comes back
 *    `suspended`, or `active` only when the operator asks for its access
 *    back in the same act — restoring members' access is a decision, not a
 *    side effect of undoing a closure.
 *  * One that was never approved goes back to the pending state it held
 *    when it was closed. The two pending states are not interchangeable:
 *    `pending_verification` is a self-registered organisation awaiting
 *    vetting and `pending_activation` an operator-created one awaiting
 *    activation, and the registration migration (20260914200000) gives them
 *    different owners and different remedies. Reading `activated_at` alone
 *    merged them, so a registration closed while it was being vetted came
 *    back into the operator-created queue.
 *
 * What it held is `builder_organisations.status_before_closure`, which the
 * close writes in the same update that sets `closed` (migration
 * 20261001160000). It is not read from the activity log: no edge function
 * reads that log (`builderInviteOracle.spec.ts`). A closure made before the
 * column existed says nothing, and resolves to `pending_activation`. Both
 * pending states are approved by the same act and its gates, so the fallback
 * can misfile an organisation but never admit one.
 */

export type ReopenTarget = 'active' | 'suspended' | 'pending_activation' | 'pending_verification';

export function reopenTarget(input: {
  activatedAt: string | null | undefined;
  /** `builder_organisations.status_before_closure`, unvalidated. */
  statusBeforeClosure: unknown;
  reinstate: boolean;
}): ReopenTarget {
  if (input.activatedAt) return input.reinstate ? 'active' : 'suspended';
  return input.statusBeforeClosure === 'pending_verification'
    ? 'pending_verification'
    : 'pending_activation';
}
