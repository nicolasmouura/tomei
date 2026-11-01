// =============================================================================
//  Conversa com o Supabase usando só `fetch` (sem biblioteca):
//    • Auth (GoTrue): entrar com e-mail/senha, renovar o token, sair
//    • PostgREST: ler/gravar tabelas (upsert idempotente)
//    • Edge Functions
//
//  Todo erro vira um RemoteError com `kind`, para o motor de sincronização saber
//  o que fazer:
//    network    sem internet / servidor inalcançável  → tenta de novo depois
//    transient  429 / 5xx                              → tenta de novo com espera
//    auth       login inválido ou expirado             → pede para entrar de novo
//    permanent  o servidor recusou ESTA linha (400/403/409...) → isola a linha, não trava o resto
// =============================================================================

export class RemoteError extends Error {
  constructor(kind, message, extra = {}) {
    super(message);
    this.name = "RemoteError";
    this.kind = kind;
    Object.assign(this, extra);
  }
}

const SESSION_KEY = "tomei.session";

function classify(status, data) {
  const message = data?.message ?? data?.msg ?? data?.error_description ?? data?.error ?? `HTTP ${status}`;
  const code = data?.code ?? data?.error_code ?? null;
  const kind = status === 401
    ? "auth"
    : status === 408 || status === 429 || status >= 500
    ? "transient"
    : "permanent";
  return new RemoteError(kind, String(message), { status, code });
}

