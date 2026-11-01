// Fixa o fuso da máquina ANTES de qualquer módulo do app ser carregado.
// Importe este arquivo PRIMEIRO: imports de ESM rodam em ordem, e um `process.env.TZ = ...`
// solto no corpo do teste só roda depois deles (o util.js já teria criado seus formatadores no
// fuso errado — foi assim que um teste passava no Brasil e falhava no CI, que roda em UTC).
process.env.TZ = "America/Sao_Paulo";
