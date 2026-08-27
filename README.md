# md-github

A small MCP server that lets a **claude.ai custom connector** do surgical markdown edits across
the GitHub repositories of one account, batching any number of changes into **exactly one commit**.

Claude authenticates with OAuth 2.1 + DCR (which the connector form requires). Each person's
consent secret selects their own GitHub PAT and their own account. Zero runtime dependencies, no
database, all state in memory.

This is **not** a GitHub MCP passthrough. It exposes seven tools and nothing else.

## The tools

| Tool | What it does |
| --- | --- |
| `overview` | One call to orient in a repository: its root `INDEX.md` verbatim plus every file path with its size. Read-only. |
| `list_md` | Every .md file with byte size and git blob SHA, optionally with each file's heading outline. Read-only. |
| `read_md` | One file's exact bytes — or several files in one call — each with its blob SHA and a heading outline with line ranges. Read-only. |
| `history` | Recent commits — who authored each, when, and the message. Optional path filter. Read-only. |
| `show_commit` | One commit's author, message, and per-file diff. Read-only. |
| `commit_edits` | Applies an ordered list of edits and pushes them as **one** commit. The only tool that edits markdown. |
| `create_repo` | Creates a repository and seeds it with its own `INDEX.md`. |

Every tool except `create_repo` **requires** `repo` — a bare name (`"notes"`) or `"owner/name"`.
Start a session with `overview(repo)`; it is the one call that tells you what is in there.

`AGENT-TEMPLATE.md` is the instruction block to paste at an agent that will use this connector, and
`./connector-prompt.sh <repo>` fills in the repository name and copies it to the clipboard.

## Many repositories, one connection

An identity reaches **every repository its PAT can see** — owned, collaborated on, or via an
organization. There is no owner to configure: a token already belongs to one account and already
carries its own access, so the set of repositories it can see *is* the namespace. Configuring that
again would only create a second source of truth that can disagree with the token.

A bare `repo:"notes"` is resolved against that visible set; `repo:"owner/notes"` skips the lookup
and addresses the repository directly. A name visible under two owners is a refusal naming both,
not a guess. Nothing is enumerated at boot, so a repository made by `create_repo` resolves on the
very next call with no redeploy.

### There is no default repository

`repo` is required, and a call that omits it is an error rather than a guess. With several
projects behind one connection there is no such thing as "the" repository, and every plausible
fallback — the first one, the one configured at boot, the one touched last — is a way for an edit
to land in the wrong project while every message still reads like success. A wrong-repo commit is
also the one mistake here that `expect_sha` cannot catch, because the blob it guards is in a
repository nobody is looking at.

**Nothing lists the repositories a connection can reach** — not on results, not in the handshake.
Every tool names its repository explicitly, so a roster is never needed to make a call, and for a
broadly-scoped PAT it would put a screenful of irrelevant names on every single result. The visible
set is read from GitHub only to resolve a bare name, and it is never printed.

That resolution reads `GET /user/repos`, not `GET /users/:owner/repos` — the latter returns only
*public* repositories even for your own account, so a private notes repo would not resolve by name
at all. It is cached for five minutes, and a miss refetches once before failing, so a repository
created moments ago somewhere else still resolves.

### Nothing narrows a connection except its PAT

There is no pinned repository, no repository allowlist, no name prefix, no branch override and no
subtree confinement. Earlier versions had all of them; they were removed. Each was a second
boundary sitting next to the PAT's own scopes, able only to disagree with it, and each made
`create_repo` incoherent — a repository that does not exist yet cannot be on an allowlist written
at boot. Every repository uses its own default branch, for the same reason: one identity spans many
repositories, and a branch that exists in one rarely exists in the next.

The PAT is the boundary. Scope it in GitHub, where it actually holds.

### Each repository documents itself

There is deliberately **no cross-repository index file**. Each repository documents itself in its
own root `INDEX.md`, which is the file `create_repo` seeds and the file this server feeds back into
context. A registry in one repo would be a second place the truth lives, and it would go stale the
first time someone renamed a project outside the connector.

## Orienting: `overview`

A session starts by calling `overview(repo)`. One round trip returns that repository's root
`INDEX.md` verbatim — the router that says which file answers which question — plus every path in
the repository with its size. On this project's own context repo that is 152 paths and ~7k tokens,
after which the model knows where everything is and how big it is before fetching anything.

Everything else follows from the router: `read_md({paths:[...]})` for the folder indexes it points
at, `list_md({path_prefix, outline:true})` to narrow.

Deliberately **not** inlined: the folder-level index files. One of them in this project's context
repo is 66 KB — inlining them all would cost more than reading the files they describe.

Nothing else ever attaches an index to a result. An earlier version appended the router to every
tool result; a 13 KB index is ~3.5k tokens, so a ten-call session paid for one piece of information
ten times. `overview` delivers it once, when asked, and nothing else ever attaches one.

The index is read from the first of `INDEX.md`, `index.md`, `README.md` at the repository root,
cached for two minutes, and **invalidated by any commit through this server** — so a router the
model just rewrote is never read back stale. That cache and the name-resolution list are the only
things this server caches: neither is ever a source of a blob SHA, so a stale one cannot cause a
wrong write. The tree is deliberately **not** cached, for that reason.

### Who edited what

Each person's own PAT is injected, so GitHub records the real human as the commit author — this
is genuine git attribution, not anything the server synthesizes. `history` answers "who changed
this file", `show_commit` shows the actual diff, and `git blame` works normally outside the app.

