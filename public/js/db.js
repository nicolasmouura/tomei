// =============================================================================
//  Banco local (IndexedDB) — a PRIMEIRA cópia dos dados.
//
//  Toda gravação do app vai para cá antes de qualquer coisa de rede. Só depois
//  o motor de sincronização (sync.js) leva para o Supabase. Por isso o app
//  funciona sem internet e o dado não se perde se a conexão cair.
//
//  Cada linha local carrega 3 campos de controle:
//    _dirty  1 = tem alteração ainda não confirmada pelo servidor
//    _rev    contador que sobe a cada alteração local (evita "marcar como enviado"
//            uma linha que foi editada enquanto o envio estava em andamento)
//    _error  texto, se o servidor recusou a linha de forma definitiva
// =============================================================================

const VERSION = 1;

export function openDb(name) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore("meta", { keyPath: "k" });
      const meds = db.createObjectStore("medications", { keyPath: "id" });
      meds.createIndex("_dirty", "_dirty");
      const intakes = db.createObjectStore("intakes", { keyPath: "id" });
      intakes.createIndex("_dirty", "_dirty");
      intakes.createIndex("taken_at", "taken_at");
      intakes.createIndex("medication_id", "medication_id");
    };
    req.onsuccess = () => resolve(wrap(req.result));
    req.onerror = () => reject(req.error ?? new Error("Não foi possível abrir o banco local"));
    req.onblocked = () => reject(new Error("Banco local bloqueado por outra aba"));
  });
}

function wrap(idb) {
  /**
   * Executa `fn(tx)` numa transação. Resolve só quando a transação CONFIRMOU
   * (oncomplete) — com durability "strict" o dado já foi para o disco.
   * `fn` deve resolver o valor de retorno a partir de callbacks do IndexedDB
   * (nada de await em outras promises dentro da transação).
   */
  const run = (stores, mode, fn) =>
    new Promise((resolve, reject) => {
      let tx;
      try {
        tx = idb.transaction(stores, mode, mode === "readwrite" ? { durability: "strict" } : undefined);
      } catch {
        tx = idb.transaction(stores, mode);
      }
      let out;
      tx.oncomplete = () => resolve(out);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error("Transação abortada"));
      try {
        fn(tx, (v) => (out = v));
      } catch (err) {
        try { tx.abort(); } catch { /* já finalizada */ }
        reject(err);
      }
    });

  const asPromise = (req) =>
    new Promise((res, rej) => {
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });

  return {
    get: (store, key) => run([store], "readonly", (tx, ret) => { tx.objectStore(store).get(key).onsuccess = (e) => ret(e.target.result); }),

    getAll: (store) => run([store], "readonly", (tx, ret) => { tx.objectStore(store).getAll().onsuccess = (e) => ret(e.target.result); }),

    /** Linhas com alteração pendente (_dirty = 1). */
    getDirty: (store) =>
      run([store], "readonly", (tx, ret) => {
        tx.objectStore(store).index("_dirty").getAll(1).onsuccess = (e) => ret(e.target.result);
      }),

    put: (store, value) => run([store], "readwrite", (tx, ret) => { tx.objectStore(store).put(value); ret(value); }),

    putMany: (store, values) =>
      run([store], "readwrite", (tx) => {
        const os = tx.objectStore(store);
        for (const v of values) os.put(v);
      }),

    /**
     * Ler-modificar-gravar ATÔMICO de uma linha. `fn(atual)` devolve a linha nova,
     * ou `undefined` para não mexer em nada.
     */
    update: (store, key, fn) =>
      run([store], "readwrite", (tx, ret) => {
        const os = tx.objectStore(store);
        os.get(key).onsuccess = (e) => {
          const cur = e.target.result;
          const next = fn(cur);
          if (next === undefined) return ret(cur);
          os.put(next);
          ret(next);
        };
      }),

    /**
     * Mescla várias linhas vindas do servidor numa transação só.
     * `mergeFn(atual, vindo)` devolve a linha a gravar, ou `undefined` para manter a atual.
     */
    mergeMany: (store, incoming, mergeFn) =>
      run([store], "readwrite", (tx, ret) => {
        const os = tx.objectStore(store);
        let changed = 0;
        for (const row of incoming) {
          os.get(row.id).onsuccess = (e) => {
            const next = mergeFn(e.target.result, row);
            if (next !== undefined) {
              os.put(next);
              changed++;
            }
          };
        }
        ret(() => changed);
      }).then((getChanged) => getChanged()),

    close: () => idb.close(),
    _asPromise: asPromise,
  };
}
