// =============================================================================
//  Tomei — interface (telas, diálogos e fluxo do app)
//
//  Resumo do funcionamento:
//    1. Abre o banco LOCAL do aparelho e mostra os dados na hora (mesmo sem internet).
//    2. Toda ação (Tomei agora, cadastrar...) grava primeiro no aparelho (store.js).
//    3. O motor de sincronização (sync.js) leva tudo para o Supabase em segundo plano.
//    4. Os lembretes chegam por Web Push (a Edge Function send-reminders manda).
// =============================================================================
import { config, isConfigured } from "../config.js";
import { BUILD } from "./build-info.js";
import {
  h, hhmm, ago, inFuture, dayDiff, longDayLabel, toLocalInput, normalizeTimes, tsMs, toCsv, HHMM,
  ALL_DAYS, DAY_SHORT, normalizeWeekdays, weekdaysLabel,
} from "./util.js";
import { openDb } from "./db.js";
import { createRemote } from "./remote.js";
import { createStore } from "./store.js";
import { createSync, profileStep } from "./sync.js";
import { createPush, closeNotificationsFor, isIos, isStandalone } from "./push.js";
import { buildToday, todaysIntakes, groupByDay, missedYesterday, CARRY_UNTIL_HOUR } from "./logic.js";

/** Se a mesma dose foi registrada há menos que isso, pergunta antes de registrar de novo. */
const DUPLICATE_WINDOW_MIN = 60;

// ---------- ícones (SVG estático e confiável; nada vindo do usuário entra aqui) ----------
const ICONS = {
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  capsule: '<g transform="rotate(-40 12 12)"><rect x="2.5" y="7.5" width="19" height="9" rx="4.5"/><path d="M12 7.5v9"/></g>',
  today: '<circle cx="12" cy="12" r="8.5"/><path d="M8 12.3l2.6 2.6L16 9.5"/>',
  history: '<path d="M12 7.5V12l3 2"/><path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3"/><path d="M4.5 4.8v3.6h3.6"/>',
  settings: '<path d="M4 7h8M16 7h4M4 17h4M12 17h8"/><circle cx="14" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>',
  cloudOk: '<path d="M7 18.5a4.5 4.5 0 0 1-.7-8.95A6 6 0 0 1 17.8 9.2 4.7 4.7 0 0 1 17.5 18.5z"/><path d="M9.5 13.5l2 2 3.5-3.8"/>',
  cloudOff: '<path d="M7 18.5a4.5 4.5 0 0 1-.7-8.95M10 6.3A6 6 0 0 1 17.8 9.2 4.7 4.7 0 0 1 19 17.4"/><path d="M4 4l16 16"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14-4.5L4 8.5"/><path d="M4 4v4.5h4.5"/><path d="M4 13a8 8 0 0 0 14 4.5l2-2"/><path d="M20 20v-4.5h-4.5"/>',
  alert: '<path d="M12 8v5M12 16.5h.01"/><circle cx="12" cy="12" r="9"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
};
function icon(name, cls = "i") {
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  s.setAttribute("viewBox", "0 0 24 24");
  s.setAttribute("class", cls);
  s.setAttribute("aria-hidden", "true");
  s.innerHTML = ICONS[name];
  return s;
}

// ---------- estado do app ----------
const S = {
  screen: "boot", // boot | login | setup | app
  tab: "today", // today | history | meds | settings
  remote: null, db: null, store: null, sync: null, push: null, stopSync: null,
  user: null,
  medications: [], intakes: [],
  syncState: { phase: "idle", pending: 0, errors: 0, lastSyncAt: null, lastError: null },
  pushInfo: null,
  historyDays: 14,
  showArchived: false,
  installEvent: null,
  justTaken: null,
};
const root = document.getElementById("app");
const toastBox = document.getElementById("toasts");
const ls = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* modo privado */ } },
};

/** "Não tomei" de ontem: lembrado só neste aparelho (não é dado de saúde, só some o aviso). */
const DISMISS_KEY = "tomei.dismissedMissed";
function dismissedSet() {
  try { return new Set(JSON.parse(ls.get(DISMISS_KEY) || "[]")); } catch { return new Set(); }
}
function dismissMissed(key) {
  const list = [...dismissedSet(), key].slice(-60);
  ls.set(DISMISS_KEY, JSON.stringify(list));
}
const missedNow = (now = new Date()) => missedYesterday({ medications: S.medications, intakes: S.intakes, now, dismissed: dismissedSet() });

// =============================================================================
//  Peças reutilizáveis: aviso (toast), diálogo de confirmação, gaveta (sheet)
// =============================================================================
function toast(text, { action, ms = 5000 } = {}) {
  while (toastBox.children.length >= 2) toastBox.firstChild.remove();
  const el = h("div", { class: "toast", role: "status" },
    h("span", {}, text),
    action ? h("button", { type: "button", onclick: () => { el.remove(); action.run(); } }, action.label) : null);
  toastBox.append(el);
  setTimeout(() => el.remove(), ms);
}

function openDialog(dlg) {
  document.body.append(dlg);
  dlg.addEventListener("close", () => dlg.remove());
  dlg.showModal();
  return dlg;
}

function confirmDialog({ title, body, confirm = "Confirmar", cancel = "Cancelar", danger = false }) {
  return new Promise((resolve) => {
    let answer = false;
    const dlg = h("dialog", { class: "confirm", "aria-labelledby": "cd-title" },
      h("h2", { id: "cd-title" }, title),
      body ? h("p", {}, body) : null,
      h("div", { class: "actions" },
        h("button", { class: "btn", type: "button", onclick: () => dlg.close() }, cancel),
        h("button", { class: `btn ${danger ? "btn-danger" : "btn-primary"}`, type: "button", onclick: () => { answer = true; dlg.close(); } }, confirm)));
    dlg.addEventListener("close", () => resolve(answer));
    openDialog(dlg);
  });
}

