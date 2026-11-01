# Tomei

App para **marcar na hora cada remédio que você tomou** e nunca mais ficar na dúvida
("será que eu já tomei?"). PWA (instala na tela inicial, abre sem internet), com
**sincronização** pelo Supabase e **lembretes** por notificação.

- Um toque em **Tomei agora** grava o remédio com o horário exato.
- A tela **Hoje** mostra cada horário como uma "cavidade de cartela": vazia (por vir),
  âmbar (agora), coral (atrasado) ou preenchida (tomado, com a hora).
- Cada remédio tem seus **horários** e os **dias da semana** em que vale (padrão: todos os dias;
  dá para marcar, por exemplo, só seg/qua/sex).
- Se a mesma dose foi marcada há menos de 1 h, o app pergunta antes de marcar de novo.
- Lembretes na hora de cada remédio (só nos dias marcados); se não for registrado, o aviso se repete 15 min depois.
- Funciona **sem internet**: tudo grava no aparelho primeiro e sobe sozinho quando a conexão volta.

> Este projeto **não** dá orientação médica nem calcula doses. É só um caderno que não esquece.

---

## O que já está pronto no seu Supabase

Projeto **`tomei`** (ref `ekyigleiqwkxoxwmyakb`, região São Paulo), criado à parte dos seus outros projetos:

| Peça | Estado |
|---|---|
| Tabelas, RLS, auditoria (`supabase/migrations/…_tomei_schema.sql`) e dias da semana (`…_tomei_weekdays.sql`) | aplicadas; os testes de banco também passaram **no projeto real** |
| Edge Function `send-reminders` | publicada (sem `verify_jwt`: ela mesma confere quem chama), já com os dias da semana |
| Agendamento de 1 em 1 minuto (`…_tomei_cron.sql`, pg_cron + pg_net + Vault) | ativo; já executou várias vezes e a função respondeu 200 |
| Chave VAPID (push) | gerada pela própria função na 1ª execução, guardada no banco. **Você não precisa copiar nenhuma chave.** |
| `public/config.js` | já aponta para o seu projeto (URL + chave *publishable*, que é pública por natureza) |

## O que falta você fazer (5 passos, ~10 min)

1. **Criar a conta dela.** Dashboard do Supabase → *Authentication → Users → Add user → Create new user*,
   informe e-mail e senha e marque **Auto Confirm User**.
2. **Bloquear cadastros.** *Authentication → Sign In / Providers →* desligue **Allow new users to sign up**.
   (O app só tem tela de entrar; a conta é criada por você.)
