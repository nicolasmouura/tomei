-- =============================================================================
--  TOMEI · migração 3 · dias da semana de cada remédio
-- =============================================================================
--  Cada remédio passa a ter os dias em que vale: 0 = domingo ... 6 = sábado.
--  Padrão = todos os dias (o que já existia continua igual). Quem escolhe os
--  dias é o app, na tela do remédio. A Edge Function só avisa nos dias marcados.
--
--  Ordem de publicação: rode ESTA migração antes de publicar o app novo e a função nova
--  (os dois passam a ler/enviar a coluna `weekdays`).
-- =============================================================================

alter table public.medications
  add column weekdays smallint[] not null default '{0,1,2,3,4,5,6}',
  add constraint medications_weekdays_check
    check (cardinality(weekdays) between 1 and 7
           and weekdays <@ array[0, 1, 2, 3, 4, 5, 6]::smallint[]);