function openSheet(title, build) {
  const dlg = h("dialog", { class: "sheet", "aria-label": title });
  const close = () => dlg.close();
  dlg.append(
    h("div", { class: "sheet-head" }, h("h2", {}, title),
      h("button", { class: "icon-btn", type: "button", "aria-label": "Fechar", onclick: close }, icon("x"))),
    build(close),
  );
  dlg.addEventListener("click", (e) => { // toque fora da gaveta fecha
    const r = dlg.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) close();
  });
  return openDialog(dlg);
}

const field = (label, input, hint) =>
  h("div", { class: "field" }, h("label", { for: input.id }, label), input, hint ? h("p", { class: "hint" }, hint) : null);

// =============================================================================
//  Ações
// =============================================================================
/** "Tomei agora": grava no aparelho NA HORA com o instante exato do toque. */
async function take(med, { at, slot, slotDate } = {}) {
  const now = new Date();
  // Madrugada: se ficou faltando um horário de ontem, pergunta se este registro é dele.
  if (!at && !slot && now.getHours() < CARRY_UNTIL_HOUR) {
    const pending = missedNow(now).filter((m) => m.med.id === med.id && now - m.at < 6 * 3600_000).pop();
    if (pending) {
      const yes = await confirmDialog({
        title: "Foi a dose de ontem?",
        body: `${med.name} das ${pending.time} de ontem ainda não foi marcado. Este registro é dessa dose?`,
        confirm: "Sim, é a de ontem",
        cancel: "Não, é de hoje",
      });
      if (yes) { slot = pending.time; slotDate = pending.date; }
    }
  }
  if (!at && !slot) {
    const last = S.intakes
      .filter((i) => i.medication_id === med.id && !i.deleted_at)
      .sort((a, b) => tsMs(b.taken_at) - tsMs(a.taken_at))[0];
    if (last && now - tsMs(last.taken_at) < DUPLICATE_WINDOW_MIN * 60_000) {
      const when = new Date(tsMs(last.taken_at));
      const ok = await confirmDialog({
        title: "Você já registrou há pouco",
        body: `${med.name} foi marcado às ${hhmm(when)} (${ago(now - when)}). Registrar de novo?`,
        confirm: "Registrar de novo",
      });
      if (!ok) return;
    }
  }
  try {
    const row = await S.store.logIntake({ medicationId: med.id, takenAt: at ?? new Date(), slot, slotDate });
    S.justTaken = row.id;
    setTimeout(() => { S.justTaken = null; }, 1200);
    navigator.vibrate?.(25);
    toast(`${med.name} registrado às ${hhmm(new Date(row.taken_at))}`, {
      ms: 7000,
      action: { label: "Desfazer", run: () => undoIntake(row.id) },
    });
    closeNotificationsFor(med.id);
  } catch (e) {
    toast(e.message, { ms: 7000 });
  }
}

async function undoIntake(id) {
  await S.store.removeIntake(id);
  toast("Registro desfeito", { ms: 6000, action: { label: "Refazer", run: () => S.store.restoreIntake(id) } });
}

/** Abriu o app tocando numa notificação (?take=<id>): pede confirmação e registra. */
async function askToTake(medId) {
  const med = S.medications.find((m) => m.id === medId && !m.archived_at);
  if (!med) return toast("Não encontrei esse remédio neste aparelho. Abra Ajustes e toque em Sincronizar agora.", { ms: 8000 });
  const ok = await confirmDialog({
    title: `Registrar ${med.name}?`,
    body: `Vai marcar que você tomou agora, às ${hhmm(new Date())}.`,
    confirm: "Tomei agora",
  });
  if (ok) take(med, { at: new Date() });
}

function handleLaunchUrl(href) {
  const u = new URL(href, location.href);
  const id = u.searchParams.get("take");
  if (!id) return;
  history.replaceState(null, "", u.pathname);
  askToTake(id);
}

