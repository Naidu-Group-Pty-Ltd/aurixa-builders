import { describe, expect, it } from 'vitest';
import { parseDrawingAnchors } from '../../../supabase/functions/_shared/builderStock/documentAnchors.pure.ts';

/**
 * A SPREADSHEET PICTURE IS ANCHORED BY ITS ELEMENT, NOT BY THE PREFIX IT WAS
 * WRITTEN UNDER.
 *
 * Excel writes a drawing part with the `xdr:` prefix; a generator is free to
 * declare the same namespace as the DEFAULT one and write `<oneCellAnchor>`
 * with no prefix at all — openpyxl does, and Excel opens the file with every
 * picture on its row. Found 28 September 2026 by the Tier-0 audit, reading its
 * `xlsx-defaultns` fixture through the product's own `extractStockFile`: the
 * workbook's two row-anchored photographs came back with NO anchor, so
 * neither could be tied to its property.
 */
const picture = (prefix: string, kind: string, row: number, rid: string) => {
  const p = prefix ? `${prefix}:` : '';
  return `<${p}${kind}><${p}from><${p}col>20</${p}col><${p}colOff>0</${p}colOff><${p}row>${row}</${p}row>`
    + `<${p}rowOff>0</${p}rowOff></${p}from><${p}ext cx="3048000" cy="1905000"/><${p}pic><${p}blipFill>`
    + `<a:blip xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" `
    + `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:embed="${rid}"/>`
    + `</${p}blipFill></${p}pic><${p}clientData/></${p}${kind}>`;
};

describe('spreadsheet drawing anchors', () => {
  it('reads Excel\'s own prefixed drawing (unchanged)', () => {
    const xml = `<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing">`
      + `${picture('xdr', 'twoCellAnchor', 4, 'rId1')}${picture('xdr', 'oneCellAnchor', 5, 'rId2')}</xdr:wsDr>`;
    expect(parseDrawingAnchors(xml)).toEqual([{ rid: 'rId1', row: 4 }, { rid: 'rId2', row: 5 }]);
  });

  it('reads a drawing written under the DEFAULT namespace (the measured defect)', () => {
    const xml = `<wsDr xmlns="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing">`
      + `${picture('', 'oneCellAnchor', 4, 'rId1')}${picture('', 'oneCellAnchor', 5, 'rId2')}</wsDr>`;
    expect(parseDrawingAnchors(xml)).toEqual([{ rid: 'rId1', row: 4 }, { rid: 'rId2', row: 5 }]);
  });

  it('reads a drawing written under any other prefix', () => {
    const xml = `<sd:wsDr xmlns:sd="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing">`
      + `${picture('sd', 'twoCellAnchor', 7, 'rId9')}</sd:wsDr>`;
    expect(parseDrawingAnchors(xml)).toEqual([{ rid: 'rId9', row: 7 }]);
  });
});
