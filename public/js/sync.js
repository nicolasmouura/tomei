// =============================================================================
//  Motor de sincronização: banco local (IndexedDB) ⇄ Supabase.
//
//  Ciclo: ENVIA o que está pendente → roda passos extras (fuso, notificações)
//  → TRAZ o que mudou no servidor.
//
//  Garantias:
//   • Idempotente: ids vêm do aparelho e o envio é upsert. Repetir é seguro.
//   • Uma linha defeituosa nunca trava as outras (o lote recusado é reenviado
//     linha a linha e só a ruim fica marcada com erro).
//   • Edição durante o envio não se perde (_rev: só marca "enviado" se a linha
//     não mudou desde que foi lida).
//   • Alteração local pendente nunca é sobrescrita por dado vindo do servidor.
//   • Falhas de rede/servidor: tenta de novo sozinho, com espera crescente.
//   • Nada é apagado, nunca.
// =============================================================================
import { toRemote, fromRemote } from "./model.js";
import { tsMs } from "./util.js";

const OVERLAP_MS = 120_000; // relê 2 min para trás: cobre commits fora de ordem no servidor
const PAGE = 500;
const BACKOFF_MS = [5, 15, 30, 60, 120, 300].map((s) => s * 1000);
const EPOCH = "1970-01-01T00:00:00.000Z";

