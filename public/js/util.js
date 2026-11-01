// =============================================================================
//  Utilidades pequenas, sem dependências: ids, datas em pt-BR, DOM e CSV.
// =============================================================================

// ---------- ids ------------------------------------------------------------------

/** UUID v4. O id nasce no aparelho: reenviar o mesmo registro nunca duplica no servidor. */
export function uuid() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const x = [...b].map((n) => n.toString(16).padStart(2, "0"));
  return `${x.slice(0, 4).join("")}-${x.slice(4, 6).join("")}-${x.slice(6, 8).join("")}-${x.slice(8, 10).join("")}-${x.slice(10).join("")}`;
}

// ---------- datas ----------------------------------------------------------------

/** Timestamp ISO do servidor ("...123456+00:00") → milissegundos (o JS só entende 3 casas). */
export const tsMs = (s) => Date.parse(String(s).replace(/(\.\d{3})\d+/, "$1"));

/** Qualquer timestamp ISO → ISO padrão do JS ("...Z"), ou null. */
export const toIso = (s) => (s == null || s === "" ? null : new Date(tsMs(s)).toISOString());

const timeFmt = new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
/** "08:03" no horário local do aparelho. */
export const hhmm = (d) => timeFmt.format(d);

export const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

export const sameDay = (a, b) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** Quantos dias de calendário separam `d` de `now` (0 = hoje, 1 = ontem). */
export const dayDiff = (d, now) => Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000);

export const dayKey = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

const longDay = new Intl.DateTimeFormat("pt-BR", { weekday: "long", day: "numeric", month: "long" });
const shortDay = new Intl.DateTimeFormat("pt-BR", { weekday: "short", day: "numeric", month: "short" });

export function dayLabel(d, now) {
  const n = dayDiff(d, now);
  if (n === 0) return "Hoje";
  if (n === 1) return "Ontem";
  return shortDay.format(d).replace(".", "");
}

/** "Domingo, 1 de novembro" (só a primeira letra em maiúscula, como se escreve em português) */
export const longDayLabel = (d) => {
  const s = longDay.format(d);
  return s.charAt(0).toUpperCase() + s.slice(1);
};

/** "há 12 min", "há 2 h 5 min", "há 3 dias". */
export function ago(ms) {
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "agora há pouco";
  if (m < 60) return `há ${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `há ${h} h ${m % 60} min` : `há ${h} h`;
  const d = Math.floor(h / 24);
  return d === 1 ? "há 1 dia" : `há ${d} dias`;
}

/** "daqui a 40 min", "daqui a 2 h". */
export function inFuture(ms) {
  const m = Math.max(1, Math.round(ms / 60_000));
  if (m < 60) return `em ${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `em ${h} h ${m % 60} min` : `em ${h} h`;
}

/** Para <input type="datetime-local">: "2026-11-01T08:03" no horário local. */
export function toLocalInput(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ---------- horários dos lembretes ----------------------------------------------

export const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
/** Remove inválidos e repetidos e ordena. */
export const normalizeTimes = (list) => [...new Set((list ?? []).filter((t) => HHMM.test(t)))].sort();

// ---------- dias da semana (0 = domingo ... 6 = sábado, igual ao Date do JavaScript) ----------

export const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
export const DAY_SHORT = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];

/** Só inteiros de 0 a 6, sem repetir, em ordem. */
export const normalizeWeekdays = (list) =>
  [...new Set((list ?? []).map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6))].sort((a, b) => a - b);

/** ["A"] → "A" · ["A","B"] → "A e B" · ["A","B","C"] → "A, B e C" */
export const joinPt = (items) =>
  items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} e ${items[items.length - 1]}`;

/** "Todos os dias" · "Dias úteis" · "Fins de semana" · "Seg, qua e sex" */
export function weekdaysLabel(list) {
  const d = normalizeWeekdays(list);
  if (d.length === 0 || d.length === 7) return "Todos os dias";
  const key = d.join();
  if (key === "1,2,3,4,5") return "Dias úteis";
  if (key === "0,6") return "Fins de semana";
  const text = joinPt(d.map((n) => DAY_SHORT[n]));
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// ---------- DOM -------------------------------------------------------------------

/**
 * Cria elementos sem innerHTML (nada que o usuário digite vira HTML).
 *   h("button", { class: "x", onclick: fn }, "texto", outroElemento)
 */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else if (k === "dataset") Object.assign(el.dataset, v);
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "for") el.htmlFor = v;
    else if (k.startsWith("aria-") || k.startsWith("data-") || k === "role") el.setAttribute(k, v === true ? "" : v);
    else if (k in el) el[k] = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  const add = (c) => {
    if (c == null || c === false) return;
    if (Array.isArray(c)) c.forEach(add);
    else el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  };
  children.forEach(add);
  return el;
}

// ---------- exportação ------------------------------------------------------------

/** CSV com ";" (o Excel em pt-BR abre direto) e BOM para os acentos. */
export function toCsv(rows) {
  const cell = (c) => {
    const s = String(c ?? "");
    return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return "﻿" + rows.map((r) => r.map(cell).join(";")).join("\r\n") + "\r\n";
}

export const debounce = (fn, ms) => {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
};
