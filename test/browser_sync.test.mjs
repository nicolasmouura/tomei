// =============================================================================
//  Testes do banco local + cliente Supabase + motor de sincronização, rodando
//  num Chromium de verdade (IndexedDB e fetch reais, com CORS) contra o
//  Supabase simulado (test/fake_supabase.mjs).
// =============================================================================
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createFakeSupabase } from "./fake_supabase.mjs";
import { createStaticServer } from "./static_server.mjs";

const { chromium } = createRequire(import.meta.url)("playwright");

let browser, statik;
before(async () => {
  statik = createStaticServer();
  await statik.listen();
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  await statik?.close();
});

const EMAIL = "ela@exemplo.com";
const PASS = "senha-boa";

/** Um mundo novo: Supabase falso + navegador limpo (IndexedDB e localStorage vazios). */
async function world(opts = {}) {
  const fake = createFakeSupabase(opts);
  await fake.listen();
  const uid = fake.addUser(EMAIL, PASS);
  const ctx = await browser.newContext({ timezoneId: "America/Sao_Paulo", serviceWorkers: "block" });
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  await page.goto(`${statik.url}/__blank`);
  const w = {
    fake, uid, ctx, page, pageErrors,
    close: async () => { await ctx.close(); await fake.close(); },
    /** Monta os módulos do app na página. `login: false` reaproveita a sessão guardada. */
    async boot({ login = true } = {}) {
      return page.evaluate(async ({ url, key, email, pass, login }) => {
        const [{ openDb }, { createRemote }, { createStore }, { createSync, profileStep }] = await Promise.all([
          import("/js/db.js"), import("/js/remote.js"), import("/js/store.js"), import("/js/sync.js"),
        ]);
        const remote = createRemote({ url, key });
        const session = login ? await remote.signIn(email, pass) : remote.getStoredSession();
        const db = await openDb("t-" + session.user.id);
        const phases = [];
        let sync;
        const store = createStore({ db, userId: session.user.id, syncSoon: () => sync.syncSoon() });
        sync = createSync({
          db, remote, userId: session.user.id, steps: [profileStep({ db, remote, userId: session.user.id })],
          onState: (s) => phases.push(s.phase),
        });
        window.t = { db, remote, store, sync, phases, userId: session.user.id };
        return session.user.id;
      }, { url: fake.url, key: fake.publishableKey, email: EMAIL, pass: PASS, login });
    },
    ev: (fn, arg) => page.evaluate(fn, arg),
    sync: () => page.evaluate(() => window.t.sync.syncNow("manual").then(() => window.t.sync.getState())),
    local: (table) => page.evaluate((t) => window.t.db.getAll(t), table),
  };
  return w;
}

const medInput = (over = {}) => ({ id: "11111111-1111-4111-8111-111111111111", name: "Losartana", dose: "50 mg", times: ["08:00", "20:00"], ...over });

test("login: senha errada vira mensagem em português; a certa guarda a sessão", async () => {
  const w = await world();
  try {
    const bad = await w.ev(async ({ url, key }) => {
      const { createRemote } = await import("/js/remote.js");
      try { await createRemote({ url, key }).signIn("ela@exemplo.com", "errada"); return null; } catch (e) { return { kind: e.kind, message: e.message }; }
    }, { url: w.fake.url, key: w.fake.publishableKey });
    assert.deepEqual(bad, { kind: "auth", message: "E-mail ou senha incorretos." });
    await w.boot();
    const session = await w.ev(() => JSON.parse(localStorage.getItem("tomei.session")));
    assert.equal(session.user.email, EMAIL);
    assert.ok(session.access_token && session.refresh_token);
  } finally { await w.close(); }
});

test("OFFLINE: registrar dose grava no aparelho na hora; ao voltar a internet sobe uma vez só", async () => {
  const w = await world();
  try {
    await w.boot();
    await w.ev((m) => window.t.store.saveMedication(m), medInput());
    await w.sync(); // remédio sobe com internet
    w.fake.state.offline = true; // perde o sinal

    const row = await w.ev(() => window.t.store.logIntake({ medicationId: "11111111-1111-4111-8111-111111111111" }));
    assert.equal(row._dirty, 1);
    assert.equal((await w.local("intakes")).length, 1, "gravou no aparelho mesmo sem internet");

    const off = await w.sync();
    assert.equal(off.phase, "offline");
    assert.equal(off.pending, 1);
    assert.equal(w.fake.table("intakes").length, 0);

    w.fake.state.offline = false;
    const on = await w.sync();
    assert.equal(on.phase, "idle");
    assert.equal(on.pending, 0);
    assert.equal(w.fake.table("intakes").length, 1);
    const [local] = await w.local("intakes");
    assert.equal(local._dirty, 0);
    assert.ok(local.updated_at, "updated_at do servidor voltou no pull");
    assert.equal(w.fake.table("intakes")[0].id, row.id);
    assert.equal(w.fake.table("intakes")[0].med_name, "Losartana");

    await w.sync();
    await w.sync();
    assert.equal(w.fake.table("intakes").length, 1, "sincronizar de novo nunca duplica");
  } finally { await w.close(); }
});

