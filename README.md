# md-github

A small MCP server that lets a **claude.ai custom connector** do surgical markdown edits in one
GitHub repository, batching any number of changes into **exactly one commit**.

Claude authenticates with OAuth 2.1 + DCR (which the connector form requires). Each person's
consent secret selects their own GitHub PAT and their own repo. Zero runtime dependencies, no
database, all state in memory.

This is **not** a GitHub MCP passthrough. It exposes five tools and nothing else.

## The tools

| Tool | What it does |
| --- | --- |
| `list_md` | Every .md file with byte size and git blob SHA. Read-only. |
| `read_md` | One file's exact bytes, its blob SHA, and a heading outline with line ranges. Read-only. |
| `history` | Recent commits — who authored each, when, and the message. Optional path filter. Read-only. |
| `show_commit` | One commit's author, message, and per-file diff. Read-only. |
| `commit_edits` | Applies an ordered list of edits and pushes them as **one** commit. The only tool that writes. |

### Who edited what

Each person's own PAT is injected, so GitHub records the real human as the commit author — this
is genuine git attribution, not anything the server synthesizes. `history` answers "who changed
this file", `show_commit` shows the actual diff, and `git blame` works normally outside the app.

Two limits worth knowing. `history(path)` does not follow renames, so commits from before a
rename are listed under the old path — same as `git log` without `--follow`. And a commit's
file list is paginated by GitHub at 300 files; the tool reports when it has hit that boundary
rather than presenting a partial list as complete.

`commit_edits` takes four operations:

| op | Fields | Notes |
| --- | --- | --- |
| `write` | `path`, `content`, `mode` | `create` (default), `overwrite` (needs `expect_sha`), `append`. |
| `str_replace` | `path`, `old_string`, `new_string`, `replace_all` | Exact byte match; must be unique unless `replace_all`. |
| `edit_section` | `path`, `heading`, `mode`, `content` | `replace` / `append` / `prepend` / `delete` a section addressed by its heading. |
| `delete` | `path`, `expect_sha` | Removes a file. |

### Why there is no start_commit / end_commit

The obvious design is a staging area you open and later close with a message. It was rejected
deliberately: it creates a place where finished-looking work can sit unpublished, so "I made the
edits and forgot to commit" becomes constructible. Three independent design reviews converged on
the same conclusion.

Instead there is **no staging area at all**. `commit_edits` is atomic — a whole batch of changes
across many files, applied and pushed in one call, or nothing sent to GitHub whatsoever. The agent
accumulates its plan in its own context (the one store a model reads reliably) and spends it in a
single call. Every tool result ends with a standing line saying nothing is pending, so the belief
that something is queued is refuted continuously rather than left to be discovered later.

There is also **no auto-commit timer**, at any timeout. An idle timer publishes work nobody
approved — a retracted deletion, a half-finished restructure. Zero unwanted commits is a designed
property, not an omission. On shutdown the server logs what it is dropping and commits nothing.

The one piece of retained state is **failure-only**: a batch that fails is held for 30 minutes as a
`retry_ref` so a large batch need not be retyped from a context that may already have been
compacted. It is announced on every subsequent result, it is cleared by any success, and it can
never produce a success receipt.

### Atomicity, precisely

`commit_edits` runs two phases and the boundary is the guarantee.

- **Plan** — validation, snapshot fetch, `expect_sha` checks, applying every op to in-memory
  buffers. Any failure aborts here having issued only `GET`s. Not "rolled back": no mutative
  request was ever sent. All failures in a batch are reported together, so a 12-op batch with 3
  defects costs one turn rather than three.
- **Execute** — three mutative requests (`POST /git/trees`, `POST /git/commits`,
  `PATCH /git/refs`) regardless of how many files changed. Only the final `PATCH` is observable.

So after any call there are exactly two observable states: one commit exists, or the branch is
byte-identical to before.

`expect_sha` is required exactly where an operation destroys a whole file — `delete` and
`write mode=overwrite`. You cannot wholesale replace or remove a file you never observed.
`list_md` returns full blob SHAs, so a deletion never needs a content read.

### Concurrency

Content is re-read at commit time from a single pinned snapshot, so the read-modify-write window is
about a second rather than the length of a conversation. `PATCH ... force:false` is a real
server-side compare-and-swap; `force: true` is never sent anywhere. On a collision the whole plan
re-runs against the new head: if nothing the batch touches moved, it lands silently; if something
did, it stops and returns the fresh upstream content inline rather than clobbering.

## Environment

