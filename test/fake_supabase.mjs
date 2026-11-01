// =============================================================================
//  Supabase "de mentira" para os testes: um servidor HTTP em memória que imita
//  o que o app e a Edge Function usam de verdade:
//    • Auth (GoTrue): login por senha, refresh com rotação, /user, logout
//    • PostgREST: filtros (eq/gte/is...), order, limit/offset, upsert
//      (merge-duplicates / ignore-duplicates), delete, rpc
//    • Regras do banco que importam: dono da linha (RLS), FK de intakes → medications,
//      updated_at pelo relógio do servidor, reenvio idêntico = no-op
//    • CORS como o gateway do Supabase (inclusive o preflight)
//  Dá para injetar falhas: offline, erro 500, token expirando etc.
// =============================================================================
import http from "node:http";
import crypto from "node:crypto";

const RESERVED = new Set(["select", "order", "limit", "offset", "on_conflict", "columns"]);
const CORS = {
  "access-control-allow-origin": "*",
  // lista de propósito enxuta: se o app mandar um cabeçalho fora dela, o preflight falha como no Supabase
  "access-control-allow-headers": "authorization, apikey, content-type, prefer, x-client-info",
  "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "access-control-expose-headers": "content-range",
};

const PK = {
  profiles: ["user_id"],
  medications: ["id"],
  intakes: ["id"],
  push_subscriptions: ["endpoint"],
  reminder_log: ["medication_id", "local_date", "slot", "kind"],
  vapid_public: ["id"],
};
const USER_TABLES = new Set(["profiles", "medications", "intakes", "push_subscriptions"]);

const b64u = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const iso6 = (d, micro) => d.toISOString().replace("Z", String(micro).padStart(3, "0") + "+00:00");

