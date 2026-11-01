-- Só para testar LOCALMENTE (Postgres puro): imita o que o Supabase já traz pronto.
-- NÃO rode isto num projeto Supabase de verdade.

-- (papéis valem para o cluster inteiro: cria só se ainda não existirem)
do $$
begin
  if not exists (select from pg_roles where rolname = 'anon')          then create role anon          nologin noinherit; end if;
  if not exists (select from pg_roles where rolname = 'authenticated') then create role authenticated nologin noinherit; end if;
  if not exists (select from pg_roles where rolname = 'service_role')  then create role service_role  nologin noinherit bypassrls; end if;
end $$;

create schema auth;
create table auth.users (id uuid primary key, email text);

-- Mesma lógica do auth.uid() do Supabase
create function auth.uid() returns uuid language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;

-- Vault de mentira
create schema vault;
create table vault.secrets (name text primary key, decrypted_secret text not null);
create view vault.decrypted_secrets as select name, decrypted_secret from vault.secrets;
insert into vault.secrets values ('tomei_cron_secret', 'segredo-de-teste-local');

-- Privilégios padrão que o Supabase concede em tudo que nasce no schema public
grant usage on schema public, auth to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables    to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
