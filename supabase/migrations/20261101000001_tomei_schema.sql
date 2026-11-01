-- =============================================================================
--  TOMEI · migração 1 · esquema, segurança (RLS) e trilha de auditoria
-- =============================================================================
--  Regras de ouro deste banco (para NUNCA perder dado):
--    1. Nada é apagado de verdade. "Excluir" = preencher deleted_at / archived_at.
--    2. O app (role `authenticated`) NÃO tem permissão de DELETE nem de TRUNCATE
--       nas tabelas de dados (medications, intakes, profiles).
--    3. Toda alteração em linha existente copia a versão ANTIGA para
--       private.audit_log (schema `private` não é exposto pela API).
--    4. RLS: cada pessoa só enxerga e escreve as próprias linhas.
--    5. Os UUIDs nascem no aparelho: reenviar o mesmo registro 10x nunca duplica
--       (upsert por id) e reenvio idêntico nem gera "nova versão".
-- =============================================================================

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;


-- -----------------------------------------------------------------------------
--  Tabelas
-- -----------------------------------------------------------------------------

-- Perfil: guarda o fuso horário usado pelo servidor para calcular os lembretes.
create table public.profiles (
  user_id    uuid primary key references auth.users (id) on delete restrict,
  timezone   text not null default 'America/Sao_Paulo',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Remédios cadastrados. `times` = horários diários dos lembretes ('08:00', '20:00'...).
-- "Excluir" um remédio = arquivar (archived_at). O histórico continua intacto.
create table public.medications (
  id          uuid primary key,
  user_id     uuid not null default auth.uid() references auth.users (id) on delete restrict,
  name        text not null check (char_length(btrim(name)) between 1 and 120),
  dose        text not null default '' check (char_length(dose) <= 120),
  notes       text not null default '' check (char_length(notes) <= 1000),
  times       text[] not null default '{}'
              check (
                cardinality(times) <= 12
                and array_to_string(times, ',') ~
                    '^$|^([01][0-9]|2[0-3]):[0-5][0-9](,([01][0-9]|2[0-3]):[0-5][0-9])*$'
              ),
  archived_at timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  -- permite a chave estrangeira composta de intakes (garante mesmo dono)
  constraint medications_id_user_key unique (id, user_id)
);

-- Cada vez que a pessoa toma um remédio = uma linha aqui.
-- med_name/med_dose são uma "foto" do momento: renomear o remédio depois não
-- reescreve o passado.
create table public.intakes (
  id            uuid primary key,
  user_id       uuid not null default auth.uid() references auth.users (id) on delete restrict,
  medication_id uuid not null,
  med_name      text not null check (char_length(btrim(med_name)) between 1 and 120),
  med_dose      text not null default '' check (char_length(med_dose) <= 120),
  taken_at      timestamptz not null,
  note          text not null default '' check (char_length(note) <= 1000),
  deleted_at    timestamptz,                  -- "desfazer" = soft delete
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  -- o remédio tem que existir E ser do mesmo dono
  constraint intakes_medication_fk
    foreign key (medication_id, user_id)
    references public.medications (id, user_id) on delete restrict
);

-- Aparelhos que aceitaram receber notificações (Web Push).
create table public.push_subscriptions (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references auth.users (id) on delete cascade,
  endpoint     text not null unique check (endpoint like 'https://%'),
  p256dh       text not null,
  auth_secret  text not null,
  user_agent   text not null default '',
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

-- Controle interno: qual lembrete já foi enviado (evita avisar duas vezes).
-- Só o servidor (service_role) mexe aqui.
create table public.reminder_log (
  medication_id uuid not null references public.medications (id) on delete cascade,
  local_date    date not null,
  slot          text not null check (slot ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  kind          smallint not null check (kind between 0 and 5),   -- 0 = no horário; 1.. = lembretes extras
  sent_at       timestamptz not null default now(),
  primary key (medication_id, local_date, slot, kind)
);

-- Chave pública VAPID (a pública é... pública: o navegador precisa dela para assinar a inscrição).
create table public.vapid_public (
  id         boolean primary key default true check (id),
  public_key text not null
);

-- Trilha de auditoria: versão ANTIGA de qualquer linha alterada. Fora da API.
create table private.audit_log (
  id         bigint generated always as identity primary key,
  table_name text        not null,
  row_id     text        not null,
  op         text        not null,
  old_row    jsonb       not null,
  changed_at timestamptz not null default clock_timestamp(),
  changed_by uuid
);
create index audit_log_row_idx on private.audit_log (table_name, row_id, changed_at);

-- Par de chaves VAPID gerado pela própria Edge Function na primeira execução.
-- A chave privada nunca sai do banco (nem passa por mim, nem por você).
create table private.vapid_keys (
  id          boolean primary key default true check (id),
  public_key  text  not null,
  private_jwk jsonb not null,
  created_at  timestamptz not null default now()
);

-- Índices (cobrem as chaves estrangeiras e as consultas do app / do servidor)
create index medications_user_updated_idx on public.medications (user_id, updated_at, id);
create index intakes_user_updated_idx     on public.intakes (user_id, updated_at, id);
create index intakes_user_taken_idx       on public.intakes (user_id, taken_at desc);
create index intakes_medication_idx       on public.intakes (medication_id, user_id, taken_at desc);
create index push_subscriptions_user_idx  on public.push_subscriptions (user_id);


-- -----------------------------------------------------------------------------
--  Triggers
-- -----------------------------------------------------------------------------

-- Mantém updated_at pelo relógio do SERVIDOR (é o cursor da sincronização) e
-- transforma "reenvio idêntico" em no-op: nada muda, nada é auditado.
create function private.tomei_touch()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    if (to_jsonb(new) - 'updated_at') = (to_jsonb(old) - 'updated_at') then
      return old;
    end if;
  end if;
  new.updated_at := clock_timestamp();
  return new;
end;
$$;

-- Guarda a versão antiga de toda linha alterada (ou removida pelo dono do banco).
create function private.tomei_audit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into private.audit_log (table_name, row_id, op, old_row, changed_by)
  values (
    tg_table_name,
    coalesce(to_jsonb(old) ->> 'id', to_jsonb(old) ->> 'user_id'),
    tg_op,
    to_jsonb(old),
    auth.uid()
  );
  return null;
end;
$$;

-- Fuso inválido quebraria os lembretes de todo mundo: recusa na entrada.
create function private.tomei_check_timezone()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  perform now() at time zone new.timezone;   -- erro 22023 se o fuso não existir
  return new;
end;
$$;

create trigger profiles_check_tz  before insert or update of timezone on public.profiles
  for each row execute function private.tomei_check_timezone();

do $$
declare t text;
begin
  foreach t in array array['profiles', 'medications', 'intakes'] loop
    execute format(
      'create trigger %I before insert or update on public.%I
         for each row execute function private.tomei_touch()', t || '_touch', t);
    execute format(
      'create trigger %I after update on public.%I
         for each row when (old.* is distinct from new.*)
         execute function private.tomei_audit()', t || '_audit_upd', t);
    execute format(
      'create trigger %I after delete on public.%I
         for each row execute function private.tomei_audit()', t || '_audit_del', t);
  end loop;
end $$;


-- -----------------------------------------------------------------------------
--  Segurança: RLS + permissões mínimas
-- -----------------------------------------------------------------------------

alter table public.profiles           enable row level security;
alter table public.medications        enable row level security;
alter table public.intakes            enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.reminder_log       enable row level security;   -- sem policy = ninguém via API
alter table public.vapid_public       enable row level security;
alter table private.audit_log         enable row level security;
alter table private.vapid_keys        enable row level security;

-- profiles / medications / intakes: ler, inserir e atualizar SÓ as próprias linhas.
-- (de propósito não existe policy de DELETE)
do $$
declare t text;
begin
  foreach t in array array['profiles', 'medications', 'intakes'] loop
    execute format(
      'create policy %I on public.%I for select to authenticated
         using (user_id = (select auth.uid()))', t || '_select_own', t);
    execute format(
      'create policy %I on public.%I for insert to authenticated
         with check (user_id = (select auth.uid()))', t || '_insert_own', t);
    execute format(
      'create policy %I on public.%I for update to authenticated
         using (user_id = (select auth.uid()))
         with check (user_id = (select auth.uid()))', t || '_update_own', t);
  end loop;
end $$;

-- push_subscriptions: o dono pode tudo nas próprias inscrições (são descartáveis).
create policy push_subscriptions_select_own on public.push_subscriptions
  for select to authenticated using (user_id = (select auth.uid()));
create policy push_subscriptions_insert_own on public.push_subscriptions
  for insert to authenticated with check (user_id = (select auth.uid()));
create policy push_subscriptions_update_own on public.push_subscriptions
  for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy push_subscriptions_delete_own on public.push_subscriptions
  for delete to authenticated using (user_id = (select auth.uid()));

-- vapid_public: qualquer pessoa logada lê (é a chave pública), ninguém escreve pela API.
create policy vapid_public_select on public.vapid_public
  for select to authenticated using (true);

-- Privilégios (cinto + suspensório junto com o RLS)
revoke all on public.profiles, public.medications, public.intakes,
              public.push_subscriptions, public.reminder_log, public.vapid_public
  from anon;
revoke delete, truncate, references, trigger on public.profiles, public.medications, public.intakes
  from authenticated;
revoke all on public.reminder_log from authenticated;
revoke insert, update, delete, truncate, references, trigger on public.vapid_public from authenticated;
revoke truncate, references, trigger on public.push_subscriptions from authenticated;


-- -----------------------------------------------------------------------------
--  Funções usadas SÓ pela Edge Function (service_role)
-- -----------------------------------------------------------------------------

-- Lê o par VAPID guardado (ou null se ainda não foi gerado).
create function public.tomei_vapid_get()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('public_key', public_key, 'private_jwk', private_jwk)
  from private.vapid_keys
  where id;
$$;

-- Guarda o par VAPID gerado. Se duas execuções correrem juntas, a primeira vence
-- e as duas recebem o MESMO par de volta (nunca existem duas chaves).
create function public.tomei_vapid_put(p_public_key text, p_private_jwk jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into private.vapid_keys (public_key, private_jwk)
  values (p_public_key, p_private_jwk)
  on conflict (id) do nothing;

  insert into public.vapid_public (public_key)
  select public_key from private.vapid_keys where id
  on conflict (id) do update set public_key = excluded.public_key;

  return (
    select jsonb_build_object('public_key', public_key, 'private_jwk', private_jwk)
    from private.vapid_keys
    where id
  );
end;
$$;

-- Confere o segredo que o pg_cron manda (guardado no Vault). Assim o segredo
-- nunca precisa ser copiado para lugar nenhum.
create function public.tomei_cron_ok(candidate text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from vault.decrypted_secrets
    where name = 'tomei_cron_secret'
      and decrypted_secret = candidate
  );
$$;

revoke execute on function public.tomei_vapid_get()                from public, anon, authenticated;
revoke execute on function public.tomei_vapid_put(text, jsonb)     from public, anon, authenticated;
revoke execute on function public.tomei_cron_ok(text)              from public, anon, authenticated;
grant  execute on function public.tomei_vapid_get()                to service_role;
grant  execute on function public.tomei_vapid_put(text, jsonb)     to service_role;
grant  execute on function public.tomei_cron_ok(text)             to service_role;