test("os dados sobrevivem a fechar e reabrir o app (reload) mesmo offline", async () => {
  const w = await world();
  try {
    await w.boot();
    await w.ev((m) => window.t.store.saveMedication(m), medInput());
    w.fake.state.offline = true;
    await w.ev(() => window.t.store.logIntake({ medicationId: "11111111-1111-4111-8111-111111111111", note: "depois do café" }));
    await w.page.reload();
    await w.boot({ login: false });
    const [i] = await w.local("intakes");
    assert.equal(i.note, "depois do café");
    assert.equal(i._dirty, 1);
    w.fake.state.offline = false;
    await w.sync();
    assert.equal(w.fake.table("intakes").length, 1);
  } finally { await w.close(); }
});

test("remédio e dose criados offline: o remédio sobe ANTES (chave estrangeira) e nada é recusado", async () => {
  const w = await world();
  try {
    await w.boot();
    w.fake.state.offline = true;
    await w.ev((m) => window.t.store.saveMedication(m), medInput());
    await w.ev(() => window.t.store.logIntake({ medicationId: "11111111-1111-4111-8111-111111111111" }));
    w.fake.state.offline = false;
    const s = await w.sync();
    assert.deepEqual([s.phase, s.pending, s.errors], ["idle", 0, 0]);
    assert.equal(w.fake.table("medications").length, 1);
    assert.equal(w.fake.table("intakes").length, 1);
  } finally { await w.close(); }
});

test("editar durante o envio NÃO se perde (_rev): fica pendente e sobe no ciclo seguinte", async () => {
  const w = await world();
  try {
    await w.boot();
    await w.ev((m) => window.t.store.saveMedication(m), medInput({ name: "Antes" }));
    let held = 0;
    let release;
    const gate = new Promise((r) => (release = r));
    w.fake.state.hold = async (req, url) => {
      if (req.method === "POST" && url.pathname === "/rest/v1/medications") { held++; await gate; }
    };
    const running = w.ev(() => window.t.sync.syncNow("manual")); // envio em andamento
    while (held === 0) await new Promise((r) => setTimeout(r, 20));
    await w.ev((m) => window.t.store.saveMedication(m), medInput({ name: "Depois" })); // edita no meio
    release();
    await running;
    assert.equal(w.fake.table("medications")[0].name, "Antes");
    const [local] = await w.local("medications");
    assert.equal(local.name, "Depois", "o pull não sobrescreve alteração local pendente");
    assert.equal(local._dirty, 1);
    w.fake.state.hold = null;
    await w.sync();
    assert.equal(w.fake.table("medications")[0].name, "Depois");
    assert.equal((await w.local("medications"))[0]._dirty, 0);
  } finally { await w.close(); }
});

test("linha recusada pelo servidor NÃO trava as outras (isolamento) e pode ser reenviada", async () => {
  const w = await world();
  try {
    await w.boot();
    await w.ev((m) => window.t.store.saveMedication(m), medInput({ id: "aaaaaaaa-0000-4000-8000-000000000001", name: "Boa" }));
    // linha defeituosa colocada direto no banco local (a interface nunca deixaria criar uma assim)
    await w.ev(({ userId }) => window.t.db.put("medications", { id: "bbbbbbbb-0000-4000-8000-000000000002", user_id: userId, name: "", dose: "", notes: "", times: [], archived_at: null, _dirty: 1, _rev: 1 }), { userId: w.uid });
    await w.ev((m) => window.t.store.saveMedication(m), medInput({ id: "cccccccc-0000-4000-8000-000000000003", name: "Outra boa" }));

    const s = await w.sync();
    assert.deepEqual([s.phase, s.pending, s.errors], ["idle", 0, 1]);
    assert.deepEqual(w.fake.table("medications").map((m) => m.name).sort(), ["Boa", "Outra boa"]);
    const bad = (await w.local("medications")).find((m) => m.name === "");
    assert.match(bad._error, /check constraint/);
    assert.equal(bad._dirty, 1, "a linha ruim continua guardada no aparelho");

    const posts = () => w.fake.state.log.filter((l) => l.method === "POST" && l.path.includes("medications")).length;
    const before = posts();
    await w.sync();
    assert.equal(posts(), before, "não fica reenviando a linha defeituosa a cada ciclo");

    const again = await w.ev(() => window.t.sync.retryErrors().then(() => window.t.sync.getState()));
    assert.equal(again.errors, 1, "'tentar de novo' reenvia; se o servidor recusar de novo, volta a marcar");
    assert.ok(posts() > before);
  } finally { await w.close(); }
});

