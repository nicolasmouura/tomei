// Textos das notificações (pt-BR) e agrupamento: remédios no mesmo horário
// viram UMA notificação só, em vez de uma pilha delas.

import type { DueReminder } from "./due.ts";

export interface PushMessage {
  title: string;
  body: string;
  /** mesma tag = a notificação nova substitui a antiga (o lembrete extra troca o primeiro) */
  tag: string;
  /** para onde o toque leva (relativo ao escopo do service worker) */
  url: string;
  medIds: string[];
  slot: string;
  kind: number;
}

export interface MessageGroup {
  message: PushMessage;
  members: DueReminder[];
}

const label = (m: { name: string; dose: string }) => (m.dose ? `${m.name} ${m.dose}` : m.name);

/** ["A"] → "A" · ["A","B"] → "A e B" · ["A","B","C"] → "A, B e C" */
export function joinPt(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} e ${items[items.length - 1]}`;
}

export function buildMessages(due: DueReminder[]): MessageGroup[] {
  const groups = new Map<string, DueReminder[]>();
  for (const d of due) {
    const key = `${d.localDate}|${d.slot}|${d.kind}`;
    groups.set(key, [...(groups.get(key) ?? []), d]);
  }
  return [...groups.values()].map((members) => {
    const first = members[0];
    const names = joinPt(members.map((m) => label(m.medication)));
    const medIds = members.map((m) => m.medication.id);
    const base = {
      tag: `tomei-${first.localDate}-${first.slot}`,
      url: medIds.length === 1 ? `./?take=${medIds[0]}` : "./",
      medIds,
      slot: first.slot,
      kind: first.kind,
    };
    const message: PushMessage = first.kind === 0
      ? { ...base, title: "Hora do remédio", body: `${names} (${first.slot})` }
      : {
        ...base,
        title: "Você já tomou?",
        body: `${names} das ${first.slot} ainda não foi registrado. Toque para marcar.`,
      };
    return { message, members };
  });
}

export const testMessage: PushMessage = {
  title: "Tomei está funcionando",
  body: "Os lembretes dos seus remédios vão chegar assim.",
  tag: "tomei-teste",
  url: "./",
  medIds: [],
  slot: "",
  kind: 0,
};
