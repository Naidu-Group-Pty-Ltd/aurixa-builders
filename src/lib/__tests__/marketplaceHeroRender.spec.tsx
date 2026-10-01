/**
 * THE MARKETPLACE HERO STANDARD — the drawing half, and the agreement between
 * what the network plans and what a card draws.
 *
 * `src/lib/marketplaceHero.ts` and `StockPicture` are byte-identical in the
 * Builder Portal and the Command Centre, and the Command Centre carries this
 * same file; so "both portals draw the same frame" is a property of one
 * implementation run over one plan, proved here at a phone, a tablet and a
 * desktop width.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { StockPicture } from '@/components/stock/StockPicture';
import {
  heroGeometry, heroPlanFitsPicture, readHeroPlan, visibleSourceRect,
} from '@/lib/marketplaceHero';
import { planHero } from '../../../supabase/functions/_shared/builderStock/marketplaceHero.pure';
import { drawScene } from './fixtures/heroScenes';

const croppedPlan = planHero(drawScene({ width: 320, height: 400, horizon: 330,
  houses: [{ x: 70, w: 180, roofTop: 250, base: 340, garage: true }] }).thumbnail)!;
const fitPlan = planHero(drawScene({ width: 240, height: 400, horizon: 330,
  houses: [{ x: 30, w: 180, roofTop: 60, base: 340 }] }).thumbnail)!;

const image = {
  id: 'img-1', source_stage: 'uploaded_document', verification_status: 'source_supplied',
  processing_status: 'ready', storage_path: 'o/1.jpg', external_url: null, position: 0, source_detail: {},
} as never;

describe('the plan the network makes is the plan a card can read', () => {
  it('a server plan survives the wire and is accepted as it is', () => {
    const wire = JSON.parse(JSON.stringify(croppedPlan));
    expect(readHeroPlan(wire)).toEqual(wire);
    expect(readHeroPlan(JSON.parse(JSON.stringify(fitPlan)))?.mode).toBe('fit');
  });

  it('anything else is ignored, and the card draws as before', () => {
    expect(readHeroPlan(null)).toBeNull();
    expect(readHeroPlan({ ...croppedPlan, version: 0 })).toBeNull();
    expect(readHeroPlan({ ...croppedPlan, crop: { ...croppedPlan.crop, h: croppedPlan.crop.h + 1 } })).toBeNull();
    expect(readHeroPlan({ ...croppedPlan, crop: { ...croppedPlan.crop, x: croppedPlan.source.width } })).toBeNull();
    expect(readHeroPlan({ ...croppedPlan, mode: 'stretch' })).toBeNull();
  });
});

describe('the same frame at every width — responsive desktop and mobile', () => {
  it.each([320, 390, 768, 1280, 1920])('at %ipx the card shows exactly the planned crop', (width) => {
    const plan = readHeroPlan(croppedPlan)!;
    const seen = visibleSourceRect(plan, width);
    expect(seen.x).toBeCloseTo(plan.crop.x, 6);
    expect(seen.y).toBeCloseTo(plan.crop.y, 6);
    expect(seen.w).toBeCloseTo(plan.crop.w, 6);
    expect(seen.h).toBeCloseTo(plan.crop.h, 6);
  });

  it('a picture is never stretched: the drawn element keeps the source aspect', () => {
    for (const plan of [croppedPlan, fitPlan]) {
      const g = heroGeometry(readHeroPlan(plan)!);
      const frame = { w: 1600, h: 900 };
      const boxW = (g.box.width / 100) * frame.w, boxH = (g.box.height / 100) * frame.h;
      const drawnAspect = ((g.image.width / 100) * boxW) / ((g.image.height / 100) * boxH);
      expect(drawnAspect).toBeCloseTo(plan.source.width / plan.source.height, 3);
    }
  });

  it('a picture no frame can hold is shown WHOLE, centred, on a plain ground', () => {
    const g = heroGeometry(readHeroPlan(fitPlan)!);
    expect(g.box.height).toBe(100);
    expect(g.box.width).toBeLessThan(100);
    expect(g.box.left).toBeCloseTo((100 - g.box.width) / 2, 6);
    const seen = visibleSourceRect(readHeroPlan(fitPlan)!, 1280);
    expect(seen).toMatchObject({ x: fitPlan.crop.x, y: fitPlan.crop.y });
    expect(seen.w).toBeCloseTo(fitPlan.crop.w, 6);
  });

  it('a picture whose shape is not the planned one does not take the plan', () => {
    const plan = readHeroPlan(croppedPlan)!;
    expect(heroPlanFitsPicture(plan, plan.source.width, plan.source.height)).toBe(true);
    expect(heroPlanFitsPicture(plan, plan.source.width / 4, plan.source.height / 4)).toBe(true);
    expect(heroPlanFitsPicture(plan, plan.source.height, plan.source.width)).toBe(false);
  });
});

describe('StockPicture: cards take the plan, detail views never do', () => {
  const resolver = (hero: unknown) => async () => ({ url: 'https://example.test/1.jpg', hero });

  it('a card with a plan draws the planned frame', async () => {
    render(<StockPicture image={image} resolveUrl={resolver(croppedPlan)} presentation="card" alt="Lot 1" />);
    const img = await screen.findByAltText('Lot 1');
    const frame = img.closest('[data-picture]')!;
    expect(frame.getAttribute('data-hero')).toBe('crop');
    const g = heroGeometry(readHeroPlan(croppedPlan)!);
    expect(img.style.width).toBe(`${g.image.width}%`);
    expect(img.style.top).toBe(`${g.image.top}%`);
  });

  it('a detail view ignores the plan and shows the picture as supplied', async () => {
    render(<StockPicture image={image} resolveUrl={resolver(croppedPlan)} alt="Lot 1" />);
    const img = await screen.findByAltText('Lot 1');
    expect(img.closest('[data-picture]')!.getAttribute('data-hero')).toBeNull();
    expect(img.style.width).toBe('');
  });

  it('a card with no plan — none yet, or planning failed — draws exactly as before', async () => {
    render(<StockPicture image={image} resolveUrl={resolver(null)} presentation="card" alt="Lot 1" />);
    const img = await screen.findByAltText('Lot 1');
    expect(img.closest('[data-picture]')!.getAttribute('data-hero')).toBeNull();
  });

  it('a resolver that answers a bare URL (an older door) still draws the picture', async () => {
    render(<StockPicture image={image} resolveUrl={async () => 'https://example.test/1.jpg'} presentation="card" alt="Lot 1" />);
    expect(await screen.findByAltText('Lot 1')).toBeTruthy();
  });

  it('bytes that do not match the plan drop it on load, and the picture stays', async () => {
    render(<StockPicture image={image} resolveUrl={resolver(croppedPlan)} presentation="card" alt="Lot 1" />);
    const img = await screen.findByAltText('Lot 1');
    Object.defineProperty(img, 'naturalWidth', { value: croppedPlan.source.height, configurable: true });
    Object.defineProperty(img, 'naturalHeight', { value: croppedPlan.source.width, configurable: true });
    await act(async () => { fireEvent.load(img); });
    await waitFor(() => {
      const drawn = screen.getByAltText('Lot 1');
      expect(drawn.closest('[data-picture]')!.getAttribute('data-hero')).toBeNull();
    });
  });
});