export function createSync({
  db,
  remote,
  userId,
  steps = [],
  onState = () => {},
  onRemoteChange = () => {},
  intervalMs = 60_000,
  now = () => Date.now(),
}) {
  let state = { phase: "idle", pending: 0, errors: 0, lastSyncAt: null, lastError: null };
  let running = null;
  let again = false;
  let reason = "start";
  let failures = 0;
  let retryTimer = null;
  let soonTimer = null;

  const set = (patch) => {
    state = { ...state, ...patch };
    onState(state);
  };

  async function counts() {
    const [m, i] = await Promise.all([db.getDirty("medications"), db.getDirty("intakes")]);
    const all = [...m, ...i];
    return { pending: all.filter((r) => !r._error).length, errors: all.filter((r) => r._error).length };
  }

  const markClean = async (table, rows) => {
    for (const r of rows) {
      // só marca como enviado se a linha NÃO foi editada enquanto o envio rolava
      await db.update(table, r.id, (cur) => (cur && cur._rev === r._rev ? { ...cur, _dirty: 0, _error: null, _error_code: null } : undefined));
    }
  };

  const flag = (table, row, err) =>
    db.update(table, row.id, (cur) =>
      cur && cur._rev === row._rev ? { ...cur, _error: String(err.message).slice(0, 300), _error_code: err.code ?? null } : undefined);

  async function pushTable(table) {
    const dirty = (await db.getDirty(table)).filter((r) => !r._error);
    if (!dirty.length) return 0;
    try {
      await remote.upsert(table, dirty.map(toRemote[table]));
      await markClean(table, dirty);
      return dirty.length;
    } catch (e) {
      if (e.kind !== "permanent") throw e; // rede/servidor/login: aborta o ciclo e tenta depois
    }
    // O servidor recusou o lote por causa de PELO MENOS uma linha: isola a defeituosa.
    let ok = 0;
    for (const row of dirty) {
      try {
        await remote.upsert(table, [toRemote[table](row)]);
        await markClean(table, [row]);
        ok++;
      } catch (e) {
        if (e.kind !== "permanent") throw e;
        await flag(table, row, e);
      }
    }
    return ok;
  }

  /** Doses recusadas só porque o remédio ainda não existia no servidor (FK 23503) voltam à fila. */
  async function requeueForeignKeyErrors() {
    const rows = (await db.getDirty("intakes")).filter((r) => r._error && r._error_code === "23503");
    for (const r of rows) {
      await db.update("intakes", r.id, (cur) => (cur && cur._rev === r._rev ? { ...cur, _error: null, _error_code: null } : undefined));
    }
  }

  async function pullTable(table) {
    const key = `cursor:${table}`;
    const saved = await db.get("meta", key);
    const since = saved ? new Date(tsMs(saved.v) - OVERLAP_MS).toISOString() : EPOCH;
    const rows = await remote.pull(table, since, PAGE);
    if (!rows.length) return 0;
    const incoming = rows.map(fromRemote[table]);
    const changed = await db.mergeMany(table, incoming, (local, theirs) => {
      if (local?._dirty) return undefined; // alteração local pendente tem prioridade (vai subir no próximo envio)
      if (local && local.updated_at === theirs.updated_at) return undefined; // já temos exatamente esta versão
      return { ...theirs, _dirty: 0, _rev: local?._rev ?? 0, _error: null, _error_code: null };
    });
    const newest = rows.reduce((a, r) => (tsMs(r.updated_at) >= tsMs(a) ? r.updated_at : a), saved?.v ?? EPOCH);
    await db.put("meta", { k: key, v: newest });
    return changed;
  }

  async function cycle() {
    clearTimeout(retryTimer);
    if (!remote.hasSession()) {
      set({ phase: "auth", ...(await counts()) });
      return;
    }
    const quiet = reason === "tick" && state.phase === "idle" && (await counts()).pending === 0;
    if (!quiet) set({ phase: "syncing" });
    try {
      const sentMeds = await pushTable("medications");
      if (sentMeds) await requeueForeignKeyErrors();
      await pushTable("intakes");
      for (const step of steps) await step();
      const changed = (await pullTable("medications")) + (await pullTable("intakes"));
      failures = 0;
      await db.put("meta", { k: "last_sync_at", v: now() });
      set({ phase: "idle", lastSyncAt: now(), lastError: null, ...(await counts()) });
      if (changed) onRemoteChange(changed);
    } catch (e) {
      const c = await counts();
      if (e.kind === "auth") {
        set({ phase: "auth", lastError: e.message, ...c });
        return;
      }
      failures++;
      set({ phase: e.kind === "network" ? "offline" : "error", lastError: e.message, ...c });
      retryTimer = setTimeout(() => syncNow("retry"), BACKOFF_MS[Math.min(failures - 1, BACKOFF_MS.length - 1)]);
    }
  }

  /** Sincroniza agora. Nunca rejeita: o resultado fica em getState(). */
  function syncNow(why = "manual") {
    reason = why;
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      do {
        again = false;
        await cycle();
      } while (again);
    })().finally(() => { running = null; });
    return running;
  }

  /** Agenda uma sincronização logo depois de uma gravação (junta várias seguidas). */
  function syncSoon() {
    clearTimeout(soonTimer);
    soonTimer = setTimeout(() => syncNow("write"), 300);
  }

  /** O usuário pediu "tentar de novo" nas linhas recusadas. */
  async function retryErrors() {
    for (const table of ["medications", "intakes"]) {
      for (const r of await db.getDirty(table)) {
        if (r._error) await db.update(table, r.id, (cur) => (cur ? { ...cur, _error: null, _error_code: null } : undefined));
      }
    }
    return syncNow("manual");
  }

  function start() {
    const onOnline = () => syncNow("online");
    const onOffline = async () => set({ phase: "offline", ...(await counts()) });
    const onVisible = () => { if (document.visibilityState === "visible") syncNow("visible"); };
    addEventListener("online", onOnline);
    addEventListener("offline", onOffline);
    addEventListener("pageshow", onVisible);
    document.addEventListener("visibilitychange", onVisible);
    const iv = setInterval(() => { if (document.visibilityState === "visible") syncNow("tick"); }, intervalMs);
    db.get("meta", "last_sync_at").then((m) => m && set({ lastSyncAt: m.v }));
    counts().then((c) => set(c));
    syncNow("start");
    return () => {
      removeEventListener("online", onOnline);
      removeEventListener("offline", onOffline);
      removeEventListener("pageshow", onVisible);
      document.removeEventListener("visibilitychange", onVisible);
      clearInterval(iv);
      clearTimeout(retryTimer);
      clearTimeout(soonTimer);
    };
  }

  /** Atualiza só os contadores (pendentes/erros) — chamado a cada gravação, para o selo reagir na hora. */
  const refreshCounts = async () => set(await counts());

  return { start, syncNow, syncSoon, retryErrors, refreshCounts, getState: () => state, counts };
}

/** Passo do ciclo: manda o fuso horário do aparelho (o servidor usa nos lembretes). */
export function profileStep({ db, remote, userId }) {
  const tz = () => {
    try {
      const z = Intl.DateTimeFormat().resolvedOptions().timeZone;
      return /^[A-Za-z_]+(\/[A-Za-z0-9_+\-]+)*$/.test(z) ? z : null;
    } catch {
      return null;
    }
  };
  return async () => {
    const zone = tz();
    if (!zone) return;
    const saved = await db.get("meta", "profile");
    if (saved?.v?.timezone === zone) return;
    try {
      await remote.upsert("profiles", [{ user_id: userId, timezone: zone }], "user_id");
      await db.put("meta", { k: "profile", v: { timezone: zone } });
    } catch (e) {
      if (e.kind !== "permanent") throw e;
      await db.put("meta", { k: "profile", v: { timezone: zone, error: e.message } }); // não insiste num fuso que o banco recusa
    }
  };
}