3. **Publicar o app** (precisa de HTTPS para instalar e receber lembretes). O projeto já vem pronto para o **GitHub Pages**:
   1. Em <https://github.com/new> crie um repositório **vazio** chamado `tomei` (público, sem README nem `.gitignore`;
      no plano gratuito o Pages exige repositório público).
   2. Na pasta do projeto:
      ```bash
      git remote add origin https://github.com/SEU-USUARIO/tomei.git
      git push -u origin main
      ```
   3. No repositório: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
   4. Aba **Actions**: a publicação roda sozinha (testa e publica). Quando ficar verde, o app está em
      `https://SEU-USUARIO.github.io/tomei/`. Se a 1ª execução falhar por o Pages ainda não estar ativado,
      ative (passo anterior) e clique em **Re-run all jobs**.

   Depois disso, cada `git push` na `main` republica o app (só se os testes passarem). No celular, o app instalado
   mostra **"Há uma versão nova do Tomei"** com o botão *Atualizar*.

   Sem GitHub: **Netlify** (<https://app.netlify.com/drop> → arraste a pasta `public`) ou Cloudflare Pages / Vercel
   apontando para a pasta `public` (sem comando de build). A pasta já vem pronta.
4. **No celular dela**, abra o endereço e entre com o e-mail/senha. Depois:
   - **iPhone** (iOS 16.4+): Safari → Compartilhar → **Adicionar à Tela de Início** → abra pelo ícone novo.
     *Sem instalar, o iPhone não entrega notificações.*
   - **Android**: menu do Chrome → **Instalar app**.
5. Em **Ajustes → Lembretes**: **Ativar lembretes** e depois **Enviar notificação de teste**.
   Se o teste chegar, tudo está funcionando de ponta a ponta.

---

## Como "nunca perder dados" funciona (camadas)

| Camada | O que garante |
|---|---|
| **Aparelho (IndexedDB)** | Toda ação grava aqui **primeiro**, com `durability: strict`. Se a Promise resolveu, está no disco. O app pede ao navegador armazenamento persistente. |
| **Fila por linha** | Cada registro tem `_dirty/_rev`. Só vira "enviado" quando o servidor confirma **e** a linha não foi editada no meio do envio. |
| **Envio idempotente** | O `id` (UUID) nasce no aparelho e o envio é *upsert*. Reenviar 10× não duplica nada. |
| **Isolamento de erro** | Se o servidor recusar uma linha, só ela fica marcada ("Problema"); as outras sobem. Nada é descartado. |
| **Nada se apaga** | "Desfazer" = `deleted_at`; "excluir remédio" = arquivar. O app **não tem permissão de DELETE/TRUNCATE** (nem no banco). |
| **Auditoria** | Toda alteração copia a versão antiga para `private.audit_log` (fora da API). Dá para restaurar o que foi sobrescrito. |
| **Exportar backup** | Ajustes → `.json` (completo, inclusive desfeitos) e `.csv` (planilha). |

**Limites honestos:** o plano **Free** do Supabase **não faz backup automático** e **pausa o projeto após ~1 semana
sem atividade** (o uso diário dela e o cron evitam, mas fica o aviso; ao pausar, nada é apagado, basta clicar em
*Restore*). Se isso virar um risco para você, as saídas são: exportar um backup de vez em quando, ou o plano Pro (backup diário).
Limpar os dados do site no navegador apaga a cópia local (a da nuvem continua e volta no próximo login).

---

## Como funciona (resumo técnico)

```
  celular ──toque──▶ IndexedDB ──(sync.js, fetch)──▶ Supabase Postgres (RLS)
     ▲                                                     │
     │ Web Push (aes128gcm + VAPID)                        │ pg_cron: todo minuto
     └───────────── Edge Function send-reminders ◀─────────┘
```

- **Sem dependências**: nada de `npm install` para rodar. O cliente do Supabase (`public/js/remote.js`) é `fetch` puro
  (login, renovação de token, PostgREST, Functions) e o Web Push (`webpush.ts`) é WebCrypto puro (RFC 8291/8188/8292).
- **Sync** (`public/js/sync.js`): envia pendentes → passos extras (fuso, inscrição de push) → traz o que mudou
  (`updated_at` do servidor, com 2 min de sobreposição). Falhas de rede/servidor: nova tentativa com espera crescente.
- **Lembretes** (`supabase/functions/send-reminders`): a cada minuto calcula, por fuso da pessoa, quais horários chegaram
  (nos dias da semana marcados em cada remédio); ignora se a dose já foi registrada; reserva o envio na tabela
  `reminder_log` (duas execuções simultâneas nunca avisam em dobro); se o serviço de push falhar de forma passageira,
  devolve a reserva e tenta de novo no minuto seguinte.
- **Cron autenticado sem copiar segredo**: o segredo do cron nasce dentro do Vault e é conferido por `tomei_cron_ok()`.
- **Atualizações seguras**: o service worker guarda o app pelo hash do conteúdo e baixa a versão nova ignorando o cache HTTP
  (o GitHub Pages manda `max-age=600`; sem isso uma versão nova poderia guardar arquivos velhos).

```
public/               app (HTML/CSS/JS) — é isto que vai para o host
  js/                 db · remote · sync · store · push · logic · util · app
  sw.js               service worker (gerado pelo build)
supabase/
  migrations/         01 esquema+RLS+auditoria · 02 cron · 03 dias da semana
  functions/send-reminders/   index · handler · due · messages · webpush
scripts/              build.mjs (gera sw.js) · make_icons.mjs · serve.mjs
test/                 testes (veja abaixo)
.github/workflows/    pages.yml (testa e publica no GitHub Pages)
```

---

## Desenvolver e testar

Requer Node 22.18+ (os testes importam `.ts` direto).

```bash
npm install            # só para os testes (playwright, typescript); o app não precisa
npm run dev            # build + http://localhost:8080
npm run build          # regenera public/sw.js e a versão do cache (rode depois de mudar qualquer arquivo de public/)

npm test               # tudo: unitários + Chromium (offline, sync, interface, subpasta do Pages)
npm run test:unit      # lógica de horários, Web Push (vetor oficial do RFC 8291), função de lembretes
npm run test:browser   # sync offline-first + interface ponta a ponta + publicação em subpasta (Playwright)
npm run test:sql       # esquema/RLS num Postgres local (precisa de um servidor Postgres em /tmp/pg, veja test/run_sql_tests.sh)
npm run typecheck
```

O que os testes cobrem: ver `test/*.test.mjs` (cada teste tem nome descritivo). Destaques: a criptografia do push reproduz
**byte a byte o exemplo oficial do RFC 8291** e é conferida em Python (`test/verify_push.py`); o motor de sync é exercitado
com IndexedDB real em Chromium (offline, edição durante envio, linha recusada, token expirando, sessão revogada, 1.200 registros);
as proteções de dados foram validadas com **teste de mutação** (quebrar a regra faz o teste falhar); a publicação em subpasta
(`/tomei/`) e a atualização do service worker com cache HTTP de 10 min têm teste próprio (`test/pages_subpath.test.mjs`).

### Usar em outro projeto Supabase

1. Rode `supabase/migrations/*.sql` em ordem no SQL Editor (a 2ª tem a URL do projeto no começo: troque; a 3ª acrescenta os dias da semana).
2. Publique `supabase/functions/send-reminders` (`supabase functions deploy send-reminders --no-verify-jwt`).
3. Troque URL e chave *publishable* em `public/config.js` (ou defina `SUPABASE_URL` e `SUPABASE_PUBLISHABLE_KEY` no host e rode `npm run build`).

---

## Operação: consultas úteis (SQL Editor)

```sql
-- o cron está rodando? (execuções do agendador)
select start_time, status, return_message from cron.job_run_details order by start_time desc limit 5;
-- ...e o que a função respondeu (200 = ok; guardado só por algumas horas)
select created, status_code, left(content::text, 160) as resposta from net._http_response order by created desc limit 5;

-- doses de hoje
select taken_at at time zone 'America/Sao_Paulo' as hora, med_name, med_dose, deleted_at
from public.intakes order by taken_at desc limit 20;

-- restaurar uma dose que foi "desfeita" sem querer
update public.intakes set deleted_at = null where id = '<id da dose>';

-- ver a versão ANTIGA de algo que foi sobrescrito
select changed_at, table_name, old_row from private.audit_log order by changed_at desc limit 20;
```

Logs da função: Dashboard → Edge Functions → `send-reminders` → Logs.

## Limitações e ideias para depois

- Cada remédio tem horários fixos e os dias da semana escolhidos. **Não há** "a cada 8 horas" nem data de início/fim de tratamento.
  A estrutura comporta: `medications.times` / `medications.weekdays` + `due.ts`.
- Se a inscrição de push mudar enquanto o app está fechado, ela é refeita na próxima abertura do app.
- Cada pessoa tem a própria conta e os próprios dados (isolados por RLS). Se você também quiser usar, crie outra conta no Dashboard.
- O repositório do GitHub Pages é público, mas só contém a URL do projeto e a chave *publishable* do Supabase (feitas para ir no
  navegador) — nenhuma chave secreta existe no código. Quem protege os dados é o RLS, e o cadastro aberto deve ficar desligado (passo 2).
- Não foi possível testar aqui notificações em aparelho real (iPhone/Android): a cadeia inteira foi testada, **menos a entrega
  pelo serviço de push da Apple/Google**. O botão "Enviar notificação de teste" existe justamente para você confirmar isso em 5 segundos.
