// =============================================================================
//  Notificações (Web Push): pedir permissão, inscrever este aparelho e avisar o
//  servidor. Quem de fato manda o lembrete na hora certa é a Edge Function.
// =============================================================================

const b64uToBytes = (s) => {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4)), (c) => c.charCodeAt(0));
};
const bytesToB64u = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export const isIos = () =>
  /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

/** App instalado na tela inicial (no iPhone, só assim as notificações funcionam). */
export const isStandalone = () =>
  navigator.standalone === true || matchMedia("(display-mode: standalone)").matches;

export const pushSupported = () =>
  "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

export function createPush({ remote, db, userId, syncSoon = () => {} }) {
  // `ready` nunca resolve se não houver service worker: não deixa a tela esperando para sempre
  const registration = () =>
    Promise.race([
      navigator.serviceWorker.ready,
      new Promise((_, reject) => setTimeout(() => reject(new Error("service worker indisponível")), 6000)),
    ]);

  /** Chave pública VAPID gerada pelo servidor (tabela vapid_public). */
  async function serverKey() {
    const [row] = await remote.select("vapid_public", { select: "public_key", limit: 1 });
    return row?.public_key ?? null;
  }

  async function currentSubscription() {
    if (!pushSupported()) return null;
    return (await registration()).pushManager.getSubscription();
  }

  /** Guarda a inscrição para o próximo ciclo de sincronização levar ao servidor. */
  async function remember(sub, key) {
    const j = sub.toJSON();
    await db.put("meta", {
      k: "push_sub",
      v: { endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth, key, dirty: true },
    });
    syncSoon();
  }

  return {
    supported: pushSupported,
    permission: () => (pushSupported() ? Notification.permission : "unsupported"),

    /**
     * Liga os lembretes neste aparelho. PRECISA ser chamado direto de um toque do
     * usuário (o iPhone exige) — por isso pede a permissão antes de qualquer outra coisa.
     */
    async enable() {
      if (!pushSupported()) throw new Error("Este navegador não oferece notificações.");
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        throw new Error(permission === "denied"
          ? "As notificações estão bloqueadas. Libere nas configurações do aparelho."
          : "Permissão não concedida.");
      }
      const key = await serverKey();
      if (!key) throw new Error("O servidor ainda está preparando as notificações. Tente de novo em 1 minuto.");

      const reg = await registration();
      let sub = await reg.pushManager.getSubscription();
      // inscrição criada com outra chave VAPID não serve mais: refaz
      if (sub && bytesToB64u(sub.options.applicationServerKey ?? new ArrayBuffer(0)) !== key) {
        await sub.unsubscribe();
        sub = null;
      }
      sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uToBytes(key) });
      await remember(sub, key);
      return sub;
    },

    async disable() {
      const sub = await currentSubscription();
      if (sub) {
        const endpoint = sub.endpoint;
        await sub.unsubscribe();
        await db.put("meta", { k: "push_sub", v: { endpoint, remove: true, dirty: true } });
        syncSoon();
      }
    },

    /** Estado para a tela de Ajustes. */
    async status() {
      const permission = this.permission();
      const sub = await currentSubscription().catch(() => null);
      const saved = (await db.get("meta", "push_sub"))?.v;
      return { supported: pushSupported(), permission, subscribed: !!sub, serverKnows: !!saved && !saved.dirty && !saved.remove };
    },

    /** Notificação local (não passa pelo servidor): só prova que o aparelho consegue exibir. */
    async testLocal() {
      const reg = await registration();
      await reg.showNotification("Tomei está funcionando", {
        body: "Esta é uma notificação de teste deste aparelho.",
        icon: "icons/icon-192.png",
        badge: "icons/badge-72.png",
        tag: "tomei-teste-local",
      });
    },

    /** Pede ao servidor para mandar um push de verdade (prova a cadeia inteira). */
    testServer: () => remote.invokeFunction("send-reminders", { test: true }),

    /** Ao abrir o app: garante que a inscrição existe e o servidor a conhece. */
    async ensure() {
      if (!pushSupported() || Notification.permission !== "granted") return;
      const sub = await currentSubscription();
      const saved = (await db.get("meta", "push_sub"))?.v;
      if (!sub) return; // permissão ok, mas sem inscrição: o usuário religa em Ajustes
      if (!saved || saved.endpoint !== sub.endpoint) await remember(sub, saved?.key ?? null);
    },

    /** Passo do ciclo de sincronização: leva a inscrição (ou a remoção dela) ao servidor. */
    syncStep: async () => {
      const saved = (await db.get("meta", "push_sub"))?.v;
      if (!saved?.dirty) return;
      if (saved.remove) {
        await remote.remove("push_subscriptions", { endpoint: `eq.${saved.endpoint}` });
        await db.put("meta", { k: "push_sub", v: { ...saved, dirty: false } });
        return;
      }
      await remote.upsert("push_subscriptions", [{
        user_id: userId,
        endpoint: saved.endpoint,
        p256dh: saved.p256dh,
        auth_secret: saved.auth,
        user_agent: navigator.userAgent.slice(0, 200),
        last_seen_at: new Date().toISOString(),
      }], "endpoint");
      await db.put("meta", { k: "push_sub", v: { ...saved, dirty: false } });
    },
  };
}

/** Fecha as notificações já entregues daquele remédio (quando a dose é registrada). */
export async function closeNotificationsFor(medId) {
  try {
    const reg = await navigator.serviceWorker?.ready;
    const list = await reg?.getNotifications?.();
    for (const n of list ?? []) if (n.data?.medIds?.includes(medId)) n.close();
  } catch { /* sem suporte: tudo bem */ }
}
