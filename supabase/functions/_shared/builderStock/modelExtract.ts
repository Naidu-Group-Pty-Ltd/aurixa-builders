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
import {
  modelFailureFromRouterError,
  unusableAnswerFailure,
} from './modelExtractionFailure.pure.ts';

/**
 * The ceiling on ONE model attempt, inside the wall clock `runImport` allows
 * the whole chain. See the note at the call site: this is what leaves a
 * fallback a realistic run instead of the remains of the first model's hang.
 */
const MODEL_ATTEMPT_TIMEOUT_MS = 40_000;

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
  let result;
  try {
    result = await callLLM({
      agentKey: 'builder_stock_extraction',
      messages,
      tools: [STOCK_TOOL],
      toolChoice: { type: 'function', function: { name: 'record_stock_items' } },
      requiredToolName: 'record_stock_items',
      requireValidToolArguments: true,
      temperature: 0,
      maxTokens: 8000,
      /*
       * ONE ATTEMPT MAY NOT SPEND THE WHOLE CHAIN'S BUDGET.
       *
       * `runImport` allows the reader 90 s of wall clock and the router
       * derives each attempt's timeout from whatever remains, so a 60 s
       * ceiling here let the FIRST model take two thirds of the budget and
       * left the fallback 30 s — and a first model that simply hung meant the
       * fallback was the only one that ever got a realistic run, on a third of
       * the time.
       *
       * At 40 s the seeded pair — both Gemini on the gateway — worst-cases at
       * 40 + 40 inside the 90 s budget, with room to spare and neither model
       * starved. End to end that is ~15 s of extraction (the 25 MB cap; the
       * 7.2 MB production brochure took 4.7 s) + 90 s + a couple of seconds of
       * import, ~108 s inside the runtime's ceiling.
       *
       * This holds for a LONGER chain too, and does not assume one: the
       * router shortens each attempt to whatever remains of the deadline and
       * abandons the chain below one second, so an operator who adds a third
       * model costs it whatever is left rather than an overrun. The chain is
       * configuration and this constant must never be derived from its
       * length.
       */
      timeoutMs: MODEL_ATTEMPT_TIMEOUT_MS,
      deadlineAt: options.deadlineAt,
      // Left at its default (true). This spends a forwarded vendor key, and an
      // unlogged call is never recharged to the tenant that made it.
    });
  } catch (error) {
    /*
     * The router's `attempts` is the only structured account of what happened
     * and every caller used to discard it. Classified here, once, rather than
     * by matching the thrown sentence anywhere downstream.
     */
    throw modelFailureFromRouterError(error);
  }

  /*
   * =======================================================================
   * AN UNUSABLE ANSWER IS NOT AN EMPTY DOCUMENT.
   * =======================================================================
   *
   * Each of the three checks below used to `return { rows: [] }`, which the
   * import then reported as `no_properties_found` — "No properties could be
   * read from that file. Check that it lists one property per row with column
   * headings." So a model that answered without calling the tool, or with
   * arguments that would not parse, or with no `items` key at all, was
   * reported to the builder as a statement about their brochure.
   *
   * They are typed failures now. The ONE case that still legitimately yields
   * nothing is a well-formed answer whose `items` array is empty — a model
   * that read the document properly and found no property in it — and that
   * one keeps travelling as `{ rows: [] }`, because it is the truth and
   * `no_properties_found` is the right thing to say about it.
   */
  const call = result.toolCalls?.find((entry: any) => entry?.function?.name === 'record_stock_items');
  if (!call) {
    throw unusableAnswerFailure(result.attempts, 'model_missing_tool_call');
  }

  let parsed: { items?: unknown };
  try {
    parsed = JSON.parse(call.function.arguments ?? '{}');
  } catch {
    throw unusableAnswerFailure(result.attempts, 'model_invalid_response');
  }

  if (!Array.isArray(parsed.items)) {
    // `items` is `required` in the schema. Absent is a malformed answer;
    // present-and-empty is handled below and is a real, reportable nothing.
    throw unusableAnswerFailure(result.attempts, 'model_invalid_response');
  }

  const rows: Array<Record<string, unknown>> = [];
  for (const item of parsed.items.slice(0, 2000)) {
    if (!item || typeof item !== 'object') continue;
    rows.push(item as Record<string, unknown>);
  }
  return { rows, modelUsed: result.modelUsed };
}