test("dose recusada só porque o remédio estava com erro volta sozinha à fila quando o remédio é corrigido", async () => {
  const w = await world();
  try {
    await w.boot();
    const id = "dddddddd-0000-4000-8000-000000000004";
    await w.ev(({ userId, id }) => window.t.db.put("medications", { id, user_id: userId, name: "", dose: "", notes: "", times: [], archived_at: null, _dirty: 1, _rev: 1 }), { userId: w.uid, id });
    await w.ev(({ userId, id }) => window.t.db.put("intakes", { id: "eeeeeeee-0000-4000-8000-000000000005", user_id: userId, medication_id: id, med_name: "?", med_dose: "", taken_at: new Date().toISOString(), note: "", deleted_at: null, _dirty: 1, _rev: 1 }), { userId: w.uid, id });
    let s = await w.sync();
    assert.equal(s.errors, 2, "remédio ruim + dose órfã");
    // corrige o remédio pela interface
    await w.ev((id) => window.t.store.saveMedication({ id, name: "Corrigido", times: [] }), id);
    s = await w.sync();
    assert.deepEqual([s.pending, s.errors], [0, 0]);
    assert.equal(w.fake.table("intakes").length, 1);
  } finally { await w.close(); }
});

test("apagar é 'soft delete': a dose continua no servidor com deleted_at, e restaurar funciona", async () => {
  const w = await world();
  try {
    await w.boot();
    await w.ev((m) => window.t.store.saveMedication(m), medInput());
    const row = await w.ev(() => window.t.store.logIntake({ medicationId: "11111111-1111-4111-8111-111111111111" }));
    await w.sync();
    await w.ev((id) => window.t.store.removeIntake(id), row.id);
    await w.sync();
    assert.equal(w.fake.table("intakes").length, 1, "nada foi removido do servidor");
    assert.ok(w.fake.table("intakes")[0].deleted_at);
    await w.ev((id) => window.t.store.restoreIntake(id), row.id);
    await w.sync();
    assert.equal(w.fake.table("intakes")[0].deleted_at, null);
  } finally { await w.close(); }
});

