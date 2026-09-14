/**
 * Builder / Developer Portal — document processing worker.
 *
 * The Builder half of the shared immutable-document pipeline. It is the exact
 * counterpart of `legal-document-processor`, and deliberately shares every
 * decision that matters:
 *
 *   * the same queue table (`document_processing_jobs`, discriminated by portal)
 *   * the same MIME sniffing and SHA-256 (`_shared/immutableDocuments.ts`)
 *   * the same malware scanner, via the same `scanDocument()` and the same
 *     provider secrets — one scanning contract for the whole application
 *   * the same operational-event stream
 *
 * What differs is only which rows it claims and which bucket it reads.
 *
 * Fail-closed throughout. A version reaches `available` only when the scanner
 * positively returns clean; every other outcome — infected, scanner error,
 * scanner unconfigured, download failure, size or MIME violation — leaves the
 * version unservable. `scanDocument()` returns `error` when the provider is not
 * configured, so an unconfigured environment quarantines everything rather than
 * silently publishing it.
 */
import { createClient } from 'npm:@supabase/supabase-js@2.55.0';
import { detectDocumentMime, scanDocument, sha256Hex } from '../_shared/immutableDocuments.ts';
import { isAllowedBuilderMime, MAX_BUILDER_DOCUMENT_BYTES } from '../_shared/builderDocuments.ts';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  // Worker-to-worker secret, exactly as the legal processor. This function is
  // never called by a browser and accepts no user session.
  const secret = Deno.env.get('BUILDER_DOCUMENT_PROCESSOR_SECRET')
    ?? Deno.env.get('LEGAL_DOCUMENT_PROCESSOR_SECRET');
  if (!secret || req.headers.get('x-worker-secret') !== secret) {
    return json({ error: 'unauthorised' }, 401);
  }

  const db = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );
  const workerId = `builder-document-${crypto.randomUUID()}`;

  const { data: jobs, error } = await db.rpc('claim_builder_document_processing_jobs', {
    _worker_id: workerId, _limit: 10,
  });
  if (error) {
    console.error('[builder-document-processor] claim failed', error.message);
    return json({ error: 'claim_failed' }, 500);
  }

  let available = 0, rejected = 0, failed = 0;

  for (const job of jobs || []) {
    let sha = '';
    let mime: string | null = null;
    let size = 0;
    let status: 'clean' | 'infected' | 'error' = 'error';
    let provider = 'content_validation';
    let reference: string | null = null;
    let details: Record<string, unknown> = {};
    let processingError: string | undefined;

    try {
      // Mark in-flight so a stuck job is visible in builder_document_scan_health
      // rather than looking like it was never picked up.
      await db.from('builder_document_versions')
        .update({ malware_scan_status: 'scanning', lifecycle_status: 'scanning' })
        .eq('id', job.version_id)
        .in('malware_scan_status', ['pending', 'error']);

      const { data: blob, error: downloadError } = await db.storage
        .from(job.storage_bucket).download(job.storage_path);
      if (downloadError || !blob) throw new Error('storage_download_failed');

      size = blob.size;
      if (size < 1 || size > MAX_BUILDER_DOCUMENT_BYTES) throw new Error('actual_size_out_of_range');

      const bytes = new Uint8Array(await blob.arrayBuffer());
      sha = await sha256Hex(bytes);

      const detected = detectDocumentMime(bytes);
      mime = detected.mime;
      details = {
        content_detection_reason: detected.reason ?? null,
        declared_mime_type: job.declared_mime_type,
        declared_byte_size: job.declared_byte_size,
        actual_byte_size: size,
      };

      // Content decides, not the uploader's claim.
      if (detected.executable) throw new Error('executable_content_rejected');
      if (!mime) throw new Error(detected.reason || 'mime_detection_failed');
      if (!isAllowedBuilderMime(mime)) throw new Error('mime_type_not_permitted');
      if (String(job.declared_mime_type ?? '').toLowerCase().split(';')[0].trim() !== mime) {
        throw new Error('declared_mime_mismatch');
      }

      const scan = await scanDocument(bytes, sha);
      status = scan.status;
      provider = scan.provider;
      reference = scan.reference;
      details = { ...details, ...scan.details };
      processingError = scan.error;

      if (status === 'clean') available++;
      else if (status === 'infected') rejected++;
      else failed++;
    } catch (caught) {
      status = 'error';
      processingError = caught instanceof Error ? caught.message : String(caught);
      details = { ...details, validation_error: processingError };
      failed++;
    }

    // The command is the only path to `available`, and it writes the trusted
    // audit record in the same transaction.
    const { error: completeError } = await db.rpc('complete_builder_document_processing', {
      _job_id: job.job_id, _worker_id: workerId,
      _sha256: sha, _detected_mime: mime, _byte_size: size,
      _scan_status: status, _scan_provider: provider, _scan_reference: reference,
      _scan_details: details, _error: processingError ?? null,
    });
    if (completeError) {
      console.error('[builder-document-processor] completion failed', completeError.message);
    }

    await db.rpc('record_portal_operational_event', {
      _event_name: status === 'infected'
        ? 'builder_document_malware_detected'
        : status === 'error' ? 'builder_document_scan_failure' : 'builder_document_scan_completed',
      _severity: status === 'infected' ? 'critical' : status === 'error' ? 'warning' : 'info',
      _correlation_id: crypto.randomUUID(),
      _request_id: job.job_id,
      _actor_type: 'worker', _actor_id: null,
      _portal: 'builder',
      _case_id: null, _matter_id: null, _firm_id: null,
      _duration_ms: null, _success: status === 'clean',
      // Never the storage path, never the file name — an alert is not a place
      // to leak where a customer's document lives.
      _metadata: {
        document_version_id: job.version_id,
        scan_status: status,
        provider,
        error_code: processingError?.slice(0, 120) ?? null,
      },
    });
  }

  return json({ claimed: (jobs || []).length, available, rejected, failed });
});
