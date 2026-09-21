#!/usr/bin/env node
/**
 * ONE ORIGIN THAT LOOKS LIKE A SUPABASE PROJECT.
 *
 * supabase-js speaks to one base URL and splits it itself: `/rest/v1` is
 * PostgREST, `/storage/v1` is the object store. This serves that origin so the
 * pipeline's own client can be constructed exactly as an edge function
 * constructs it, with nothing in the product aware it is not hosted.
 *
 * WHAT IS REAL AND WHAT IS NOT, because that distinction is the whole value of
 * this harness. `/rest/v1` is PROXIED, byte for byte, to a real PostgREST
 * 12.2.3 — the version Supabase runs — over the catalogue the repository's own
 * migrations produce. Nothing here parses, rewrites or answers a query: the
 * filters this pipeline composes are answered by the server that will answer
 * them in production, which is the one property a hand-written double cannot
 * have and the reason two defects in this product's history survived their
 * tests (the AML `.or()` string and the ranking fallback's error code — code
 * and double agreed while only the server disagreed).
 *
 * `/storage/v1` IS local, and that is safe for a different reason: a blob
 * store has no query language to disagree about. It stores bytes under a key
 * and hands the same bytes back, and a stub that fails to do that fails
 * loudly rather than subtly.
 */
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const PORT = Number(process.env.GATEWAY_PORT || 54997);
const PGRST = process.env.PGRST_URL || 'http://localhost:54998';
const ROOT = resolve(process.env.STORAGE_ROOT || '/var/tmp/acceptance-storage');
const SECRET = process.env.GATEWAY_JWT_SECRET
  || 'acceptance-corpus-local-jwt-secret-which-is-at-least-32-bytes';

mkdirSync(ROOT, { recursive: true });

const objectPath = (bucket, key) => join(ROOT, bucket, key);
const sign = (v) => createHmac('sha256', SECRET).update(v).digest('hex').slice(0, 32);

const readBody = (req) => new Promise((ok, no) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => ok(Buffer.concat(chunks)));
  req.on('error', no);
});

const send = (res, status, body, headers = {}) => {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body ?? null));
  res.writeHead(status, {
    'content-type': Buffer.isBuffer(body) ? 'application/octet-stream' : 'application/json',
    'content-length': buf.length, ...headers,
  });
  res.end(buf);
};

/** Every object this gateway has served, so a test can assert on real traffic. */
export const traffic = [];

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  // ---- PostgREST, proxied untouched ------------------------------------
  if (path.startsWith('/rest/v1')) {
    const target = PGRST + path.slice('/rest/v1'.length) + url.search;
    const body = ['GET', 'HEAD'].includes(req.method) ? undefined : await readBody(req);
    const headers = { ...req.headers };
    delete headers.host; delete headers['content-length'];
    const upstream = await fetch(target, { method: req.method, headers, body });
    const buf = Buffer.from(await upstream.arrayBuffer());
    const out = {};
    upstream.headers.forEach((v, k) => {
      if (!['content-encoding', 'transfer-encoding', 'content-length'].includes(k)) out[k] = v;
    });
    res.writeHead(upstream.status, { ...out, 'content-length': buf.length });
    return res.end(buf);
  }

  // ---- Storage ----------------------------------------------------------
  if (path.startsWith('/storage/v1/')) {
    const rest = path.slice('/storage/v1/'.length);

    // createSignedUploadUrl: POST object/upload/sign/{bucket}/{key}
    if (req.method === 'POST' && rest.startsWith('object/upload/sign/')) {
      const spec = rest.slice('object/upload/sign/'.length);
      return send(res, 200, { url: `/storage/v1/object/upload/sign/${spec}?token=${sign(spec)}` });
    }
    // createSignedUrl: POST object/sign/{bucket}/{key}
    if (req.method === 'POST' && rest.startsWith('object/sign/')) {
      const spec = rest.slice('object/sign/'.length);
      const [bucket, ...k] = spec.split('/');
      if (!existsSync(objectPath(bucket, k.join('/')))) {
        return send(res, 404, { error: 'not_found', message: 'Object not found' });
      }
      return send(res, 200, {
        signedURL: `/storage/v1/object/sign/${spec}?token=${sign(spec)}`,
      });
    }
    // list: POST object/list/{bucket}
    if (req.method === 'POST' && rest.startsWith('object/list/')) {
      const bucket = rest.slice('object/list/'.length);
      const body = JSON.parse((await readBody(req)).toString() || '{}');
      const prefix = String(body.prefix ?? '');
      const dir = join(ROOT, bucket, prefix);
      if (!existsSync(dir)) return send(res, 200, []);
      const names = readdirSync(dir).filter((n) => statSync(join(dir, n)).isFile());
      return send(res, 200, names.map((name) => ({
        name, id: name, metadata: { size: statSync(join(dir, name)).size },
      })));
    }
    // upload / update: POST|PUT object/{bucket}/{key}  (signed or bearer)
    if (['POST', 'PUT'].includes(req.method)
      && (rest.startsWith('object/') && !rest.startsWith('object/list/')
        && !rest.startsWith('object/sign/'))) {
      const spec = rest.replace(/^object\/(upload\/sign\/)?/, '');
      const [bucket, ...k] = spec.split('/');
      const key = k.join('/');
      const bytes = await readBody(req);
      const file = objectPath(bucket, key);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, bytes);
      traffic.push({ op: 'upload', bucket, key, bytes: bytes.length });
      return send(res, 200, { Key: `${bucket}/${key}`, path: key });
    }
    // download: GET object/{bucket}/{key}, object/sign/..., object/public/...
    if (req.method === 'GET' && rest.startsWith('object/')) {
      const spec = rest.replace(/^object\/(sign\/|public\/|authenticated\/)?/, '');
      const [bucket, ...k] = spec.split('/');
      const file = objectPath(bucket, k.join('/'));
      if (!existsSync(file)) return send(res, 404, { error: 'not_found', message: 'Object not found' });
      traffic.push({ op: 'download', bucket, key: k.join('/') });
      return send(res, 200, readFileSync(file));
    }
    if (req.method === 'DELETE' && rest.startsWith('object/')) {
      const body = JSON.parse((await readBody(req)).toString() || '{}');
      const bucket = rest.slice('object/'.length).split('/')[0];
      for (const p of body.prefixes ?? []) {
        const f = objectPath(bucket, p);
        if (existsSync(f)) rmSync(f);
      }
      return send(res, 200, []);
    }
    return send(res, 404, { error: 'not_found', message: `no storage route for ${req.method} ${rest}` });
  }

  // ---- The escape hatch that must never fire ----------------------------
  // Anything else reaching this origin is a call the harness did not intend.
  return send(res, 501, { error: 'unimplemented', path, method: req.method });
});

server.listen(PORT, () => console.log(`supabase gateway on :${PORT} -> ${PGRST}, objects in ${ROOT}`));
