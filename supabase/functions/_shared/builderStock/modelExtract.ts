/**
 * Builder stock lists — reading the ones that are not tables.
 *
 * A stock list that arrives as a brochure, a scanned schedule photographed on
 * a phone, or a paragraph of prose still describes properties, and refusing it
 * would make this a spreadsheet feature. The model is used ONLY to recover the
 * rows; everything after that is the same deterministic path a spreadsheet
 * takes, so a value the model returns is still coerced, still range-checked,
 * and still dropped when it identifies no property.
 *
 * The prompt's single hard rule is the one the whole feature depends on: a
 * field that is not stated in the document is omitted. A fabricated price on a
 * builder's stock reaches a client, and there is no recovery from that.
 */
import { callLLM, type LLMMessage } from '../llmRouter.ts';

/** Sent to the model as a tool schema so the answer is structured, not prose. */
const STOCK_TOOL = {
  type: 'function',
  function: {
    name: 'record_stock_items',
    description:
      'Record every distinct property listed in the document. One entry per property. '
      + 'Omit any field the document does not state.',
    parameters: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          description: 'One entry per property. Empty when the document lists none.',
          items: {
            type: 'object',
            properties: {
              external_reference: { type: 'string', description: "The builder's own reference or stock code for this property, if stated." },
              development_name: { type: 'string', description: 'Estate, community or development name.' },
              project_name: { type: 'string', description: 'Project, stage or building name.' },
              address_line: { type: 'string', description: 'Street address as written.' },
              suburb: { type: 'string' },
              state: { type: 'string', description: 'Australian state or territory abbreviation.' },
              postcode: { type: 'string', description: 'Four digits.' },
              lot_number: { type: 'string' },
              unit_number: { type: 'string' },
              bedrooms: { type: 'number' },
              bathrooms: { type: 'number' },
              car_spaces: { type: 'number' },
              property_type: {
                type: 'string',
                description: 'One of: house, townhouse, apartment, duplex, land, terrace, house_and_land, other.',
              },
              land_size_sqm: { type: 'number', description: 'Square metres.' },
              building_size_sqm: { type: 'number', description: 'Square metres.' },
              price: { type: 'string', description: 'Exactly as written, including any wording such as "from" or "POA".' },
              availability_status: { type: 'string', description: 'As written: available, sold, under offer, on hold, withdrawn.' },
              expected_completion: { type: 'string', description: 'As written.' },
              description: { type: 'string', description: 'A short description or the inclusions, if stated.' },
            },
            additionalProperties: false,
          },
        },
      },
      required: ['items'],
      additionalProperties: false,
    },
  },
};

const SYSTEM_PROMPT = `You read Australian builder and developer stock lists and return the properties they contain.

RULES, in order of importance:
1. NEVER invent a value. If the document does not state a field, omit it. An omitted field is correct; a guessed field is a defect that reaches a client.
2. One entry per distinct property. A stock list of 40 lots is 40 entries, not one summary.
3. Copy prices exactly as written, including "from", "starting at", "POA" or a range. Do not convert, round or average.
4. Do not carry a value from one property to another. Where a heading applies to a whole section (an estate name, a suburb), repeat it on each property in that section — that is stated, not inferred.
5. Ignore marketing copy, disclaimers, contact details, finance illustrations and anything that is not a property in the list.
6. If the document lists no properties, return an empty array.`;

export interface ModelExtractionResult {
  /** Raw rows keyed by canonical field name, ready for `normaliseStockRow`. */
  rows: Array<Record<string, unknown>>;
  modelUsed: string;
}

/** Rows recovered from document text. */
export async function extractStockRowsFromText(
  text: string,
  context: { filename: string; organisationName: string | null },
  options: { deadlineAt?: number } = {},
): Promise<ModelExtractionResult> {
  return await run([
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: `Document: ${context.filename}\n`
        + (context.organisationName ? `Supplied by: ${context.organisationName}\n` : '')
        + `\n---\n${text}\n---\n\nList every property this document offers.`,
    },
  ], options);
}

/** Rows recovered from an uploaded image of a schedule or brochure page. */
export async function extractStockRowsFromImages(
  images: Array<{ base64: string; contentType: string }>,
  context: { filename: string; organisationName: string | null },
  options: { deadlineAt?: number } = {},
): Promise<ModelExtractionResult> {
  const content: Array<Record<string, unknown>> = [
    {
      type: 'text',
      text: `Document: ${context.filename}\n`
        + (context.organisationName ? `Supplied by: ${context.organisationName}\n` : '')
        + 'List every property shown.',
    },
  ];
  for (const image of images.slice(0, 8)) {
    content.push({
      type: 'image_url',
      image_url: { url: `data:${image.contentType};base64,${image.base64}` },
    });
  }
  return await run([
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content },
  ], options);
}

async function run(
  messages: LLMMessage[],
  options: { deadlineAt?: number },
): Promise<ModelExtractionResult> {
  const result = await callLLM({
    agentKey: 'builder_stock_extraction',
    messages,
    tools: [STOCK_TOOL],
    toolChoice: { type: 'function', function: { name: 'record_stock_items' } },
    requiredToolName: 'record_stock_items',
    requireValidToolArguments: true,
    temperature: 0,
    maxTokens: 8000,
    timeoutMs: 60_000,
    deadlineAt: options.deadlineAt,
    // Left at its default (true). This spends a forwarded vendor key, and an
    // unlogged call is never recharged to the tenant that made it.
  });

  const call = result.toolCalls?.find((entry: any) => entry?.function?.name === 'record_stock_items');
  if (!call) return { rows: [], modelUsed: result.modelUsed };

  let parsed: { items?: unknown };
  try {
    parsed = JSON.parse(call.function.arguments ?? '{}');
  } catch {
    return { rows: [], modelUsed: result.modelUsed };
  }

  const items = Array.isArray(parsed.items) ? parsed.items : [];
  const rows: Array<Record<string, unknown>> = [];
  for (const item of items.slice(0, 2000)) {
    if (!item || typeof item !== 'object') continue;
    rows.push(item as Record<string, unknown>);
  }
  return { rows, modelUsed: result.modelUsed };
}
