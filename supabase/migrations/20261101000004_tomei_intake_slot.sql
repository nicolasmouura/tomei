-- Dose ligada a um horário da cartela: ao tocar na bolinha das 08:00, a dose fica
-- registrada PARA as 08:00, mesmo que seja tomada às 12:55. Nulo = sem horário
-- escolhido (o app liga ao horário livre mais próximo).
alter table public.intakes
  add column slot text
  check (slot is null or slot ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$');
