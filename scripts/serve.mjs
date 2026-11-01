#!/usr/bin/env node
// Servidor local para testar o app no computador: http://localhost:8080
// (localhost conta como "seguro" para service worker e notificações).
import { createStaticServer } from "../test/static_server.mjs";
const s = createStaticServer();
const port = Number(process.env.PORT ?? 8080);
s.server.listen(port, () => console.log(`Tomei em http://localhost:${port}`));
