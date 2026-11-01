// =============================================================================
//  Teste ponta a ponta da interface, num Chromium de verdade, contra o Supabase
//  simulado: login, cadastro, "Tomei agora", offline, histórico, backup, push...
//  Também grava capturas de tela em ./shots para conferir o visual.
// =============================================================================
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import { createFakeSupabase } from "./fake_supabase.mjs";
import { createStaticServer } from "./static_server.mjs";

const { chromium } = createRequire(import.meta.url)("playwright");
const EMAIL = "ela@exemplo.com";
const PASS = "senha-boa";
const SHOTS = new URL("../shots/", import.meta.url).pathname;
fs.mkdirSync(SHOTS, { recursive: true });

let browser;
before(async () => { browser = await chromium.launch(); });
after(async () => { await browser?.close(); });

const waitFor = async (fn, what = "condição", ms = 8000) => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`Tempo esgotado esperando: ${what}`);
    await new Promise((r) => setTimeout(r, 40));
  }
};

/** Sobe tudo: Supabase falso, servidor estático com config apontando para ele e um navegador novo. */
async function app({ colorScheme = "light", clockAt, permissions = [], configured = true, stubPush = false, viewport = { width: 390, height: 844 }, seed } = {}) {
  const fake = createFakeSupabase();
  await fake.listen();
  const uid = fake.addUser(EMAIL, PASS);
  fake.state.tables.vapid_public.push({ id: true, public_key: "BD7qb3FpQQt2eDSkZbI6nmwESjMWo7p1-ZxduNTJHKjJ5kYmfXk03bCjoXc6gP2FnUODbA_87wCcMaffS02kcXk" });
  fake.state.functions["send-reminders"] = async () => ({ ok: true, results: [{ status: 201, ok: true, detail: "" }] });
  seed?.(fake, uid);
  const statik = createStaticServer({
    overrides: {
      "/config.js": `export const config = { SUPABASE_URL: ${JSON.stringify(fake.url)}, SUPABASE_PUBLISHABLE_KEY: ${JSON.stringify(fake.publishableKey)} };
                     export const isConfigured = () => ${configured};`,
    },
  });
  await statik.listen();
  const ctx = await browser.newContext({ viewport, colorScheme, timezoneId: "America/Sao_Paulo", locale: "pt-BR", acceptDownloads: true, deviceScaleFactor: 2 });
  if (permissions.length) await ctx.grantPermissions(permissions, { origin: statik.url });
  const page = await ctx.newPage();
  const problems = [];
  page.on("pageerror", (e) => problems.push(`pageerror: ${e}`));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    // erro HTTP esperado: senha errada devolve 400 e o navegador loga isso
    if (/Failed to load resource/.test(m.text()) && /\/auth\/v1\/token/.test(m.location().url)) return;
    problems.push(`console.error: ${m.text()}`);
  });
  if (stubPush) {
    await page.addInitScript(() => {
      // O Chromium "headless" não suporta o fluxo de permissão de notificações: simulamos
      // (começa em "default", vira "granted" quando o app pede) e também a inscrição de push.
      let perm = "default";
      Object.defineProperty(Notification, "permission", { configurable: true, get: () => perm });
      Notification.requestPermission = async () => (perm = "granted");
      let current = null;
      const make = (key) => ({
        endpoint: "https://push.example.test/e2e-device",
        options: { applicationServerKey: key },
        toJSON() { return { endpoint: this.endpoint, keys: { p256dh: "BPublicKeyFakeFakeFakeFakeFakeFakeFakeFakeFakeFakeFakeFakeFakeFakeFakeFakeFakeFakeFak", auth: "AuthFakeFakeFake00" } }; },
        unsubscribe: async () => { current = null; return true; },
      });
      PushManager.prototype.getSubscription = async () => current;
      PushManager.prototype.subscribe = async (o) => (current = make(o.applicationServerKey.buffer ?? o.applicationServerKey));
    });
  }
  if (clockAt) await page.clock.install({ time: new Date(clockAt) });
  const a = {
    fake, uid, ctx, page, problems, url: statik.url,
    close: async () => { await ctx.close(); await statik.close(); await fake.close(); },
    open: () => page.goto(`${statik.url}/`),
    async login() {
      await page.getByLabel("E-mail").fill(EMAIL);
      await page.getByLabel("Senha").fill(PASS);
      await page.getByRole("button", { name: "Entrar" }).click();
      await page.getByRole("navigation", { name: "Seções" }).waitFor();
    },
    tab: (name) => page.getByRole("navigation", { name: "Seções" }).getByRole("button", { name }).click(),
    badge: () => page.locator("#sync-badge"),
    synced: () => waitFor(async () => /Salvo na nuvem/.test(await page.locator("#sync-badge").innerText().catch(() => "")), "selo 'Salvo na nuvem'"),
    async addMed({ name, dose = "", times = [] }) {
      await page.getByRole("button", { name: /Novo remédio/ }).first().click();
      await page.getByLabel("Nome", { exact: true }).fill(name);
      await page.getByLabel("Dose", { exact: true }).fill(dose);
      for (const t of times) {
        await page.locator("#f-time").fill(t);
        await page.getByRole("button", { name: "Adicionar" }).click();
      }
      await page.getByRole("button", { name: "Salvar" }).click();
      await page.locator("dialog.sheet").waitFor({ state: "detached" });
    },
    shot: (name) => page.screenshot({ path: `${SHOTS}${name}.png`, fullPage: false }),
    shotFull: (name) => page.screenshot({ path: `${SHOTS}${name}.png`, fullPage: true }),
  };
  return a;
}

