import { describe, expect, it } from 'vitest';
import {
  STOCK_IMAGE_PROGRESS_BADGE, STOCK_IMAGE_PROGRESS_DETAIL, STOCK_IMAGE_PROGRESS_LABEL, stockImageProgress,
} from '../../../supabase/functions/_shared/builderStock/imageProgress.pure';
import {
  isTraversableBranch, rowSourceBranchCandidates,
} from '../../../supabase/functions/_shared/builderStock/sourceBranches.pure';

/**
 * MEASURED 30 SEPTEMBER 2026. Three display homes on the live Notion list link
 * one Dropbox FOLDER in their "Complete Package Pack" column. Nothing here can
 * read a photograph out of a Dropbox folder, so the row counts no readable
 * document — and the chip said "No brochure on this row", with the detail
 * "This stock list attaches no brochure or plan to this property". False: the
 * link is in the cell.
 */
const DROPBOX_FOLDER = 'https://www.dropbox.com/scl/fo/mfz4my954d5dbaeyryde6/AEG4VGr-sYkI0BLpSr0XJbQ?rlkey=z2rciuafpmhzublxakygtcijc&st=j3otkwaa&dl=0';

describe('a row that links something photos cannot be read from', () => {
  it('is counted as an unsupported link, not as no link', () => {
    const branches = rowSourceBranchCandidates({ 'Complete Package Pack': DROPBOX_FOLDER });
    expect(branches).toHaveLength(1);
    expect(branches.filter((branch) => !isTraversableBranch(branch))).toHaveLength(1);
  });

  it('says the link cannot be read, and never that the row attaches nothing', () => {
    const state = stockImageProgress({
      hasImage: false, sourceDocuments: 0, unsupportedLinks: 1, workStage: 'settled',
    });
    expect(state).toBe('unsupported_link');
    expect(STOCK_IMAGE_PROGRESS_BADGE[state]).toBe('Link not readable');
    expect(STOCK_IMAGE_PROGRESS_DETAIL[state]).toMatch(/Dropbox folder/);
    expect(STOCK_IMAGE_PROGRESS_DETAIL[state]).not.toMatch(/attaches no/);
    expect(STOCK_IMAGE_PROGRESS_LABEL[state]).toBeTruthy();
  });

  it('is not "our team has been alerted" either, even where the work failed', () => {
    expect(stockImageProgress({
      hasImage: false, sourceDocuments: 0, unsupportedLinks: 2, workStage: 'failed',
    })).toBe('unsupported_link');
  });

  it('leaves every other reading exactly as it was', () => {
    expect(stockImageProgress({ hasImage: false, sourceDocuments: 0, workStage: 'settled' })).toBe('no_document');
    expect(stockImageProgress({ hasImage: false, sourceDocuments: 0, unsupportedLinks: 0, workStage: 'settled' }))
      .toBe('no_document');
    // A readable document beside the unreadable link: the document decides.
    expect(stockImageProgress({ hasImage: false, sourceDocuments: 1, unsupportedLinks: 1, workStage: 'settled' }))
      .toBe('none_found');
    expect(stockImageProgress({ hasImage: true, sourceDocuments: 0, unsupportedLinks: 1, workStage: 'settled' }))
      .toBe('drawn');
  });
});
