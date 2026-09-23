/**
 * The uploading organisation's own name, read once.
 *
 * WHY IT IS SHARED RATHER THAN QUERIED WHERE IT IS NEEDED. The deterministic
 * PDF reader uses this as EVIDENCE — a builder's brochure carries the
 * builder's name on every page and it is never the estate or the design — so
 * an import that resolves it differently from another reads the document
 * differently. There are three callers now (the portal's own session, the
 * reader sweep, and an import continuation) and they must resolve the same
 * name for the same organisation or the reading depends on which one ran.
 *
 * NEVER THROWS, AND NULL IS A REAL ANSWER. A name that could not be read is
 * an absence of evidence, which is exactly how the reader treats it.
 */
export async function tradingName(
  db: any, organisationId: unknown,
): Promise<string | null> {
  try {
    const { data } = await db.from('builder_organisations')
      .select('trading_name, legal_name')
      .eq('id', organisationId)
      .maybeSingle();
    return (data?.trading_name ?? data?.legal_name ?? null) as string | null;
  } catch {
    return null;
  }
}
