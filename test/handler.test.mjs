// Teste de integração da Edge Function (handler.ts) contra um Supabase simulado
// e um "serviço de push" falso. Tudo roda em Node, sem Deno e sem rede externa.
import test from "node:test";
import assert from "node:assert/strict";
import { handle } from "../supabase/functions/send-reminders/handler.ts";
import { wallTimeToInstant } from "../supabase/functions/send-reminders/due.ts";
import { createFakeSupabase } from "./fake_supabase.mjs";
import { decryptAes128gcm, newSubscriber, fakePushService } from "./push_helpers.mjs";

const SP = "America/Sao_Paulo";
const CRON = "segredo-do-cron";
const at = (hhmm, tz = SP, day = "2026-11-01") => wallTimeToInstant(day, hhmm, tz);
const plus = (d, min) => new Date(d.getTime() + min * 60_000);

/** Monta um mundo de teste: Supabase falso + uma pessoa com um aparelho + um remédio às 08:00. */
async function world({ pushReply = () => [201], times = ["08:00"], tz } = {}) {
  const fake = createFakeSupabase();
  await fake.listen();
  const vapidRow = { stored: null, puts: 0, gets: 0 };
  fake.state.rpcs.tomei_cron_ok = ({ candidate }) => candidate === CRON;
  fake.state.rpcs.tomei_vapid_get = () => { vapidRow.gets++; return vapidRow.stored; };
  fake.state.rpcs.tomei_vapid_put = (a) => {
    vapidRow.puts++;
    vapidRow.stored ??= { public_key: a.p_public_key, private_jwk: a.p_private_jwk };
    return vapidRow.stored;
  };
  const userId = fake.addUser("ela@exemplo.com", "senha");
  const push = await fakePushService(pushReply);
  const browser = newSubscriber();
  fake.table("push_subscriptions").push({
    id: "sub1", user_id: userId, endpoint: `${push.base}/push/1`, p256dh: browser.p256dh, auth_secret: browser.auth,
  });
  fake.table("medications").push({ id: "m1", user_id: userId, name: "Losartana", dose: "50 mg", times, archived_at: null });
  if (tz) fake.table("profiles").push({ user_id: userId, timezone: tz });
  const envMap = {
    SUPABASE_URL: fake.url,
    SUPABASE_SECRET_KEYS: JSON.stringify({ default: fake.secretKey }),
    SUPABASE_PUBLISHABLE_KEYS: JSON.stringify({ default: fake.publishableKey }),
  };
  const deps = (now, state = {}) => ({ env: (k) => envMap[k], fetch, state, now: () => now });
  const cron = (now, state, secret = CRON) =>
    handle(new Request("http://fn/send-reminders", { method: "POST", headers: { "x-cron-secret": secret }, body: "{}" }), deps(now, state));
  return {
    fake, push, browser, userId, vapidRow, deps, cron,
    payloads: () => push.seen.map((r) => JSON.parse(decryptAes128gcm(r.body, browser.priv, browser.p256dh, browser.auth))),
    close: async () => { await fake.close(); push.server.close(); },
  };
}

test("CORS: OPTIONS responde 204; método errado, 405", async () => {
  const w = await world();
  try {
    const r = await handle(new Request("http://fn/", { method: "OPTIONS" }), w.deps(at("08:00")));
    assert.equal(r.status, 204);
    assert.equal(r.headers.get("access-control-allow-origin"), "*");
    assert.match(r.headers.get("access-control-allow-headers"), /authorization/);
    assert.equal((await handle(new Request("http://fn/", { method: "GET" }), w.deps(at("08:00")))).status, 405);
  } finally { await w.close(); }
});

test("sem credencial ou com segredo errado: 401 e nada é enviado", async () => {
  const w = await world();
  try {
    const none = await handle(new Request("http://fn/", { method: "POST", body: "{}" }), w.deps(at("08:00")));
    assert.equal(none.status, 401);
    assert.equal((await w.cron(at("08:00"), {}, "chute")).status, 401);
    assert.equal(w.push.seen.length, 0);
  } finally { await w.close(); }
});