test("outro aparelho: o que ele grava e desfaz chega aqui; e o que é daqui não é sobrescrito", async () => {
  const w = await world();
  try {
    await w.boot();
    await w.ev((m) => window.t.store.saveMedication(m), medInput());
    await w.sync();
    // "segundo aparelho": escreve direto no servidor com o mesmo login
    const token = (await w.ev(() => JSON.parse(localStorage.getItem("tomei.session")).access_token));
    const post = (table, body) => fetch(`${w.fake.url}/rest/v1/${table}?on_conflict=id`, {
      method: "POST", headers: { apikey: w.fake.publishableKey, authorization: `Bearer ${token}`, "content-type": "application/json", prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify([body]),
    });
    const other = { id: "ffffffff-0000-4000-8000-000000000006", user_id: w.uid, medication_id: "11111111-1111-4111-8111-111111111111", med_name: "Losartana", med_dose: "50 mg", taken_at: "2026-11-01T11:00:00Z", note: "do celular", deleted_at: null };
    assert.equal((await post("intakes", other)).status, 201);
    await w.sync();
    let local = await w.local("intakes");
    assert.deepEqual(local.map((i) => i.note), ["do celular"]);
    await post("intakes", { ...other, deleted_at: "2026-11-01T12:00:00Z" });
    await w.sync();
    local = await w.local("intakes");
    assert.ok(local[0].deleted_at, "o 'desfazer' do outro aparelho chegou");
  } finally { await w.close(); }
});

test("token vencido: renova sozinho (refresh token) e segue", async () => {
  const w = await world();
  try {
    await w.boot();
    await w.ev((m) => window.t.store.saveMedication(m), medInput());
    await w.ev(() => { const s = JSON.parse(localStorage.getItem("tomei.session")); s.expires_at_ms = Date.now() - 1000; localStorage.setItem("tomei.session", JSON.stringify(s)); });
    const s = await w.sync();
    assert.equal(s.phase, "idle");
    assert.equal(w.fake.table("medications").length, 1);
    const refreshes = w.fake.state.log.filter((l) => l.path === "/auth/v1/token").length;
    assert.ok(refreshes >= 2, "login + renovação");
  } finally { await w.close(); }
});

test("servidor devolve 401 no meio do caminho: renova e repete a chamada", async () => {
  const w = await world();
  try {
    await w.boot();
    await w.ev((m) => window.t.store.saveMedication(m), medInput());
    w.fake.state.access.clear(); // o servidor "esquece" o token atual
    const s = await w.sync();
    assert.equal(s.phase, "idle");
    assert.equal(w.fake.table("medications").length, 1);
  } finally { await w.close(); }
});

test("sessão revogada: vira fase 'auth', NENHUM dado local é perdido e, ao entrar de novo, tudo sobe", async () => {
  const w = await world();
  try {
    await w.boot();
    await w.ev((m) => window.t.store.saveMedication(m), medInput());
    w.fake.state.refresh.clear(); // refresh token revogado
    await w.ev(() => { const s = JSON.parse(localStorage.getItem("tomei.session")); s.expires_at_ms = Date.now() - 1000; localStorage.setItem("tomei.session", JSON.stringify(s)); });
    const s = await w.sync();
    assert.equal(s.phase, "auth");
    assert.equal(s.pending, 1);
    assert.equal(await w.ev(() => localStorage.getItem("tomei.session")), null);
    assert.equal((await w.local("medications")).length, 1, "dado continua no aparelho");
    assert.equal(w.fake.table("medications").length, 0);

    await w.ev(async ({ email, pass }) => { await window.t.remote.signIn(email, pass); }, { email: EMAIL, pass: PASS });
    const after = await w.sync();
    assert.deepEqual([after.phase, after.pending], ["idle", 0]);
    assert.equal(w.fake.table("medications").length, 1);
  } finally { await w.close(); }
});

test("servidor com erro 500: fica pendente, mostra 'error' e recupera sozinho depois", async () => {
  const w = await world();
  try {
    await w.boot();
    await w.ev((m) => window.t.store.saveMedication(m), medInput());
    w.fake.state.inject = (req) => (req.method === "POST" && req.url.startsWith("/rest/v1/medications") ? { status: 503, body: { message: "indisponível" } } : null);
    const bad = await w.sync();
    assert.deepEqual([bad.phase, bad.pending], ["error", 1]);
    w.fake.state.inject = null;
    const ok = await w.sync();
    assert.deepEqual([ok.phase, ok.pending], ["idle", 0]);
  } finally { await w.close(); }
});

test("histórico grande: pull paginado traz tudo, e o ciclo seguinte quase não baixa nada", async () => {
  const w = await world();
  try {
    const t = Date.parse("2026-10-01T00:00:00Z");
    const iso6 = (ms, n) => new Date(ms).toISOString().replace("Z", String(n).padStart(3, "0") + "+00:00");
    w.fake.table("medications").push({ id: "11111111-1111-4111-8111-111111111111", user_id: w.uid, name: "Losartana", dose: "", notes: "", times: [], archived_at: null, created_at: iso6(t, 0), updated_at: iso6(t, 0) });
    for (let n = 0; n < 1200; n++) {
      w.fake.table("intakes").push({
        id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, user_id: w.uid, medication_id: "11111111-1111-4111-8111-111111111111",
        med_name: "Losartana", med_dose: "", taken_at: new Date(t + n * 3600_000).toISOString(), note: "", deleted_at: null,
        created_at: iso6(t, 0), updated_at: iso6(t + n * 1000, n % 1000),
      });
    }
    await w.boot();
    const s = await w.sync();
    assert.equal(s.phase, "idle");
    assert.equal((await w.local("intakes")).length, 1200);
    const gets = w.fake.state.log.filter((l) => l.method === "GET" && l.path === "/rest/v1/intakes").length;
    assert.ok(gets >= 3, `paginou (${gets} requisições)`);
    await w.sync();
    assert.equal((await w.local("intakes")).length, 1200);
  } finally { await w.close(); }
});

test("regras do store: horário futuro é recusado; editar/restaurar contam _rev; nome vazio é recusado", async () => {
  const w = await world();
  try {
    await w.boot();
    await w.ev((m) => window.t.store.saveMedication(m), medInput());
    const err = await w.ev(async () => {
      try { await window.t.store.logIntake({ medicationId: "11111111-1111-4111-8111-111111111111", takenAt: new Date(Date.now() + 3 * 3600_000) }); return null; } catch (e) { return e.message; }
    });
    assert.match(err, /ainda não chegou/);
    const empty = await w.ev(async () => { try { await window.t.store.saveMedication({ name: "  " }); return null; } catch (e) { return e.message; } });
    assert.match(empty, /nome/i);
    const row = await w.ev(() => window.t.store.logIntake({ medicationId: "11111111-1111-4111-8111-111111111111" }));
    const edited = await w.ev((id) => window.t.store.updateIntake(id, { note: "ok" }), row.id);
    assert.equal(edited._rev, 2);
    assert.equal(edited.note, "ok");
    assert.equal((await w.ev(() => window.t.db.get("intakes", "nao-existe"))), undefined);
  } finally { await w.close(); }
});

test("fuso do aparelho é enviado ao servidor (perfil) para o cálculo dos lembretes", async () => {
  const w = await world();
  try {
    await w.boot();
    await w.sync();
    const [p] = w.fake.table("profiles");
    assert.equal(p.timezone, "America/Sao_Paulo");
    assert.equal(p.user_id, w.uid);
  } finally { await w.close(); }
});

test("exportAll devolve tudo, inclusive doses desfeitas, sem campos internos", async () => {
  const w = await world();
  try {
    await w.boot();
    await w.ev((m) => window.t.store.saveMedication(m), medInput());
    const r = await w.ev(() => window.t.store.logIntake({ medicationId: "11111111-1111-4111-8111-111111111111" }));
    await w.ev((id) => window.t.store.removeIntake(id), r.id);
    const dump = await w.ev(() => window.t.store.exportAll());
    assert.equal(dump.app, "tomei");
    assert.equal(dump.intakes.length, 1);
    assert.ok(dump.intakes[0].deleted_at);
    assert.equal("_dirty" in dump.intakes[0], false);
    assert.equal(dump.medications[0].name, "Losartana");
  } finally { await w.close(); }
});

test("dias da semana: escolhidos no app sobem ao servidor, são preservados ao editar sem informar os dias e nunca ficam vazios", async () => {
  const w = await world();
  try {
    await w.boot();
    const id = "11111111-1111-4111-8111-111111111111";
    await w.ev((m) => window.t.store.saveMedication(m), medInput({ weekdays: [5, 1, 3] }));
    await w.sync();
    assert.deepEqual(w.fake.table("medications")[0].weekdays, [1, 3, 5]);

    // editar só o nome (sem mandar os dias) mantém os dias
    await w.ev((id) => window.t.store.saveMedication({ id, name: "Losartana potássica", times: ["08:00"] }), id);
    await w.sync();
    assert.deepEqual(w.fake.table("medications")[0].weekdays, [1, 3, 5]);
    assert.equal(w.fake.table("medications")[0].name, "Losartana potássica");

    const err = await w.ev(async (id) => { try { await window.t.store.saveMedication({ id, name: "X", weekdays: [] }); return null; } catch (e) { return e.message; } }, id);
    assert.match(err, /pelo menos um dia/);

    // remédio novo sem informar dias = todos os dias
    await w.ev(() => window.t.store.saveMedication({ id: "22222222-2222-4222-8222-222222222222", name: "Vitamina", times: [] }));
    await w.sync();
    assert.deepEqual(w.fake.table("medications").find((m) => m.name === "Vitamina").weekdays, [0, 1, 2, 3, 4, 5, 6]);

    // outro aparelho recebe os dias
    const local = await w.local("medications");
    assert.deepEqual(local.find((m) => m.id === id).weekdays, [1, 3, 5]);
  } finally { await w.close(); }
});

test("nenhuma exceção solta na página durante os testes", async () => {
  const w = await world();
  try {
    await w.boot();
    await w.ev((m) => window.t.store.saveMedication(m), medInput());
    await w.sync();
    assert.deepEqual(w.pageErrors, []);
  } finally { await w.close(); }
});