// =============================================================================
//  Gavetas: remédio, editar registro
// =============================================================================
function openMedSheet(med) {
  const startDays = normalizeWeekdays(med?.weekdays?.length ? med.weekdays : ALL_DAYS);
  const state = {
    times: [...(med?.times ?? [])],
    days: startDays,
    mode: startDays.length === 7 ? "all" : "some", // "all" = todos os dias · "some" = dias específicos
  };
  const name = h("input", { class: "input", id: "f-name", value: med?.name ?? "", placeholder: "ex.: Losartana", autocomplete: "off", maxLength: 120 });
  const dose = h("input", { class: "input", id: "f-dose", value: med?.dose ?? "", placeholder: "ex.: 50 mg, 1 comprimido", autocomplete: "off", maxLength: 120 });
  const notes = h("textarea", { class: "input", id: "f-notes", placeholder: "ex.: tomar depois do café", maxLength: 1000 });
  notes.value = med?.notes ?? "";
  const timeInput = h("input", { class: "input", id: "f-time", type: "time", "aria-label": "Novo horário" });
  const chips = h("div", { class: "chips", "aria-live": "polite" });
  const err = h("p", { class: "error", role: "alert" });

  const drawTimes = () => {
    const nodes = state.times.map((t) => h("span", { class: "chip" }, t,
      h("button", { type: "button", "aria-label": `Remover o horário ${t}`, onclick: () => { state.times = state.times.filter((x) => x !== t); drawTimes(); } }, icon("x"))));
    if (!nodes.length) nodes.push(h("p", { class: "hint" }, "Sem horário fixo: não haverá lembrete, mas você pode registrar quando tomar."));
    chips.replaceChildren(...nodes); // (replaceChildren transformaria null em texto "null": só entra nó de verdade)
  };
  const addTime = () => {
    if (!HHMM.test(timeInput.value)) return;
    state.times = normalizeTimes([...state.times, timeInput.value]);
    timeInput.value = "";
    drawTimes();
  };
  drawTimes();
  timeInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); addTime(); } });

  // ---- dias da semana: "Todos os dias" (padrão) ou "Dias específicos" ----
  const modeAll = h("button", { type: "button", class: "seg-btn", onclick: () => { state.mode = "all"; drawDays(); } }, "Todos os dias");
  const modeSome = h("button", { type: "button", class: "seg-btn", onclick: () => { state.mode = "some"; if (state.days.length === 7) state.days = [1, 2, 3, 4, 5]; drawDays(); } }, "Dias específicos");
  const dayGrid = h("div", { class: "weekdays", role: "group", "aria-label": "Dias da semana" },
    ALL_DAYS.map((n) => h("button", { type: "button", class: "day", dataset: { day: String(n) }, onclick: () => toggleDay(n) }, DAY_SHORT[n])));
  const daysHint = h("p", { class: "hint", "aria-live": "polite" });
  function drawDays(warning) {
    modeAll.setAttribute("aria-pressed", String(state.mode === "all"));
    modeSome.setAttribute("aria-pressed", String(state.mode === "some"));
    dayGrid.hidden = state.mode === "all";
    for (const b of dayGrid.children) b.setAttribute("aria-pressed", String(state.days.includes(Number(b.dataset.day))));
    daysHint.textContent = warning ?? (state.mode === "all" ? "" : `Os lembretes e os horários só valem em: ${weekdaysLabel(state.days).toLowerCase()}.`);
  }
  function toggleDay(n) {
    const next = state.days.includes(n) ? state.days.filter((x) => x !== n) : normalizeWeekdays([...state.days, n]);
    if (!next.length) return drawDays("Deixe pelo menos um dia marcado.");
    state.days = next;
    drawDays();
  }
  drawDays();

  return openSheet(med ? "Editar remédio" : "Novo remédio", (close) => {
    const save = h("button", { class: "btn btn-primary btn-block", type: "submit" }, "Salvar");
    const form = h("form", {
      class: "form",
      onsubmit: async (e) => {
        e.preventDefault();
        err.textContent = "";
        addTime(); // se digitou um horário e esqueceu de tocar em "Adicionar", vale também
        save.disabled = true;
        try {
          await S.store.saveMedication({
            id: med?.id, name: name.value, dose: dose.value, notes: notes.value, times: state.times,
            weekdays: state.mode === "all" ? ALL_DAYS : state.days,
          });
          close();
          toast(med ? "Remédio atualizado" : "Remédio cadastrado");
        } catch (ex) {
          err.textContent = ex.message;
          save.disabled = false;
        }
      },
    },
    field("Nome", name),
    field("Dose", dose),
    h("div", { class: "field" },
      h("label", { for: "f-time" }, "Horários dos lembretes"),
      h("div", { class: "time-add" }, timeInput, h("button", { class: "btn", type: "button", onclick: addTime }, icon("plus"), "Adicionar")),
      chips),
    h("div", { class: "field" },
      h("span", { class: "label", id: "f-days-label" }, "Dias da semana"),
      h("div", { class: "seg", role: "group", "aria-labelledby": "f-days-label" }, modeAll, modeSome),
      dayGrid,
      daysHint),
    field("Observações", notes),
    err,
    save,
    med
      ? h("button", {
        class: "btn btn-block", type: "button",
        onclick: async () => {
          if (!med.archived_at) {
            const ok = await confirmDialog({
              title: `Arquivar ${med.name}?`,
              body: "Ele para de aparecer em Hoje e de mandar lembretes. O histórico continua guardado, e dá para desarquivar depois.",
              confirm: "Arquivar",
            });
            if (!ok) return;
          }
          await S.store.setMedicationArchived(med.id, !med.archived_at);
          close();
          toast(med.archived_at ? "Remédio desarquivado" : "Remédio arquivado");
        },
      }, med.archived_at ? "Desarquivar" : "Arquivar remédio")
      : null);
    setTimeout(() => (med ? null : name.focus()), 60);
    return form;
  });
}

function openIntakeSheet(row) {
  const d = new Date(tsMs(row.taken_at));
  const when = h("input", { class: "input", id: "f-when", type: "datetime-local", value: toLocalInput(d), max: toLocalInput(new Date()) });
  const note = h("input", { class: "input", id: "f-note", value: row.note ?? "", maxLength: 1000 });
  const err = h("p", { class: "error", role: "alert" });
  return openSheet(`${row.med_name}${row.med_dose ? ` ${row.med_dose}` : ""}`, (close) =>
    h("form", {
      class: "form",
      onsubmit: async (e) => {
        e.preventDefault();
        const t = new Date(when.value);
        if (Number.isNaN(t.getTime())) { err.textContent = "Escolha a data e a hora."; return; }
        try {
          await S.store.updateIntake(row.id, { takenAt: t, note: note.value });
          close();
          toast("Registro atualizado");
        } catch (ex) { err.textContent = ex.message; }
      },
    },
    field("Quando você tomou?", when),
    field("Observação", note),
    row._error ? h("p", { class: "error" }, `Este registro não foi aceito pela nuvem: ${row._error}`) : null,
    err,
    h("button", { class: "btn btn-primary btn-block", type: "submit" }, "Salvar"),
    h("button", {
      class: "btn btn-danger btn-block", type: "button",
      onclick: async () => { close(); await undoIntake(row.id); },
    }, "Remover este registro")));
}

// =============================================================================
//  Telas
// =============================================================================
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function notice(kind, title, text, ...actions) {
  return h("section", { class: `notice ${kind ?? ""}` }, h("h2", {}, title), h("p", {}, text), ...actions);
}

function syncMark(row) {
  if (row._error) return h("span", { class: "meta pending" }, icon("alert"), "Problema");
  if (row._dirty) return h("span", { class: "meta pending", title: "Ainda não enviado à nuvem" }, icon("clock"), "Pendente");
  return h("span", { class: "meta" });
}

