// Testes da lógica pura de lembretes (due.ts + messages.ts). Rode: node --test test/
import test from "node:test";
import assert from "node:assert/strict";
import {
  computeDue, wallTimeToInstant, localDate, addDays, reminderKey, weekdayOf,
  GRACE_MIN, NAG_AFTER_MIN,
} from "../supabase/functions/send-reminders/due.ts";
import { buildMessages, joinPt } from "../supabase/functions/send-reminders/messages.ts";

const SP = "America/Sao_Paulo"; // UTC-3, sem horário de verão desde 2019
const med = (over = {}) => ({ id: "m1", name: "Losartana", dose: "50 mg", times: ["08:00"], ...over });
// "agora" = hh:mm no relógio de São Paulo em 2026-11-01 (UTC-3)
const at = (hhmm, day = "2026-11-01") => wallTimeToInstant(day, hhmm, SP);
const minutes = (date, n) => new Date(date.getTime() + n * 60_000);
const due = (over) => computeDue({ tz: SP, medications: [med()], intakes: [], ...over });

test("wallTimeToInstant: São Paulo é UTC-3", () => {
  assert.equal(wallTimeToInstant("2026-11-01", "08:00", SP).toISOString(), "2026-11-01T11:00:00.000Z");
  assert.equal(wallTimeToInstant("2026-11-01", "23:30", SP).toISOString(), "2026-11-02T02:30:00.000Z");
});

test("wallTimeToInstant: respeita horário de verão (Nova York)", () => {
  const NY = "America/New_York";
  assert.equal(wallTimeToInstant("2026-03-07", "08:00", NY).toISOString(), "2026-03-07T13:00:00.000Z"); // EST
  assert.equal(wallTimeToInstant("2026-03-08", "08:00", NY).toISOString(), "2026-03-08T12:00:00.000Z"); // EDT (virou 02:00→03:00)
  assert.equal(wallTimeToInstant("2026-11-01", "08:00", NY).toISOString(), "2026-11-01T13:00:00.000Z"); // voltou para EST
});

test("localDate / addDays", () => {
  assert.equal(localDate(new Date("2026-11-01T02:30:00Z"), SP), "2026-10-31"); // ainda é o dia anterior em SP
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(addDays("2026-03-01", -1), "2026-02-28");
});

test("no horário exato: lembrete kind 0", () => {
  const r = due({ now: at("08:00") });
  assert.equal(r.length, 1);
  assert.deepEqual([r[0].slot, r[0].kind, r[0].localDate], ["08:00", 0, "2026-11-01"]);
});

test("janela de tolerância do cron: vale até GRACE_MIN, não depois", () => {
  assert.equal(due({ now: minutes(at("08:00"), GRACE_MIN - 1) }).length, 1);
  assert.equal(due({ now: minutes(at("08:00"), GRACE_MIN) }).length, 0);
});

test("antes do horário não avisa", () => {
  assert.equal(due({ now: minutes(at("08:00"), -1) }).length, 0);
});

test("lembrete extra (kind 1) só depois de NAG_AFTER_MIN, se não registrou", () => {
  const n = NAG_AFTER_MIN[0];
  assert.equal(due({ now: minutes(at("08:00"), n - 1) }).length, 0);
  const r = due({ now: minutes(at("08:00"), n) });
  assert.equal(r.length, 1);
  assert.equal(r[0].kind, 1);
  assert.equal(due({ now: minutes(at("08:00"), n + GRACE_MIN) }).length, 0);
});

test("dose registrada logo antes do horário (10 min) → não avisa", () => {
  const intakes = [{ medication_id: "m1", taken_at: minutes(at("08:00"), -10).toISOString() }];
  assert.equal(due({ now: at("08:00"), intakes }).length, 0);
});

test("dose registrada 2 h antes NÃO vale para este horário", () => {
  const intakes = [{ medication_id: "m1", taken_at: minutes(at("08:00"), -120).toISOString() }];
  assert.equal(due({ now: at("08:00"), intakes }).length, 1);
});

test("dose registrada depois do aviso cancela o lembrete extra", () => {
  const n = NAG_AFTER_MIN[0];
  const intakes = [{ medication_id: "m1", taken_at: minutes(at("08:00"), 5).toISOString() }];
  assert.equal(due({ now: minutes(at("08:00"), n), intakes }).length, 0);
});

test("dose de OUTRO remédio não cancela", () => {
  const intakes = [{ medication_id: "outro", taken_at: at("08:00").toISOString() }];
  assert.equal(due({ now: at("08:00"), intakes }).length, 1);
});

test("dois horários colados (08:00 e 09:00): dose das 07:50 vale para as 08:00, não para as 09:00", () => {
  const m = med({ times: ["08:00", "09:00"] });
  const intakes = [{ medication_id: "m1", taken_at: at("07:50").toISOString() }];
  assert.equal(computeDue({ tz: SP, now: at("08:00"), medications: [m], intakes }).length, 0);
  const r = computeDue({ tz: SP, now: at("09:00"), medications: [m], intakes });
  assert.equal(r.length, 1);
  assert.equal(r[0].slot, "09:00");
});