const toastLocator = (page, text) => page.locator("#toasts .toast", { hasText: text });

test("sem configurar o Supabase o app explica o que falta (e não quebra)", async () => {
  const a = await app({ configured: false });
  try {
    await a.open();
    await a.page.getByText("Falta configurar").waitFor();
    assert.deepEqual(a.problems, []);
  } finally { await a.close(); }
});

test("login: senha errada mostra o erro em português; a certa leva para a tela Hoje vazia", async () => {
  const a = await app();
  try {
    await a.open();
    await a.shot("00-login");
    await a.page.getByLabel("E-mail").fill(EMAIL);
    await a.page.getByLabel("Senha").fill("errada");
    await a.page.getByRole("button", { name: "Entrar" }).click();
    await a.page.getByText("E-mail ou senha incorretos.").waitFor();
    await a.page.getByLabel("Senha").fill(PASS);
    await a.page.getByRole("button", { name: "Entrar" }).click();
    await a.page.getByRole("heading", { name: "Cadastre seu primeiro remédio" }).waitFor();
    await a.synced();
    assert.deepEqual(a.problems, []);
  } finally { await a.close(); }
});

test("fluxo principal: cadastrar → Tomei agora → duplicata → desfazer → outro horário → nuvem", async () => {
  const a = await app();
  try {
    await a.open();
    await a.login();
    await a.addMed({ name: "Losartana", dose: "50 mg", times: ["08:00", "20:00"] });
    const card = a.page.getByRole("article", { name: "Losartana" });
    await card.waitFor();
    assert.equal(await card.locator(".cell").count(), 2);
    assert.match(await card.innerText(), /08:00/);
    assert.match(await card.innerText(), /20:00/);

    // 1) Tomei agora
    await card.getByRole("button", { name: "Tomei agora" }).click();
    await toastLocator(a.page, "Losartana registrado às").waitFor();
    assert.equal(await a.page.locator(".timeline .entry").count(), 1);
    await waitFor(() => a.fake.table("intakes").length === 1, "dose chegou ao servidor");
    assert.equal(a.fake.table("intakes")[0].med_name, "Losartana");
    await a.synced();

    // 2) segundo toque logo em seguida: pergunta antes
    await card.getByRole("button", { name: "Tomei agora" }).click();
    await a.page.getByText("Você já registrou há pouco").waitFor();
    await a.page.getByRole("button", { name: "Cancelar" }).click();
    assert.equal(await a.page.locator(".timeline .entry").count(), 1, "cancelou: nada novo");

    // 3) confirma mesmo assim
    await card.getByRole("button", { name: "Tomei agora" }).click();
    await a.page.getByRole("button", { name: "Registrar de novo" }).click();
    await waitFor(async () => (await a.page.locator(".timeline .entry").count()) === 2, "2 registros");

    // 4) desfazer (pelo aviso) e refazer
    await toastLocator(a.page, "registrado às").last().getByRole("button", { name: "Desfazer" }).click();
    await waitFor(async () => (await a.page.locator(".timeline .entry").count()) === 1, "voltou a 1 registro");
    await toastLocator(a.page, "Registro desfeito").getByRole("button", { name: "Refazer" }).click();
    await waitFor(async () => (await a.page.locator(".timeline .entry").count()) === 2, "refeito");

    // 5) tomei em outro horário (1 h atrás)
    await card.getByRole("button", { name: "Tomei em outro horário" }).click();
    const earlier = await a.page.evaluate(async () => (await import("/js/util.js")).toLocalInput(new Date(Date.now() - 3600_000)));
    await a.page.getByLabel("Quando você tomou?").fill(earlier);
    await a.page.getByLabel("Observação").fill("depois do almoço");
    await a.page.getByRole("button", { name: "Registrar" }).click();
    await waitFor(async () => (await a.page.locator(".timeline .entry").count()) === 3, "3 registros");
    await a.synced();
    assert.equal(a.fake.table("intakes").filter((i) => !i.deleted_at).length, 3);
    assert.ok(a.fake.table("intakes").some((i) => i.note === "depois do almoço"));
    assert.deepEqual(a.problems, []);
  } finally { await a.close(); }
});