function entryButton(i) {
  const d = new Date(tsMs(i.taken_at));
  return h("button", { class: "entry", type: "button", onclick: () => openIntakeSheet(i) },
    h("time", { datetime: i.taken_at }, hhmm(d)),
    h("span", { class: "what" }, `${i.med_name}${i.med_dose ? ` ${i.med_dose}` : ""}`, i.note ? h("small", {}, i.note) : null),
    syncMark(i));
}

function lastLine(last, now) {
  if (!last) return "Ainda não registrou nenhuma dose.";
  const d = new Date(tsMs(last.taken_at));
  const n = dayDiff(d, now);
  if (n === 0) return `Última dose: hoje às ${hhmm(d)} · ${ago(now - d)}`;
  if (n === 1) return `Última dose: ontem às ${hhmm(d)}`;
  return `Última dose: ${n} dias atrás`;
}

function cell(slot, now, med) {
  const took = slot.intake ? new Date(tsMs(slot.intake.taken_at)) : null;
  const sub = {
    taken: `às ${took ? hhmm(took) : ""}`,
    due: "agora",
    late: "atrasado",
    upcoming: inFuture(slot.at - now),
  }[slot.status];
  const label = {
    taken: `${slot.time}: tomado às ${took ? hhmm(took) : ""}`,
    due: `${slot.time}: está na hora`,
    late: `${slot.time}: atrasado, ainda não registrado`,
    upcoming: `${slot.time}: ${sub}`,
  }[slot.status];
  const fresh = slot.intake && slot.intake.id === S.justTaken;
  const glyph = { taken: "check", due: "clock", late: "alert" }[slot.status];
  const inner = [
    h("div", { class: "cell-dot" }, glyph ? icon(glyph) : null),
    h("span", { class: "cell-time" }, slot.time),
    h("span", { class: "cell-sub" }, sub),
  ];
  const cls = `cell ${slot.status}${fresh ? " just" : ""}`;
  if (slot.status === "taken") return h("div", { class: cls, role: "group", "aria-label": label }, inner);
  // ainda não tomado: tocar na bolinha marca ESTE horário como tomado agora (vale para atrasado também)
  return h("button", { class: cls, type: "button", "aria-label": `${label}. Toque para marcar como tomado`, onclick: () => take(med, { slot: slot.time }) }, inner);
}

function medCard({ med, slots, extras, scheduledToday, last }) {
  const now = new Date();
  return h("article", { class: "med", "aria-label": med.name },
    h("div", { class: "med-head" }, h("h3", {}, med.name), med.dose ? h("span", { class: "dose" }, med.dose) : null),
    h("p", { class: "last" }, lastLine(last, now)),
    slots.length ? h("div", { class: "cells" }, slots.map((s) => cell(s, now, med))) : null,
    !scheduledToday && med.times?.length
      ? h("p", { class: "extra" }, `Hoje não é dia deste remédio · ${weekdaysLabel(med.weekdays)}`)
      : null,
    extras.length
      ? h("p", { class: "extra" }, slots.length ? "Dose extra às " : "Hoje: ",
        extras.map((e) => hhmm(new Date(tsMs(e.taken_at)))).join(", "))
      : null,
    slots.length ? h("p", { class: "hint tap-hint" }, "Toque na bolinha do horário para marcar como tomado.") : null,
    h("button", { class: "btn btn-take", type: "button", onclick: () => take(med) }, icon("capsule"), "Tomei agora"));
}

function summaryLine(t) {
  if (!t.items.length) return h("p", {}, "Cadastre seus remédios para começar.");
  if (!t.scheduled) return h("p", {}, "Toque em “Tomei agora” sempre que tomar um remédio.");
  if (t.late) return h("p", {}, h("span", { class: "alert" }, plural(t.late, "horário atrasado", "horários atrasados")), " · ", h("b", {}, `${t.done} de ${t.scheduled}`), " cumpridos");
  if (t.done === t.scheduled) return h("p", {}, h("b", {}, "Tudo certo por hoje."), ` ${t.done} de ${t.scheduled} horários cumpridos.`);
  return h("p", {}, h("b", {}, `${t.done} de ${t.scheduled}`), " horários cumpridos hoje");
}

function notices(hasTimes) {
  const out = [];
  if (S.syncState.phase === "auth") {
    out.push(notice("coral", "Entre de novo para sincronizar",
      "Sua sessão expirou. Seus registros continuam salvos neste aparelho e sobem assim que você entrar.",
      h("button", { class: "btn btn-primary", type: "button", onclick: () => showLogin({ expired: true }) }, "Entrar")));
  }
  const dismissed = (key, days) => Date.now() - Number(ls.get(key) ?? 0) < days * 86_400_000;
  const p = S.pushInfo;
  if (hasTimes) {
    if (isIos() && !isStandalone() && !dismissed("tomei.hideIos", 7)) {
      out.push(notice("", "Para receber lembretes no iPhone, instale o app",
        "Toque no botão Compartilhar do Safari e escolha “Adicionar à Tela de Início”. Depois abra o Tomei pelo ícone novo.",
        h("button", { class: "btn", type: "button", onclick: () => { ls.set("tomei.hideIos", String(Date.now())); render(); } }, "Entendi")));
    } else if (p?.supported && (p.permission === "default" || (p.permission === "granted" && !p.subscribed)) && !dismissed("tomei.hidePush", 3)) {
      out.push(notice("", "Ative os lembretes",
        "Receba um aviso na hora de cada remédio, mesmo com o app fechado.",
        h("div", { class: "btns", style: { display: "flex", gap: "8px", flexWrap: "wrap" } },
          h("button", { class: "btn btn-primary", type: "button", onclick: enablePush }, "Ativar lembretes"),
          h("button", { class: "btn", type: "button", onclick: () => { ls.set("tomei.hidePush", String(Date.now())); render(); } }, "Agora não"))));
    }
  }
  return out;
}

