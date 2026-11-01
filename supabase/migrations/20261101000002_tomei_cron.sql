-- =============================================================================
--  TOMEI · migração 2 · agenda os lembretes (pg_cron + pg_net + Vault)
-- =============================================================================
--  De 1 em 1 minuto o banco chama a Edge Function `send-reminders`, que calcula
--  quais remédios estão na hora e manda o Web Push.
--
--  O segredo que autentica o cron é gerado AQUI DENTRO, vive só no Vault e é
--  conferido pela função tomei_cron_ok(). Você nunca precisa copiá-lo.
--
--  >>> Se for usar em OUTRO projeto, troque a URL abaixo pela do seu projeto. <<<
-- =============================================================================

create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

-- URL do projeto + segredo do cron (só cria se ainda não existirem: pode rodar de novo sem medo)
do $$
begin
  if not exists (select 1 from vault.decrypted_secrets where name = 'tomei_project_url') then
    perform vault.create_secret(
      'https://ekyigleiqwkxoxwmyakb.supabase.co',
      'tomei_project_url',
      'URL do projeto Supabase usada pelo cron do Tomei');
  end if;
  if not exists (select 1 from vault.decrypted_secrets where name = 'tomei_cron_secret') then
    perform vault.create_secret(
      replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
      'tomei_cron_secret',
      'Segredo que o pg_cron envia para a Edge Function send-reminders');
  end if;
end $$;

-- Lembretes: todo minuto. (cron.schedule com o mesmo nome apenas atualiza o job.)
select cron.schedule(
  'tomei-lembretes',
  '* * * * *',
  $job$
    select net.http_post(
      url     := (select decrypted_secret from vault.decrypted_secrets where name = 'tomei_project_url')
                 || '/functions/v1/send-reminders',
      headers := jsonb_build_object(
                   'Content-Type', 'application/json',
                   'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'tomei_cron_secret')),
      body    := '{}'::jsonb,
      timeout_milliseconds := 20000
    );
  $job$
);

-- Faxina diária (04:17 UTC): o controle anti-duplicata só precisa de alguns dias.
select cron.schedule(
  'tomei-limpeza',
  '17 4 * * *',
  $job$ delete from public.reminder_log where sent_at < now() - interval '14 days'; $job$
);
