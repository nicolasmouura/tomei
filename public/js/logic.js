// =============================================================================
//  Regras de exibição (puras, sem DOM e sem banco): o que mostrar na tela "Hoje".
//  Testadas em Node: test/logic.test.mjs
// =============================================================================
import { tsMs, startOfDay, sameDay, dayKey, dayLabel, normalizeTimes, normalizeWeekdays, ALL_DAYS } from "./util.js";

/** Depois de quantos minutos do horário um remédio não registrado vira "atrasado". */
export const DUE_WINDOW_MIN = 15;

/** Data/hora de hoje (ou do dia dado) para um "HH:MM". */
export function slotDate(day, time) {
  const [hh, mm] = time.split(":").map(Number);
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), hh, mm);
}

/**
 * Liga cada dose registrada ao horário MAIS PRÓXIMO que ainda estiver livre.
 * Ex.: horários 08:00 e 20:00; dose às 19:10 → vale para as 20:00.
 * Doses que sobram (mais doses que horários) viram `extras`.
 */
export function matchSlots(times, intakes, day) {
  const slots = normalizeTimes(times).map((time) => ({ time, at: slotDate(day, time), intake: null }));
  const extras = [];
  const sorted = [...intakes].sort((a, b) => tsMs(a.taken_at) - tsMs(b.taken_at));
  for (const it of sorted) {
    const t = tsMs(it.taken_at);
    let best = null;
    for (const s of slots) {
      if (s.intake) continue;
      const d = Math.abs(t - s.at.getTime());
      if (!best || d < best.d) best = { s, d };
    }
    if (best) best.s.intake = it;
    else extras.push(it);
  }
  return { slots, extras };
}

/** 'taken' | 'upcoming' | 'due' (acabou de dar a hora) | 'late' (passou e nada registrado) */
export function slotStatus(slot, now) {
  if (slot.intake) return "taken";
  const diff = now.getTime() - slot.at.getTime();
  if (diff < 0) return "upcoming";
  return diff < DUE_WINDOW_MIN * 60_000 ? "due" : "late";
}

/**
 * Monta a tela "Hoje": um item por remédio ativo, com seus horários, o status de
 * cada um e a última dose já registrada (de qualquer dia).
 */
export function buildToday({ medications, intakes, now }) {
  const day = startOfDay(now);
  const live = intakes.filter((i) => !i.deleted_at);
  const lastBy = new Map();
  const todayBy = new Map();
  for (const i of live) {
    const t = tsMs(i.taken_at);
    const prev = lastBy.get(i.medication_id);
    if (!prev || t > tsMs(prev.taken_at)) lastBy.set(i.medication_id, i);
    if (sameDay(new Date(t), now)) todayBy.set(i.medication_id, [...(todayBy.get(i.medication_id) ?? []), i]);
  }

  const items = medications
    .filter((m) => !m.archived_at)
    .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"))
    .map((med) => {
      const today = todayBy.get(med.id) ?? [];
      // hoje é um dos dias marcados deste remédio? (sem informação = todos os dias)
      const days = normalizeWeekdays(med.weekdays?.length ? med.weekdays : ALL_DAYS);
      const scheduledToday = days.includes(now.getDay());
      // fora dos dias marcados não há horários hoje; qualquer dose registrada vira "extra"
      const { slots, extras } = matchSlots(scheduledToday ? med.times ?? [] : [], today, day);
      for (const s of slots) s.status = slotStatus(s, now);
      return {
        med,
        slots,
        extras,
        scheduledToday,
        takenToday: today.length,
        last: lastBy.get(med.id) ?? null,
      };
    });

  const scheduled = items.reduce((n, i) => n + i.slots.length, 0);
  const done = items.reduce((n, i) => n + i.slots.filter((s) => s.intake).length, 0);
  const late = items.reduce((n, i) => n + i.slots.filter((s) => s.status === "late").length, 0);
  return { items, scheduled, done, late };
}

/** Doses de hoje, da mais recente para a mais antiga (lista "Registros de hoje"). */
export function todaysIntakes(intakes, now) {
  return intakes
    .filter((i) => !i.deleted_at && sameDay(new Date(tsMs(i.taken_at)), now))
    .sort((a, b) => tsMs(b.taken_at) - tsMs(a.taken_at));
}

/** Histórico agrupado por dia (mais recente primeiro). `days` limita quantos dias mostrar. */
export function groupByDay(intakes, now, days = 14) {
  const groups = new Map();
  for (const i of intakes) {
    if (i.deleted_at) continue;
    const d = new Date(tsMs(i.taken_at));
    const key = dayKey(d);
    if (!groups.has(key)) groups.set(key, { key, date: d, label: dayLabel(d, now), items: [] });
    groups.get(key).items.push(i);
  }
  const all = [...groups.values()].sort((a, b) => (a.key < b.key ? 1 : -1));
  for (const g of all) g.items.sort((a, b) => tsMs(b.taken_at) - tsMs(a.taken_at));
  return { shown: all.slice(0, days), hidden: Math.max(0, all.length - days) };
}
