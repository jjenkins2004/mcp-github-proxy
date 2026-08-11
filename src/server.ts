import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { Readable } from "node:stream";

const PORT = Number(process.env.PORT || 3000);
const JWT_SECRET = req("JWT_SECRET");
const PUBLIC_URL = req("PUBLIC_URL").replace(/\/+$/, "");
const UPSTREAM_MCP_URL = process.env.UPSTREAM_MCP_URL || "https://api.githubcopilot.com/mcp/";

const REDIRECT_ALLOWLIST = new Set([
  "https://claude.ai/api/mcp/auth_callback",
  "https://claude.com/api/mcp/auth_callback",
]);

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

/* Each person gets USER<N>_SECRET + USER<N>_PAT (+ optional USER<N>_NAME).
   The secret they type on the consent page is what identifies them, so their
   own PAT is the one injected upstream. */
type User = { id: string; secret: string; pat: string };

const users: User[] = Object.keys(process.env)
  .map((k) => /^USER(\d+)_SECRET$/.exec(k)?.[1])
  .filter((n): n is string => !!n)
  .sort()
  .map((n) => ({
    id: process.env[`USER${n}_NAME`] || `user${n}`,
    secret: process.env[`USER${n}_SECRET`]!,
    pat: req(`USER${n}_PAT`),
  }));

if (!users.length) throw new Error("No users configured: set USER1_SECRET and USER1_PAT");
if (new Set(users.map((u) => u.id)).size !== users.length) throw new Error("Duplicate USER<N>_NAME values");

/* ---------------- crypto helpers ---------------- */

const b64url = (b: Buffer | string) =>
  Buffer.from(b as never).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function sign(payload: Record<string, unknown>): string {
  const head = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(JSON.stringify(payload));
  const mac = b64url(createHmac("sha256", JWT_SECRET).update(`${head}.${body}`).digest());
  return `${head}.${body}.${mac}`;
}

function verify(token: string): Record<string, any> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [head, body, mac] = parts;
  const expected = b64url(createHmac("sha256", JWT_SECRET).update(`${head}.${body}`).digest());
  if (!eq(mac, expected)) return null;
  try {
    const claims = JSON.parse(Buffer.from(body, "base64url").toString());
    if (typeof claims.exp !== "number" || claims.exp * 1000 < Date.now()) return null;
    if (claims.iss !== PUBLIC_URL) return null;
    return claims;
  } catch {
    return null;
  }
}

function eq(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/* ---------------- in-memory state ---------------- */

type Code = { clientId: string; redirectUri: string; challenge: string; scope: string; user: string; exp: number };
const clients = new Map<string, unknown>();
const codes = new Map<string, Code>();

/* ---------------- http helpers ---------------- */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Expose-Headers": "Mcp-Session-Id, WWW-Authenticate",
  "Access-Control-Max-Age": "86400",
};

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "Content-Type": "application/json", ...CORS, ...headers });
  res.end(JSON.stringify(body));
}

function html(res: ServerResponse, status: number, body: string) {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", ...CORS });
  res.end(body);
}

function body(reqm: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    reqm.on("data", (c) => chunks.push(c));
    reqm.on("end", () => resolve(Buffer.concat(chunks)));
    reqm.on("error", reject);
  });
}

