// Testes das regras de exibição (logic.js) e utilidades (util.js).
import "./pin_tz.mjs"; // fixa o fuso (America/Sao_Paulo) antes de carregar o app — precisa ser o 1º import
import test from "node:test";
import assert from "node:assert/strict";
import { matchSlots, slotStatus, buildToday, groupByDay, todaysIntakes, DUE_WINDOW_MIN } from "../public/js/logic.js";
import { tsMs, toIso, normalizeTimes, ago, inFuture, toCsv, dayLabel, dayDiff, hhmm, toLocalInput, normalizeWeekdays, weekdaysLabel, ALL_DAYS } from "../public/js/util.js";

const d = (s) => new Date(s); // "2026-11-01T08:00:00-03:00"
const NOW = d("2026-11-01T10:00:00-03:00");
const intake = (id, med, at, extra = {}) => ({ id, medication_id: med, taken_at: d(at).toISOString(), deleted_at: null, med_name: "X", ...extra });
const med = (over = {}) => ({ id: "m1", name: "Losartana", dose: "50 mg", times: ["08:00", "20:00"], archived_at: null, ...over });

test("util: tsMs entende microssegundos do Postgres; toIso padroniza", () => {
  assert.equal(tsMs("2026-11-01T11:00:00.123456+00:00"), Date.parse("2026-11-01T11:00:00.123Z"));
  assert.equal(toIso("2026-11-01T11:00:00+00:00"), "2026-11-01T11:00:00.000Z");
  assert.equal(toIso(null), null);
  assert.equal(toIso(""), null);
});

test("util: normalizeTimes remove inválidos/repetidos e ordena", () => {
  assert.deepEqual(normalizeTimes(["20:00", "8:00", "08:00", "08:00", "25:00", "x"]), ["08:00", "20:00"]);
  assert.deepEqual(normalizeTimes(undefined), []);
});

test("util: ago / inFuture", () => {
  assert.equal(ago(10_000), "agora há pouco");
  assert.equal(ago(12 * 60_000), "há 12 min");
  assert.equal(ago(125 * 60_000), "há 2 h 5 min");
  assert.equal(ago(120 * 60_000), "há 2 h");
  assert.equal(ago(26 * 3600_000), "há 1 dia");
  assert.equal(ago(72 * 3600_000), "há 3 dias");
  assert.equal(inFuture(40 * 60_000), "em 40 min");
  assert.equal(inFuture(150 * 60_000), "em 2 h 30 min");
});

test("util: hhmm, dayLabel, dayDiff e toLocalInput usam o relógio local", () => {
  assert.equal(hhmm(d("2026-11-01T08:03:30-03:00")), "08:03");
  assert.equal(dayLabel(NOW, NOW), "Hoje");
  assert.equal(dayLabel(d("2026-10-31T22:00:00-03:00"), NOW), "Ontem");
  assert.match(dayLabel(d("2026-10-28T22:00:00-03:00"), NOW), /qua/i);
  assert.equal(dayDiff(d("2026-10-30T23:59:00-03:00"), NOW), 2);
  assert.equal(toLocalInput(d("2026-11-01T08:03:00-03:00")), "2026-11-01T08:03");
});

test("util: toCsv escapa ; aspas e quebras de linha, com BOM", () => {
  const out = toCsv([["a", 'b"c', "d;e", "f\ng"]]);
  assert.ok(out.startsWith("﻿"));
  assert.equal(out.slice(1), 'a;"b""c";"d;e";"f\ng"\r\n');
});

test("matchSlots: a dose vai para o horário mais próximo", () => {
  const { slots, extras } = matchSlots(["08:00", "20:00"], [intake("a", "m1", "2026-11-01T19:10:00-03:00")], NOW);
  assert.equal(slots[0].intake, null);
  assert.equal(slots[1].intake.id, "a");
  assert.equal(extras.length, 0);
});

test("matchSlots: duas doses preenchem os dois horários; a terceira é extra", () => {
  const list = [
    intake("a", "m1", "2026-11-01T07:55:00-03:00"),
    intake("b", "m1", "2026-11-01T20:05:00-03:00"),
    intake("c", "m1", "2026-11-01T21:00:00-03:00"),
  ];
  const { slots, extras } = matchSlots(["08:00", "20:00"], list, NOW);
  assert.deepEqual(slots.map((s) => s.intake.id), ["a", "b"]);
  assert.deepEqual(extras.map((e) => e.id), ["c"]);
});

test("matchSlots: remédio sem horário fixo → toda dose é extra", () => {
  const { slots, extras } = matchSlots([], [intake("a", "m1", "2026-11-01T09:00:00-03:00")], NOW);
  assert.equal(slots.length, 0);
  assert.equal(extras.length, 1);
});

test("slotStatus: upcoming → due → late; taken tem prioridade", () => {
  const slot = { at: d("2026-11-01T08:00:00-03:00"), intake: null };
  assert.equal(slotStatus(slot, d("2026-11-01T07:59:00-03:00")), "upcoming");
  assert.equal(slotStatus(slot, d("2026-11-01T08:00:00-03:00")), "due");
  assert.equal(slotStatus(slot, new Date(slot.at.getTime() + (DUE_WINDOW_MIN - 1) * 60_000)), "due");
  assert.equal(slotStatus(slot, new Date(slot.at.getTime() + DUE_WINDOW_MIN * 60_000)), "late");
  assert.equal(slotStatus({ ...slot, intake: {} }, d("2026-11-01T23:00:00-03:00")), "taken");
});

