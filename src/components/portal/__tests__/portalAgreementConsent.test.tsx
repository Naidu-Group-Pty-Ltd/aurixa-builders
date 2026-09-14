/**
 * The consent wall, RENDERED.
 *
 * Everything else that guards this component reads its source — which is how
 * a prop declared in the type annotation, referenced in the JSX and never
 * destructured shipped to production. TypeScript agreed the prop existed,
 * the linter agreed, the build agreed, and the browser threw
 * `ReferenceError: beforeAccept is not defined` on the first paint of every
 * page that mounts it.
 *
 * So this file mounts the thing. A test that renders it once catches the
 * whole class; no amount of source scanning does.
 */
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PortalAgreementConsent } from '@/components/portal/PortalAgreementConsent';
import {
  DIRECT_TERMS_ACKNOWLEDGEMENTS,
  PORTAL_TERMS_ACKNOWLEDGEMENTS,
  type PortalTermsVersion,
} from '@/lib/portalAgreement';

const terms = {
  id: 'v1',
  version: '2.0',
  title: 'Portal Access, Confidentiality, Privacy and AML/CTF Compliance Passport Agreement',
  content_markdown: '# Agreement\n\nSection 1. The partner agrees.',
  document_hash: 'abcdef0123456789',
} as unknown as PortalTermsVersion;

describe('PortalAgreementConsent', () => {
  it('renders the agreement, every acknowledgment and the accept button', () => {
    render(
      <PortalAgreementConsent terms={terms} loading={false} busy={false} onAccept={() => {}} />,
    );

    expect(screen.getByText(terms.title)).toBeInTheDocument();
    expect(screen.getByText('Section 1. The partner agrees.')).toBeInTheDocument();
    for (const item of PORTAL_TERMS_ACKNOWLEDGEMENTS) {
      expect(screen.getByText(item.statement)).toBeInTheDocument();
    }
    expect(screen.getAllByRole('checkbox')).toHaveLength(PORTAL_TERMS_ACKNOWLEDGEMENTS.length);
  });

  it('renders the caller node passed as beforeAccept', () => {
    render(
      <PortalAgreementConsent
        terms={terms}
        loading={false}
        busy={false}
        onAccept={() => {}}
        beforeAccept={<p>Full name of the person accepting</p>}
      />,
    );

    expect(screen.getByText('Full name of the person accepting')).toBeInTheDocument();
  });

  it('holds the button until every acknowledgment is ticked, then emits the keys', () => {
    const onAccept = vi.fn();
    render(
      <PortalAgreementConsent
        terms={terms}
        loading={false}
        busy={false}
        onAccept={onAccept}
        acknowledgements={DIRECT_TERMS_ACKNOWLEDGEMENTS}
      />,
    );

    const boxes = screen.getAllByRole('checkbox');
    const button = screen.getByRole('button', { name: /accept/i });
    expect(button).toBeDisabled();

    boxes.slice(0, -1).forEach((box) => fireEvent.click(box));
    expect(button).toBeDisabled();

    fireEvent.click(boxes[boxes.length - 1]);
    expect(button).not.toBeDisabled();

    fireEvent.click(button);
    expect(onAccept).toHaveBeenCalledWith(DIRECT_TERMS_ACKNOWLEDGEMENTS.map((item) => item.key));
  });

  it('renders the link channel wording when the link channel passes it', () => {
    render(
      <PortalAgreementConsent
        terms={null}
        loading={false}
        busy={false}
        onAccept={() => {}}
        acknowledgements={DIRECT_TERMS_ACKNOWLEDGEMENTS}
        fallbackTitle="AML/CTF Compliance Passport Link Agreement"
        acceptanceNotice="This is the link channel notice."
      />,
    );

    // No terms loaded: the fallback title stands in, and the button is held.
    expect(screen.getByText('AML/CTF Compliance Passport Link Agreement')).toBeInTheDocument();
    expect(screen.getByText('This is the link channel notice.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /accept/i })).toBeDisabled();
  });
});
