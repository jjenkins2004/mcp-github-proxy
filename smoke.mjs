// Local smoke test of the OAuth flow + proxy pass-through. Not shipped to prod.
import { createHash, randomBytes } from "node:crypto";

const B = "http://127.0.0.1:8787";
const b64 = (b) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const ok = (n, c) => console.log(`${c ? "PASS" : "FAIL"}  ${n}`);

const prm = await (await fetch(`${B}/.well-known/oauth-protected-resource/mcp`)).json();
ok("protected-resource metadata", prm.resource === `${B}/mcp` && prm.authorization_servers[0] === B);

const as = await (await fetch(`${B}/.well-known/oauth-authorization-server`)).json();
ok("AS metadata", as.issuer === B && as.code_challenge_methods_supported[0] === "S256" && as.token_endpoint_auth_methods_supported[0] === "none");

const reg = await fetch(`${B}/register`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ client_name: "claude", redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] }),
});
const client = await reg.json();
ok("DCR returns client_id, no secret", reg.status === 201 && !!client.client_id && !client.client_secret);

const verifier = b64(randomBytes(32));
const challenge = b64(createHash("sha256").update(verifier).digest());
const q = new URLSearchParams({
  client_id: client.client_id,
  redirect_uri: "https://claude.ai/api/mcp/auth_callback",
  response_type: "code",
  code_challenge: challenge,
  code_challenge_method: "S256",
  state: "xyz",
  scope: "mcp",
});

const bad = await fetch(`${B}/authorize?` + new URLSearchParams({ ...Object.fromEntries(q), redirect_uri: "https://evil.example/cb" }));
ok("rejects non-allowlisted redirect_uri", bad.status === 400);

const page = await fetch(`${B}/authorize?${q}`);
ok("consent page renders", page.status === 200 && (await page.text()).includes('name="secret"'));

const wrong = await fetch(`${B}/authorize`, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ ...Object.fromEntries(q), secret: "nope" }),
  redirect: "manual",
});
ok("wrong secret rejected", wrong.status === 401);

const good = await fetch(`${B}/authorize`, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ ...Object.fromEntries(q), secret: "secret-alice" }),
  redirect: "manual",
});
const loc = new URL(good.headers.get("location"));
const code = loc.searchParams.get("code");
ok("consent redirects with code+state", good.status === 302 && !!code && loc.searchParams.get("state") === "xyz" && loc.origin === "https://claude.ai");

const badPkce = await fetch(`${B}/token`, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: "https://claude.ai/api/mcp/auth_callback", code_verifier: "wrong-verifier" }),
});
ok("PKCE mismatch rejected", badPkce.status === 400);

// code was consumed by the failed attempt -> get a fresh one
const good2 = await fetch(`${B}/authorize`, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ ...Object.fromEntries(q), secret: "secret-alice" }),
  redirect: "manual",
});
const code2 = new URL(good2.headers.get("location")).searchParams.get("code");

const tok = await (await fetch(`${B}/token`, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ grant_type: "authorization_code", code: code2, redirect_uri: "https://claude.ai/api/mcp/auth_callback", code_verifier: verifier }),
})).json();
ok("token issued", !!tok.access_token && tok.token_type === "Bearer" && tok.expires_in === 3600 && !!tok.refresh_token);

const reuse = await fetch(`${B}/token`, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ grant_type: "authorization_code", code: code2, redirect_uri: "https://claude.ai/api/mcp/auth_callback", code_verifier: verifier }),
});
ok("auth code is single-use", reuse.status === 400);

const ref = await (await fetch(`${B}/token`, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tok.refresh_token }),
})).json();
ok("refresh_token grant works", !!ref.access_token);

// second user: their own secret must mint a token bound to their own identity
const sub = (t) => JSON.parse(Buffer.from(t.split(".")[1], "base64url").toString()).sub;
const bobRedirect = await fetch(`${B}/authorize`, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ ...Object.fromEntries(q), secret: "secret-bob" }),
  redirect: "manual",
});
const bobCode = new URL(bobRedirect.headers.get("location")).searchParams.get("code");
const bobTok = await (await fetch(`${B}/token`, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ grant_type: "authorization_code", code: bobCode, redirect_uri: "https://claude.ai/api/mcp/auth_callback", code_verifier: verifier }),
})).json();
ok("second user authenticates to a distinct identity", sub(tok.access_token) === "alice" && sub(bobTok.access_token) === "bob");

const noAuth = await fetch(`${B}/mcp`, { method: "POST", body: "{}" });
ok("401 + WWW-Authenticate on /mcp", noAuth.status === 401 && (noAuth.headers.get("www-authenticate") || "").includes(`resource_metadata="${B}/.well-known/oauth-protected-resource"`));

// proxy pass-through against the echo upstream
const call = (token) =>
  fetch(`${B}/mcp?probe=1`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-session-id": "client-session-7",
      "mcp-protocol-version": "2025-06-18",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
  });

const t0 = Date.now();
const proxied = await call(tok.access_token);
const reader = proxied.body.getReader();
const firstChunk = new TextDecoder().decode((await reader.read()).value);
const firstAt = Date.now() - t0;
const seen = JSON.parse(firstChunk.replace(/^data: /, ""));
await reader.cancel();

ok("upstream got the caller's own PAT, not Claude's token", seen.auth === "Bearer pat-alice" && !seen.auth.includes(tok.access_token));
ok("method, query, and body forwarded verbatim", seen.method === "POST" && seen.url === "/?probe=1" && JSON.parse(seen.body).method === "initialize");
ok("request headers forwarded", seen.session === "client-session-7" && seen.protocol === "2025-06-18" && seen.accept.includes("text/event-stream"));
ok("response Mcp-Session-Id + Content-Type round-trip", proxied.headers.get("mcp-session-id") === "upstream-session-42" && proxied.headers.get("content-type") === "text/event-stream");
ok(`SSE streams unbuffered (first chunk at ${firstAt}ms, upstream ends at ~700ms)`, firstAt < 500);

const bobProxied = await call(bobTok.access_token);
const bobSeen = JSON.parse((await bobProxied.text()).split("\n")[0].replace(/^data: /, ""));
ok("each user gets their own PAT injected", bobSeen.auth === "Bearer pat-bob");