test("OFFLINE de verdade: registra sem internet, fecha e reabre o app sem internet (cache do SW), e sobe ao reconectar", async () => {
  const a = await app();
  try {
    await a.open();
    await a.login();
    await a.addMed({ name: "Losartana", dose: "50 mg", times: ["08:00"] });
    await a.synced();
    // espera o service worker assumir o controle (necessário para abrir offline)
    await a.page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
    await waitFor(() => a.page.evaluate(() => !!navigator.serviceWorker.controller), "service worker controlando a página");

    await a.ctx.setOffline(true);
    await a.page.getByRole("button", { name: "Tomei agora" }).click();
    await toastLocator(a.page, "Losartana registrado às").waitFor();
    await waitFor(async () => /Offline · 1 pendente/.test(await a.badge().innerText()), "selo 'Offline · 1 pendente'");
    assert.equal(a.fake.table("intakes").length, 0);

    await a.page.reload(); // reabrir o app SEM internet
    await a.page.getByRole("article", { name: "Losartana" }).waitFor();
    assert.equal(await a.page.locator(".timeline .entry").count(), 1, "o registro feito offline continua lá");
    assert.match(await a.page.locator(".timeline .entry").first().innerText(), /Pendente/);

    await a.ctx.setOffline(false);
    await a.synced();
    await waitFor(() => a.fake.table("intakes").length === 1, "dose subiu ao reconectar");
    assert.equal(await a.page.locator(".entry .meta.pending").count(), 0);
  } finally { await a.close(); }
});

