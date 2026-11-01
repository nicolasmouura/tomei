// Ponto de entrada da Edge Function (Deno). Toda a lógica está em handler.ts,
// que é testado em Node sem precisar do Supabase.
import { handle } from "./handler.ts";

// Sobrevive entre requisições enquanto o "isolate" estiver quente (guarda a chave VAPID em cache).
const state = {};

Deno.serve((req: Request) =>
  handle(req, {
    env: (name: string) => Deno.env.get(name),
    fetch,
    state,
  })
);