function missedCard(list) {
  return h("section", { class: "notice coral missed" },
    h("h2", {}, "Ontem ficou faltando"),
    h("p", {}, now_hint()),
    ...list.map((m) => h("div", { class: "missed-row" },
      h("span", { class: "missed-what" }, h("strong", {}, `${m.med.name}${m.med.dose ? ` ${m.med.dose}` : ""}`), ` · ${m.time}`),
      h("button", { class: "btn", type: "button", onclick: () => take(m.med, { slot: m.time, slotDate: m.date }) }, "Tomei"),
      h("button", { class: "btn", type: "button", onclick: () => { dismissMissed(`${m.med.id}|${m.date}|${m.time}`); render(); } }, "Não tomei"))));
}
const now_hint = () => (new Date().getHours() < CARRY_UNTIL_HOUR ? "Ainda dá tempo: marque se você tomou." : "Marque o que você tomou ou toque em “Não tomei” para tirar daqui.");

function todayView() {
  const now = new Date();
  const t = buildToday({ medications: S.medications, intakes: S.intakes, now });
  const today = todaysIntakes(S.intakes, now);
  const hasTimes = t.items.some((i) => i.slots.length);
  const missed = missedNow(now);
  return [
    h("section", { class: "hello" }, h("h1", {}, longDayLabel(now)), summaryLine(t)),
    ...(missed.length ? [missedCard(missed)] : []),
    ...notices(hasTimes),
    ...(t.items.length
      ? t.items.map(medCard)
      : [h("section", { class: "empty" },
        h("h2", {}, "Cadastre seu primeiro remédio"),
        h("p", {}, "Informe o nome, a dose e os horários. Depois é só tocar em “Tomei agora”."),
        h("button", { class: "btn btn-primary", type: "button", onclick: () => openMedSheet() }, icon("plus"), "Novo remédio"))]),
    today.length
      ? h("h2", { class: "section-title" }, "Registros de hoje", h("small", {}, plural(today.length, "dose", "doses")))
      : null,
    today.length ? h("ol", { class: "timeline" }, today.map((i) => h("li", {}, entryButton(i)))) : null,
  ];
}

function historyView() {
  const { shown, hidden } = groupByDay(S.intakes, new Date(), S.historyDays);
  return [
    h("section", { class: "hello" }, h("h1", {}, "Histórico"), h("p", {}, "Tudo que você já registrou. Toque num registro para corrigir o horário.")),
    ...(shown.length
      ? shown.flatMap((g) => [
        h("h2", { class: "section-title" }, g.label, h("small", {}, plural(g.items.length, "dose", "doses"))),
        h("ol", { class: "timeline" }, g.items.map((i) => h("li", {}, entryButton(i)))),
      ])
      : [h("section", { class: "empty" }, h("h2", {}, "Nada registrado ainda"), h("p", {}, "Quando você tocar em “Tomei agora”, o registro aparece aqui com o horário exato."))]),
    hidden ? h("button", { class: "btn btn-block more", type: "button", onclick: () => { S.historyDays += 14; render(); } }, "Ver dias anteriores") : null,
  ];
}

function medRow(m) {
  return h("button", { class: "row-card", type: "button", onclick: () => openMedSheet(m) },
    h("h3", {}, m.name, m.dose ? h("span", { class: "dose" }, m.dose) : null),
    h("div", { class: "chips" },
      m.archived_at ? h("span", { class: "chip plain" }, "Arquivado")
        : m.times?.length ? m.times.map((t) => h("span", { class: "chip" }, t))
        : h("span", { class: "chip plain" }, "Sem lembrete"),
      !m.archived_at && m.times?.length && (m.weekdays?.length ?? 7) < 7 ? h("span", { class: "chip plain" }, weekdaysLabel(m.weekdays)) : null,
      m._error ? h("span", { class: "chip plain" }, "Problema ao sincronizar") : m._dirty ? h("span", { class: "chip plain" }, "Pendente") : null));
}

function medsView() {
  const byName = (a, b) => a.name.localeCompare(b.name, "pt-BR");
  const active = S.medications.filter((m) => !m.archived_at).sort(byName);
  const archived = S.medications.filter((m) => m.archived_at).sort(byName);
  return [
    h("section", { class: "hello" }, h("h1", {}, "Remédios"), h("p", {}, "Nome, dose e os horários dos lembretes.")),
    h("div", { class: "page-actions" }, h("button", { class: "btn btn-primary", type: "button", onclick: () => openMedSheet() }, icon("plus"), "Novo remédio")),
    ...(active.length ? active.map(medRow) : [h("p", { class: "hint" }, "Nenhum remédio cadastrado ainda.")]),
    archived.length
      ? h("button", { class: "link", type: "button", onclick: () => { S.showArchived = !S.showArchived; render(); } },
        S.showArchived ? "Esconder arquivados" : `Ver arquivados (${archived.length})`)
      : null,
    ...(S.showArchived ? archived.map(medRow) : []),
  ];
}