test("histórico, edição e remoção; remédios: arquivar e desarquivar", async () => {
  const a = await app();
  try {
    await a.open();
    await a.login();
    await a.addMed({ name: "Losartana", dose: "50 mg", times: ["08:00"] });
    await a.page.getByRole("button", { name: "Tomei agora" }).click();
    await a.tab("Histórico");
    await a.page.getByRole("heading", { name: /^Hoje/ }).waitFor();
    await a.page.locator(".entry").first().click();
    await a.page.getByLabel("Observação").fill("tomei com água");
    await a.page.getByRole("button", { name: "Salvar" }).click();
    await a.page.locator(".entry", { hasText: "tomei com água" }).waitFor();

    await a.page.locator(".entry").first().click();
    await a.page.getByRole("button", { name: "Remover este registro" }).click();
    await a.page.getByText("Nada registrado ainda").waitFor();
    await waitFor(() => a.fake.table("intakes")[0]?.deleted_at, "soft delete chegou ao servidor");
    assert.equal(a.fake.table("intakes").length, 1, "continua no servidor, só marcado como desfeito");

    await a.tab("Remédios");
    await a.page.getByRole("button", { name: /Losartana/ }).click();
    await a.page.getByRole("button", { name: "Arquivar remédio" }).click();
    await a.page.getByRole("button", { name: "Arquivar", exact: true }).click();
    await a.page.getByText("Nenhum remédio cadastrado ainda.").waitFor();
    await a.page.getByRole("button", { name: /Ver arquivados/ }).click();
    await a.page.getByRole("button", { name: /Losartana/ }).click();
    await a.page.getByRole("button", { name: "Desarquivar" }).click();
    await a.tab("Hoje");
    await a.page.getByRole("article", { name: "Losartana" }).waitFor();
    assert.deepEqual(a.problems, []);
  } finally { await a.close(); }
});

test("backup: exporta JSON (com doses desfeitas) e CSV (com BOM, separador ;)", async () => {
  const a = await app();
  try {
    await a.open();
    await a.login();
    await a.addMed({ name: "Losartana", dose: "50 mg", times: ["08:00"] });
    await a.page.getByRole("button", { name: "Tomei agora" }).click();
    await a.tab("Ajustes");

    const [jsonDl] = await Promise.all([a.page.waitForEvent("download"), a.page.getByRole("button", { name: /Exportar backup/ }).click()]);
    assert.match(jsonDl.suggestedFilename(), /^tomei-backup-\d+\.json$/);
    const dump = JSON.parse(fs.readFileSync(await jsonDl.path(), "utf8"));
    assert.equal(dump.app, "tomei");
    assert.equal(dump.medications[0].name, "Losartana");
    assert.equal(dump.intakes.length, 1);

    const [csvDl] = await Promise.all([a.page.waitForEvent("download"), a.page.getByRole("button", { name: /Exportar planilha/ }).click()]);
    const csv = fs.readFileSync(await csvDl.path(), "utf8");
    assert.ok(csv.startsWith("﻿Data;Hora;Remédio;Dose;Observação"));
    assert.match(csv, /;Losartana;50 mg;/);
    await a.page.getByText(/Último backup/).waitFor();
  } finally { await a.close(); }
});

test("sair da conta NÃO apaga os dados: ao entrar de novo tudo continua", async () => {
  const a = await app();
  try {
    await a.open();
    await a.login();
    await a.addMed({ name: "Losartana", dose: "50 mg", times: ["08:00"] });
    await a.page.getByRole("button", { name: "Tomei agora" }).click();
    await a.synced();
    await a.tab("Ajustes");
    await a.page.getByRole("button", { name: "Sair da conta" }).click();
    await a.page.locator("dialog.confirm").getByRole("button", { name: "Sair" }).click();
    await a.page.getByRole("button", { name: "Entrar" }).waitFor();
    await a.login();
    await a.tab("Hoje");
    await a.page.getByRole("article", { name: "Losartana" }).waitFor();
    assert.equal(await a.page.locator(".timeline .entry").count(), 1);
  } finally { await a.close(); }
});