test("cron sem nenhuma inscrição: responde ok e JÁ garante a chave VAPID (o app precisa da pública para se inscrever)", async () => {
  const w = await world();
  try {
    w.fake.state.tables.push_subscriptions.length = 0;
    const r = await (await w.cron(at("08:00"), {})).json();
    assert.equal(r.ok, true);
    assert.equal(r.subscriptions, 0);
    assert.equal(w.vapidRow.puts, 1);
    assert.equal(w.push.seen.length, 0);
  } finally { await w.close(); }
});

test("na hora do remédio: 1 push entregue, texto certo, reminder_log gravado — e a segunda rodada NÃO repete", async () => {
  const w = await world();
  try {
    const now = plus(at("08:00"), 1);
    const r1 = await (await w.cron(now, {})).json();
    assert.deepEqual([r1.ok, r1.due, r1.notifications, r1.delivered], [true, 1, 1, 1]);
    assert.equal(w.push.seen.length, 1);
    const [p] = w.payloads();
    assert.deepEqual([p.title, p.body, p.url, p.slot, p.kind], ["Hora do remédio", "Losartana 50 mg (08:00)", "./?take=m1", "08:00", 0]);
    assert.equal(w.fake.table("reminder_log").length, 1);
    // cabeçalhos exigidos pelos serviços de push
    const h = w.push.seen[0].headers;
    assert.match(h.authorization, /^vapid t=.+, k=.+$/);
    assert.equal(h["content-encoding"], "aes128gcm");

    const r2 = await (await w.cron(plus(now, 1), {})).json();
    assert.equal(r2.delivered, 0);
    assert.equal(w.push.seen.length, 1, "não pode mandar o mesmo lembrete de novo");
  } finally { await w.close(); }
});

test("execuções SIMULTÂNEAS no mesmo minuto: só uma envia (reserva no reminder_log)", async () => {
  const w = await world();
  try {
    const now = at("08:00");
    await Promise.all([w.cron(now, {}), w.cron(now, {}), w.cron(now, {})]);
    assert.equal(w.push.seen.length, 1);
    assert.equal(w.fake.table("reminder_log").length, 1);
  } finally { await w.close(); }
});

test("chave VAPID: gerada uma vez, guardada no banco e reaproveitada por outra instância", async () => {
  const w = await world();
  try {
    await w.cron(at("08:00"), {});
    assert.equal(w.vapidRow.puts, 1);
    const getsBefore = w.vapidRow.gets;
    await w.cron(at("08:00"), {});          // mesma instância (state novo = instância fria): lê do banco
    assert.equal(w.vapidRow.puts, 1, "não gera outra chave");
    assert.ok(w.vapidRow.gets > getsBefore);
    // a chave pública que o app vai usar para assinar a inscrição é a mesma do cabeçalho VAPID
    const k = w.push.seen[0].headers.authorization.match(/k=(.+)$/)[1];
    assert.equal(k, w.vapidRow.stored.public_key);
  } finally { await w.close(); }
});

test("lembrete extra 15 min depois, com outro texto — e a MESMA tag para substituir o primeiro", async () => {
  const w = await world();
  try {
    await w.cron(at("08:00"), {});
    await w.cron(plus(at("08:00"), 15), {});
    const [first, nag] = w.payloads();
    assert.equal(first.title, "Hora do remédio");
    assert.equal(nag.title, "Você já tomou?");
    assert.equal(first.tag, nag.tag);
    assert.equal(nag.kind, 1);
  } finally { await w.close(); }
});

test("se ela registrou a dose, não manda lembrete extra (nem o primeiro, se registrou antes)", async () => {
  const w = await world();
  try {
    await w.cron(at("08:00"), {});
    w.fake.table("intakes").push({ id: "i1", user_id: w.userId, medication_id: "m1", taken_at: plus(at("08:00"), 4).toISOString(), deleted_at: null });
    await w.cron(plus(at("08:00"), 15), {});
    assert.equal(w.push.seen.length, 1, "só o primeiro aviso");

    const w2 = await world();
    try {
      w2.fake.table("intakes").push({ id: "i2", user_id: w2.userId, medication_id: "m1", taken_at: plus(at("08:00"), -5).toISOString(), deleted_at: null });
      await w2.cron(at("08:00"), {});
      assert.equal(w2.push.seen.length, 0);
      assert.equal(w2.fake.table("reminder_log").length, 0);
    } finally { await w2.close(); }
  } finally { await w.close(); }
});