// ---------- Ajustes ----------
function syncInfo() {
  const s = S.syncState;
  const pend = s.pending ? ` · ${plural(s.pending, "registro aguardando", "registros aguardando")}` : "";
  switch (s.phase) {
    case "syncing": return { cls: "busy", text: "Sincronizando…", long: "Sincronizando com a nuvem…", ic: "refresh", tone: "" };
    case "offline": return { cls: "warn", text: s.pending ? `Offline · ${s.pending} pendente${s.pending > 1 ? "s" : ""}` : "Offline", long: `Sem internet${pend}. Está tudo salvo neste aparelho e sobe sozinho quando a conexão voltar.`, ic: "cloudOff", tone: "warn" };
    case "error": return { cls: "bad", text: s.pending ? `Falha · ${s.pending} pendente${s.pending > 1 ? "s" : ""}` : "Falha ao sincronizar", long: `A nuvem não respondeu direito${pend}. O app tenta de novo sozinho; nada foi perdido.`, ic: "alert", tone: "bad" };
    case "auth": return { cls: "bad", text: "Entrar de novo", long: `Sessão expirada${pend}. Entre de novo para sincronizar. Nada foi perdido.`, ic: "alert", tone: "bad" };
    default:
      if (s.errors) return { cls: "bad", text: `${plural(s.errors, "item com problema", "itens com problema")}`, long: `${plural(s.errors, "registro foi recusado", "registros foram recusados")} pela nuvem. Eles continuam guardados neste aparelho.`, ic: "alert", tone: "bad" };
      if (s.pending) return { cls: "warn", text: `${s.pending} pendente${s.pending > 1 ? "s" : ""}`, long: `${plural(s.pending, "registro aguardando", "registros aguardando")} envio.`, ic: "clock", tone: "warn" };
      return { cls: "ok", text: "Salvo na nuvem", long: "Tudo salvo neste aparelho e na nuvem.", ic: "cloudOk", tone: "ok" };
  }
}

function syncBadge() {
  const i = syncInfo();
  return h("button", { class: `sync ${i.cls}`, id: "sync-badge", type: "button", "aria-label": `Sincronização: ${i.long}`, onclick: () => setTab("settings") }, icon(i.ic), i.text);
}

function lastSyncText() {
  const t = S.syncState.lastSyncAt;
  return t ? `Última sincronização: ${ago(Date.now() - t)}.` : "Ainda não sincronizou neste aparelho.";
}

const panelItem = (...children) => h("div", { class: "item" }, ...children);
const group = (title, ...items) => h("section", { class: "group" }, h("h2", {}, title), h("div", { class: "panel" }, ...items));

async function enablePush() {
  try {
    await S.push.enable();
    toast("Lembretes ativados neste aparelho.");
  } catch (e) {
    toast(e.message, { ms: 9000 });
  }
  S.pushInfo = await S.push.status().catch(() => S.pushInfo);
  render();
}

async function disablePush() {
  await S.push.disable();
  S.pushInfo = await S.push.status().catch(() => S.pushInfo);
  toast("Lembretes desativados neste aparelho.");
  render();
}

async function testPush() {
  toast("Pedindo ao servidor para enviar um teste…");
  try {
    await S.sync.syncNow("manual"); // garante que o servidor já conhece este aparelho
    const r = await S.push.testServer();
    if (r.ok) toast("Enviado! A notificação deve aparecer em instantes.", { ms: 8000 });
    else if (r.reason === "sem_inscricao") toast("O servidor ainda não conhece este aparelho. Ative os lembretes e tente de novo.", { ms: 9000 });
    else toast(`O serviço de notificações recusou o envio (código ${r.results?.[0]?.status ?? "?"}). Desative e ative os lembretes de novo.`, { ms: 10000 });
  } catch (e) {
    toast(e.kind === "network" ? "Sem internet para pedir o teste." : `Não deu certo: ${e.message}`, { ms: 8000 });
  }
}

