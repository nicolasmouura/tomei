-- Dia a que o horário da dose pertence. Serve para a dose das 23:00 de ontem que só foi
-- marcada às 00:30 de hoje: taken_at continua sendo o instante real, e slot_date diz
-- "esta dose é do dia anterior". Nulo = o dia de taken_at.
alter table public.intakes add column slot_date date;
