#!/usr/bin/env node
// Gera os ícones (PNG) a partir do SVG abaixo. Já estão commitados em public/icons;
// só rode de novo se quiser mudar o desenho. Precisa do pacote `sharp`.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const sharp = require("sharp");
const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public/icons");
fs.mkdirSync(out, { recursive: true });

const art = `
  <g transform="rotate(-40 256 256)">
    <rect x="96" y="176" width="320" height="160" rx="80" fill="#ffffff"/>
    <path d="M256 176h80a80 80 0 0 1 0 160h-80z" fill="#bfe8dc"/>
    <rect x="251" y="176" width="10" height="160" fill="#0a5a4a" opacity=".16"/>
  </g>
  <circle cx="388" cy="388" r="66" fill="#ffc857"/>
  <path d="M358 390l22 22 40-46" fill="none" stroke="#0a5a4a" stroke-width="18" stroke-linecap="round" stroke-linejoin="round"/>`;
const defs = `<defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#14a085"/><stop offset="1" stop-color="#0a5a4a"/></linearGradient></defs>`;
const svg = (body, rx) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">${defs}<rect width="512" height="512" rx="${rx}" fill="url(#bg)"/>${body}</svg>`;

const any = svg(art, 116);
const maskable = svg(`<g transform="translate(256 256) scale(.76) translate(-256 -256)">${art}</g>`, 0);
const badge = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 72 72"><g transform="rotate(-40 36 36)" fill="#fff"><path d="M34 22H24a14 14 0 0 0 0 28h10z"/><path d="M38 22h10a14 14 0 0 1 0 28H38z"/></g></svg>`;

fs.writeFileSync(path.join(out, "icon.svg"), any);
const png = (svgText, size, name) => sharp(Buffer.from(svgText)).resize(size, size).png().toFile(path.join(out, name));
await Promise.all([
  png(any, 192, "icon-192.png"),
  png(any, 512, "icon-512.png"),
  png(maskable, 512, "icon-maskable-512.png"),
  png(svg(art, 0), 180, "apple-touch-icon.png"), // o iOS arredonda sozinho: sem cantos transparentes
  png(badge, 72, "badge-72.png"),
]);
console.log("ícones gerados em", out);
