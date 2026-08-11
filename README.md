# mcp-github-proxy

Transparent MCP reverse-proxy that lets a **claude.ai custom connector** reach GitHub's remote MCP
server. Claude authenticates to *this* server with OAuth 2.1 + DCR (which the connector form
requires); this server then forwards every MCP request verbatim to
`https://api.githubcopilot.com/mcp/` with a GitHub PAT swapped into the `Authorization` header.

No GitHub tools are reimplemented — it is pure pass-through. No database. Zero runtime dependencies.

## Endpoints

| Route | Purpose |
| --- | --- |
| `GET /.well-known/oauth-protected-resource[/mcp]` | Resource metadata |
| `GET /.well-known/oauth-authorization-server[/mcp]` | AS metadata |
| `POST /register` | Dynamic client registration (public client, no secret) |
| `GET/POST /authorize` | Consent page → one password field → 302 with auth code |
| `POST /token` | `authorization_code` (PKCE S256 enforced) + `refresh_token` |
| `ALL /mcp` | Authenticated transparent proxy (POST / GET / DELETE) |

Access tokens are HS256 JWTs (~1h), refresh tokens 30d, so tokens survive restarts. Auth codes and
registered clients live in memory (single user); auth codes expire after 60s and are single-use.

Only these `redirect_uri` values are accepted:
`https://claude.ai/api/mcp/auth_callback`, `https://claude.com/api/mcp/auth_callback`.

## Environment

| Var | Notes |
| --- | --- |
| `JWT_SECRET` | Signs the tokens this server issues. |
| `PUBLIC_URL` | This service's own base URL, no trailing slash, e.g. `https://x.up.railway.app`. |
| `UPSTREAM_MCP_URL` | Optional, defaults to `https://api.githubcopilot.com/mcp/`. |
| `PORT` | Provided by Railway. |

### Users (one numbered triple per person)

| Var | Notes |
| --- | --- |
| `USER<N>_SECRET` | What that person types on the consent page. |
| `USER<N>_PAT` | That person's fine-grained GitHub PAT, injected upstream for their requests only. |
| `USER<N>_NAME` | Optional label, defaults to `user<N>`. Ends up as the token `sub`. |

Two people means `USER1_*` and `USER2_*`. The secret is the identity: whichever secret is typed
decides which PAT gets injected, so there is no account picker and no user database. Everyone's
tokens are independent — rotating one person's secret or PAT does not disturb the other.

Adding a third person later is just another `USER3_*` triple; the server discovers them at boot.

`JWT_SECRET`, `PUBLIC_URL`, and at least one complete user triple are required — the process exits
at boot if any is missing.

## Connect from claude.ai

1. claude.ai → **Settings → Connectors → Add custom connector**.
2. **URL**: `<PUBLIC_URL>/mcp` — that exact path.
3. Leave **OAuth Client ID** and **Client Secret** empty (the server registers Claude dynamically).
4. Click **Connect**. A window opens on `/authorize`.
5. Type **your own** secret (`USER1_SECRET` or `USER2_SECRET`), submit. The window closes and the
   connector shows as connected.
6. Enable the connector in a chat; GitHub's tools appear as if you had connected GitHub directly.

Both people add the *same* connector URL — the secret each types is what binds their session to
their own PAT. Same flow works on mobile. If the connector ever drops, hit **Connect** again — the
refresh grant normally handles it silently.

## Local run

```bash
npm install && npm run build

# terminal 1 — fake upstream that echoes back which PAT arrived
node echo-upstream.mjs

# terminal 2 — the proxy, pointed at the fake upstream
USER1_NAME=alice USER1_SECRET=secret-alice USER1_PAT=pat-alice \
USER2_NAME=bob   USER2_SECRET=secret-bob   USER2_PAT=pat-bob \
JWT_SECRET=test-jwt PUBLIC_URL=http://127.0.0.1:8787 PORT=8787 \
UPSTREAM_MCP_URL=http://127.0.0.1:8899/ npm start

# terminal 3
node smoke.mjs
```

`smoke.mjs` covers discovery, DCR, the redirect allowlist, PKCE (including a deliberate mismatch),
single-use codes, refresh, per-user PAT injection, header round-tripping, and unbuffered SSE.

## Deploying

```bash
railway up --service mcp-github-proxy --detach
```

Builds via the `Dockerfile`, deliberately. Railway's default builder (railpack) fails this service
with `failed to solve: secret RAILWAY_GIT_REPO_OWNER not found` — its generated plan declares the
`RAILWAY_GIT_*` build secrets, which only exist when the service's source is a connected GitHub
repo, not a CLI tarball upload. Deleting the `Dockerfile` brings that failure back unless the
service is first connected to a GitHub source.

`PORT` is pinned to 3000 to match the generated domain's target port.

## Notes

- Claude's token never goes upstream; no PAT ever comes back down.
- A token's `sub` claim selects the PAT on every request, so one person's session can never reach
  GitHub as the other. Revoke someone by deleting their `USER<N>_*` triple — their live tokens stop
  resolving to a PAT immediately and start returning 401.
- Responses stream unbuffered, so GitHub's `text/event-stream` replies flush as they arrive.
- `Mcp-Session-Id` and `MCP-Protocol-Version` round-trip in both directions — required or the
  session breaks after `initialize`.
- Rotating `JWT_SECRET` invalidates every issued token; reconnect the connector afterwards.
