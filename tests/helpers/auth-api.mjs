import { createServer } from "node:http";
import { CREATOR_ID, READER_ID, product, profileFor, sessionFor, userFor } from "./auth-fixtures.mjs";

function readViewer(request) {
  try {
    const token = request.headers.authorization?.replace(/^Bearer /i, "");
    return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()).sub;
  } catch { return null; }
}

let omitServerProfiles = false;
let failProductList = false;
const server = createServer(async (request, response) => {
  response.setHeader("Access-Control-Allow-Origin", "http://127.0.0.1:3000");
  response.setHeader("Access-Control-Allow-Headers", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  response.setHeader("Content-Type", "application/json");
  if (request.method === "OPTIONS") { response.writeHead(204).end(); return; }
  const url = new URL(request.url, "http://127.0.0.1:54329");
  const send = (value, status = 200) => { response.writeHead(status).end(JSON.stringify(value)); };
  if (url.pathname === "/health") return send({ ok: true });
  if (url.pathname === "/test/profile-availability") {
    omitServerProfiles = url.searchParams.get("missing") === "true";
    return send({ ok: true });
  }
  if (url.pathname === "/test/product-list-availability") {
    failProductList = url.searchParams.get("fail") === "true";
    return send({ ok: true });
  }
  const viewer = readViewer(request);
  if (url.pathname === "/auth/v1/user") return viewer ? send(userFor(viewer)) : send({ message: "No test session" }, 401);
  if (url.pathname === "/auth/v1/logout") return send({});
  if (url.pathname === "/auth/v1/token") {
    let body = "";
    for await (const part of request) body += part;
    const input = JSON.parse(body || "{}");
    return send(sessionFor(input.email?.startsWith("creator") ? CREATOR_ID : READER_ID));
  }
  if (url.pathname === "/rest/v1/profiles") {
    if (omitServerProfiles && request.headers["x-client-info"]?.includes("createServerClient")) return send(null);
    const id = url.searchParams.get("id")?.replace(/^eq\./, "") ?? viewer ?? READER_ID;
    return send(profileFor(id));
  }
  if (url.pathname === "/rest/v1/submission_cards") {
    if (failProductList && !url.searchParams.has("id")) return send({ message: "Local test product list unavailable" }, 503);
    if (url.searchParams.get("id")?.startsWith("neq.")) return send([]);
    return send(url.searchParams.get("id")?.startsWith("eq.") ? product : [product]);
  }
  if (url.pathname === "/rest/v1/product_supports") {
    return send(viewer === READER_ID ? { id: "44444444-4444-4444-8444-444444444444" } : null);
  }
  if (url.pathname.startsWith("/rest/v1/")) return send([]);
  return send({ message: "Unknown test endpoint" }, 404);
});

server.listen(54329, "127.0.0.1");
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => server.close(() => process.exit(0)));
