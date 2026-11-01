// =============================================================================
//  Edge Function `send-reminders`
//
//  Quem chama:
//   1. pg_cron (todo minuto)  → cabeçalho `x-cron-secret` (conferido no banco).
//      Calcula quais doses estão na hora e manda o Web Push.
//   2. O app (botão "Testar notificação") → `Authorization: Bearer <login>` + {"test":true}.
//      Manda uma notificação de teste só para os aparelhos de quem pediu.
//
//  Este arquivo não usa nenhuma API específica do Deno: recebe `env` e `fetch`
//  por injeção, então roda igual nos testes (Node) e em produção (index.ts).
// =============================================================================

import { computeDue, reminderKey } from "./due.ts";
import type { Medication } from "./due.ts";
import { buildMessages, testMessage } from "./messages.ts";
import type { PushMessage } from "./messages.ts";
import { generateVapidKeys, sendPush } from "./webpush.ts";
import type { VapidKeys } from "./webpush.ts";

export interface Deps {
  env: (name: string) => string | undefined;
  fetch: typeof fetch;
  /** sobrevive entre requisições (cache da chave VAPID) — o index.ts passa sempre o mesmo objeto */
  state: { vapid?: VapidKeys };
  now?: () => Date;
}

const DEFAULT_TZ = "America/Sao_Paulo";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

// ---------- chaves do projeto ---------------------------------------------------

interface ServiceKey {
  apikey: string;
  bearer?: string;
}

function firstKey(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const o = JSON.parse(raw) as Record<string, string>;
    const k = o.default ?? Object.values(o)[0];
    return typeof k === "string" && k ? k : undefined;
  } catch {
    return undefined;
  }
}

/** Chave "secret" nova (sb_secret_…, só no cabeçalho apikey) ou, se não houver, a service_role legada. */
function serviceKey(env: Deps["env"]): ServiceKey {
  const secret = firstKey(env("SUPABASE_SECRET_KEYS"));
  if (secret) return { apikey: secret };
  const legacy = env("SUPABASE_SERVICE_ROLE_KEY");
  if (legacy) return { apikey: legacy, bearer: legacy };
  throw new Error("Nenhuma chave de serviço disponível no ambiente da função");
}

function publishableKey(env: Deps["env"]): string {
  const k = firstKey(env("SUPABASE_PUBLISHABLE_KEYS")) ?? env("SUPABASE_ANON_KEY");
  if (!k) throw new Error("Nenhuma chave publicável disponível no ambiente da função");
  return k;
}

// ---------- mini cliente PostgREST (service role) -----------------------------

interface Rest {
  select(table: string, query?: Record<string, string>): Promise<any[]>;
  insertIgnore(table: string, rows: unknown[], onConflict: string): Promise<any[]>;
  remove(table: string, query: Record<string, string>): Promise<void>;
  rpc(fn: string, args: Record<string, unknown>): Promise<any>;
}

