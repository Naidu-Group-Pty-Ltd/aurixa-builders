/**
 * WHAT AN INVITEE IS SENT (doc 68).
 *
 * Two invitations, one per kind of account, and both wait for the invitee:
 *
 *  * An account's FIRST invitation sets its password — the wording it always
 *    had.
 *  * An invitation to an account that already signs in asks for consent and
 *    nothing else. It used to be a notice ("you now have access … your
 *    existing sign-in still works") over a membership granted without anyone
 *    agreeing to it. Now nothing changes until the person accepts, the link
 *    sets no password, and it says so — a reader who already has a password
 *    and is asked for one is being phished, and should be able to tell.
 *
 * The greeting is the name THIS organisation typed. The account row carries
 * whatever the first inviter typed or the person's registered name, and
 * neither is this organisation's to repeat.
 *
 * Pure, so the copy is tested without a network; `builderInviteEmail.ts` draws
 * and sends it.
 */
import type { InviteEmailContent } from './builderInviteEmail.ts';

export interface InvitationEmailInput {
  readonly organisationName: string;
  readonly companyName: string;
  readonly inviterName: string | null;
  readonly inviteeName: string | null;
  readonly url: string;
  readonly requiresPassword: boolean;
  readonly expiryHours: number;
}

export function invitationEmail(
  input: InvitationEmailInput,
): { readonly subject: string; readonly content: InviteEmailContent } {
  const greeting = `Hi ${String(input.inviteeName || 'there')},`;
  const inviter = String(input.inviterName || 'A colleague');
  const portal = `the ${input.companyName} Builder / Developer Portal`;
  const subject = `You have been invited to ${input.organisationName} on the ${input.companyName} Builder Portal`;

  if (input.requiresPassword) {
    return {
      subject,
      content: {
        heading: `You have been invited to ${input.organisationName}`,
        paragraphs: [greeting, `${inviter} has invited you to join ${input.organisationName} on ${portal}.`],
        action: { label: 'Set your password', url: input.url },
        footnote: `This link can be used once and expires in ${input.expiryHours} hours.`,
      },
    };
  }

  return {
    subject,
    content: {
      heading: `You have been invited to ${input.organisationName}`,
      paragraphs: [
        greeting,
        `${inviter} has invited you to join ${input.organisationName} on ${portal}.`,
        `You already have an account, so there is nothing to set up: accept the invitation and ${input.organisationName} ` +
          'is added to the organisations you can open. Nothing changes until you accept, and your sign-in stays as it is.',
      ],
      action: { label: 'Accept invitation', url: input.url },
      footnote: `This link can be used once and expires in ${input.expiryHours} hours. ` +
        'If you were not expecting it, ignore it and nothing changes.',
    },
  };
}
