// =============================================================================
//  Publicação em subpasta (GitHub Pages: https://usuario.github.io/tomei/) e
//  atualização do service worker com o cache HTTP de 10 min que o Pages usa.
//
//  Serve uma CÓPIA de public/ em /tomei/ com "Cache-Control: max-age=600" e confere:
//    • tudo abre dentro da subpasta (nada de caminho absoluto quebrado);
//    • o service worker e o manifest apontam para a subpasta;
//    • dá para recarregar sem internet;
//    • uma versão nova NÃO guarda cópias velhas vindas do cache HTTP do navegador
//      (sem `cache: "reload"` no precache, o app podia ficar preso numa versão velha).
// =============================================================================
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const { chromium } = createRequire(import.meta.url)("playwright");
const PUBLIC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public");
const PREFIX = "/tomei/";
const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".webmanifest": "application/manifest+json", ".png": "image/png", ".svg": "image/svg+xml", ".json": "application/json",
};

let site, server, base, browser, ctx, page;
const bad = [];
const errs = [];

before(async () => {
  site = fs.mkdtempSync(path.join(os.tmpdir(), "tomei-site-"));
  fs.cpSync(PUBLIC, site, { recursive: true });
  server = http.createServer((req, res) => {
    const p = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (!p.startsWith(PREFIX)) { res.writeHead(404); return res.end(`fora da subpasta: ${p}`); }
    let rel = p.slice(PREFIX.length);
    if (rel === "" || rel.endsWith("/")) rel += "index.html";
    const file = path.join(site, rel);
    if (!file.startsWith(site) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404);
      return res.end(`404 ${rel}`);
    }
    res.writeHead(200, {
      "Content-Type": TYPES[path.extname(file)] ?? "application/octet-stream",
      "Cache-Control": "max-age=600", // igual ao GitHub Pages
    });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}${PREFIX}`;

  browser = await chromium.launch();
  ctx = await browser.newContext();
  page = await ctx.newPage();
  page.on("response", (r) => { if (r.status() >= 400) bad.push(`${r.status()} ${r.url()}`); });
  page.on("requestfailed", (r) => bad.push(`FALHOU ${r.url()} ${r.failure()?.errorText ?? ""}`));
  page.on("pageerror", (e) => errs.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") errs.push(`console: ${m.text()}`); });
});

after(async () => {
  await browser?.close();
  if (server) {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
  if (site) fs.rmSync(site, { recursive: true, force: true });
});

const showsLogin = () => page.waitForFunction(() => document.body.innerText.includes("Entrar"), null, { timeout: 15000 });

test("abre dentro de /tomei/ e mostra a tela de entrar", async () => {
  await page.goto(base, { waitUntil: "load" });
  await showsLogin();
});

test("service worker ativo e com escopo da subpasta", async () => {
  const info = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready;
    for (let i = 0; i < 100 && reg.active?.state !== "activated"; i++) await new Promise((r) => setTimeout(r, 100));
    return { scope: reg.scope, state: reg.active?.state };
  });
  assert.deepEqual(info, { scope: base, state: "activated" });
});

test("manifest: start_url e scope são a subpasta e todos os ícones respondem 200", async () => {
  const m = await page.evaluate(async () => {
    const href = document.querySelector('link[rel="manifest"]').href;
    const res = await fetch(href);
    const json = await res.json();
    const out = {
      status: res.status,
      start: new URL(json.start_url, href).href,
      scope: new URL(json.scope, href).href,
      icons: [],
    };
    for (const ic of json.icons) {
      const r = await fetch(new URL(ic.src, href).href);
      out.icons.push(`${r.status} ${r.headers.get("content-type")}`);
    }
    return out;
  });
  assert.equal(m.status, 200);
  assert.equal(m.start, base);
  assert.equal(m.scope, base);
  assert.ok(m.icons.length >= 3 && m.icons.every((s) => /^200 image\//.test(s)), JSON.stringify(m.icons));
});

test("recarrega SEM internet usando o cache do service worker", async () => {
  await page.reload({ waitUntil: "load" }); // agora a página já é controlada pelo service worker
  await ctx.setOffline(true);
  try {
    await page.reload({ waitUntil: "load" });
    await showsLogin();
  } finally {
    await ctx.setOffline(false);
  }
});

test("nenhuma requisição com erro (404 etc.) e nenhum erro de console", () => {
  assert.deepEqual([...bad, ...errs], []);
});

test("versão nova, com o cache HTTP ainda fresco, guarda os arquivos NOVOS (não os velhos)", async () => {
  // "deploy" da versão 2: muda um arquivo do app e o identificador do cache no sw.js
  const marker = `/* marcador-v2-${Date.now()} */`;
  fs.appendFileSync(path.join(site, "js/util.js"), `\n${marker}\n`);
  const swFile = path.join(site, "sw.js");
  fs.writeFileSync(swFile, fs.readFileSync(swFile, "utf8").replace(/const BUILD = "[^"]+";/, 'const BUILD = "v2test";'));

  const out = await page.evaluate(async (mk) => {
    const reg = await navigator.serviceWorker.getRegistration();
    await reg.update();
    for (let i = 0; i < 100; i++) {
      const w = reg.waiting || reg.installing;
      if (w && w.state === "installed") break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const names = await caches.keys();
    if (!names.includes("tomei-v2test")) return { names, found: false, hasMarker: false };
    const res = await (await caches.open("tomei-v2test")).match("./js/util.js");
    const txt = res ? await res.text() : "";
    return { names, found: !!res, hasMarker: txt.includes(mk) };
  }, marker);
  assert.ok(out.found, `a versão nova não criou o cache: ${JSON.stringify(out)}`);
  assert.ok(out.hasMarker, `o cache novo guardou o util.js VELHO: ${JSON.stringify(out)}`);
});