async function form(reqm: IncomingMessage): Promise<Record<string, string>> {
  const raw = (await body(reqm)).toString();
  if ((reqm.headers["content-type"] || "").includes("application/json")) {
    try {
      return JSON.parse(raw || "{}");
    } catch {
      return {};
    }
  }
  return Object.fromEntries(new URLSearchParams(raw));
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/* ---------------- consent page ---------------- */

function consentPage(q: URLSearchParams, error?: string): string {
  const hidden = ["response_type", "client_id", "redirect_uri", "state", "code_challenge", "code_challenge_method", "scope", "resource"]
    .filter((k) => q.get(k))
    .map((k) => `<input type="hidden" name="${k}" value="${esc(q.get(k)!)}">`)
    .join("");
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Authorize</title>
<style>body{font:16px/1.5 system-ui,sans-serif;background:#111;color:#eee;display:grid;place-items:center;height:100vh;margin:0}
form{background:#1c1c1c;padding:28px;border-radius:12px;width:min(340px,90vw);display:grid;gap:12px}
input[type=password]{padding:10px;border-radius:8px;border:1px solid #444;background:#111;color:#eee;font-size:16px}
button{padding:10px;border:0;border-radius:8px;background:#c96442;color:#fff;font-size:16px;cursor:pointer}
h1{font-size:17px;margin:0}p{margin:0;color:#999;font-size:13px}.e{color:#ff6b6b}</style>
<form method="post" action="/authorize">
<h1>GitHub MCP proxy</h1>
<p>Enter the access secret to connect.</p>
${error ? `<p class="e">${esc(error)}</p>` : ""}
${hidden}
<input type="password" name="secret" placeholder="Access secret" autofocus required>
<button type="submit">Authorize</button>
</form>`;
}

/* ---------------- server ---------------- */

const server = createServer(async (rq, res) => {
  const url = new URL(rq.url || "/", PUBLIC_URL);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = rq.method || "GET";

  if (method === "OPTIONS") {
    res.writeHead(204, CORS);
    return res.end();
  }

  try {
    /* --- discovery --- */
    if (method === "GET" && (path === "/.well-known/oauth-protected-resource" || path === "/.well-known/oauth-protected-resource/mcp")) {
      return json(res, 200, {
        resource: `${PUBLIC_URL}/mcp`,
        authorization_servers: [PUBLIC_URL],
        bearer_methods_supported: ["header"],
      });
    }

    if (method === "GET" && (path === "/.well-known/oauth-authorization-server" || path === "/.well-known/oauth-authorization-server/mcp")) {
      return json(res, 200, {
        issuer: PUBLIC_URL,
        authorization_endpoint: `${PUBLIC_URL}/authorize`,
        token_endpoint: `${PUBLIC_URL}/token`,
        registration_endpoint: `${PUBLIC_URL}/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      });
    }

    /* --- dynamic client registration --- */
    if (method === "POST" && path === "/register") {
      const meta = await form(rq);
      const client_id = randomUUID();
      clients.set(client_id, meta);
      return json(res, 201, {
        client_id,
        client_id_issued_at: Math.floor(Date.now() / 1000),
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        redirect_uris: (meta as any).redirect_uris ?? [],
      });
    }

    /* --- authorize --- */
    if (path === "/authorize" && (method === "GET" || method === "POST")) {
      const p = method === "GET" ? url.searchParams : new URLSearchParams(Object.entries(await form(rq)));
      const redirectUri = p.get("redirect_uri") || "";
      const clientId = p.get("client_id") || "";
      const challenge = p.get("code_challenge") || "";

      if (!REDIRECT_ALLOWLIST.has(redirectUri)) return json(res, 400, { error: "invalid_request", error_description: "redirect_uri not allowed" });
      if (p.get("response_type") !== "code") return json(res, 400, { error: "unsupported_response_type" });
      if (!challenge || p.get("code_challenge_method") !== "S256") return json(res, 400, { error: "invalid_request", error_description: "PKCE S256 required" });

      if (method === "GET") return html(res, 200, consentPage(p));

      const submitted = p.get("secret") || "";
      const user = users.find((u) => eq(submitted, u.secret));
      if (!user) return html(res, 401, consentPage(p, "Wrong secret."));

      const code = randomUUID();
      codes.set(code, { clientId, redirectUri, challenge, scope: p.get("scope") || "mcp", user: user.id, exp: Date.now() + 60_000 });
      const to = new URL(redirectUri);
      to.searchParams.set("code", code);
      if (p.get("state")) to.searchParams.set("state", p.get("state")!);
      res.writeHead(302, { Location: to.toString(), ...CORS });
      return res.end();
    }

    /* --- token --- */
    if (method === "POST" && path === "/token") {
      const p = await form(rq);
      const issue = (sub: string, scope: string) => {
        const now = Math.floor(Date.now() / 1000);
        return json(res, 200, {
          access_token: sign({ iss: PUBLIC_URL, aud: `${PUBLIC_URL}/mcp`, sub, typ: "access", scope, iat: now, exp: now + 3600 }),
          token_type: "Bearer",
          expires_in: 3600,
          refresh_token: sign({ iss: PUBLIC_URL, sub, typ: "refresh", scope, iat: now, exp: now + 30 * 86400 }),
          scope,
        });
      };

      if (p.grant_type === "authorization_code") {
        const entry = codes.get(p.code || "");
        codes.delete(p.code || "");
        if (!entry || entry.exp < Date.now()) return json(res, 400, { error: "invalid_grant" });
        if (entry.redirectUri !== p.redirect_uri) return json(res, 400, { error: "invalid_grant", error_description: "redirect_uri mismatch" });
        const digest = b64url(createHash("sha256").update(p.code_verifier || "").digest());
        if (!eq(digest, entry.challenge)) return json(res, 400, { error: "invalid_grant", error_description: "PKCE verification failed" });
        return issue(entry.user, entry.scope);
      }

      if (p.grant_type === "refresh_token") {
        const claims = verify(p.refresh_token || "");
        if (!claims || claims.typ !== "refresh") return json(res, 400, { error: "invalid_grant" });
        if (!users.some((u) => u.id === claims.sub)) return json(res, 400, { error: "invalid_grant" });
        return issue(claims.sub, claims.scope || "mcp");
      }

      return json(res, 400, { error: "unsupported_grant_type" });
    }

    /* --- transparent MCP proxy --- */
    if (path === "/mcp") {
      const auth = rq.headers.authorization || "";
      const claims = auth.startsWith("Bearer ") ? verify(auth.slice(7)) : null;
      const caller = claims?.typ === "access" ? users.find((u) => u.id === claims.sub) : undefined;
      if (!caller) {
        return json(res, 401, { error: "invalid_token" }, {
          "WWW-Authenticate": `Bearer resource_metadata="${PUBLIC_URL}/.well-known/oauth-protected-resource"`,
        });
      }

      const headers: Record<string, string> = { Authorization: `Bearer ${caller.pat}` };
      for (const h of ["content-type", "accept", "mcp-session-id", "mcp-protocol-version"]) {
        const v = rq.headers[h];
        if (typeof v === "string") headers[h] = v;
      }

      const target = new URL(UPSTREAM_MCP_URL);
      target.search = url.search;

      const upstream = await fetch(target, {
        method,
        headers,
        body: method === "GET" || method === "HEAD" ? undefined : new Uint8Array(await body(rq)),
        redirect: "manual",
      });

      const out: Record<string, string> = { ...CORS };
      for (const h of ["content-type", "mcp-session-id", "mcp-protocol-version", "cache-control", "www-authenticate"]) {
        const v = upstream.headers.get(h);
        if (v) out[h] = v;
      }
      res.writeHead(upstream.status, out);
      res.flushHeaders();

      if (!upstream.body) return res.end();
      const stream = Readable.fromWeb(upstream.body as never);
      stream.on("error", () => res.end());
      return stream.pipe(res);
    }

    return json(res, 404, { error: "not_found" });
  } catch (err) {
    console.error(err);
    if (!res.headersSent) return json(res, 500, { error: "server_error" });
    res.end();
  }
});

// purge expired auth codes
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of codes) if (v.exp < now) codes.delete(k);
}, 60_000).unref();

server.listen(PORT, () => console.log(`listening on :${PORT} -> ${UPSTREAM_MCP_URL}`));
