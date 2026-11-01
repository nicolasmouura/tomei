-- =============================================================================
--  Testes do esquema do Tomei (RLS, soft delete, auditoria, constraints).
--  Roda tudo dentro de uma transação e termina com ROLLBACK: não deixa rastro.
--  Funciona no Postgres local (com 00_stubs_supabase.sql) e no SQL Editor do
--  Supabase. Resultado: uma tabela (n, teste, ok). Todas as linhas devem ter ok = true.
-- =============================================================================
begin;

create temp table _t (n serial, test text, ok boolean);
create temp table _kv (k text primary key, v text);

create function pg_temp.chk(t text, c boolean) returns boolean language plpgsql as $$
begin
  insert into _t (test, ok) values (t, coalesce(c, false));
  return c;
end $$;

-- Executa um comando como `r` (authenticated/anon/service_role) no papel do usuário `uid`.
-- Devolve 'OK:<linhas afetadas>' ou 'ERR:<sqlstate>:<mensagem>'.
create function pg_temp.run(uid uuid, r text, stmt text) returns text language plpgsql as $$
declare n bigint;
begin
  perform set_config('request.jwt.claim.sub', coalesce(uid::text, ''), true);
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', r)::text, true);
  execute format('set local role %I', r);
  begin
    execute stmt;
    get diagnostics n = row_count;
    execute 'reset role';
    return 'OK:' || n;
  exception when others then
    execute 'reset role';
    return 'ERR:' || sqlstate || ':' || sqlerrm;
  end;
end $$;

-- Idem, mas devolve o valor (texto) de uma consulta escalar.
create function pg_temp.val(uid uuid, r text, q text) returns text language plpgsql as $$
declare v text;
begin
  perform set_config('request.jwt.claim.sub', coalesce(uid::text, ''), true);
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', r)::text, true);
  execute format('set local role %I', r);
  begin
    execute q into v;
    execute 'reset role';
    return v;
  exception when others then
    execute 'reset role';
    return 'ERR:' || sqlstate;
  end;
end $$;

-- Pessoas de teste -------------------------------------------------------------
-- A = aaaaaaaa-..., B = bbbbbbbb-...
insert into auth.users (id, email) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'a@tomei.test'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'b@tomei.test');

-- 1. RLS: isolamento entre pessoas ----------------------------------------------
select pg_temp.chk('A cria remédio',
  pg_temp.run('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'authenticated',
    $q$insert into public.medications (id, name, dose, times)
       values ('11111111-1111-1111-1111-111111111111', 'Losartana', '50 mg', '{08:00,20:00}')$q$) = 'OK:1');