test("lembretes: ativar (inscrição vai ao servidor), testar, desativar", async () => {
  const a = await app({ stubPush: true });
  try {
    await a.open();
    await a.login();
    await a.addMed({ name: "Losartana", dose: "50 mg", times: ["08:00"] });
    // o aviso na tela Hoje oferece ativar
    await a.page.getByRole("heading", { name: "Ative os lembretes" }).waitFor();
    await a.tab("Ajustes");
    await a.page.getByRole("button", { name: "Ativar lembretes" }).click();
    await toastLocator(a.page, "Lembretes ativados").waitFor();
    await a.page.getByText("Ativadas neste aparelho").waitFor();
    await waitFor(() => a.fake.table("push_subscriptions").length === 1, "inscrição no servidor");
    const sub = a.fake.table("push_subscriptions")[0];
    assert.equal(sub.endpoint, "https://push.example.test/e2e-device");
    assert.equal(sub.user_id, a.uid);
    assert.ok(sub.p256dh && sub.auth_secret);

    await a.page.getByRole("button", { name: "Enviar notificação de teste" }).click();
    await toastLocator(a.page, "Enviado!").waitFor();
    assert.ok(a.fake.state.log.some((l) => l.method === "POST" && l.path === "/functions/v1/send-reminders"));

    await a.page.getByRole("button", { name: "Desativar" }).click();
    await waitFor(() => a.fake.table("push_subscriptions").length === 0, "inscrição removida do servidor");
    assert.deepEqual(a.problems, []);
  } finally { await a.close(); }
});

test("tocar na notificação abre o app já pedindo para registrar aquela dose (?take=)", async () => {
  const a = await app();
  try {
    await a.open();
    await a.login();
    await a.addMed({ name: "Losartana", dose: "50 mg", times: ["08:00"] });
    await waitFor(() => a.fake.table("medications").length === 1, "remédio no servidor");
    await a.synced();
    const medId = a.fake.table("medications")[0].id;
    await a.page.goto(`${a.url}/?take=${medId}`);
    const dlg = a.page.locator("dialog.confirm");
    await dlg.getByRole("heading", { name: "Registrar Losartana?" }).waitFor();
    assert.equal(new URL(a.page.url()).search, "", "a URL foi limpa");
    await dlg.getByRole("button", { name: "Tomei agora" }).click();
    await waitFor(async () => (await a.page.locator(".timeline .entry").count()) === 1, "dose registrada");
    await a.synced();
    assert.equal(a.fake.table("intakes").length, 1);
  } finally { await a.close(); }
});

