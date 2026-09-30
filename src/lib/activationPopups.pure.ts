/**
 * The portal's "Property activated by <agency>" pop-up, as words and rules.
 *
 * When a Command Centre adviser selects one of the builder's properties, the
 * network writes a notification of kind `stock_selection` to every member of
 * the organisation (`builder_stock_activation_fanout`). The bell has always
 * listed it; the pop-up used to be raised by the Dashboard page alone, so a
 * builder working on the Stock List — or in another tab — was never told
 * until they happened to open the Dashboard. The pop-up is raised by the
 * portal layout now, on every page, and this module is what it says and
 * where it leads.
 */
import type { BuilderNotification } from './builderCollaboration';

/**
 * The `entity_kind` the fan-out writes for an activation — the only kind that
 * pops up. Every other notification behaves exactly as it did: in the bell.
 */
export const STOCK_SELECTION_ENTITY_KIND = 'stock_selection';

/** Whether a notification is an activation the builder has not read yet. */
export function isActivationToAnnounce(item: Pick<BuilderNotification, 'entity_kind' | 'read_at'>): boolean {
  return item.entity_kind === STOCK_SELECTION_ENTITY_KIND && !item.read_at;
}

/**
 * Where pressing it lands — the bell's rule: the project the activation
 * opened, else the Stock List (an activation from before projects existed),
 * else the Notifications page.
 */
export function activationHref(item: Pick<BuilderNotification, 'activation'>): string {
  if (item.activation?.project_id) return `/builder/projects/${item.activation.project_id}`;
  return item.activation ? '/builder/stock' : '/builder/notifications';
}

export interface ActivationPopup {
  id: string;
  title: string;
  description: string | undefined;
  href: string;
}

/**
 * The stored title ("Property activated by <agency>"), then the property and
 * who to contact — the resolved context beats the stored sentence, so nothing
 * is said twice.
 */
export function activationPopup(item: BuilderNotification): ActivationPopup {
  const activation = item.activation;
  const contact = activation
    ? [activation.contact_name, activation.contact_email].map((part) => part?.trim()).filter(Boolean).join(' · ')
    : '';
  const description = activation
    ? [activation.property_label?.trim(), contact ? `Contact ${contact}` : null].filter(Boolean).join(' — ')
    : item.body?.trim() ?? '';
  return {
    id: item.id,
    title: item.title,
    description: description || undefined,
    href: activationHref(item),
  };
}

/** The once-per-person ledger's keys for one activation. */
export const activationAlertKey = (notificationId: string) => `activation:${notificationId}`;
export const activationCatchUpKey = (notificationId: string) => `activation-shown:${notificationId}`;