export function createRemote({
  url,
  key,
  storage = globalThis.localStorage,
  fetchFn = (...a) => fetch(...a),
  now = () => Date.now(),
  timeoutMs = 20_000,
  locks = globalThis.navigator?.locks,
}) {
  const base = `${url.replace(/\/+$/, "")}/`;
  const listeners = new Set();
  const emit = (event, session) => listeners.forEach((cb) => cb(event, session));

  // ---------- sessão (fica no localStorage; sobrevive a fechar o app) ----------
  function readSession() {
    try {
      return JSON.parse(storage.getItem(SESSION_KEY) ?? "null");
    } catch {
      return null;
    }
  }
  const writeSession = (s) => storage.setItem(SESSION_KEY, JSON.stringify(s));
  const clearSession = () => storage.removeItem(SESSION_KEY);
  const toSession = (j) => ({
    access_token: j.access_token,
    refresh_token: j.refresh_token,
    // calculado com o relógio DO APARELHO (não confia no relógio do servidor)
    expires_at_ms: now() + (Number(j.expires_in) || 3600) * 1000,
    user: { id: j.user?.id, email: j.user?.email },
  });

  // Outra aba saiu da conta / entrou: avisa esta.
  globalThis.addEventListener?.("storage", (e) => {
    if (e.key !== SESSION_KEY) return;
    emit(e.newValue ? "signed_in" : "signed_out", readSession());
  });

  // ---------- HTTP cru ----------
  async function http(method, path, { query, body, token, prefer } = {}) {
    const u = new URL(path, base);
    for (const [k, v] of Object.entries(query ?? {})) u.searchParams.set(k, String(v));
    const headers = { apikey: key };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (prefer) headers.Prefer = prefer;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res, text;
    try {
      res = await fetchFn(u, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
      text = await res.text();
    } catch (cause) {
      throw new RemoteError("network", "Sem conexão com o servidor", { cause });
    } finally {
      clearTimeout(timer);
    }
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { message: text.slice(0, 200) };
      }
    }
    return { status: res.status, ok: res.ok, data };
  }

  // ---------- renovação do token (uma por vez, mesmo com várias abas) ----------
  let refreshing = null;
  function refresh(staleToken) {
    refreshing ??= (async () => {
      const work = async () => {
        const cur = readSession();
        if (!cur) throw new RemoteError("auth", "Sem sessão");
        // outra aba já renovou enquanto esperávamos a vez
        if (staleToken && cur.access_token !== staleToken) return cur;
        let r;
        try {
          r = await http("POST", "auth/v1/token", {
            query: { grant_type: "refresh_token" },
            body: { refresh_token: cur.refresh_token },
          });
        } catch (e) {
          throw e; // network: mantém a sessão, tenta depois
        }
        if (r.ok) {
          const s = toSession(r.data);
          writeSession(s);
          emit("token_refreshed", s);
          return s;
        }
        if (r.status >= 500 || r.status === 429 || r.status === 408) throw classify(r.status, r.data);
        // refresh token inválido/usado/revogado: a sessão morreu. NÃO apaga dados locais.
        clearSession();
        emit("signed_out", null);
        throw new RemoteError("auth", "Sessão expirada. Entre de novo.", { status: r.status });
      };
      return locks ? locks.request("tomei-auth", work) : work();
    })().finally(() => { refreshing = null; });
    return refreshing;
  }

  async function accessToken() {
    const s = readSession();
    if (!s) throw new RemoteError("auth", "Sem sessão");
    if (s.expires_at_ms - now() > 60_000) return s.access_token;
    return (await refresh(s.access_token)).access_token;
  }

  /** Chamada autenticada; se vier 401 renova o token e tenta mais uma vez. */
  async function call(method, path, opts = {}) {
    const token = await accessToken();
    let r = await http(method, path, { ...opts, token });
    if (r.status === 401 && !opts._retried) {
      await refresh(token);
      return call(method, path, { ...opts, _retried: true });
    }
    if (!r.ok) throw classify(r.status, r.data);
    return r.data;
  }

  // ---------- API pública ----------
  return {
    hasSession: () => !!readSession(),
    getStoredSession: readSession,

    onAuthChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },

    async signIn(email, password) {
      const r = await http("POST", "auth/v1/token", {
        query: { grant_type: "password" },
        body: { email: String(email).trim(), password },
      });
      if (!r.ok) {
        if (r.status === 400 || r.status === 401 || r.status === 422) {
          throw new RemoteError("auth", "E-mail ou senha incorretos.", { status: r.status });
        }
        if (r.status === 429) throw new RemoteError("transient", "Muitas tentativas. Espere um minuto e tente de novo.", { status: 429 });
        throw classify(r.status, r.data);
      }
      const s = toSession(r.data);
      writeSession(s);
      emit("signed_in", s);
      return s;
    },

    /** Sai da conta. Os dados locais NÃO são apagados. */
    async signOut() {
      const s = readSession();
      clearSession();
      emit("signed_out", null);
      if (s) {
        try {
          await http("POST", "auth/v1/logout", { query: { scope: "local" }, token: s.access_token });
        } catch { /* sem internet: tudo bem, a sessão local já foi removida */ }
      }
    },

    select: (table, query) => call("GET", `rest/v1/${table}`, { query }),

    /** Upsert idempotente por `onConflict` (reenviar a mesma linha nunca duplica). */
    async upsert(table, rows, onConflict = "id") {
      for (let i = 0; i < rows.length; i += 200) {
        await call("POST", `rest/v1/${table}`, {
          query: { on_conflict: onConflict },
          body: rows.slice(i, i + 200),
          prefer: "resolution=merge-duplicates,return=minimal",
        });
      }
    },

    async remove(table, query) {
      await call("DELETE", `rest/v1/${table}`, { query });
    },

    /** Tudo que mudou desde `sinceIso` (updated_at), paginado. */
    async pull(table, sinceIso, pageSize = 500) {
      const out = [];
      for (let offset = 0; ; offset += pageSize) {
        const page = await call("GET", `rest/v1/${table}`, {
          query: {
            select: "*",
            updated_at: `gte.${sinceIso}`,
            order: "updated_at.asc,id.asc",
            limit: pageSize,
            offset,
          },
        });
        out.push(...page);
        if (page.length < pageSize) return out;
      }
    },

    rpc: (fn, args = {}) => call("POST", `rest/v1/rpc/${fn}`, { body: args }),
    invokeFunction: (name, body = {}) => call("POST", `functions/v1/${name}`, { body }),
  };
}
