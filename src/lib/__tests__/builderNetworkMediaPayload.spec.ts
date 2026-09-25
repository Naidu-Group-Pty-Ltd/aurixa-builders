import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A PROPERTY'S MEDIA CROSSES THE NETWORK — AND CHANGES NOTHING ABOUT WHICH
 * PICTURES ARE ITS PHOTOGRAPHS.
 *
 * What these pin is what the SQL contract check (`scripts/db/media-contract-check.ts`,
 * run against a rebuilt database in CI) cannot see: that the check is run at
 * all, and that the one public image door serves the gallery the composer
 * publishes and nothing wider.
 */

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');
const MIGRATION = 'supabase/migrations/20260925160000_a_property_carries_its_media_across_the_network.sql';

describe('the composer', () => {
  const sql = read(MIGRATION);

  it('adds a versioned media block and keeps primary_image as it was', () => {
    expect(sql).toMatch(/'media', jsonb_build_object\(\s*'schema_version', 1,/);
    expect(sql).toContain("'primary_image', v_image,");
  });

  it('reads photographs from the one gallery rule, and documents from the one port', () => {
    expect(sql).toContain('unnest(public.builder_network_stock_item_gallery(v_i.id))');
    expect(sql).toContain("'documents', public.builder_network_property_documents(v_i.source_row)");
  });

  it('leaves the image pipeline alone: the gallery is the primary under the composer\'s own rule', () => {
    const gallery = sql.slice(sql.indexOf('FUNCTION public.builder_network_stock_item_gallery'));
    const body = gallery.slice(0, gallery.indexOf('$fn$;'));
    expect(body).toContain('img.id = i.primary_image_id');
    expect(body).toContain("img.source_stage = 'uploaded_document'");
    expect(body).toContain("img.verification_status = 'source_supplied'");
    expect(body).toContain("img.processing_status = 'ready'");
  });

  it('is not callable by a browser', () => {
    for (const fn of [
      'builder_network_property_documents(jsonb)',
      'builder_network_stock_item_gallery(uuid)',
      'builder_network_compose_stock_item_payload(uuid)',
    ]) {
      expect(sql).toContain(`REVOKE ALL ON FUNCTION public.${fn} FROM PUBLIC, anon, authenticated;`);
    }
  });
});

describe('the image door', () => {
  const door = read('supabase/functions/builder-network-stock-image/index.ts');

  it('still serves the current primary exactly as before', () => {
    expect(door).toContain(".eq('primary_image_id', image.id)");
    expect(door).toContain(".eq('lifecycle_status', 'active')");
    expect(door).toContain("rpc('builder_stock_item_client_visible'");
  });

  it('serves any other image only as a member of its own item\'s published gallery', () => {
    const fallback = door.slice(door.indexOf('builder_network_stock_item_gallery'));
    expect(fallback.length).toBeGreaterThan(0);
    expect(door).toMatch(/rpc\('builder_network_stock_item_gallery', \{ _item_id: image\.stock_item_id \}\)/);
    expect(door).toMatch(/gallery\)\s*\|\|\s*!gallery\.includes\(image\.id\)/);
  });
});

describe('the contract check runs', () => {
  it('in CI, beside the baseline, against a rebuilt database', () => {
    const ci = read('.github/workflows/ci.yml');
    expect(ci).toContain('npm run db:media-contract:check');
    expect(read('package.json')).toContain('"db:media-contract:check"');
  });
});