test("dose desfeita (deleted_at) não conta como tomada", async () => {
  const w = await world();
  try {
    w.fake.table("intakes").push({ id: "i3", user_id: w.userId, medication_id: "m1", taken_at: plus(at("08:00"), -5).toISOString(), deleted_at: "2026-11-01T11:00:00Z" });
    await w.cron(at("08:00"), {});
    assert.equal(w.push.seen.length, 1);
  } finally { await w.close(); }
});

test("dias da semana: o servidor só avisa nos dias marcados do remédio", async () => {
  const w = await world();
  try {
    w.fake.table("medications")[0].weekdays = [1, 3, 5]; // seg, qua, sex
    await w.cron(at("08:00", SP, "2026-11-01"), {});     // domingo
    assert.equal(w.push.seen.length, 0, "domingo não");
    await w.cron(at("08:00", SP, "2026-11-02"), {});     // segunda
    assert.equal(w.push.seen.length, 1, "segunda sim");
    const sel = w.fake.state.log.filter((l) => l.path === "/rest/v1/medications");
    assert.ok(sel.length >= 1);
  } finally { await w.close(); }
});

test("remédio arquivado não gera lembrete", async () => {
  const w = await world();
  try {
    w.fake.table("medications")[0].archived_at = "2026-10-01T00:00:00Z";
    await w.cron(at("08:00"), {});
    assert.equal(w.push.seen.length, 0);
  } finally { await w.close(); }
});

test("fuso do perfil manda: Tóquio recebe às 08:00 de Tóquio, e não às 08:00 de São Paulo", async () => {
  const w = await world({ tz: "Asia/Tokyo" });
  try {
    await w.cron(at("08:00", SP), {});
    assert.equal(w.push.seen.length, 0);
    await w.cron(at("08:00", "Asia/Tokyo"), {});
    assert.equal(w.push.seen.length, 1);
  } finally { await w.close(); }
});

test("fuso inválido no perfil cai no padrão (São Paulo) em vez de quebrar tudo", async () => {
  const w = await world({ tz: "Marte/Fobos" });
  try {
    const r = await (await w.cron(at("08:00"), {})).json();
    assert.equal(r.ok, true);
    assert.equal(w.push.seen.length, 1);
  } finally { await w.close(); }
});

test("dois remédios no mesmo horário = uma notificação só", async () => {
  const w = await world();
  try {
    w.fake.table("medications").push({ id: "m2", user_id: w.userId, name: "Vitamina D", dose: "", times: ["08:00"], archived_at: null });
    const r = await (await w.cron(at("08:00"), {})).json();
    assert.deepEqual([r.due, r.notifications], [2, 1]);
    const [p] = w.payloads();
    assert.equal(p.body, "Losartana 50 mg e Vitamina D (08:00)");
    assert.deepEqual(p.medIds.sort(), ["m1", "m2"]);
    assert.equal(w.fake.table("reminder_log").length, 2);
  } finally { await w.close(); }
});

test("410 do serviço de push: a inscrição morta é apagada", async () => {
  const w = await world({ pushReply: () => [410, "gone"] });
  try {
    const r = await (await w.cron(at("08:00"), {})).json();
    assert.equal(r.removed, 1);
    assert.equal(w.fake.table("push_subscriptions").length, 0);
  } finally { await w.close(); }
});

test("falha passageira (500): devolve a reserva e o minuto seguinte tenta de novo — sem perder o lembrete", async () => {
  let healthy = false;
  const w = await world({ pushReply: () => (healthy ? [201] : [500, "ops"]) });
  try {
    const r1 = await (await w.cron(at("08:00"), {})).json();
    assert.deepEqual([r1.delivered, r1.released], [0, 1]);
    assert.equal(w.fake.table("reminder_log").length, 0, "reserva devolvida");
    healthy = true;
    const r2 = await (await w.cron(plus(at("08:00"), 1), {})).json();
    assert.equal(r2.delivered, 1);
    assert.equal(w.fake.table("reminder_log").length, 1);
    assert.equal(w.push.seen.length, 2);
  } finally { await w.close(); }
});

test("rejeição permanente (403, ex.: chave VAPID trocada): NÃO fica repetindo a cada minuto e mantém a inscrição", async () => {
  const w = await world({ pushReply: () => [403, "vapid mismatch"] });
  try {
    await w.cron(at("08:00"), {});
    await w.cron(plus(at("08:00"), 1), {});
    assert.equal(w.push.seen.length, 1);
    assert.equal(w.fake.table("push_subscriptions").length, 1);
  } finally { await w.close(); }
});