test("virada da meia-noite: horário 23:58 ainda gera lembrete extra depois das 00:00 (data = ontem)", () => {
  const m = med({ times: ["23:58"] });
  const now = minutes(at("23:58", "2026-11-01"), 16); // 00:14 do dia 2
  const r = computeDue({ tz: SP, now, medications: [m], intakes: [] });
  assert.equal(r.length, 1);
  assert.deepEqual([r[0].localDate, r[0].kind], ["2026-11-01", 1]);
});

test("horários inválidos e duplicados são ignorados", () => {
  const m = med({ times: ["8:00", "25:00", "08:00", "08:00", "xx"] });
  const r = computeDue({ tz: SP, now: at("08:00"), medications: [m], intakes: [] });
  assert.equal(r.length, 1);
});

test("remédio sem horários não gera nada", () => {
  assert.equal(due({ now: at("08:00"), medications: [med({ times: [] })] }).length, 0);
});

test("o fuso da pessoa manda (Tóquio)", () => {
  const TK = "Asia/Tokyo";
  const now = wallTimeToInstant("2026-11-01", "08:00", TK);
  assert.equal(computeDue({ tz: TK, now, medications: [med()], intakes: [] }).length, 1);
  assert.equal(computeDue({ tz: SP, now, medications: [med()], intakes: [] }).length, 0);
});

test("chave já enviada (sent) é pulada", () => {
  const sent = new Set([reminderKey("m1", "2026-11-01", "08:00", 0)]);
  assert.equal(due({ now: at("08:00"), sent }).length, 0);
});

test("vários remédios no mesmo horário viram UMA notificação", () => {
  const meds = [med(), med({ id: "m2", name: "Vitamina D", dose: "" })];
  const r = computeDue({ tz: SP, now: at("08:00"), medications: meds, intakes: [] });
  assert.equal(r.length, 2);
  const groups = buildMessages(r);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].message.body, "Losartana 50 mg e Vitamina D (08:00)");
  assert.equal(groups[0].message.url, "./");
  assert.equal(groups[0].members.length, 2);
});

test("um remédio só: o toque abre direto a confirmação dele", () => {
  const g = buildMessages(due({ now: at("08:00") }));
  assert.equal(g[0].message.url, "./?take=m1");
  assert.equal(g[0].message.title, "Hora do remédio");
});

test("lembrete extra usa a mesma tag (substitui o primeiro) e outro texto", () => {
  const first = buildMessages(due({ now: at("08:00") }))[0].message;
  const nag = buildMessages(due({ now: minutes(at("08:00"), NAG_AFTER_MIN[0]) }))[0].message;
  assert.equal(first.tag, nag.tag);
  assert.equal(nag.title, "Você já tomou?");
});

test("joinPt", () => {
  assert.equal(joinPt([]), "");
  assert.equal(joinPt(["A"]), "A");
  assert.equal(joinPt(["A", "B"]), "A e B");
  assert.equal(joinPt(["A", "B", "C"]), "A, B e C");
});

// ---------- dias da semana ----------
// 2026-11-01 é domingo; 2026-11-02 é segunda; 2026-11-03 é terça.
test("weekdayOf: 0 = domingo ... 6 = sábado", () => {
  assert.equal(weekdayOf("2026-11-01"), 0);
  assert.equal(weekdayOf("2026-11-02"), 1);
  assert.equal(weekdayOf("2026-11-07"), 6);
});

test("dias específicos: só avisa nos dias marcados (seg e qua)", () => {
  const m = med({ weekdays: [1, 3] });
  const run = (day) => computeDue({ tz: SP, now: at("08:00", day), medications: [m], intakes: [] }).length;
  assert.equal(run("2026-11-01"), 0, "domingo: não");
  assert.equal(run("2026-11-02"), 1, "segunda: sim");
  assert.equal(run("2026-11-03"), 0, "terça: não");
  assert.equal(run("2026-11-04"), 1, "quarta: sim");
});

test("sem weekdays (remédio antigo) ou lista vazia = todos os dias", () => {
  for (const weekdays of [undefined, null, []]) {
    const m = med({ weekdays });
    assert.equal(computeDue({ tz: SP, now: at("08:00", "2026-11-01"), medications: [m], intakes: [] }).length, 1);
  }
});

test("virada da meia-noite respeita o dia DO HORÁRIO: 23:58 de segunda ainda lembra na terça 00:14, mesmo que terça não seja dia", () => {
  const m = med({ times: ["23:58"], weekdays: [1] }); // só segunda
  const now = minutes(at("23:58", "2026-11-02"), 16); // terça 00:14
  const r = computeDue({ tz: SP, now, medications: [m], intakes: [] });
  assert.equal(r.length, 1);
  assert.deepEqual([r[0].localDate, r[0].kind], ["2026-11-02", 1]);
});

test("a janela de 'dose antecipada' ignora o horário de um dia não marcado", () => {
  // só segunda e quarta, às 08:00. Uma dose na terça às 07:50 NÃO é "dose antecipada" da quarta (é de outro dia, longe).
  const m = med({ weekdays: [1, 3] });
  const intakes = [{ medication_id: "m1", taken_at: at("07:50", "2026-11-03").toISOString() }];
  assert.equal(computeDue({ tz: SP, now: at("08:00", "2026-11-04"), medications: [m], intakes }).length, 1);
});
