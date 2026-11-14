// Dependencies are injected so local checks can run the same routes with an in-memory database.
const SECTIONS = {
  rooms: { max: 12, item: { i: ['int', 0, 50], price: ['num'], note: ['str', 600], available: ['bool'] } },
  tours: { max: 40, item: { id: ['str', 40, true], name: ['str', 120, true], cat: ['str', 60], len: ['str', 60], summary: ['str', 800], highlights: ['list', 12, 200], includes: ['list', 12, 200], price: ['num'], active: ['bool'] } },
  notes: { max: 100, item: { q: ['str', 300, true], a: ['str', 1500, true] } },
  general: { object: { currency: ['str', 12], breakfast: ['str', 600], announcement: ['str', 400] } },
};
const STATUSES = ['new', 'done', 'cancelled', 'removed'];
const KINDS = ['booking', 'tour', 'question'];
const REQUEST_WINDOW_MS = 10 * 60 * 1000;
const REQUEST_WINDOW_MAX = 150;

export function application({ db, requireUser, BackendError }) {
  const fail = (code, status) => { throw new BackendError(code, status); };
  const rows = result => { if (result.error) fail(result.error.code, result.error.status); return result.data; };
  const uuid = v => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
  const clean = (v, max) => typeof v === 'string' ? v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max) : '';
  const noStore = { 'cache-control': 'no-store' };

  async function input(request, limit) {
    if (!request.headers.get('content-type')?.startsWith('application/json')) fail('invalid_input', 400);
    const reader = request.body?.getReader(); if (!reader) fail('invalid_input', 400);
    let size = 0; const chunks = [];
    try {
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.length;
        if (size > limit) { await reader.cancel(); fail('payload_too_large', 413); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { fail('invalid_input', 400); }
  }

  function field(spec, value) {
    const [type, a, b] = spec;
    if (type === 'str') { const s = clean(value, a); if (b && !s) fail('invalid_input', 400); return s; }
    if (type === 'num') {
      if (value === null || value === undefined || value === '') return null;
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0 || n > 10000000) fail('invalid_input', 400);
      return Math.round(n * 100) / 100;
    }
    if (type === 'int') { if (!Number.isInteger(value) || value < a || value > b) fail('invalid_input', 400); return value; }
    if (type === 'bool') return value !== false;
    if (type === 'list') {
      if (value === undefined) return [];
      if (!Array.isArray(value) || value.length > a) fail('invalid_input', 400);
      return value.map(x => clean(x, b)).filter(Boolean);
    }
    fail('invalid_input', 400);
  }
  function shape(specs, value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid_input', 400);
    const out = {};
    for (const [key, spec] of Object.entries(specs)) out[key] = field(spec, value[key]);
    return out;
  }
  function validate(key, value) {
    const section = SECTIONS[key];
    if (section.object) return shape(section.object, value);
    if (!Array.isArray(value) || value.length > section.max) fail('invalid_input', 400);
    return value.map(item => shape(section.item, item));
  }

  async function owner(ctx) {
    const user = requireUser(ctx);
    const found = rows(await db.from('owners').select('user_id').eq('user_id', user.id).limit(1));
    if (!found?.length) fail('not_owner', 403);
    return user;
  }

  async function sha256(text) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
  }

  async function consume(key) {
    const now = Date.now();
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const found = rows(await db.from('rate_buckets').select('key,window_started_at,attempt_count').eq('key', key).limit(1));
      if (!found?.length) {
        const inserted = rows(await db.from('rate_buckets').insertIfAbsent({ key, window_started_at: new Date(now).toISOString(), attempt_count: 1 }, { onConflict: 'key' }).select('key'));
        if (inserted?.length) return; continue;
      }
      const row = found[0], started = Date.parse(row.window_started_at);
      if (!Number.isFinite(started) || now - started >= REQUEST_WINDOW_MS) {
        const reset = rows(await db.from('rate_buckets').update({ window_started_at: new Date(now).toISOString(), attempt_count: 1 }).eq('key', key).eq('window_started_at', row.window_started_at).select('key'));
        if (reset?.length) return; continue;
      }
      if (row.attempt_count >= REQUEST_WINDOW_MAX) fail('too_many_requests', 429);
      const bumped = rows(await db.from('rate_buckets').update({ attempt_count: row.attempt_count + 1 }).eq('key', key).eq('window_started_at', row.window_started_at).eq('attempt_count', row.attempt_count).select('key'));
      if (bumped?.length) return;
    }
    fail('limiter_busy', 503);
  }

  return async ctx => {
    const request = ctx.request;
    // The gateway swaps "app" for the deployment's physical name; the provider may strip /functions/v1.
    const match = new URL(request.url).pathname.match(/^\/(?:functions\/v1\/)?(?:app|app-d[0-9a-f]{32})(\/.*)?$/);
    if (!match) fail('not_found', 404);
    const path = match[1] || '/';
    const method = request.method;

    if (path === '/api/health' && method === 'GET') return Response.json({ ok: true }, { headers: noStore });

    if (path === '/api/content' && method === 'GET') {
      const list = rows(await db.from('content').select('key,value,version,updated_at').limit(50));
      const sections = {};
      for (const row of list || []) if (SECTIONS[row.key]) sections[row.key] = { value: row.value, version: row.version, updated_at: row.updated_at };
      return Response.json({ sections }, { headers: noStore });
    }

    if (path === '/api/requests' && method === 'POST') {
      const body = await input(request, 4096);
      if (!uuid(body?.key) || !KINDS.includes(body?.kind)) fail('invalid_input', 400);
      const row = {
        idempotency_key: body.key, kind: body.kind,
        item: clean(body.item, 120), room: clean(body.room, 20), guest_name: clean(body.name, 80), details: clean(body.details, 1500),
      };
      if (!row.item && !row.details) fail('invalid_input', 400);
      const existing = rows(await db.from('guest_requests').select('id,status').eq('idempotency_key', body.key).limit(1));
      if (existing?.length) return Response.json(existing[0], { headers: noStore });
      await consume('guest_requests');
      const inserted = rows(await db.from('guest_requests').insertIfAbsent(row, { onConflict: 'idempotency_key' }).select('id,status'));
      if (inserted?.length) return Response.json(inserted[0], { status: 201, headers: noStore });
      const again = rows(await db.from('guest_requests').select('id,status').eq('idempotency_key', body.key).limit(1));
      if (!again?.length) fail('write_conflict', 409);
      return Response.json(again[0], { headers: noStore });
    }

    // Guests can only look up the status of requests they created themselves:
    // they pass back the idempotency keys their browser stored when sending them.
    if (path === '/api/requests/mine' && method === 'GET') {
      const keys = new URL(request.url).searchParams.get('keys');
      const list = (keys ? keys.split(',') : []).filter(uuid).slice(0, 20);
      if (!list.length) return Response.json({ requests: [] }, { headers: noStore });
      const all = rows(await db.from('guest_requests').select('id,idempotency_key,kind,item,guest_name,status,created_at').limit(200));
      const mine = (all || []).filter(r => list.includes(r.idempotency_key)).map(r => {
        // a request the owner removed still counts as handled for the guest
        const status = r.status === 'removed' ? 'done' : r.status;
        const { idempotency_key, ...rest } = r;
        return { ...rest, status };
      });
      return Response.json({ requests: mine }, { headers: noStore });
    }

    // A guest cancels with the same key they booked with, so only the browser
    // that created the request can cancel it.
    if (path === '/api/requests/cancel' && method === 'POST') {
      const body = await input(request, 1024);
      if (!uuid(body?.key)) fail('invalid_input', 400);
      const found = rows(await db.from('guest_requests').select('id,status').eq('idempotency_key', body.key).limit(1));
      if (!found?.length) fail('not_found', 404);
      if (found[0].status !== 'new') fail('write_conflict', 409);
      // mark who cancelled, so the owner desk can tell a guest cancellation apart
      const cur = rows(await db.from('guest_requests').select('details').eq('idempotency_key', body.key).limit(1));
      const details = (cur[0].details || '') + '\n[Cancelled by the guest from the website]';
      const updated = rows(await db.from('guest_requests').update({ status: 'cancelled', details }).eq('idempotency_key', body.key).eq('status', 'new').select('id,status'));
      if (!updated?.length) fail('write_conflict', 409);
      return Response.json(updated[0], { headers: noStore });
    }

    if (path === '/api/owner/me' && method === 'GET') {
      const user = requireUser(ctx);
      const found = rows(await db.from('owners').select('user_id').eq('user_id', user.id).limit(1));
      const claim = rows(await db.from('owner_claim').select('used').eq('id', 1).limit(1));
      return Response.json({ name: user.name || '', isOwner: !!found?.length, claimable: !!claim?.length && claim[0].used === false }, { headers: noStore });
    }

    if (path === '/api/owner/claim' && method === 'POST') {
      const user = requireUser(ctx);
      const body = await input(request, 1024);
      const code = clean(body?.code, 64).toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (code.length < 12) fail('invalid_code', 403);
      const hash = await sha256(code);
      const claimed = rows(await db.from('owner_claim').update({ used: true, claimed_by: user.id, claimed_at: new Date().toISOString() })
        .eq('id', 1).eq('used', false).eq('code_hash', hash).select('id'));
      if (!claimed?.length) {
        const row = rows(await db.from('owner_claim').select('used,claimed_by,code_hash').eq('id', 1).limit(1));
        if (!row?.length || row[0].claimed_by !== user.id || row[0].code_hash !== hash) fail('invalid_code', 403);
      }
      rows(await db.from('owners').insertIfAbsent({ user_id: user.id, name: clean(user.name, 120) }, { onConflict: 'user_id' }).select('user_id'));
      return Response.json({ isOwner: true }, { headers: noStore });
    }

    const section = path.match(/^\/api\/owner\/content\/([a-z]+)$/);
    if (section && method === 'PUT') {
      const user = await owner(ctx);
      const key = section[1];
      if (!SECTIONS[key]) fail('not_found', 404);
      const body = await input(request, 96 * 1024);
      if (!Number.isInteger(body?.version) || body.version < 0 || body.version >= 2147483647) fail('invalid_input', 400);
      const value = validate(key, body.value);
      const stamp = new Date().toISOString();
      let saved;
      if (body.version === 0) {
        saved = rows(await db.from('content').insertIfAbsent({ key, value, version: 1, updated_by: user.id, updated_at: stamp }, { onConflict: 'key' }).select('key,version,updated_at'));
      } else {
        saved = rows(await db.from('content').update({ value, version: body.version + 1, updated_by: user.id, updated_at: stamp })
          .eq('key', key).eq('version', body.version).select('key,version,updated_at'));
      }
      if (!saved?.length) fail('write_conflict', 409);
      return Response.json({ ...saved[0], value }, { headers: noStore });
    }

    if (path === '/api/owner/requests' && method === 'GET') {
      await owner(ctx);
      const all = rows(await db.from('guest_requests').select('id,kind,item,room,guest_name,details,status,created_at').order('created_at', { ascending: false }).limit(100));
      const list = (all || []).filter(r => r.status !== 'removed');
      return Response.json({ requests: list }, { headers: noStore });
    }

    const req = path.match(/^\/api\/owner\/requests\/([0-9a-f-]{36})$/);
    if (req && uuid(req[1]) && method === 'PATCH') {
      await owner(ctx);
      const body = await input(request, 1024);
      if (!STATUSES.includes(body?.status) || !STATUSES.includes(body?.from)) fail('invalid_input', 400);
      const updated = rows(await db.from('guest_requests').update({ status: body.status }).eq('id', req[1]).eq('status', body.from).select('id,status'));
      if (!updated?.length) fail('write_conflict', 409);
      return Response.json(updated[0], { headers: noStore });
    }

    fail('not_found', 404);
  };
}
