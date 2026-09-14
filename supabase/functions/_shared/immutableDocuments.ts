export const MAX_LEGAL_DOCUMENT_BYTES = 50 * 1024 * 1024;
export const LEGAL_DOCUMENT_BUCKET_V2 = 'legal-matter-documents';

const hex = (bytes: Uint8Array, length = bytes.length) => Array.from(bytes.slice(0, length)).map((b) => b.toString(16).padStart(2, '0')).join('');
const asciiIncludes = (bytes: Uint8Array, needle: string) => new TextDecoder('latin1').decode(bytes).includes(needle);

export function detectDocumentMime(bytes: Uint8Array): { mime: string | null; executable: boolean; reason?: string } {
  const h = hex(bytes, 16);
  if (h.startsWith('4d5a') || h.startsWith('7f454c46') || ['feedface','feedfacf','cefaedfe','cffaedfe'].some((x)=>h.startsWith(x))) return { mime:null, executable:true, reason:'executable_signature' };
  if (h.startsWith('255044462d')) return { mime:'application/pdf', executable:false };
  if (h.startsWith('89504e470d0a1a0a')) return { mime:'image/png', executable:false };
  if (h.startsWith('ffd8ff')) return { mime:'image/jpeg', executable:false };
  if (h.startsWith('49492a00') || h.startsWith('4d4d002a')) return { mime:'image/tiff', executable:false };
  if (h.startsWith('504b0304')) {
    if (asciiIncludes(bytes,'word/')) return { mime:'application/vnd.openxmlformats-officedocument.wordprocessingml.document', executable:false };
    if (asciiIncludes(bytes,'xl/')) return { mime:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', executable:false };
    return { mime:null, executable:false, reason:'unsupported_or_ambiguous_zip' };
  }
  if (h.startsWith('d0cf11e0a1b11ae1')) return { mime:null, executable:false, reason:'ambiguous_legacy_office_container' };
  if (bytes.length > 0 && !bytes.slice(0,Math.min(bytes.length,8192)).includes(0)) {
    try { const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes.slice(0,Math.min(bytes.length,65536))); return { mime:text.includes(',')&&/\r?\n/.test(text)?'text/csv':'text/plain', executable:false }; } catch { /* binary */ }
  }
  return { mime:null, executable:false, reason:'unknown_content_signature' };
}

export async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest=await crypto.subtle.digest('SHA-256',bytes); return hex(new Uint8Array(digest));
}

export async function scanDocument(bytes: Uint8Array<ArrayBuffer>, sha256: string): Promise<{ status:'clean'|'infected'|'error'; provider:string; reference:string|null; details:Record<string,unknown>; error?:string }> {
  const endpoint=Deno.env.get('LEGAL_DOCUMENT_MALWARE_SCANNER_URL'); const secret=Deno.env.get('LEGAL_DOCUMENT_MALWARE_SCANNER_SECRET');
  if(!endpoint||!secret)return {status:'error',provider:'unconfigured',reference:null,details:{reason:'scanner_not_configured'},error:'malware_scanner_not_configured'};
  const controller=new AbortController(); const timeout=setTimeout(()=>controller.abort(),30_000);
  try {
    const response=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/octet-stream','x-scan-secret':secret,'x-content-sha256':sha256},body:bytes,signal:controller.signal});
    if(!response.ok)return {status:'error',provider:'configured_scanner',reference:response.headers.get('x-scan-id'),details:{http_status:response.status},error:`scanner_http_${response.status}`};
    const result=await response.json().catch(()=>null) as any;
    if(result?.clean===true)return {status:'clean',provider:String(result.provider||'configured_scanner'),reference:String(result.scan_id||response.headers.get('x-scan-id')||'')||null,details:{engine_version:result.engine_version||null,signatures_version:result.signatures_version||null}};
    if(result?.clean===false)return {status:'infected',provider:String(result.provider||'configured_scanner'),reference:String(result.scan_id||response.headers.get('x-scan-id')||'')||null,details:{threats:Array.isArray(result.threats)?result.threats.slice(0,20):[]},error:'malware_detected'};
    return {status:'error',provider:'configured_scanner',reference:null,details:{reason:'invalid_scanner_response'},error:'invalid_scanner_response'};
  } catch(error) { return {status:'error',provider:'configured_scanner',reference:null,details:{reason:error instanceof DOMException&&error.name==='AbortError'?'timeout':'network_error'},error:error instanceof DOMException&&error.name==='AbortError'?'scanner_timeout':'scanner_network_error'}; }
  finally { clearTimeout(timeout); }
}
