// =============================================================================
//  Formato dos dados: o que vai para o servidor e o que volta de lá.
//  (As colunas batem com supabase/migrations/…_tomei_schema.sql)
// =============================================================================
import { toIso, ALL_DAYS, normalizeWeekdays } from "./util.js";

const pick = (o, keys) => Object.fromEntries(keys.map((k) => [k, o[k] ?? null]));

const MED_COLS = ["id", "user_id", "name", "dose", "notes", "times", "weekdays", "archived_at"];
const INTAKE_COLS = ["id", "user_id", "medication_id", "med_name", "med_dose", "taken_at", "note", "slot", "slot_date", "deleted_at"];

/** Linha local → corpo do upsert (sem campos de controle e sem created_at/updated_at, que são do servidor). */
export const toRemote = {
  medications: (r) => ({
    ...pick(r, MED_COLS),
    dose: r.dose ?? "",
    notes: r.notes ?? "",
    times: r.times ?? [],
    weekdays: r.weekdays?.length ? normalizeWeekdays(r.weekdays) : ALL_DAYS,
  }),
  intakes: (r) => ({ ...pick(r, INTAKE_COLS), med_dose: r.med_dose ?? "", note: r.note ?? "", slot: r.slot ?? null, slot_date: r.slot_date ?? null }),
};

/** Linha do servidor → linha local (timestamps no formato padrão do JS). */
export const fromRemote = {
  medications: (r) => ({
    id: r.id,
    user_id: r.user_id,
    name: r.name,
    dose: r.dose ?? "",
    notes: r.notes ?? "",
    times: r.times ?? [],
    weekdays: r.weekdays?.length ? normalizeWeekdays(r.weekdays) : ALL_DAYS,
    archived_at: toIso(r.archived_at),
    created_at: r.created_at,
    updated_at: r.updated_at,
  }),
  intakes: (r) => ({
    id: r.id,
    user_id: r.user_id,
    medication_id: r.medication_id,
    med_name: r.med_name,
    med_dose: r.med_dose ?? "",
    taken_at: toIso(r.taken_at),
    note: r.note ?? "",
    slot: r.slot ?? null,
    slot_date: r.slot_date ?? null,
    deleted_at: toIso(r.deleted_at),
    created_at: r.created_at,
    updated_at: r.updated_at,
  }),
};

/** Tira os campos de controle local (para exportar backup). */
export const stripLocal = ({ _dirty, _rev, _error, _error_code, ...row }) => row;
