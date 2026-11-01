// =============================================================================
//  Configuração do Tomei — dados PÚBLICOS do seu projeto Supabase.
//
//  Pode ficar no código: a chave "publishable" é feita para ir no navegador. Quem
//  protege os dados é o RLS do banco (cada pessoa só enxerga o que é dela).
//  NUNCA coloque aqui a chave "secret" / "service_role".
//
//  Se você fizer deploy numa hospedagem que roda `npm run build`, pode definir as
//  variáveis SUPABASE_URL e SUPABASE_PUBLISHABLE_KEY no painel dela: o build
//  reescreve este arquivo.
// =============================================================================
export const config = {
  SUPABASE_URL: "https://ekyigleiqwkxoxwmyakb.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_S8Y7bBBsCmNDLoUFIfu8mQ_Ds-Uz6Rf",
};

/** false enquanto os valores de exemplo não forem trocados pelos do seu projeto. */
export const isConfigured = (c = config) =>
  /^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/.test(c.SUPABASE_URL ?? "") && !!c.SUPABASE_PUBLISHABLE_KEY &&
  !/SEU|YOUR/i.test(c.SUPABASE_URL + c.SUPABASE_PUBLISHABLE_KEY);