test("dias da semana: escolher no app, ver na lista, e o cartão de Hoje respeita o dia", async () => {
  const a = await app({ clockAt: "2026-11-01T09:10:00-03:00" }); // domingo
  try {
    await a.open();
    await a.login();
    await a.page.getByRole("button", { name: "Novo remédio" }).first().click();
    await a.page.getByLabel("Nome", { exact: true }).fill("Vitamina C");
    await a.page.locator("#f-time").fill("08:00");
    await a.page.getByRole("button", { name: "Adicionar" }).click();

    // padrão: "Todos os dias", sem a grade de dias
    const all = a.page.getByRole("button", { name: "Todos os dias" });
    const some = a.page.getByRole("button", { name: "Dias específicos" });
    assert.equal(await all.getAttribute("aria-pressed"), "true");
    assert.equal(await a.page.locator(".weekdays").isVisible(), false);

    // dias específicos: começa em seg–sex; tira quarta e põe sábado
    await some.click();
    assert.equal(await a.page.locator(".weekdays").isVisible(), true);
    const pressed = async () => a.page.evaluate(() => [...document.querySelectorAll(".day")].filter((b) => b.getAttribute("aria-pressed") === "true").map((b) => b.textContent));
    assert.deepEqual(await pressed(), ["seg", "ter", "qua", "qui", "sex"]);
    await a.page.locator(".day", { hasText: "qua" }).click();
    await a.page.locator(".day", { hasText: "sáb" }).click();
    assert.deepEqual(await pressed(), ["seg", "ter", "qui", "sex", "sáb"]);
    await a.page.getByText(/só valem em: seg, ter, qui, sex e sáb/).waitFor();

    // não deixa desmarcar tudo
    for (const d of ["seg", "ter", "qui", "sex"]) await a.page.locator(".day", { hasText: d }).click();
    await a.page.locator(".day", { hasText: "sáb" }).click();
    await a.page.getByText("Deixe pelo menos um dia marcado.").waitFor();
    assert.deepEqual(await pressed(), ["sáb"]);
    for (const d of ["seg", "ter", "qui", "sex"]) await a.page.locator(".day", { hasText: d }).click();

    await a.page.getByRole("button", { name: "Salvar" }).click();
    await a.page.locator("dialog.sheet").waitFor({ state: "detached" });

    // domingo: hoje NÃO é dia → aviso, nenhuma cavidade, mas "Tomei agora" continua disponível
    const card = a.page.getByRole("article", { name: "Vitamina C" });
    await card.getByText("Hoje não é dia deste remédio · Seg, ter, qui, sex e sáb").waitFor();
    assert.equal(await card.locator(".cell").count(), 0);
    await card.getByRole("button", { name: "Tomei agora" }).waitFor();
    await waitFor(() => a.fake.table("medications")[0]?.weekdays?.join() === "1,2,4,5,6", "dias no servidor");

    // segunda-feira: vira dia do remédio → aparece a cavidade das 08:00 (atrasada, já são 09:10)
    await a.page.clock.setSystemTime(new Date("2026-11-02T09:10:00-03:00"));
    await a.tab("Remédios");
    await a.page.locator(".row-card", { hasText: "Vitamina C" }).getByText("Seg, ter, qui, sex e sáb").waitFor();
    await a.tab("Hoje");
    await card.locator(".cell.late").waitFor();

    // voltar para "Todos os dias"
    await a.tab("Remédios");
    await a.page.locator(".row-card", { hasText: "Vitamina C" }).click();
    assert.equal(await a.page.getByRole("button", { name: "Dias específicos" }).getAttribute("aria-pressed"), "true", "abriu já em 'Dias específicos'");
    assert.deepEqual(await pressed(), ["ter", "qui", "sex", "sáb", "seg"].sort((x, y) => ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"].indexOf(x) - ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"].indexOf(y)));
    await a.page.getByRole("button", { name: "Todos os dias" }).click();
    await a.page.getByRole("button", { name: "Salvar" }).click();
    await a.page.locator("dialog.sheet").waitFor({ state: "detached" });
    await waitFor(() => a.fake.table("medications")[0]?.weekdays?.join() === "0,1,2,3,4,5,6", "todos os dias no servidor");
    assert.deepEqual(a.problems, []);
  } finally { await a.close(); }
});

// ---------- visual: capturas e verificações básicas de layout ----------
const NOW = "2026-11-01T09:10:00-03:00";
const seedShowcase = (fake, uid) => {
  const iso = (s) => new Date(s).toISOString();
  const med = (id, name, dose, times, extra = {}) => ({ id, user_id: uid, name, dose, notes: "", times, archived_at: null, created_at: "2026-10-01T10:00:00.000000+00:00", updated_at: "2026-10-01T10:00:00.000001+00:00", ...extra });
  let n = 0;
  const dose = (medId, name, dos, at, extra = {}) => ({ id: `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`, user_id: uid, medication_id: medId, med_name: name, med_dose: dos, taken_at: iso(at), note: "", deleted_at: null, created_at: iso(at), updated_at: `2026-11-01T11:${String(n).padStart(2, "0")}:00.000000+00:00`, ...extra });
  const L = "11111111-1111-4111-8111-111111111111", M = "22222222-2222-4222-8222-222222222222", V = "33333333-3333-4333-8333-333333333333", O = "44444444-4444-4444-8444-444444444444";
  fake.table("medications").push(
    med(L, "Losartana", "50 mg", ["08:00", "20:00"]),
    med(M, "Metformina", "850 mg", ["07:00", "09:00", "21:00"]),
    med(V, "Vitamina D", "2000 UI", ["06:30"]),
    med(O, "Antibiótico (terminou)", "", [], { archived_at: "2026-10-20T00:00:00.000Z" }),
  );
  fake.table("intakes").push(
    dose(L, "Losartana", "50 mg", "2026-11-01T08:03:00-03:00"),
    dose(M, "Metformina", "850 mg", "2026-11-01T07:10:00-03:00"),
    dose(L, "Losartana", "50 mg", "2026-10-31T20:05:00-03:00"),
    dose(M, "Metformina", "850 mg", "2026-10-31T21:02:00-03:00"),
    dose(V, "Vitamina D", "2000 UI", "2026-10-31T06:41:00-03:00", { note: "com o café" }),
    dose(L, "Losartana", "50 mg", "2026-10-30T08:00:00-03:00"),
  );
};

