// =============================================================================
//  "Quais lembretes estão na hora de sair agora?" — lógica pura, sem rede.
//
//  Regras:
//   • Cada remédio tem horários diários ('08:00', '20:00'...) no FUSO da pessoa.
//   • O cron roda a cada minuto. Um lembrete "vale" do horário até GRACE_MIN
//     minutos depois (tolera atraso do cron / cold start). Quem impede duplicata
//     é a tabela reminder_log, não esta janela.
//   • Se a pessoa JÁ registrou o remédio perto do horário, não avisa.
//   • Se, passados NAG_AFTER_MIN minutos, ainda não registrou: aviso extra.
// =============================================================================

/** tolerância (min) para o cron/cold start atrasar */
export const GRACE_MIN = 5;
/** minutos depois do horário para cada lembrete extra (kind 1, 2...) */
export const NAG_AFTER_MIN: number[] = [15];
/** dose registrada até X min ANTES do horário já "vale" para aquele horário */
export const EARLY_WINDOW_MIN = 90;

export interface Medication {
  id: string;
  name: string;
  dose: string;
  times: string[];
  /** dias em que vale: 0 = domingo ... 6 = sábado. Ausente/vazio = todos os dias. */
  weekdays?: number[] | null;
}

export const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

export interface IntakeRef {
  medication_id: string;
  taken_at: string; // ISO
}

export interface DueReminder {
  medication: Medication;
  slot: string; // 'HH:MM'
  localDate: string; // 'YYYY-MM-DD' no fuso da pessoa
  kind: number; // 0 = no horário; 1.. = lembretes extras
  slotAt: Date;
}

const HHMM = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(tz, f);
  }
  return f;
}

/** Relógio de parede de `date` no fuso `tz`. */
export function zonedParts(date: Date, tz: string) {
  const o: Record<string, number> = {};
  for (const p of formatter(tz).formatToParts(date)) {
    if (p.type !== "literal") o[p.type] = parseInt(p.value, 10);
  }
  return {
    year: o.year,
    month: o.month,
    day: o.day,
    hour: o.hour === 24 ? 0 : o.hour,
    minute: o.minute,
    second: o.second,
  };
}

const pad = (n: number) => String(n).padStart(2, "0");

/** 'YYYY-MM-DD' de `date` no fuso `tz`. */
export function localDate(date: Date, tz: string): string {
  const p = zonedParts(date, tz);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** Dia da semana (0 = domingo ... 6 = sábado) de uma data de calendário 'YYYY-MM-DD'. */
export function weekdayOf(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** Soma dias a uma data de calendário 'YYYY-MM-DD' (independe de fuso). */
export function addDays(date: string, delta: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + delta)).toISOString().slice(0, 10);
}

/** Diferença (ms) entre o relógio de parede de `tz` e o UTC no instante `ms`. */
function offsetMs(ms: number, tz: string): number {
  const p = zonedParts(new Date(ms), tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** Converte "dia + HH:MM no relógio da pessoa" para o instante real (UTC). */
export function wallTimeToInstant(date: string, hhmm: string, tz: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = hhmm.split(":").map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  let t = guess - offsetMs(guess, tz);
  const again = offsetMs(t, tz); // pode mudar na fronteira do horário de verão
  if (again !== guess - t) t = guess - again;
  return new Date(t);
}

export function reminderKey(medId: string, date: string, slot: string, kind: number): string {
  return `${medId}|${date}|${slot}|${kind}`;
}

export interface ComputeInput {
  now: Date;
  tz: string;
  medications: Medication[];
  /** doses (não apagadas) das últimas horas */
  intakes: IntakeRef[];
  /** chaves já enviadas (reminderKey) — normalmente vazio: quem decide é o reminder_log */
  sent?: Set<string>;
}

export function computeDue(input: ComputeInput): DueReminder[] {
  const { now, tz, medications, intakes } = input;
  const sent = input.sent ?? new Set<string>();
  const nowMs = now.getTime();

  // Datas locais em que ainda pode haver lembrete "vivo": hoje e, logo após a
  // meia-noite, ontem. (3 h cobre GRACE + lembretes extras com folga.)
  const dates = [...new Set([localDate(new Date(nowMs - 3 * 3600_000), tz), localDate(now, tz)])].sort();
  const lookupDates = [addDays(dates[0], -1), ...dates]; // + 1 dia atrás, para achar o "horário anterior"

  const takenByMed = new Map<string, number[]>();
  for (const i of intakes) {
    const t = Date.parse(i.taken_at);
    if (Number.isNaN(t)) continue;
    const list = takenByMed.get(i.medication_id) ?? [];
    list.push(t);
    takenByMed.set(i.medication_id, list);
  }

  const out: DueReminder[] = [];
  for (const med of medications) {
    const slots = [...new Set(med.times ?? [])].filter((s) => HHMM.test(s)).sort();
    if (!slots.length) continue;
    // dias em que o remédio vale (sem informação = todos os dias)
    const days = new Set((med.weekdays?.length ? med.weekdays : ALL_DAYS).map(Number));

    // Só entram os horários dos dias marcados: assim o "horário anterior" também respeita os dias.
    const instants: { date: string; slot: string; at: number }[] = [];
    for (const date of lookupDates) {
      if (!days.has(weekdayOf(date))) continue;
      for (const slot of slots) {
        instants.push({ date, slot, at: wallTimeToInstant(date, slot, tz).getTime() });
      }
    }
    instants.sort((a, b) => a.at - b.at);

    for (let idx = 0; idx < instants.length; idx++) {
      const inst = instants[idx];
      if (!dates.includes(inst.date)) continue;
      const elapsedMin = (nowMs - inst.at) / 60_000;
      if (elapsedMin < 0 || elapsedMin >= Math.max(...NAG_AFTER_MIN, 0) + GRACE_MIN) continue;

      // Uma dose antecipada só vale para ESTE horário se for mais perto dele do que do anterior.
      let windowStart = inst.at - EARLY_WINDOW_MIN * 60_000;
      if (idx > 0) {
        const prev = instants[idx - 1].at;
        windowStart = Math.max(windowStart, prev + (inst.at - prev) / 2);
      }
      const alreadyTaken = (takenByMed.get(med.id) ?? []).some((t) => t >= windowStart && t <= nowMs);
      if (alreadyTaken) continue;

      for (let kind = 0; kind <= NAG_AFTER_MIN.length; kind++) {
        const offset = kind === 0 ? 0 : NAG_AFTER_MIN[kind - 1];
        if (elapsedMin >= offset && elapsedMin < offset + GRACE_MIN) {
          if (sent.has(reminderKey(med.id, inst.date, inst.slot, kind))) continue;
          out.push({ medication: med, slot: inst.slot, localDate: inst.date, kind, slotAt: new Date(inst.at) });
        }
      }
    }
  }
  return out;
}