test("buildToday: status por horário, resumo e última dose (mesmo de outro dia)", () => {
  const meds = [med(), med({ id: "m2", name: "Vitamina D", dose: "", times: [] }), med({ id: "m3", name: "Antigo", archived_at: "2026-10-01T00:00:00Z" })];
  const intakes = [
    intake("a", "m1", "2026-11-01T08:03:00-03:00"),
    intake("old", "m2", "2026-10-30T09:00:00-03:00"),
    intake("gone", "m1", "2026-11-01T09:00:00-03:00", { deleted_at: "2026-11-01T09:01:00Z" }),
  ];
  const t = buildToday({ medications: meds, intakes, now: NOW });
  assert.deepEqual(t.items.map((i) => i.med.name), ["Losartana", "Vitamina D"], "arquivado some; ordem alfabética");
  const l = t.items[0];
  assert.deepEqual(l.slots.map((s) => s.status), ["taken", "upcoming"]);
  assert.equal(l.last.id, "a", "dose desfeita não conta como última");
  assert.equal(t.items[1].last.id, "old");
  assert.deepEqual([t.scheduled, t.done, t.late], [2, 1, 0]);
});

test("buildToday: horário que passou sem registro vira 'late' e entra no resumo", () => {
  const t = buildToday({ medications: [med()], intakes: [], now: NOW });
  assert.deepEqual(t.items[0].slots.map((s) => s.status), ["late", "upcoming"]);
  assert.equal(t.late, 1);
});

test("todaysIntakes: só hoje, sem desfeitas, mais recente primeiro", () => {
  const list = [
    intake("a", "m1", "2026-11-01T08:00:00-03:00"),
    intake("b", "m1", "2026-11-01T09:30:00-03:00"),
    intake("ontem", "m1", "2026-10-31T21:00:00-03:00"),
    intake("x", "m1", "2026-11-01T09:00:00-03:00", { deleted_at: "2026-11-01T09:05:00Z" }),
  ];
  assert.deepEqual(todaysIntakes(list, NOW).map((i) => i.id), ["b", "a"]);
});

test("groupByDay: agrupa por dia local, rótulos Hoje/Ontem, limite e contagem de ocultos", () => {
  const list = [
    intake("a", "m1", "2026-11-01T08:00:00-03:00"),
    intake("b", "m1", "2026-10-31T23:30:00-03:00"),
    intake("c", "m1", "2026-10-31T08:00:00-03:00"),
    intake("d", "m1", "2026-10-20T08:00:00-03:00"),
  ];
  const g = groupByDay(list, NOW, 2);
  assert.deepEqual(g.shown.map((x) => x.label), ["Hoje", "Ontem"]);
  assert.deepEqual(g.shown[1].items.map((i) => i.id), ["b", "c"], "mais recente primeiro dentro do dia");
  assert.equal(g.hidden, 1);
});

// ---------- dias da semana ----------
// NOW = domingo 2026-11-01 10:00 (getDay() = 0)
test("util: normalizeWeekdays e weekdaysLabel", () => {
  assert.deepEqual(normalizeWeekdays([3, 1, 1, 9, -1, "2", "x", 5.5]), [1, 2, 3]);
  assert.deepEqual(normalizeWeekdays(undefined), []);
  assert.equal(weekdaysLabel(undefined), "Todos os dias");
  assert.equal(weekdaysLabel(ALL_DAYS), "Todos os dias");
  assert.equal(weekdaysLabel([1, 2, 3, 4, 5]), "Dias úteis");
  assert.equal(weekdaysLabel([6, 0]), "Fins de semana");
  assert.equal(weekdaysLabel([1, 3, 5]), "Seg, qua e sex");
  assert.equal(weekdaysLabel([2]), "Ter");
});

test("buildToday: remédio de seg/qua NÃO tem horários no domingo, mas aceita 'Tomei agora' (dose vira extra)", () => {
  const m = med({ weekdays: [1, 3] });
  const sunday = buildToday({ medications: [m], intakes: [intake("a", "m1", "2026-11-01T09:00:00-03:00")], now: NOW });
  assert.equal(sunday.items[0].scheduledToday, false);
  assert.equal(sunday.items[0].slots.length, 0);
  assert.equal(sunday.items[0].extras.length, 1);
  assert.deepEqual([sunday.scheduled, sunday.done, sunday.late], [0, 0, 0], "não conta no resumo do dia");

  const monday = buildToday({ medications: [m], intakes: [], now: d("2026-11-02T10:00:00-03:00") });
  assert.equal(monday.items[0].scheduledToday, true);
  assert.equal(monday.items[0].slots.length, 2);
});

test("buildToday: sem weekdays (remédio antigo) vale todo dia", () => {
  for (const weekdays of [undefined, null, []]) {
    const t = buildToday({ medications: [med({ weekdays })], intakes: [], now: NOW });
    assert.equal(t.items[0].scheduledToday, true);
    assert.equal(t.items[0].slots.length, 2);
  }
});

test("matchSlots: dose marcada na bolinha fica no horário escolhido, mesmo que o outro esteja mais perto", () => {
  // 12:55 está mais perto de 12:00, mas a pessoa tocou na bolinha das 08:00
  const list = [intake("a", "m1", "2026-11-01T12:55:00-03:00", { slot: "08:00" })];
  const { slots, extras } = matchSlots(["08:00", "12:00"], list, NOW);
  assert.equal(slots[0].intake.id, "a");
  assert.equal(slots[1].intake, null);
  assert.equal(extras.length, 0);
});

test("matchSlots: dose com horário já ocupado cai no mais próximo livre", () => {
  const list = [
    intake("a", "m1", "2026-11-01T08:05:00-03:00", { slot: "08:00" }),
    intake("b", "m1", "2026-11-01T08:10:00-03:00", { slot: "08:00" }),
  ];
  const { slots } = matchSlots(["08:00", "12:00"], list, NOW);
  assert.equal(slots[0].intake.id, "a");
  assert.equal(slots[1].intake.id, "b");
});