-- (cada select abaixo é um comando novo: só assim enxerga o que o anterior gravou)
select pg_temp.chk('...e o user_id veio sozinho do default auth.uid()',
  (select user_id from public.medications where id = '11111111-1111-1111-1111-111111111111')
  = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');

select pg_temp.chk('A enxerga o próprio remédio',
  pg_temp.val('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'authenticated', 'select count(*) from public.medications') = '1');
select pg_temp.chk('B NÃO enxerga remédio de A',
  pg_temp.val('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'authenticated', 'select count(*) from public.medications') = '0');
select pg_temp.chk('B não consegue inserir linha em nome de A (RLS 42501)',
  pg_temp.run('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'authenticated',
    $q$insert into public.medications (id, user_id, name) values
       ('22222222-2222-2222-2222-222222222222', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Invasor')$q$) like 'ERR:42501%');
select pg_temp.chk('B não altera remédio de A (0 linhas)',
  pg_temp.run('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'authenticated',
    $q$update public.medications set name = 'Hackeado'$q$) = 'OK:0'
  and (select name from public.medications where id = '11111111-1111-1111-1111-111111111111') = 'Losartana');
select pg_temp.chk('anon (sem login) não lê nada (42501)',
  pg_temp.val(null, 'anon', 'select count(*) from public.medications') = 'ERR:42501');

-- 2. Doses (intakes) ------------------------------------------------------------
select pg_temp.chk('A registra uma dose',
  pg_temp.run('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'authenticated',
    $q$insert into public.intakes (id, medication_id, med_name, med_dose, taken_at)
       values ('33333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111',
               'Losartana', '50 mg', '2026-11-01T03:00:00Z')$q$) = 'OK:1');
select pg_temp.chk('B não pode registrar dose usando o remédio de A (FK composta 23503)',
  pg_temp.run('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'authenticated',
    $q$insert into public.intakes (id, medication_id, med_name, taken_at)
       values ('44444444-4444-4444-4444-444444444444', '11111111-1111-1111-1111-111111111111',
               'Losartana', now())$q$) like 'ERR:23503%');
select pg_temp.chk('B não pode registrar dose em nome de A (RLS 42501)',
  pg_temp.run('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'authenticated',
    $q$insert into public.intakes (id, user_id, medication_id, med_name, taken_at)
       values ('55555555-5555-5555-5555-555555555555', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
               '11111111-1111-1111-1111-111111111111', 'Losartana', now())$q$) like 'ERR:42501%');

-- 3. Nada apaga ----------------------------------------------------------------
select pg_temp.chk('A NÃO consegue DELETE em doses (42501)',
  pg_temp.run('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'authenticated', 'delete from public.intakes') like 'ERR:42501%');
select pg_temp.chk('A NÃO consegue DELETE em remédios (42501)',
  pg_temp.run('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'authenticated', 'delete from public.medications') like 'ERR:42501%');
select pg_temp.chk('A NÃO consegue TRUNCATE (42501)',
  pg_temp.run('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'authenticated', 'truncate public.intakes') like 'ERR:42501%');
select pg_temp.chk('Nem o dono apaga remédio que tem doses (RESTRICT 23503)',
  pg_temp.run(null, 'postgres', $q$delete from public.medications where id = '11111111-1111-1111-1111-111111111111'$q$) like 'ERR:23503%');

-- 4. Idempotência + auditoria ---------------------------------------------------
insert into _kv select 'upd_before', updated_at::text from public.intakes where id = '33333333-3333-3333-3333-333333333333';

select pg_temp.chk('Reenvio IDÊNTICO (upsert) é aceito...',
  pg_temp.run('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'authenticated',
    $q$insert into public.intakes (id, user_id, medication_id, med_name, med_dose, taken_at, note, deleted_at)
       values ('33333333-3333-3333-3333-333333333333', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
               '11111111-1111-1111-1111-111111111111', 'Losartana', '50 mg', '2026-11-01T03:00:00Z', '', null)
       on conflict (id) do update set
         user_id = excluded.user_id, medication_id = excluded.medication_id, med_name = excluded.med_name,
         med_dose = excluded.med_dose, taken_at = excluded.taken_at, note = excluded.note,
         deleted_at = excluded.deleted_at$q$) = 'OK:1');
select pg_temp.chk('...e não mexe em updated_at (cursor de sync estável)',
  (select updated_at::text from public.intakes where id = '33333333-3333-3333-3333-333333333333')
  = (select v from _kv where k = 'upd_before'));
select pg_temp.chk('...e não gera linha de auditoria',
  (select count(*) from private.audit_log) = 0);

select pg_temp.chk('Alteração REAL (nota) é aceita',
  pg_temp.run('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'authenticated',
    $q$update public.intakes set note = 'depois do café' where id = '33333333-3333-3333-3333-333333333333'$q$) = 'OK:1');
select pg_temp.chk('...updated_at avançou (relógio do servidor)',
  (select updated_at::text from public.intakes where id = '33333333-3333-3333-3333-333333333333')
  <> (select v from _kv where k = 'upd_before'));
select pg_temp.chk('...a versão ANTIGA foi guardada na auditoria',
  (select count(*) from private.audit_log where table_name = 'intakes' and op = 'UPDATE'
     and old_row ->> 'note' = '') = 1);

select pg_temp.chk('Desfazer = soft delete (deleted_at) é aceito',
  pg_temp.run('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'authenticated',
    $q$update public.intakes set deleted_at = now() where id = '33333333-3333-3333-3333-333333333333'$q$) = 'OK:1');
select pg_temp.chk('...auditado também, e a linha continua existindo',
  (select count(*) from private.audit_log where table_name = 'intakes') = 2
  and (select count(*) from public.intakes where id = '33333333-3333-3333-3333-333333333333'
         and deleted_at is not null) = 1);

select pg_temp.chk('Insert com updated_at forjado (2000-01-01) é aceito...',
  pg_temp.run('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'authenticated',
    $q$insert into public.intakes (id, medication_id, med_name, taken_at, updated_at)
       values ('66666666-6666-6666-6666-666666666666', '11111111-1111-1111-1111-111111111111',
               'Losartana', now(), '2000-01-01')$q$) = 'OK:1');
select pg_temp.chk('...mas o servidor ignora o valor e usa o próprio relógio',
  (select updated_at from public.intakes where id = '66666666-6666-6666-6666-666666666666') > '2020-01-01');

select pg_temp.chk('Arquivar remédio (archived_at) funciona',
  pg_temp.run('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'authenticated',
    $q$update public.medications set archived_at = now() where id = '11111111-1111-1111-1111-111111111111'$q$) = 'OK:1');

-- 5. Constraints ---------------------------------------------------------------
select pg_temp.chk('Horário inválido (25:00) é recusado',
  pg_temp.run('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'authenticated',
    $q$insert into public.medications (id, name, times) values ('77777777-7777-7777-7777-777777777771', 'X', '{25:00}')$q$) like 'ERR:23514%');
select pg_temp.chk('Horário sem zero à esquerda (8:00) é recusado',
  pg_temp.run('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'authenticated',
    $q$insert into public.medications (id, name, times) values ('77777777-7777-7777-7777-777777777772', 'X', '{8:00}')$q$) like 'ERR:23514%');
select pg_temp.chk('Mais de 12 horários é recusado',
  pg_temp.run('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'authenticated',
    $q$insert into public.medications (id, name, times) values ('77777777-7777-7777-7777-777777777773', 'X',
       '{00:00,01:00,02:00,03:00,04:00,05:00,06:00,07:00,08:00,09:00,10:00,11:00,12:00}')$q$) like 'ERR:23514%');
select pg_temp.chk('Nome vazio/espaços é recusado',
  pg_temp.run('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'authenticated',
    $q$insert into public.medications (id, name) values ('77777777-7777-7777-7777-777777777774', '   ')$q$) like 'ERR:23514%');
select pg_temp.chk('Lista de horários vazia é válida',
  pg_temp.run('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'authenticated',
    $q$insert into public.medications (id, name, times) values ('77777777-7777-7777-7777-777777777775', 'Vitamina D', '{}')$q$) = 'OK:1');

-- 5b. Dias da semana de cada remédio ------------------------------------------
select pg_temp.chk('Remédio novo vem com TODOS os dias por padrão',
  (select weekdays::text from public.medications where id = '77777777-7777-7777-7777-777777777775') = '{0,1,2,3,4,5,6}');
select pg_temp.chk('Dias específicos (seg, qua, sex) são aceitos',
  pg_temp.run('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'authenticated',
    $q$insert into public.medications (id, name, times, weekdays) values ('88888888-8888-8888-8888-888888888881', 'Só em dias úteis', '{08:00}', '{1,3,5}')$q$) = 'OK:1');
select pg_temp.chk('Dia inválido (7) é recusado',
  pg_temp.run('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'authenticated',
    $q$insert into public.medications (id, name, weekdays) values ('88888888-8888-8888-8888-888888888882', 'X', '{1,7}')$q$) like 'ERR:23514%');
select pg_temp.chk('Lista vazia de dias é recusada',
  pg_temp.run('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'authenticated',
    $q$insert into public.medications (id, name, weekdays) values ('88888888-8888-8888-8888-888888888883', 'X', '{}')$q$) like 'ERR:23514%');
select pg_temp.chk('Trocar os dias de um remédio é uma alteração real (auditada)',
  pg_temp.run('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'authenticated',
    $q$update public.medications set weekdays = '{0,6}' where id = '88888888-8888-8888-8888-888888888881'$q$) = 'OK:1'
  );
select pg_temp.chk('...e a versão antiga dos dias ficou na auditoria',
  (select count(*) from private.audit_log where table_name = 'medications'
     and old_row ->> 'id' = '88888888-8888-8888-8888-888888888881' and old_row -> 'weekdays' = '[1, 3, 5]'::jsonb) = 1);

-- 6. Perfil / fuso -------------------------------------------------------------
select pg_temp.chk('Fuso válido é aceito',
  pg_temp.run('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'authenticated',
    $q$insert into public.profiles (user_id, timezone) values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'America/Sao_Paulo')$q$) = 'OK:1');
select pg_temp.chk('Fuso inventado é recusado (22023)',
  pg_temp.run('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'authenticated',
    $q$insert into public.profiles (user_id, timezone) values ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Marte/Fobos')$q$) like 'ERR:22023%');
select pg_temp.chk('B não vê o perfil de A',
  pg_temp.val('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'authenticated', 'select count(*) from public.profiles') = '0');

-- 7. Inscrições de push --------------------------------------------------------
select pg_temp.chk('A cadastra inscrição de push',
  pg_temp.run('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'authenticated',
    $q$insert into public.push_subscriptions (endpoint, p256dh, auth_secret)
       values ('https://push.example/abc', 'k', 'a')$q$) = 'OK:1');
select pg_temp.chk('Endpoint não-https é recusado',
  pg_temp.run('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'authenticated',
    $q$insert into public.push_subscriptions (endpoint, p256dh, auth_secret) values ('http://x', 'k', 'a')$q$) like 'ERR:23514%');
select pg_temp.chk('B não vê inscrição de A',
  pg_temp.val('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'authenticated', 'select count(*) from public.push_subscriptions') = '0');
select pg_temp.chk('A pode apagar a própria inscrição',
  pg_temp.run('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'authenticated', 'delete from public.push_subscriptions') = 'OK:1');

-- 8. Chaves VAPID, log de lembretes, auditoria e segredo do cron ---------------
select pg_temp.chk('Login comum NÃO chama tomei_vapid_get (42501)',
  pg_temp.val('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'authenticated', 'select public.tomei_vapid_get()::text') = 'ERR:42501');
select pg_temp.chk('vapid_get começa vazio',
  pg_temp.val(null, 'service_role', 'select coalesce(public.tomei_vapid_get()::text, ''vazio'')') = 'vazio');
select pg_temp.chk('service_role guarda o par VAPID',
  pg_temp.val(null, 'service_role',
    $q$select (public.tomei_vapid_put('PUB1', '{"d":"segredo"}'::jsonb))->>'public_key'$q$) = 'PUB1');
select pg_temp.chk('Segunda gravação concorrente NÃO sobrescreve (vence a primeira)',
  pg_temp.val(null, 'service_role',
    $q$select (public.tomei_vapid_put('PUB2', '{"d":"outro"}'::jsonb))->>'public_key'$q$) = 'PUB1');
select pg_temp.chk('Chave pública fica legível para quem está logado',
  pg_temp.val('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'authenticated', 'select public_key from public.vapid_public') = 'PUB1');
select pg_temp.chk('Ninguém logado consegue alterar a chave pública (42501)',
  pg_temp.run('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'authenticated', $q$update public.vapid_public set public_key = 'X'$q$) like 'ERR:42501%');
select pg_temp.chk('Chave PRIVADA inacessível pela API (schema private)',
  pg_temp.val('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'authenticated', 'select count(*) from private.vapid_keys') = 'ERR:42501');
select pg_temp.chk('Auditoria inacessível pela API',
  pg_temp.val('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'authenticated', 'select count(*) from private.audit_log') = 'ERR:42501');
select pg_temp.chk('reminder_log inacessível para login comum (42501)',
  pg_temp.val('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'authenticated', 'select count(*) from public.reminder_log') = 'ERR:42501');
select pg_temp.chk('service_role grava no reminder_log',
  pg_temp.run(null, 'service_role',
    $q$insert into public.reminder_log (medication_id, local_date, slot, kind)
       values ('11111111-1111-1111-1111-111111111111', '2026-11-01', '08:00', 0)$q$) = 'OK:1');
select pg_temp.chk('reminder_log: mesmo lembrete duas vezes = conflito (anti-duplicata)',
  pg_temp.run(null, 'service_role',
    $q$insert into public.reminder_log (medication_id, local_date, slot, kind)
       values ('11111111-1111-1111-1111-111111111111', '2026-11-01', '08:00', 0)$q$) like 'ERR:23505%');

-- segredo do cron: usa o que existir no Vault (no local, o do stub)
insert into _kv select 'cron', decrypted_secret from vault.decrypted_secrets where name = 'tomei_cron_secret';
select pg_temp.chk('tomei_cron_ok: segredo certo = true (service_role)',
  pg_temp.val(null, 'service_role',
    format('select public.tomei_cron_ok(%L)::text', (select v from _kv where k = 'cron'))) = 'true');
select pg_temp.chk('tomei_cron_ok: segredo errado = false',
  pg_temp.val(null, 'service_role', $q$select public.tomei_cron_ok('chute')::text$q$) = 'false');
select pg_temp.chk('tomei_cron_ok: null = false',
  pg_temp.val(null, 'service_role', $q$select public.tomei_cron_ok(null)::text$q$) = 'false');
select pg_temp.chk('tomei_cron_ok: login comum não pode chamar (42501)',
  pg_temp.val('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'authenticated', $q$select public.tomei_cron_ok('x')::text$q$) = 'ERR:42501');

select n, test, ok from _t order by n;

rollback;