export function createFakeSupabase(opts = {}) {
  const publishableKey = opts.publishableKey ?? "sb_publishable_fake";
  const secretKey = opts.secretKey ?? "sb_secret_fake";
  const state = {
    tables: Object.fromEntries(Object.keys(PK).map((t) => [t, []])),
    users: new Map(), // email -> { id, email, password }
    access: new Map(), // access_token -> { userId, exp }
    refresh: new Map(), // refresh_token -> { userId, used }
    rpcs: {}, // nome -> (args, ctx) => resultado
    functions: {}, // nome -> async (body, ctx) => resultado
    accessTtlSec: opts.accessTtlSec ?? 3600,
    offline: false, // true = derruba as conexões (como perder o sinal)
    inject: null, // (req) => null | { status, body } para simular erros
    hold: null, // async (req, url) => void — atrasa o processamento
    log: [], // { method, path, status }
    seq: 0,
    clock: () => new Date(),
    publishableKey,
    secretKey,
  };

  function addUser(email, password) {
    const id = crypto.randomUUID();
    state.users.set(email, { id, email, password });
    return id;
  }

  function issueSession(user) {
    const now = Math.floor(Date.now() / 1000);
    const exp = now + state.accessTtlSec;
    const access = `${b64u({ alg: "HS256", typ: "JWT" })}.${b64u({ sub: user.id, role: "authenticated", exp })}.${crypto.randomBytes(8).toString("hex")}`;
    const refresh = crypto.randomBytes(8).toString("hex");
    state.access.set(access, { userId: user.id, exp });
    state.refresh.set(refresh, { userId: user.id, used: false });
    return {
      access_token: access,
      token_type: "bearer",
      expires_in: state.accessTtlSec,
      expires_at: exp,
      refresh_token: refresh,
      user: { id: user.id, email: user.email, aud: "authenticated", role: "authenticated" },
    };
  }

  // ---------- filtros PostgREST ----------
  const norm = (v) => (typeof v === "string" && /^\d{4}-\d\d-\d\dT/.test(v) ? normTs(v) : v);
  function normTs(v) {
    const m = v.match(/^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d+))?(Z|[+-]\d\d:\d\d)$/);
    if (!m) return v;
    const frac = (m[2] ?? "").padEnd(6, "0").slice(0, 6);
    const tz = m[3] === "Z" ? "+00:00" : m[3];
    return `${m[1]}.${frac}${tz}`;
  }
  function matches(row, params) {
    for (const [col, expr] of params) {
      if (RESERVED.has(col)) continue;
      const dot = expr.indexOf(".");
      const op = expr.slice(0, dot);
      const raw = expr.slice(dot + 1);
      const cell = row[col];
      const a = norm(cell);
      const b = norm(raw);
      let ok;
      switch (op) {
        case "eq": ok = String(a) === String(b); break;
        case "neq": ok = String(a) !== String(b); break;
        case "gt": ok = a > b; break;
        case "gte": ok = a >= b; break;
        case "lt": ok = a < b; break;
        case "lte": ok = a <= b; break;
        case "is": ok = raw === "null" ? cell == null : String(cell) === raw; break;
        case "in": ok = raw.replace(/^\(|\)$/g, "").split(",").includes(String(cell)); break;
        default: ok = true;
      }
      if (!ok) return false;
    }
    return true;
  }

  function stampUpdated(row) {
    state.seq += 1;
    row.updated_at = iso6(state.clock(), state.seq % 1000);
  }

  // ---------- servidor ----------
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString("utf8");

    const send = (status, body, extra = {}) => {
      state.log.push({ method: req.method, path: url.pathname, status });
      const headers = { ...CORS, ...extra };
      if (body === undefined || body === null || status === 204) {
        res.writeHead(status, headers);
        res.end();
      } else {
        res.writeHead(status, { "content-type": "application/json", ...headers });
        res.end(JSON.stringify(body));
      }
    };

    if (state.offline) return req.socket.destroy();
    if (state.hold) await state.hold(req, url); // gancho de teste: segura a requisição (simula rede lenta)
    if (req.method === "OPTIONS") {
      // preflight: confere se TODOS os cabeçalhos pedidos estão liberados
      const asked = (req.headers["access-control-request-headers"] ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
      const allowed = CORS["access-control-allow-headers"].split(",").map((s) => s.trim());
      const bad = asked.filter((h) => !allowed.includes(h));
      if (bad.length) { state.log.push({ method: "OPTIONS", path: url.pathname, status: 400, bad }); res.writeHead(400, CORS); return res.end(); }
      return send(204, null, { "access-control-max-age": "600" });
    }

    if (state.inject) {
      const inj = state.inject(req, url);
      if (inj) return send(inj.status, inj.body ?? { message: "injetado" });
    }

    const apikey = req.headers["apikey"];
    if (apikey !== publishableKey && apikey !== secretKey) return send(401, { message: "No API key found in request", hint: "No `apikey` request header or url param was found." });

    const bearer = (req.headers["authorization"] ?? "").replace(/^Bearer\s+/i, "");
    const isService = apikey === secretKey && !bearer;
    let user = null;
    if (bearer) {
      const a = state.access.get(bearer);
      if (!a) return send(401, { code: "PGRST301", message: "JWT invalid", details: null, hint: null });
      if (a.exp * 1000 < Date.now()) return send(401, { code: "PGRST303", message: "JWT expired", details: null, hint: null });
      user = { id: a.userId };
    }
    let body = null;
    if (raw) { try { body = JSON.parse(raw); } catch { return send(400, { message: "JSON inválido" }); } }
    const ctx = { user, isService, apikey };
    const path = url.pathname;

    // ---- Auth ----
    if (path === "/auth/v1/token" && req.method === "POST") {
      const grant = url.searchParams.get("grant_type");
      if (grant === "password") {
        const u = state.users.get(body?.email);
        if (!u || u.password !== body?.password) return send(400, { code: 400, error_code: "invalid_credentials", msg: "Invalid login credentials" });
        return send(200, issueSession(u));
      }
      if (grant === "refresh_token") {
        const r = state.refresh.get(body?.refresh_token);
        if (!r) return send(400, { code: 400, error_code: "refresh_token_not_found", msg: "Invalid Refresh Token: Refresh Token Not Found" });
        if (r.used) return send(400, { code: 400, error_code: "refresh_token_already_used", msg: "Invalid Refresh Token: Already Used" });
        r.used = true;
        const u = [...state.users.values()].find((x) => x.id === r.userId);
        return send(200, issueSession(u));
      }
      return send(400, { msg: "grant_type inválido" });
    }
    if (path === "/auth/v1/user" && req.method === "GET") {
      if (!user) return send(401, { code: 401, msg: "missing sub claim" });
      const u = [...state.users.values()].find((x) => x.id === user.id);
      return send(200, { id: u.id, email: u.email, aud: "authenticated", role: "authenticated" });
    }
    if (path === "/auth/v1/logout" && req.method === "POST") return send(204, null);

    // ---- Edge Functions ----
    const fm = path.match(/^\/functions\/v1\/([\w-]+)$/);
    if (fm && req.method === "POST") {
      const fn = state.functions[fm[1]];
      if (!fn) return send(404, { message: "função não existe" });
      return send(200, await fn(body, ctx));
    }

    // ---- RPC ----
    const rm = path.match(/^\/rest\/v1\/rpc\/(\w+)$/);
    if (rm && req.method === "POST") {
      const fn = state.rpcs[rm[1]];
      if (!fn) return send(404, { code: "PGRST202", message: "função não encontrada" });
      return send(200, await fn(body ?? {}, ctx));
    }

    // ---- Tabelas ----
    const tm = path.match(/^\/rest\/v1\/(\w+)$/);
    if (tm && PK[tm[1]]) {
      const table = tm[1];
      const rows = state.tables[table];
      if (!isService) {
        if (!user) return send(401, { code: "42501", message: "permission denied for table " + table });
        if (table === "reminder_log") return send(403, { code: "42501", message: "permission denied for table reminder_log" });
        if (table === "vapid_public" && req.method !== "GET") return send(403, { code: "42501", message: "permission denied for table vapid_public" });
      }
      const mine = (r) => isService || !USER_TABLES.has(table) || r.user_id === user.id;
      const params = [...url.searchParams.entries()];

      if (req.method === "GET") {
        let out = rows.filter(mine).filter((r) => matches(r, params));
        const order = url.searchParams.get("order");
        if (order) {
          const keys = order.split(",").map((o) => { const [c, d] = o.split("."); return [c, d === "desc" ? -1 : 1]; });
          out.sort((x, y) => { for (const [c, d] of keys) { const a = norm(x[c]); const b = norm(y[c]); if (a < b) return -d; if (a > b) return d; } return 0; });
        }
        const off = Number(url.searchParams.get("offset") ?? 0);
        const lim = Number(url.searchParams.get("limit") ?? 1000);
        out = out.slice(off, off + Math.min(lim, 1000));
        return send(200, out.map((r) => structuredClone(r)));
      }

      if (req.method === "DELETE") {
        if (!isService && table !== "push_subscriptions") return send(403, { code: "42501", message: `permission denied for table ${table}` });
        const keep = [], gone = [];
        for (const r of rows) (mine(r) && matches(r, params) ? gone : keep).push(r);
        state.tables[table] = keep;
        return send(204, null);
      }

      if (req.method === "POST") {
        const list = Array.isArray(body) ? body : [body];
        const prefer = req.headers["prefer"] ?? "";
        const onConflict = (url.searchParams.get("on_conflict") ?? PK[table].join(",")).split(",");
        const merge = prefer.includes("resolution=merge-duplicates");
        const ignore = prefer.includes("resolution=ignore-duplicates");
        const returned = [];
        const staged = structuredClone(state.tables[table]);
        for (const input of list) {
          const row = { ...input };
          if (USER_TABLES.has(table) && !isService) {
            if (row.user_id === undefined) row.user_id = user.id;
            if (row.user_id !== user.id) return send(403, { code: "42501", message: `new row violates row-level security policy for table "${table}"` });
          }
          // ---- validações que o banco faria ----
          if (table === "medications" || table === "intakes") {
            if (!row.id) return send(400, { code: "23502", message: "null value in column id" });
            const nm = table === "medications" ? row.name : row.med_name;
            if (typeof nm !== "string" || !nm.trim()) return send(400, { code: "23514", message: "new row violates check constraint (nome vazio)" });
          }
          if (table === "medications" && row.times && !row.times.every((t) => /^([01]\d|2[0-3]):[0-5]\d$/.test(t))) return send(400, { code: "23514", message: "new row violates check constraint medications_times_check" });
          if (table === "medications" && row.weekdays !== undefined &&
              (!Array.isArray(row.weekdays) || row.weekdays.length < 1 || row.weekdays.length > 7 || row.weekdays.some((d) => !Number.isInteger(d) || d < 0 || d > 6))) {
            return send(400, { code: "23514", message: 'new row violates check constraint "medications_weekdays_check"' });
          }
          if (table === "intakes" && row.slot != null && !/^([01]\d|2[0-3]):[0-5]\d$/.test(row.slot)) return send(400, { code: "23514", message: 'new row violates check constraint "intakes_slot_check"' });
          if (table === "intakes") {
            const med = staged.find((r) => false) ?? state.tables.medications.find((m) => m.id === row.medication_id && m.user_id === row.user_id);
            if (!med) return send(409, { code: "23503", message: 'insert or update on table "intakes" violates foreign key constraint "intakes_medication_fk"' });
          }
          if (table === "profiles") {
            try { new Intl.DateTimeFormat("en", { timeZone: row.timezone }); } catch { return send(400, { code: "22023", message: `time zone "${row.timezone}" not recognized` }); }
          }
          const target = state.tables[table];
          const existing = target.find((r) => onConflict.every((c) => String(r[c]) === String(row[c])));
          if (existing) {
            if (ignore) continue;
            if (!merge) return send(409, { code: "23505", message: "duplicate key value violates unique constraint" });
            if (!isService && USER_TABLES.has(table) && existing.user_id !== user.id) return send(403, { code: "42501", message: "new row violates row-level security policy (USING expression)" });
            const before = JSON.stringify({ ...existing, updated_at: undefined });
            Object.assign(existing, row);
            if (JSON.stringify({ ...existing, updated_at: undefined }) !== before) stampUpdated(existing);
            returned.push(structuredClone(existing));
          } else {
            const fresh = { ...row };
            if (table === "medications" && fresh.weekdays === undefined) fresh.weekdays = [0, 1, 2, 3, 4, 5, 6]; // default do banco
            if (table !== "reminder_log" && table !== "vapid_public") { fresh.created_at = fresh.created_at ?? iso6(state.clock(), 0); stampUpdated(fresh); }
            if (table === "push_subscriptions" && !fresh.id) fresh.id = crypto.randomUUID();
            target.push(fresh);
            returned.push(structuredClone(fresh));
          }
        }
        if (prefer.includes("return=representation")) return send(201, returned);
        return send(201, null);
      }
    }
    return send(404, { message: `rota desconhecida: ${req.method} ${path}` });
  });

  return {
    state,
    addUser,
    /** conveniência: lê direto as tabelas (para as asserções dos testes) */
    table: (name) => state.tables[name],
    listen: () => new Promise((resolve) => server.listen(opts.port ?? 0, "127.0.0.1", () => resolve(server.address().port))),
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }),
    get url() { return `http://127.0.0.1:${server.address().port}`; },
    publishableKey,
    secretKey,
  };
}