async function saveFile(name, mime, text) {
  const file = new File([text], name, { type: mime });
  if (navigator.canShare?.({ files: [file] })) { // no celular abre a folha de compartilhar (salvar em Arquivos, WhatsApp...)
    try { await navigator.share({ files: [file], title: name }); return true; } catch (e) { if (e.name === "AbortError") return false; }
  }
  const url = URL.createObjectURL(file);
  const a = h("a", { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 15_000);
  return true;
}
const stamp = () => new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");

async function exportJson() {
  const data = await S.store.exportAll();
  if (await saveFile(`tomei-backup-${stamp()}.json`, "application/json", JSON.stringify(data, null, 2))) {
    ls.set("tomei.lastExport", String(Date.now()));
    toast("Backup exportado.");
    render();
  }
}

async function exportCsv() {
  const { intakes } = await S.store.exportAll();
  const fmtDate = new Intl.DateTimeFormat("pt-BR");
  const rows = [["Data", "Hora", "Remédio", "Dose", "Observação"]];
  intakes.filter((i) => !i.deleted_at).sort((a, b) => tsMs(a.taken_at) - tsMs(b.taken_at)).forEach((i) => {
    const d = new Date(tsMs(i.taken_at));
    rows.push([fmtDate.format(d), hhmm(d), i.med_name, i.med_dose, i.note]);
  });
  if (await saveFile(`tomei-historico-${stamp()}.csv`, "text/csv", toCsv(rows))) toast("Planilha exportada.");
}

async function signOut() {
  const c = await S.sync.counts();
  const ok = await confirmDialog({
    title: "Sair da conta?",
    body: c.pending
      ? `${plural(c.pending, "registro ainda não foi enviado", "registros ainda não foram enviados")} à nuvem. Eles continuam salvos neste aparelho e sobem quando você entrar de novo.`
      : "Seus registros continuam salvos neste aparelho e na nuvem.",
    confirm: "Sair",
  });
  if (!ok) return;
  await S.remote.signOut();
  teardown();
  S.tab = "today";
  showLogin();
}

function settingsView() {
  const info = syncInfo();
  const p = S.pushInfo;
  const tz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return "—"; } })();
  const lastExport = Number(ls.get("tomei.lastExport") ?? 0);

  let pushItems;
  if (!p?.supported) {
    pushItems = [panelItem(
      h("span", { class: "status-line warn" }, icon("alert"), "Indisponível aqui"),
      h("p", { class: "hint" }, isIos() && !isStandalone()
        ? "No iPhone, os lembretes só funcionam com o app instalado: toque em Compartilhar, escolha “Adicionar à Tela de Início” e abra o Tomei pelo ícone novo."
        : "Este navegador não oferece notificações. Instale o app (menu do navegador) ou use outro navegador."))];
  } else if (p.permission === "denied") {
    pushItems = [panelItem(
      h("span", { class: "status-line bad" }, icon("alert"), "Bloqueadas"),
      h("p", { class: "hint" }, "Libere as notificações do Tomei nas configurações do aparelho ou do navegador e volte aqui."))];
  } else if (p.permission === "granted" && p.subscribed) {
    pushItems = [panelItem(
      h("span", { class: "status-line ok" }, icon("check"), "Ativadas neste aparelho"),
      h("p", { class: "hint" }, p.serverKnows ? "O servidor conhece este aparelho." : "Falta o servidor registrar este aparelho (acontece ao sincronizar)."),
      h("div", { class: "btns" },
        h("button", { class: "btn btn-primary", type: "button", onclick: testPush }, "Enviar notificação de teste"),
        h("button", { class: "btn", type: "button", onclick: () => S.push.testLocal().catch((e) => toast(e.message)) }, "Testar só neste aparelho"),
        h("button", { class: "btn", type: "button", onclick: disablePush }, "Desativar")))];
  } else {
    pushItems = [panelItem(
      h("span", { class: "status-line" }, "Desativadas"),
      h("p", { class: "hint" }, "Ative para receber um aviso na hora de cada remédio, mesmo com o app fechado."),
      h("button", { class: "btn btn-primary", type: "button", onclick: enablePush }, "Ativar lembretes"))];
  }

  return [
    h("section", { class: "hello" }, h("h1", {}, "Ajustes")),
    group("Sincronização",
      panelItem(h("span", { class: `status-line ${info.tone}` }, icon(info.ic), info.text), h("p", { class: "hint" }, info.long), h("p", { class: "hint" }, lastSyncText()),
        h("div", { class: "btns" },
          h("button", { class: "btn", type: "button", onclick: () => S.sync.syncNow("manual") }, icon("refresh"), "Sincronizar agora"),
          S.syncState.errors ? h("button", { class: "btn", type: "button", onclick: () => S.sync.retryErrors() }, "Tentar de novo os recusados") : null)),
      S.syncState.lastError && S.syncState.phase !== "idle" ? panelItem(h("p", { class: "hint" }, `Detalhe técnico: ${S.syncState.lastError}`)) : null),
    group("Lembretes", ...pushItems,
      panelItem(h("b", {}, "Como funciona"), h("p", { class: "hint" }, `Você recebe um aviso na hora de cada horário. Se a dose não for registrada, o aviso se repete 15 minutos depois. Fuso usado: ${tz}.`))),
    group("Backup dos dados",
      panelItem(h("p", { class: "hint" }, "Seus registros ficam neste aparelho e na nuvem. O plano gratuito do Supabase não faz backup automático, então guarde uma cópia de vez em quando."),
        h("div", { class: "btns" },
          h("button", { class: "btn", type: "button", onclick: exportJson }, "Exportar backup (.json)"),
          h("button", { class: "btn", type: "button", onclick: exportCsv }, "Exportar planilha (.csv)")),
        h("p", { class: "hint" }, lastExport ? `Último backup: ${ago(Date.now() - lastExport)}.` : "Você ainda não exportou um backup."))),
    group("Conta",
      panelItem(h("b", {}, S.user?.email ?? "—"), h("button", { class: "btn", type: "button", onclick: signOut }, "Sair da conta"))),
    group("Sobre",
      panelItem(h("p", { class: "hint" }, `Tomei · versão ${BUILD}`),
        S.installEvent ? h("button", { class: "btn", type: "button", onclick: async () => { S.installEvent.prompt(); await S.installEvent.userChoice; S.installEvent = null; render(); } }, "Instalar na tela inicial") : null)),
  ];
}

// ---------- estrutura geral ----------
const TABS = [
  ["today", "Hoje", "today"],
  ["history", "Histórico", "history"],
  ["meds", "Remédios", "capsule"],
  ["settings", "Ajustes", "settings"],
];

function setTab(tab) {
  S.tab = tab;
  render();
  window.scrollTo(0, 0);
}

function topbar() {
  return h("header", { class: "topbar" },
    h("div", { class: "brand" }, icon("capsule"), "Tomei"),
    syncBadge());
}

function tabbar() {
  return h("nav", { class: "tabbar", "aria-label": "Seções" },
    TABS.map(([id, label, ic]) => h("button", { class: "tab", type: "button", "aria-current": S.tab === id ? "page" : null, onclick: () => setTab(id) }, icon(ic), label)));
}

function render() {
  if (S.screen !== "app") return;
  const y = window.scrollY;
  const view = { today: todayView, history: historyView, meds: medsView, settings: settingsView }[S.tab]();
  root.replaceChildren(topbar(), h("main", { id: "main" }, view), tabbar());
  window.scrollTo(0, y);
}

/** Só redesenha quando algo que aparece na tela mudou no estado da sincronização. */
let lastChromeKey = "";
function onSyncState(state) {
  S.syncState = state;
  const key = `${state.phase}|${state.pending}|${state.errors}|${state.lastError}`;
  if (key === lastChromeKey) return;
  lastChromeKey = key;
  render();
}

