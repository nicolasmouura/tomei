// Servidor estático mínimo para os testes: serve public/ (e uma página em branco em /__blank).
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public");
const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".webmanifest": "application/manifest+json", ".png": "image/png", ".svg": "image/svg+xml",
};

export function createStaticServer({ overrides = {} } = {}) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/__blank") {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end("<!doctype html><title>blank</title>");
    }
    if (overrides[url.pathname]) {
      res.writeHead(200, { "content-type": TYPES[path.extname(url.pathname)] ?? "text/plain" });
      return res.end(overrides[url.pathname]);
    }
    let file = path.join(ROOT, url.pathname === "/" ? "index.html" : url.pathname);
    if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); return res.end("not found"); }
      res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream", "cache-control": "no-cache" });
      res.end(data);
    });
  });
  return {
    server,
    listen: () => new Promise((r) => server.listen(0, "127.0.0.1", () => r(server.address().port))),
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
    get url() { return `http://127.0.0.1:${server.address().port}`; },
  };
}