test("falha do Supabase (500 no PostgREST): a função responde 500 JSON, sem estourar", async () => {
  const w = await world();
  try {
    w.fake.state.inject = (req) => (req.url.startsWith("/rest/v1/push_subscriptions") ? { status: 500, body: { message: "boom" } } : null);
    const r = await w.cron(at("08:00"), {});
    assert.equal(r.status, 500);
    assert.equal((await r.json()).ok, false);
  } finally { await w.close(); }
});

test("botão 'Testar notificação': login válido manda push SÓ para os aparelhos dessa pessoa", async () => {
  const w = await world();
  try {
    // login real no Supabase falso
    const login = await (await fetch(`${w.fake.url}/auth/v1/token?grant_type=password`, {
      method: "POST", headers: { apikey: w.fake.publishableKey, "content-type": "application/json" },
      body: JSON.stringify({ email: "ela@exemplo.com", password: "senha" }),
    })).json();
    // outra pessoa, com outro aparelho, que NÃO pode receber
    const outro = w.fake.addUser("outro@exemplo.com", "x");
    const b2 = newSubscriber();
    w.fake.table("push_subscriptions").push({ id: "sub2", user_id: outro, endpoint: `${w.push.base}/push/2`, p256dh: b2.p256dh, auth_secret: b2.auth });

    const req = new Request("http://fn/", {
      method: "POST", headers: { authorization: `Bearer ${login.access_token}`, apikey: w.fake.publishableKey, "content-type": "application/json" },
      body: JSON.stringify({ test: true }),
    });
    const res = await handle(req, w.deps(at("03:00")));
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.ok, true);
    assert.equal(w.push.seen.length, 1);
    assert.equal(w.push.seen[0].url, "/push/1");
    assert.equal(w.payloads()[0].title, "Tomei está funcionando");
  } finally { await w.close(); }
});

test("botão 'Testar notificação': token inválido = 401; sem aparelho cadastrado = ok:false", async () => {
  const w = await world();
  try {
    const bad = await handle(new Request("http://fn/", { method: "POST", headers: { authorization: "Bearer lixo" }, body: JSON.stringify({ test: true }) }), w.deps(at("03:00")));
    assert.equal(bad.status, 401);

    w.fake.state.tables.push_subscriptions.length = 0;
    const login = await (await fetch(`${w.fake.url}/auth/v1/token?grant_type=password`, {
      method: "POST", headers: { apikey: w.fake.publishableKey, "content-type": "application/json" },
      body: JSON.stringify({ email: "ela@exemplo.com", password: "senha" }),
    })).json();
    const res = await handle(new Request("http://fn/", { method: "POST", headers: { authorization: `Bearer ${login.access_token}` }, body: JSON.stringify({ test: true }) }), w.deps(at("03:00")));
    const body = await res.json();
    assert.deepEqual([body.ok, body.reason], [false, "sem_inscricao"]);
  } finally { await w.close(); }
});

test("usa a service_role legada quando só ela existe (apikey + Authorization)", async () => {
  const w = await world();
  try {
    const seenAuth = [];
    w.fake.state.inject = (req) => { seenAuth.push([req.headers.apikey, req.headers.authorization]); return null; };
    // com a chave "secret" nova só o apikey vai; aqui simulamos o ambiente antigo
    const legacy = w.fake.secretKey; // o fake aceita a mesma chave nos dois cabeçalhos
    const env = { SUPABASE_URL: w.fake.url, SUPABASE_SERVICE_ROLE_KEY: legacy };
    const res = await handle(
      new Request("http://fn/", { method: "POST", headers: { "x-cron-secret": CRON }, body: "{}" }),
      { env: (k) => env[k], fetch, state: {}, now: () => at("08:00") },
    );
    // com bearer = service key o fake trata como "token de usuário" inválido → 401 do PostgREST → função devolve 500
    // O importante: o cabeçalho Authorization foi enviado junto com apikey.
    assert.ok(seenAuth.length > 0);
    assert.equal(seenAuth[0][0], legacy);
    assert.equal(seenAuth[0][1], `Bearer ${legacy}`);
    assert.ok([200, 500].includes(res.status));
  } finally { await w.close(); }
});
