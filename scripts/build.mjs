#!/usr/bin/env node
// =============================================================================
//  Build do Tomei — sem dependências (só o Node).
//
//    npm run build
//
//  1. (opcional) reescreve public/config.js se SUPABASE_URL e
//     SUPABASE_PUBLISHABLE_KEY estiverem definidos no ambiente — útil em
//     hospedagens (Netlify, Vercel, Cloudflare Pages) que rodam o build.
//  2. Calcula um identificador da versão (hash do conteúdo de public/).
//  3. Gera public/js/build-info.js e public/sw.js (com a lista de arquivos que
//     o app guarda para funcionar offline).
//  Se nada mudou, o hash é o mesmo e o service worker não é "atualizado" à toa.
// =============================================================================
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pub = path.join(root, "public");

// 1) config pelo ambiente
const { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } = process.env;
if (SUPABASE_URL && SUPABASE_PUBLISHABLE_KEY) {
  const file = path.join(pub, "config.js");
  const current = fs.readFileSync(file, "utf8");
  const tail = current.slice(current.indexOf("/** false enquanto"));
  fs.writeFileSync(file, `// Gerado pelo build a partir das variáveis de ambiente.\nexport const config = {\n  SUPABASE_URL: ${JSON.stringify(SUPABASE_URL)},\n  SUPABASE_PUBLISHABLE_KEY: ${JSON.stringify(SUPABASE_PUBLISHABLE_KEY)},\n};\n\n${tail}`);
  console.log("config.js reescrito a partir do ambiente");
}

// 2) arquivos do app
const IGNORE = new Set(["sw.js", ".DS_Store"]);
const files = [];
(function walk(dir) {
  for (const name of fs.readdirSync(dir).sort()) {
    if (IGNORE.has(name) || name.endsWith(".map")) continue;
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) walk(full);
    else files.push(path.relative(pub, full).split(path.sep).join("/"));
  }
})(pub);

const hash = crypto.createHash("sha256");
for (const f of files) {
  if (f === "js/build-info.js") continue; // contém o próprio hash
  hash.update(f).update(fs.readFileSync(path.join(pub, f)));
}
// O service worker (o modelo em scripts/) também faz parte da versão: mexer só nele também gera um cache novo.
hash.update("sw.template.js").update(fs.readFileSync(path.join(root, "scripts/sw.template.js")));
const build = hash.digest("hex").slice(0, 10);

// 3) build-info.js e sw.js
fs.writeFileSync(path.join(pub, "js/build-info.js"), `// Gerado por scripts/build.mjs — não edite.\nexport const BUILD = "${build}";\n`);
if (!files.includes("js/build-info.js")) files.push("js/build-info.js");

const precache = ["./", ...files.map((f) => `./${f}`)];
const template = fs.readFileSync(path.join(root, "scripts/sw.template.js"), "utf8");
fs.writeFileSync(
  path.join(pub, "sw.js"),
  template.replaceAll("__BUILD_ID__", build).replaceAll("__PRECACHE__", JSON.stringify(precache, null, 2)),
);
console.log(`build ${build} · ${precache.length} arquivos no cache offline`);