for (const scheme of ["light", "dark"]) {
  test(`visual (${scheme}): telas principais, sem rolagem horizontal e com alvos de toque grandes`, async () => {
    const a = await app({ colorScheme: scheme, clockAt: NOW, seed: seedShowcase });
    try {
      await a.open();
      await a.login();
      await a.page.getByRole("article", { name: "Metformina" }).waitFor();
      await a.synced();
      await a.shot(`${scheme}-1-hoje`);
      await a.shotFull(`${scheme}-1b-hoje-completa`);

      // estados das cavidades: tomado / agora / atrasado / por vir
      const status = await a.page.evaluate(() => [...document.querySelectorAll(".cell")].map((c) => `${c.closest("article").getAttribute("aria-label")} ${c.querySelector(".cell-time").textContent}:${[...c.classList].filter((k) => ["taken", "due", "late", "upcoming"].includes(k))[0]}`));
      assert.deepEqual(status.sort(), [
        "Losartana 08:00:taken", "Losartana 20:00:upcoming",
        "Metformina 07:00:taken", "Metformina 09:00:due", "Metformina 21:00:upcoming",
        "Vitamina D 06:30:late",
      ].sort());

      // layout
      const layout = await a.page.evaluate(() => ({
        overflowX: document.documentElement.scrollWidth - window.innerWidth,
        smallTargets: [...document.querySelectorAll("button, a, input, textarea")].filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.height < 40 && !el.classList.contains("link"); }).map((el) => el.textContent.trim().slice(0, 30)),
      }));
      assert.equal(layout.overflowX <= 0, true, `rolagem horizontal: ${layout.overflowX}px`);
      assert.deepEqual(layout.smallTargets, [], "botões pequenos demais para o dedo");

      await a.tab("Histórico");
      await a.page.getByRole("heading", { name: /^Hoje/ }).waitFor();
      await a.shot(`${scheme}-2-historico`);
      await a.tab("Remédios");
      await a.shot(`${scheme}-3-remedios`);
      await a.page.getByRole("button", { name: "Novo remédio" }).click();
      await a.page.locator("#f-name").fill("Omeprazol");
      await a.page.locator("#f-time").fill("07:30");
      await a.page.getByRole("button", { name: "Adicionar" }).click();
      await a.page.getByRole("button", { name: "Dias específicos" }).click();
      await a.page.locator(".day", { hasText: "qua" }).click();
      await a.page.locator("#f-days-label").scrollIntoViewIfNeeded();
      await a.shot(`${scheme}-4-novo-remedio`);
      await a.page.getByRole("button", { name: "Fechar" }).click();
      await a.tab("Ajustes");
      await a.shotFull(`${scheme}-5-ajustes`);
      assert.deepEqual(a.problems, []);
    } finally { await a.close(); }
  });
}

test("visual: Hoje logo depois de tocar em 'Tomei agora' (cavidade preenchida + aviso)", async () => {
  const a = await app({ clockAt: NOW, seed: seedShowcase });
  try {
    await a.open();
    await a.login();
    await a.page.getByRole("article", { name: "Vitamina D" }).waitFor();
    await a.page.getByRole("article", { name: "Vitamina D" }).getByRole("button", { name: "Tomei agora" }).click();
    await toastLocator(a.page, "Vitamina D registrado às 09:10").waitFor();
    await a.page.waitForTimeout(700);
    await a.shot("light-6-depois-de-tomar");
    const cls = await a.page.getByRole("article", { name: "Vitamina D" }).locator(".cell").first().getAttribute("class");
    assert.match(cls, /taken/);
  } finally { await a.close(); }
});
