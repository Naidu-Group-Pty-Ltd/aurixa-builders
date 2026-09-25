# 60 · A builder has an Agencies area

## 1. What it is

`/builder/agencies` is the builder's view of the connected Command Centre workspaces (the agencies) that activate their stock. It is one section with two bookmarkable tabs:

- `/builder/agencies/activations` — **Activated Properties**, the default tab;
- `/builder/agencies/messages` — **Messages**, a shell until messaging is carried over the network (Step 5).

The existing **Messages** entry (`/builder/messages`) is the builder team's internal collaboration. It is unchanged, and it is a different thing.

## 2. What it reads

Both tabs read `list_activated_properties` on `builder-portal-stock`. That operation serves the same activations as the Stock List's `list_selections`, behind the same gate (`inventory` view), through one module: `_shared/builderStock/activatedProperties.ts`, which projects its rows with `activatedProperties.pure.ts`.

**No second activation model.** An activation is the row the signed network sweep converges into `builder_stock_selection_announcements`.

For each activation the page shows:

- the property: lot, address, locality and design;
- its elected photograph, drawn by the Stock List's own rule (`isDisplayableSourceImage`) and signed by the Stock List's `image_url`;
- the activation's status and date;
- the acknowledgement: when it happened, and the colleague who made it, by name;
- the agency's own name, its workspace's directory name, and the outward contact of the person who activated it;
- a link to the project the activation opened.

## 3. What it withholds

- **The client label.** `remote_client_label` is never read. The Command Centre's producer has never sent one (`20261124010000`: "the label is an authorised-disclosure decision this wave deliberately does not take"). If one ever arrives, this page still does not show it: a builder learns which agency activated a property, not for whom.
- **The selection ref.** `remote_selection_ref` is the network's idempotency key, not something a person needs.
- **User ids.** The acknowledger appears by name, and only if they are a member of this organisation.

## 4. Who sees it

- **The navigation entry.** It is drawn only for a user whose server-resolved matrix grants `inventory` view (`builderNavVisibility.pure.ts`). The operation enforces the same rule on the server.
- **Every read is pinned to the organisation the session holds.** `projectActivatedProperties` re-checks that organisation, so a stray row never decorates another organisation's activation.
- **The project link is decided by `builder_accessible_projects`,** the same resolver the Projects page uses. A project party is a contact and gains nothing: the parties table is never read here.

## 5. The Messages shell

- **One conversation per agency and property,** keyed `connection:stock item` (`agencyThreadsFrom`). That is the relationship a Step 5 conversation will belong to.
- **Every thread is empty and says so,** and the composer is disabled.
- **It sends nothing:** no mutation, no email, no model call.
- **It is built from the organisation's own activations,** so another builder's never appears.

## 6. Proof

| Where | What |
| --- | --- |
| `src/lib/__tests__/builderAgencyActivations.spec.ts` | The read, against a stand-in that enforces the filters it is given: the source table, the organisation pin, cross-organisation isolation, what is withheld, the project-access rule, a project party gaining nothing, the edge wiring and gate, and the shell's grouping. |
| `src/pages/builder/__tests__/builderAgencies.spec.tsx` | The navigation gate, the routes, the rows, the project link only where access exists, the empty and refused states, and the shell: empty, disabled, sending nothing. |
| `scripts/ops/stock-agencies-proof.mjs` (phase `stock-agencies-proof`) | On the live product: a signed activation through the real network door, read back by its own builder with property, photograph, agency and project, and by another organisation (also after being listed as a party) as nothing. |