// ---------- entrar / configurar ----------
function showLogin({ expired = false } = {}) {
  S.screen = "login";
  const email = h("input", { class: "input", id: "email", type: "email", autocomplete: "username", inputMode: "email", required: true, value: ls.get("tomei.lastEmail") ?? "" });
  const pass = h("input", { class: "input", id: "password", type: "password", autocomplete: "current-password", required: true });
  const err = h("p", { class: "error", role: "alert" });
  const btn = h("button", { class: "btn btn-primary btn-block", type: "submit" }, "Entrar");
  const form = h("form", {
    class: "form",
    onsubmit: async (e) => {
      e.preventDefault();
      err.textContent = "";
      btn.disabled = true;
      btn.textContent = "Entrando…";
      try {
        const s = await S.remote.signIn(email.value, pass.value);
        ls.set("tomei.lastEmail", email.value.trim());
        await startFor(s.user);
      } catch (ex) {
        err.textContent = ex.kind === "network" ? "Sem conexão. Conecte-se à internet para entrar." : ex.message;
        btn.disabled = false;
        btn.textContent = "Entrar";
      }
    },
  }, field("E-mail", email), field("Senha", pass), err, btn);
  root.replaceChildren(h("section", { class: "auth" },
    h("div", { class: "logo" }, h("img", { src: "icons/icon-192.png", alt: "", width: 72, height: 72 }), h("h1", {}, "Tomei"), h("p", { class: "tag" }, "Marque na hora cada remédio que tomou.")),
    expired || ls.get("tomei.lastUser") ? h("p", { class: "notice coral", style: { padding: "12px 14px" } }, "Entre para sincronizar. Os registros já feitos neste aparelho continuam salvos e sobem depois do login.") : null,
    form,
    h("p", { class: "hint" }, "A conta é criada por quem administra o app. Não há cadastro aqui.")));
  (email.value ? pass : email).focus();
}

function showSetup() {
  S.screen = "setup";
  root.replaceChildren(h("section", { class: "auth" },
    h("div", { class: "logo" }, h("h1", {}, "Falta configurar")),
    h("p", {}, "Abra ", h("span", { class: "code" }, "public/config.js"), " e coloque a URL e a chave publishable do seu projeto Supabase (Project Settings → API Keys). Depois rode ", h("span", { class: "code" }, "npm run build"), " e publique de novo.")));
}

function showFatal(text) {
  S.screen = "fatal";
  root.replaceChildren(h("section", { class: "auth" }, h("h1", {}, "Algo impediu o app de abrir"), h("p", {}, text),
    h("button", { class: "btn btn-primary", type: "button", onclick: () => location.reload() }, "Tentar de novo")));
}

// ---------- ciclo de vida ----------
function teardown() {
  S.stopSync?.();
  S.stopSync = null;
  try { S.db?.close(); } catch { /* já fechado */ }
  S.db = S.store = S.sync = S.push = null;
}

async function loadAll() {
  const [medications, intakes] = await Promise.all([S.store.allMedications(), S.store.allIntakes()]);
  S.medications = medications;
  S.intakes = intakes;
}

async function reload() {
  await loadAll();
  render();
}

let starting = null;
function startFor(user) {
  if (starting) return starting;
  if (S.screen === "app" && S.user?.id === user.id && S.db) return Promise.resolve();
  starting = doStart(user).finally(() => { starting = null; });
  return starting;
}

async function doStart(user) {
  teardown();
  try {
    S.db = await openDb(`tomei-${user.id}`);
  } catch (e) {
    return showFatal("Não consegui abrir o armazenamento deste aparelho. Se você está numa aba anônima/privada, abra o app numa aba normal.");
  }
  ls.set("tomei.lastUser", user.id);
  S.user = user;
  const syncSoon = () => S.sync?.syncSoon();
  S.store = createStore({ db: S.db, userId: user.id, onChange: () => { S.sync?.refreshCounts(); return reload(); }, syncSoon });
  S.push = createPush({ remote: S.remote, db: S.db, userId: user.id, syncSoon });
  S.sync = createSync({
    db: S.db, remote: S.remote, userId: user.id,
    steps: [profileStep({ db: S.db, remote: S.remote, userId: user.id }), S.push.syncStep],
    onState: onSyncState,
    onRemoteChange: reload,
  });
  S.screen = "app";
  await loadAll();
  render();
  // o estado das notificações depende do service worker: carrega em segundo plano, sem segurar a tela
  S.push.status().then((info) => { S.pushInfo = info; render(); }).catch(() => {});
  S.stopSync = S.sync.start();
  S.push.ensure().catch(() => {});
  navigator.storage?.persist?.().catch(() => {}); // pede ao navegador para NÃO apagar os dados do app sozinho
  handleLaunchUrl(location.href);
}

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  const hadController = !!navigator.serviceWorker.controller;
  try {
    const reg = await navigator.serviceWorker.register("./sw.js");
    const offerUpdate = () => toast("Há uma versão nova do Tomei.", { ms: 30_000, action: { label: "Atualizar", run: () => reg.waiting?.postMessage({ type: "SKIP_WAITING" }) } });
    if (reg.waiting && hadController) offerUpdate();
    reg.addEventListener("updatefound", () => {
      const w = reg.installing;
      w?.addEventListener("statechange", () => { if (w.state === "installed" && navigator.serviceWorker.controller) offerUpdate(); });
    });
    let reloaded = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => { if (hadController && !reloaded) { reloaded = true; location.reload(); } });
    navigator.serviceWorker.addEventListener("message", (e) => { if (e.data?.type === "navigate") handleLaunchUrl(e.data.url); });
    setInterval(() => reg.update().catch(() => {}), 3_600_000);
  } catch { /* sem service worker o app funciona, só não abre offline do zero */ }
}

async function main() {
  registerServiceWorker();
  addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); S.installEvent = e; render(); });
  if (!isConfigured(config)) return showSetup();

  S.remote = createRemote({ url: config.SUPABASE_URL, key: config.SUPABASE_PUBLISHABLE_KEY });
  S.remote.onAuthChange((event) => {
    if (event === "signed_out" && S.screen === "app") onSyncState({ ...S.syncState, phase: "auth" });
    if (event === "signed_in" && S.screen !== "app") { const s = S.remote.getStoredSession(); if (s) startFor(s.user); }
  });

  // A tela "Hoje" depende da hora: atualiza a cada 30 s e quando o app volta ao primeiro plano.
  setInterval(() => { if (document.visibilityState === "visible" && S.tab === "today") render(); }, 30_000);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") render(); });

  const session = S.remote.getStoredSession();
  if (session) await startFor(session.user);
  else showLogin();
}

main();
