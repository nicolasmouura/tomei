// =============================================================================
//  Operações do app sobre os dados (cadastrar remédio, registrar dose...).
//
//  REGRA: toda função grava primeiro no banco local e só então avisa a tela e
//  agenda a sincronização. Quando a Promise resolve, o dado JÁ está confirmado
//  no disco do aparelho. Nenhuma operação apaga linha: "excluir" é marcar
//  deleted_at / archived_at (e isso também é sincronizado).
// =============================================================================
import { uuid, normalizeTimes, normalizeWeekdays, ALL_DAYS, HHMM } from "./util.js";
import { stripLocal } from "./model.js";

/** Tolerância para relógio do aparelho adiantado ao registrar "agora". */
const FUTURE_SLACK_MS = 10 * 60_000;

export function createStore({ db, userId, onChange = () => {}, syncSoon = () => {}, now = () => new Date() }) {
  /** Marca a linha como "alterada e ainda não enviada". */
  const touch = (cur, patch) => ({
    ...cur,
    ...patch,
    _dirty: 1,
    _rev: (cur?._rev ?? 0) + 1,
    _error: null,
    _error_code: null,
  });

  const changed = (row) => {
    onChange();
    syncSoon();
    return row;
  };

  return {
    allMedications: () => db.getAll("medications"),
    allIntakes: () => db.getAll("intakes"),

    /**
     * `weekdays` = dias em que o remédio vale (0 = domingo ... 6 = sábado). Se não vier,
     * mantém o que já estava (ou "todos os dias" para remédio novo).
     */
    async saveMedication({ id, name, dose = "", notes = "", times = [], weekdays }) {
      name = String(name ?? "").trim();
      if (!name) throw new Error("Dê um nome ao remédio.");
      if (name.length > 120) throw new Error("O nome do remédio está grande demais.");
      const days = weekdays === undefined ? undefined : normalizeWeekdays(weekdays);
      if (days && !days.length) throw new Error("Escolha pelo menos um dia da semana.");
      const rowId = id ?? uuid();
      const row = await db.update("medications", rowId, (cur) =>
        touch(
          cur ?? { id: rowId, user_id: userId, archived_at: null, created_at: now().toISOString(), updated_at: null },
          { name, dose: String(dose).trim(), notes: String(notes).trim(), times: normalizeTimes(times), weekdays: days ?? cur?.weekdays ?? ALL_DAYS },
        ));
      return changed(row);
    },

    async setMedicationArchived(id, archived) {
      const row = await db.update("medications", id, (cur) =>
        cur ? touch(cur, { archived_at: archived ? now().toISOString() : null }) : undefined);
      return changed(row);
    },

    /** Registra uma dose. Sem `takenAt`, usa o instante exato deste momento. */
    async logIntake({ medicationId, takenAt = now(), note = "", slot = null }) {
      const med = await db.get("medications", medicationId);
      if (!med) throw new Error("Remédio não encontrado.");
      if (takenAt.getTime() > now().getTime() + FUTURE_SLACK_MS) {
        throw new Error("Esse horário ainda não chegou. Escolha um horário que já passou.");
      }
      const row = {
        id: uuid(),
        user_id: userId,
        medication_id: med.id,
        med_name: med.name, // "foto" do nome/dose: renomear o remédio depois não muda o histórico
        med_dose: med.dose ?? "",
        taken_at: takenAt.toISOString(),
        note: String(note).trim(),
        slot: slot && HHMM.test(slot) ? slot : null,
        deleted_at: null,
        created_at: now().toISOString(),
        updated_at: null,
        _dirty: 1,
        _rev: 1,
        _error: null,
        _error_code: null,
      };
      await db.put("intakes", row);
      return changed(row);
    },

    async updateIntake(id, { takenAt, note }) {
      if (takenAt && takenAt.getTime() > now().getTime() + FUTURE_SLACK_MS) {
        throw new Error("Esse horário ainda não chegou. Escolha um horário que já passou.");
      }
      const row = await db.update("intakes", id, (cur) =>
        cur
          ? touch(cur, {
            ...(takenAt ? { taken_at: takenAt.toISOString() } : {}),
            ...(note !== undefined ? { note: String(note).trim() } : {}),
          })
          : undefined);
      return changed(row);
    },

    /** "Desfazer" = soft delete. Continua no banco (local e nuvem) e pode ser restaurado. */
    async removeIntake(id) {
      const row = await db.update("intakes", id, (cur) => (cur ? touch(cur, { deleted_at: now().toISOString() }) : undefined));
      return changed(row);
    },

    async restoreIntake(id) {
      const row = await db.update("intakes", id, (cur) => (cur ? touch(cur, { deleted_at: null }) : undefined));
      return changed(row);
    },

    /** Cópia completa (inclusive doses desfeitas) para o botão "Exportar backup". */
    async exportAll() {
      const [medications, intakes] = await Promise.all([db.getAll("medications"), db.getAll("intakes")]);
      return {
        app: "tomei",
        format: 1,
        exported_at: now().toISOString(),
        user_id: userId,
        medications: medications.map(stripLocal),
        intakes: intakes.map(stripLocal),
      };
    },
  };
}