Two limits worth knowing. `history(path)` does not follow renames, so commits from before a
rename are listed under the old path — same as `git log` without `--follow`. And a commit's
file list is paginated by GitHub at 300 files; the tool reports when it has hit that boundary
rather than presenting a partial list as complete.

### Reading several files at once

`read_md` takes `paths: [...]` (up to 20) instead of `path`. Reading five folder indexes is then
one round trip rather than five, and `max_bytes` becomes a budget shared across the batch and spent
in the order given. The batch is deliberately **not** all-or-nothing: a path that does not exist
reports its own error while the others still return. All-or-nothing is a property of `commit_edits`,
where a partial result would be a corrupt repository; here it would only cost a round trip.

`list_md` takes `outline: true` to show each file's headings without reading it. That is one read
per file, so it is refused above 40 files and says how to narrow.

### Creating a repository

`create_repo({name, overview})` creates the repository under the connection's owner and seeds it
with an `INDEX.md` of `# <name>` plus the overview. The overview is meant to be the document a
reader lands on first, not a one-line summary — it is that repository's router.

Its two effects on GitHub — the repository, then its first commit — **cannot be one transaction**,
so they are reported separately. If the seeding commit fails, the result says the repository exists
and is empty, and names the exact `commit_edits` call that finishes the job. It does not delete the
repository it just made: destroying a namespace to tidy up an error is a far worse failure than an
empty repository.

### Writing to a repository that has no commits

A brand-new repository cannot be written through GitHub's git-data API at all: blobs, trees and
commits all answer `409 Git Repository is empty.` The only endpoint that works is
`PUT /contents`, which creates the branch and the initial commit in one request — so that is what
`create_repo` seeds with, and it is the **only** place this server ever calls `PUT /contents`.

It writes exactly one file, so exactly one file is what a batch into an empty repository may
carry. A multi-file batch is refused with instructions rather than split across two commits,
because "one call, one commit" is the guarantee the whole design rests on.

`POST /user/repos` creates under **the account the token belongs to**, not under a name in the
request body — so a PAT that merely collaborates on someone else's repositories creates new ones in
its *own* account. The result reports the `full_name` GitHub returned rather than a name this server
assumed. It resolves by name on the very next call.

Creating a repository needs more than `Contents: Read and write`. A classic PAT with the `repo`
scope works; a fine-grained PAT needs `Administration: Read and write`, cannot create repositories
in a *personal* account at all (only in an organization), and if it is limited to selected
repositories it could not write to the new repository anyway — so multi-repo use wants
**All repositories**. A 403 says exactly this instead of the generic contents message.

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
never produce a success receipt. It is also bound to the repository it was authored against:
replaying it into another one is refused, because those edits were built from text the other
repository has never contained.

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
| `USER<N>_PAT` | That person's GitHub PAT. Used only for their own requests, and the whole of their reach. |
| `USER<N>_NAME` | Optional label, defaults to `user<N>`. Becomes the token `sub`. |

That is the entire per-person configuration: a secret and a PAT. There is nothing else to set —
every repository the PAT can see is reachable, and every call names the one it acts on.

`USER<N>_NAME` is an identity key, not a label: renaming someone invalidates their live tokens and
they must reconnect. Changing their `PAT` takes effect immediately with no reconnect.

**Migrating an older deployment**: delete `USER<N>_REPO`, `USER<N>_OWNER`, `USER<N>_REPOS`,
`USER<N>_REPO_PREFIX`, `USER<N>_BRANCH` and `USER<N>_ROOT` if you have any of them. None are read
any more, and a secret plus a PAT is the whole configuration.

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

# integration: 264 assertions against a stateful fake GitHub
USER1_NAME=alice USER1_SECRET=secret-alice USER1_PAT=pat-alice \
USER2_NAME=bob   USER2_SECRET=secret-bob   USER2_PAT=pat-bob \
USER3_NAME=frank USER3_SECRET=secret-frank USER3_PAT=pat-frank \
JWT_SECRET=test-jwt PUBLIC_URL=http://127.0.0.1:8787 PORT=8787 \
GITHUB_API_URL=http://127.0.0.1:8899 npm start &
node smoke.mjs
```

`fake-github.mjs` is a stateful fake with a real git-blob-SHA implementation, a commit DAG,
per-token repository visibility (owned plus collaborated-on, so name resolution proves something), a
request log and injectable faults, so a commit made through the server is observable by a later
read. It is what lets the suite assert the things that actually matter: that N edits produce
exactly one commit and zero `PUT /contents` calls, that a deletion survives serialization as a
literal `"sha":null`, that `force:false` appears on every ref update, that a failed batch leaves
zero mutative requests, that a colleague's concurrent push is never clobbered, that a call naming
one repository issues requests to no other, that `create_repo` produces exactly one commit in
exactly the new repository and reports the account GitHub really created it under, and that a batch
held after a failure cannot be replayed into a different repository.

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
- A short file returned whole gets **no** outline. An outline is a map of a file you have not read;
  printing one above the twelve lines it describes is noise. It reappears the moment the file is
  long enough to page through, or the window is partial.
- A GitHub 401 is surfaced as tool-error text and never as an HTTP 401 from `/mcp`. The old proxy
  forwarded GitHub's `WWW-Authenticate`, which sent claude.ai to re-authenticate against GitHub and
  produced a reauth loop while the real problem — a dead PAT — stayed invisible.
- The PAT is the real security boundary, and now it is also the only one that decides reach:
  nothing in this server's configuration narrows it. Scope the PAT itself in GitHub. Note the tension
  with `create_repo`: it wants a token that can reach repositories that did not exist when the
  token was made, which is the opposite of a selected-repositories fine-grained PAT.