function createRest(baseUrl: string, key: ServiceKey, fetchFn: typeof fetch): Rest {
  async function call(
    method: string,
    path: string,
    opts: { query?: Record<string, string>; body?: unknown; prefer?: string } = {},
  ) {
    const url = new URL(`${baseUrl}/rest/v1/${path}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
    const headers: Record<string, string> = { apikey: key.apikey };
    if (key.bearer) headers.Authorization = `Bearer ${key.bearer}`;
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    if (opts.prefer) headers.Prefer = opts.prefer;
    const res = await fetchFn(url, {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`PostgREST ${method} ${path} → ${res.status} ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : null;
  }
  return {
    select: (table, query) => call("GET", table, { query }),
    insertIgnore: (table, rows, onConflict) =>
      call("POST", table, {
        query: { on_conflict: onConflict },
        body: rows,
        prefer: "resolution=ignore-duplicates,return=representation",
      }).then((r) => r ?? []),
    remove: async (table, query) => {
      await call("DELETE", table, { query });
    },
    rpc: (fn, args) => call("POST", `rpc/${fn}`, { body: args }),
  };
}

// ---------- VAPID: gera na primeira vez, guarda no banco -----------------------

async function getVapid(rest: Rest, state: Deps["state"]): Promise<VapidKeys> {
  if (state.vapid) return state.vapid;
  let row = await rest.rpc("tomei_vapid_get", {});
  if (!row) {
    const fresh = await generateVapidKeys();
    // Se outra execução gravou primeiro, o banco devolve o par DELA (vence a primeira).
    row = await rest.rpc("tomei_vapid_put", {
      p_public_key: fresh.publicKey,
      p_private_jwk: fresh.privateJwk,
    });
  }
  state.vapid = { publicKey: row.public_key, privateJwk: row.private_jwk };
  return state.vapid;
}

// ---------- envio para os aparelhos de uma pessoa -------------------------------

interface SubRow {
  id: string;
  user_id: string;
  endpoint: string;
  p256dh: string;
  auth_secret: string;
}

interface DeliveryOutcome {
  delivered: number;
  removed: number;
  transient: number;
  permanent: number;
  results: { status: number; ok: boolean; detail: string }[];
}

async function deliver(
  subs: SubRow[],
  msg: PushMessage,
  ctx: { rest: Rest; vapid: VapidKeys; subject: string; fetchFn: typeof fetch },
): Promise<DeliveryOutcome> {
  const payload = JSON.stringify(msg);
  const out: DeliveryOutcome = { delivered: 0, removed: 0, transient: 0, permanent: 0, results: [] };
  for (const s of [...subs]) {
    const r = await sendPush(
      { endpoint: s.endpoint, p256dh: s.p256dh, auth: s.auth_secret },
      payload,
      ctx.vapid,
      ctx.subject,
      ctx.fetchFn,
      { ttlSeconds: 3600, urgency: "high" },
    );
    out.results.push({ status: r.status, ok: r.ok, detail: r.detail });
    if (r.ok) out.delivered++;
    else if (r.status === 404 || r.status === 410) {
      // o aparelho cancelou/expirou a inscrição: limpa para não tentar de novo
      await ctx.rest.remove("push_subscriptions", { id: `eq.${s.id}` });
      subs.splice(subs.indexOf(s), 1);
      out.removed++;
    } else if (r.status === 0 || r.status === 429 || r.status >= 500) out.transient++;
    else {
      out.permanent++;
      console.error(JSON.stringify({ evt: "push_rejeitado", status: r.status, detail: r.detail }));
    }
  }
  return out;
}

// ---------- fluxo do cron -----------------------------------------------------

async function runCron(rest: Rest, deps: Deps, now: Date) {
  const stats = {
    subscriptions: 0,
    users: 0,
    due: 0,
    notifications: 0,
    delivered: 0,
    removed: 0,
    released: 0,
  };
  // A chave VAPID precisa existir ANTES de qualquer aparelho se inscrever: o app lê a parte
  // pública (tabela vapid_public) para assinar a inscrição. Por isso é garantida em toda
  // rodada do cron (só na primeira vez gera; depois fica em cache).
  const vapid = await getVapid(rest, deps.state);
  const subject = deps.env("VAPID_SUBJECT") ?? deps.env("SUPABASE_URL") ?? "https://localhost";

  const subs = (await rest.select("push_subscriptions", {
    select: "id,user_id,endpoint,p256dh,auth_secret",
  })) as SubRow[];
  stats.subscriptions = subs.length;
  if (!subs.length) return { ok: true, ...stats };

  const byUser = new Map<string, SubRow[]>();
  for (const s of subs) byUser.set(s.user_id, [...(byUser.get(s.user_id) ?? []), s]);

  for (const [userId, userSubs] of byUser) {
    stats.users++;
    const [profile] = await rest.select("profiles", { select: "timezone", user_id: `eq.${userId}`, limit: "1" });
    const tz = isValidTz(profile?.timezone) ? profile.timezone : DEFAULT_TZ;

    const meds = ((await rest.select("medications", {
      select: "id,name,dose,times,weekdays",
      user_id: `eq.${userId}`,
      archived_at: "is.null",
    })) as Medication[]).filter((m) => m.times?.length);
    if (!meds.length) continue;

    const intakes = await rest.select("intakes", {
      select: "medication_id,taken_at",
      user_id: `eq.${userId}`,
      deleted_at: "is.null",
      taken_at: `gte.${new Date(now.getTime() - 4 * 3600_000).toISOString()}`,
    });

    const due = computeDue({ now, tz, medications: meds, intakes });
    if (!due.length) continue;
    stats.due += due.length;

    // 1) Reserva: só "ganha" o lembrete quem conseguiu inserir a linha no reminder_log.
    //    Duas execuções simultâneas nunca avisam duas vezes.
    const inserted = await rest.insertIgnore(
      "reminder_log",
      due.map((d) => ({
        medication_id: d.medication.id,
        local_date: d.localDate,
        slot: d.slot,
        kind: d.kind,
      })),
      "medication_id,local_date,slot,kind",
    );
    const won = new Set(inserted.map((r) => reminderKey(r.medication_id, r.local_date, r.slot, r.kind)));
    const mine = due.filter((d) => won.has(reminderKey(d.medication.id, d.localDate, d.slot, d.kind)));

    // 2) Envia. Se NADA chegou por falha passageira, devolve a reserva e tenta no próximo minuto.
    for (const { message, members } of buildMessages(mine)) {
      stats.notifications++;
      const o = await deliver(userSubs, message, { rest, vapid, subject, fetchFn: deps.fetch });
      stats.delivered += o.delivered;
      stats.removed += o.removed;
      if (o.delivered === 0 && o.transient > 0) {
        for (const m of members) {
          await rest.remove("reminder_log", {
            medication_id: `eq.${m.medication.id}`,
            local_date: `eq.${m.localDate}`,
            slot: `eq.${m.slot}`,
            kind: `eq.${m.kind}`,
          });
        }
        stats.released++;
      }
    }
  }
  console.log(JSON.stringify({ evt: "cron", ...stats }));
  return { ok: true, ...stats };
}

function isValidTz(tz: unknown): tz is string {
  if (typeof tz !== "string" || !tz) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// ---------- fluxo do botão "Testar notificação" -------------------------------

async function runTest(rest: Rest, deps: Deps, userId: string) {
  const subs = (await rest.select("push_subscriptions", {
    select: "id,user_id,endpoint,p256dh,auth_secret",
    user_id: `eq.${userId}`,
  })) as SubRow[];
  if (!subs.length) return { ok: false, reason: "sem_inscricao", results: [] };
  const vapid = await getVapid(rest, deps.state);
  const subject = deps.env("VAPID_SUBJECT") ?? deps.env("SUPABASE_URL") ?? "https://localhost";
  const o = await deliver(subs, testMessage, { rest, vapid, subject, fetchFn: deps.fetch });
  return { ok: o.delivered > 0, results: o.results.map((r) => ({ status: r.status, ok: r.ok, detail: r.detail })) };
}

// ---------- ponto de entrada ---------------------------------------------------

export async function handle(req: Request, deps: Deps): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json({ error: "metodo_nao_permitido" }, 405);

  try {
    const url = deps.env("SUPABASE_URL");
    if (!url) return json({ error: "SUPABASE_URL ausente" }, 500);
    const rest = createRest(url, serviceKey(deps.env), deps.fetch);
    const now = deps.now?.() ?? new Date();

    // (1) Chamada do cron
    const cronSecret = req.headers.get("x-cron-secret");
    if (cronSecret) {
      const ok = await rest.rpc("tomei_cron_ok", { candidate: cronSecret });
      if (ok !== true) return json({ error: "nao_autorizado" }, 401);
      return json(await runCron(rest, deps, now));
    }

    // (2) Chamada do app, com o login da pessoa
    const auth = req.headers.get("authorization") ?? "";
    const jwt = /^bearer\s+/i.test(auth) ? auth.replace(/^bearer\s+/i, "").trim() : "";
    if (jwt) {
      const res = await deps.fetch(`${url}/auth/v1/user`, {
        headers: { apikey: publishableKey(deps.env), Authorization: `Bearer ${jwt}` },
      });
      const user = res.ok ? await res.json().catch(() => null) : null;
      if (!user?.id) return json({ error: "nao_autorizado" }, 401);
      const body = await req.json().catch(() => ({}));
      if (body?.test === true) return json(await runTest(rest, deps, user.id));
      return json({ error: "pedido_invalido" }, 400);
    }

    return json({ error: "nao_autorizado" }, 401);
  } catch (err) {
    console.error(JSON.stringify({ evt: "erro", message: String((err as Error)?.message ?? err) }));
    return json({ ok: false, error: "erro_interno" }, 500);
  }
}