| Var | Notes |
| --- | --- |
| `JWT_SECRET` | Signs the tokens this server issues. |
| `PUBLIC_URL` | This service's own base URL, no trailing slash. |
| `PORT` | Pinned to 3000 to match the generated Railway domain. |
| `GITHUB_API_URL` | Defaults to `https://api.github.com`. The testing seam. |

One numbered triple per person:

| Var | Notes |
| --- | --- |
| `USER<N>_SECRET` | What that person types on the consent page. Identity is the secret. |
| `USER<N>_PAT` | That person's GitHub PAT. Used only for their own requests. |
| `USER<N>_REPO` | `owner/name`. One repo per identity — no tool takes a repo argument. |
| `USER<N>_NAME` | Optional label, defaults to `user<N>`. Becomes the token `sub`. |
| `USER<N>_BRANCH` | Optional. Defaults to the repo's default branch, resolved lazily. |
| `USER<N>_ROOT` | Optional path prefix that confines this user to a subtree. |

`USER<N>_NAME` is an identity key, not a label: renaming someone invalidates their live tokens and
they must reconnect. Changing their `PAT` or `REPO` takes effect immediately with no reconnect,
which makes repo migration a one-variable change.

## Connect from claude.ai

1. Settings → Connectors → **Add custom connector**.
2. **URL**: `<PUBLIC_URL>/mcp`.
3. Leave client ID and secret empty.
4. **Connect**, then type your own `USER<N>_SECRET`.

Both people add the same URL; the secret each types binds their session to their own PAT and repo.

## Tests

```bash
npm install && npm run build
node test-md.mjs        # 92 assertions: scanner, edit ops, byte fidelity — no network

# integration: 168 assertions against a stateful fake GitHub
USER1_NAME=alice USER1_SECRET=secret-alice USER1_PAT=pat-alice USER1_REPO=alice/notes \
USER2_NAME=bob   USER2_SECRET=secret-bob   USER2_PAT=pat-bob   USER2_REPO=bob/wiki \
USER3_NAME=carol USER3_SECRET=secret-carol USER3_PAT=pat-carol USER3_REPO=alice/notes USER3_ROOT=docs \
USER4_NAME=dave  USER4_SECRET=secret-dave  USER4_PAT=pat-dave  USER4_REPO=alice/notes USER4_BRANCH=nope \
JWT_SECRET=test-jwt PUBLIC_URL=http://127.0.0.1:8787 PORT=8787 \
GITHUB_API_URL=http://127.0.0.1:8899 npm start &
node smoke.mjs
```

`fake-github.mjs` is a stateful fake with a real git-blob-SHA implementation, a commit DAG, a
request log and injectable faults, so a commit made through the server is observable by a later
read. It is what lets the suite assert the things that actually matter: that N edits produce
exactly one commit and zero `PUT /contents` calls, that a deletion survives serialization as a
literal `"sha":null`, that `force:false` appears on every ref update, that a failed batch leaves
zero mutative requests, and that a colleague's concurrent push is never clobbered.

## Deploying

```bash
railway up --service mcp-github-proxy --detach
```

Builds via the `Dockerfile`, deliberately. Railway's default builder (railpack) fails this service
with `failed to solve: secret RAILWAY_GIT_REPO_OWNER not found` — its generated plan declares the
`RAILWAY_GIT_*` build secrets, which only exist when the service's source is a connected GitHub
repo, not a CLI tarball upload.

## Notes

- The markdown scanner is a real CommonMark block scanner, not a `^#{1,6}` regex. Front matter's
  closing `---` is a legal setext H2 underline, so a naive scan invents a phantom heading named
  after the last YAML line and an agent would edit straight into the front matter. Headings inside
  fences, indented code, HTML blocks and blockquotes are correctly not addressable.
- Byte fidelity is deliberate: CRLF files keep CRLF on untouched lines, a BOM is split off so a
  start-anchored `old_string` can match, and nothing is ever trimmed — two trailing spaces are a
  markdown hard line break.
- `read_md` returns content **without** line-number gutters, because numbers next to text the model
  is about to copy into `old_string` is exactly how a gutter ends up in the needle. Line numbers
  appear only in outlines and error messages — places nothing is copied from.
- A GitHub 401 is surfaced as tool-error text and never as an HTTP 401 from `/mcp`. The old proxy
  forwarded GitHub's `WWW-Authenticate`, which sent claude.ai to re-authenticate against GitHub and
  produced a reauth loop while the real problem — a dead PAT — stayed invisible.
- The PAT is the real security boundary. `USER<N>_REPO` confines this server to one repo, but a
  token with broader access still has that access; scope the PAT itself in GitHub.
