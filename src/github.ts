/* GitHub REST client + the two-phase commit.
   PLAN is entirely non-mutative: any failure aborts having issued only GETs.
   EXECUTE is 3 mutative requests regardless of how many files changed. */

import { Doc, EditError, Scan, deltaInvariants, editSection, parseDoc, render, scanHeadings, sectionSpan, strReplace } from "./md.js";

export const GITHUB_API_URL = (process.env.GITHUB_API_URL || "https://api.github.com").replace(/\/+$/, "");

/** One tool call's target. Identity (who, and which repos they may reach) lives in server.ts;
    everything below needs only the credential and the one repo this call is against. */
export type Ctx = {
  id: string;
  pat: string;
  repo: string;      // "owner/name"
};

/** A configured person: a secret they type, and the PAT their requests are made with. The PAT is
    the whole of their reach — every repository it can see, and nothing else. There is no
    per-identity narrowing, no default repository and no pinned branch: every tool call names the
    repository it acts on, and that is the only thing that decides where it lands. */
export type User = {
  id: string;
  secret: string;
  pat: string;
};

export type Edit =
  | { op: "write"; path: string; content: string; mode?: "create" | "overwrite" | "append"; expect_sha?: string }
  | { op: "str_replace"; path: string; old_string: string; new_string: string; replace_all?: boolean; expect_sha?: string }
  | { op: "edit_section"; path: string; heading: string; mode: "replace" | "append" | "prepend" | "delete"; content?: string; expect_sha?: string }
  | { op: "delete"; path: string; expect_sha: string };

export class ToolError extends Error {}
// A function declaration, not a const arrow: TS only applies never-return control-flow
// analysis to the former, and the narrowing after every bail() call depends on it.
function bail(m: string): never {
  throw new ToolError(m);
}

/* ---------------- transport ---------------- */

type GhRes = { status: number; body: any; headers: Headers; text: string };

/** Node's global fetch does not set User-Agent and api.github.com 403s without one. */
async function gh(ctx: Ctx, path: string, init: { method?: string; body?: unknown; accept?: string } = {}): Promise<GhRes> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${ctx.pat}`,
    Accept: init.accept || "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "mcp-github-proxy",
  };
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  let res: Response;
  try {
    res = await fetch(`${GITHUB_API_URL}${path}`, {
      method: init.method || "GET",
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  } catch (err) {
    bail(`Could not reach GitHub (${err instanceof Error ? err.message : String(err)}). Nothing was committed.`);
  }
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body, headers: res.headers, text };
}

/** GitHub hides repo existence from tokens that cannot see it, so 404 is never "no such repo".
    `read` suppresses the "Nothing was committed" tail, which is nonsense from a read-only tool
    and reads as a failed write. */
function classify(ctx: Ctx, r: GhRes, what: string, read = false): never {
  const msg = typeof r.body?.message === "string" ? r.body.message : r.text.slice(0, 200);
  const tail = read ? "" : " Nothing was committed.";
  if (r.status === 401) {
    bail(`The configured GitHub PAT was rejected (401) while ${what}. It may have expired or been revoked.${tail}`);
  }
  if (r.status === 404) {
    bail(
      `Cannot reach ${ctx.repo} while ${what} (404). The PAT lacks "Contents: Read and write" for ${ctx.repo}, ` +
        `or the repository is not among the token's selected repositories, or an organization has not approved the token.`
    );
  }
  if (r.status === 403 && /resource not accessible/i.test(msg)) {
    bail(`${ctx.repo} is readable but not writable by this PAT (403). "Contents: Read and write" is required.${tail}`);
  }
  bail(`GitHub returned ${r.status} while ${what}: ${msg}.${tail}`);
}

const isProtection = (r: GhRes) => {
  const m = JSON.stringify(r.body || "").toLowerCase();
  return /pull request|protected|status check|ruleset|required/.test(m);
};

/** Branch names legitimately contain slashes (`feature/x`), and GitHub's ref paths take them
    raw — percent-encoding turns the whole branch into one unresolvable segment. */
const refPath = (branch: string) => branch.split("/").map(encodeURIComponent).join("/");

/* ---------------- repo resolution ---------------- */

/** Turns a tool's `repo` argument into the one repo this call targets.

    `repo` is REQUIRED on every tool. There is no default and no last-used memory: with several
    projects behind one connection, a call that names no repo has no correct answer, and the
    plausible-looking fallbacks — "the first one", "the one configured at boot", "the one touched
    last" — are exactly how an edit lands in the wrong project while every message still reads
    like success.

    A bare name resolves against the repositories the PAT can actually see, because that set is
    already the namespace: a token belongs to one account and carries its own collaborator and
    org access, so an owner is something to look up, never something to configure. "owner/name"
    skips the lookup entirely and addresses the repo directly.

    Existence of a fully-qualified repo is deliberately NOT pre-checked: GitHub's 404 already
    produces a better message than a guess would, via classify(). */
export async function resolveRepo(user: User, arg: unknown): Promise<Ctx> {
  if (arg === undefined || arg === null || arg === "") {
    bail(`repo is required — pass the repository name, e.g. repo:"notes". There is no default repository.`);
  }
  if (typeof arg !== "string") bail("repo must be a string — a repository name, or \"owner/name\".");

  const parts = arg.split("/");
  if (parts.length > 2) bail(`"${arg}" is not a repository. Pass a name ("notes") or "owner/name".`);
  for (const seg of parts) if (!REPO_NAME_RE.test(seg)) bail(`"${arg}" is not a valid repository name. Use letters, digits, ".", "-" and "_".`);

  const ctx: Ctx = { id: user.id, pat: user.pat, repo: arg };
  if (parts.length === 2) return ctx; // fully qualified: nothing to look up

  const name = parts[0]!;
  const hit = await findRepo(ctx, name);
  if (!hit) {
    bail(`No repository named "${name}" is visible to this PAT. Check the spelling, or pass "owner/${name}" to address it directly.`);
  }
  return { ...ctx, repo: hit };
}

/** Resolve a bare name to "owner/name" against the visible set. A miss refetches once before
    failing, so a repo created moments ago in another session is not reported as nonexistent
    merely because the roster is a few minutes old. */
async function findRepo(ctx: Ctx, name: string): Promise<string | null> {
  for (const fresh of [false, true]) {
    if (fresh) rosters.delete(ctx.id);
    let repos: RepoBrief[];
    try {
      repos = await listRepos(ctx);
    } catch {
      return null;
    }
    const matches = repos.filter((r) => r.name.toLowerCase() === name.toLowerCase());
    // Two owners can both have a repo called "notes". Guessing between them is how an edit lands
    // in a stranger's repository, so it is a refusal.
    if (matches.length > 1) {
      bail(`"${name}" is ambiguous — this PAT can see ${matches.map((m) => m.full).join(" and ")}. Pass the full "owner/name".`);
    }
    if (matches.length === 1) return matches[0]!.full;
    if (fresh) return null;
  }
  return null;
}

/* ---------------- paths ---------------- */

/** Structural checks shared by every path, read or write. The `.md` rule is NOT here: it is a
    property of editing, and applying it to a read tool rejects the directory and non-markdown
    filters that "who changed what" questions are actually made of. */
export function validateReadPath(p: unknown): string {
  if (typeof p !== "string" || !p) bail("path must be a non-empty string.");
  const path = p as string;
  if (path.length > 512) bail(`path is too long (${path.length} chars, max 512).`);
  if (path.startsWith("/")) bail(`${path} must be repo-relative, with no leading slash.`);
  if (path.includes("\\")) bail(`${path} must use forward slashes.`);
  if (/[\u0000-\u001f\u007f]/.test(path)) bail(`${path} contains a control character.`);
  for (const seg of path.split("/")) {
    if (seg === "") bail(`${path} has an empty path segment.`);
    if (seg === "." || seg === "..") bail(`${path} must not contain "." or ".." segments.`);
  }
  return path;
}

/** Write paths additionally must be markdown — commit_edits is the only write tool. */
export function validatePath(p: unknown): string {
  const path = validateReadPath(p);
  if (!/\.md$/i.test(path)) bail(`${path} is not a .md file. This tool only edits markdown.`);
  return path;
}

/* ---------------- branch ---------------- */

/** Keyed by repo: a Ctx is built fresh per call, so caching the resolved branch on it would
    cache nothing. Every repository uses its own default branch — there is no override, because
    one identity now spans many repositories and a branch that exists in one rarely exists in
    the next. */
const defaultBranches = new Map<string, string>();

/** Lazily resolved: a boot-time network call turns a slow GitHub into a restart loop. */
export async function branchOf(ctx: Ctx): Promise<string> {
  const cached = defaultBranches.get(ctx.repo);
  if (cached) return cached;
  const r = await gh(ctx, `/repos/${ctx.repo}`);
  if (r.status !== 200) classify(ctx, r, "resolving the default branch");
  const branch = r.body.default_branch || "main";
  defaultBranches.set(ctx.repo, branch);
  return branch;
}

/* ---------------- reads ---------------- */

export type TreeEntry = { path: string; mode: string; type: string; sha: string; size?: number };

const isEmptyRepo = (r: GhRes) => r.status === 409 && /repository is empty/i.test(JSON.stringify(r.body || ""));

async function fetchTree(ctx: Ctx, ref: string, recursive: boolean, read = false): Promise<{ entries: TreeEntry[]; truncated: boolean }> {
  const r = await gh(ctx, `/repos/${ctx.repo}/git/trees/${encodeURIComponent(ref)}${recursive ? "?recursive=1" : ""}`);
  // A repository with no commits has no tree. That is "no files", not a failure — and reporting
  // it as one made a freshly created repo look broken.
  if (isEmptyRepo(r)) return { entries: [], truncated: false };
  if (r.status !== 200) classify(ctx, r, "listing the repository tree", read);
  // .sha here echoes the input and is NOT a tree sha — never read base_tree from it.
  return { entries: (r.body.tree || []) as TreeEntry[], truncated: !!r.body.truncated };
}

export async function listMd(ctx: Ctx, prefix: string, max: number) {
  const branch = await branchOf(ctx);
  const { entries, truncated } = await fetchTree(ctx, branch, true, true);
  const files = entries
    .filter((e) => e.type === "blob" && /\.md$/i.test(e.path))
    .filter((e) => (prefix ? e.path.startsWith(prefix.replace(/^\/+/, "")) : true))
    .sort((a, b) => a.path.localeCompare(b.path));
  return { branch, files: files.slice(0, max), total: files.length, truncated };
}

/** Everything a session needs to orient itself in one repository, in one call: the root index
    verbatim, and every path with its size. Deliberately not just .md — knowing an images folder
    or a stray script exists is part of knowing the repository, and the paths are cheap.

    Folder-level index files are NOT inlined. One of this repo's own folder indexes is 66 KB;
    inlining them all would cost more than reading the files they describe. */
export async function overview(ctx: Ctx, maxFiles: number) {
  const branch = await branchOf(ctx);
  const [{ entries, truncated }, idx] = await Promise.all([fetchTree(ctx, branch, true, true), repoIndex(ctx)]);
  const blobs = entries
    .filter((e) => e.type === "blob")
    .sort((a, b) => a.path.localeCompare(b.path));
  return {
    branch,
    index: idx,
    files: blobs.slice(0, maxFiles).map((e) => ({ path: e.path, size: e.size ?? 0, md: /\.md$/i.test(e.path) })),
    total: blobs.length,
    markdown: blobs.filter((e) => /\.md$/i.test(e.path)).length,
    bytes: blobs.reduce((n, e) => n + (e.size ?? 0), 0),
    truncated,
  };
}

/** One blob GET per file, so it is bounded by the caller. A file too big to be worth a fetch
    is reported as skipped rather than silently outlined as empty. */
export const OUTLINE_MAX_FILES = 40;
const OUTLINE_MAX_BYTES = 400_000;

export async function outlinesFor(ctx: Ctx, files: TreeEntry[]): Promise<Map<string, string[] | null>> {
  const out = new Map<string, string[] | null>();
  const wanted = files.filter((f) => (f.size ?? 0) <= OUTLINE_MAX_BYTES);
  for (const f of files) if (!wanted.includes(f)) out.set(f.path, null);
  const bodies = await pooled(wanted, async (f) => {
    const r = await gh(ctx, `/repos/${ctx.repo}/git/blobs/${f.sha}`);
    if (r.status !== 200 || r.body?.encoding !== "base64") return null;
    return Buffer.from(String(r.body.content).replace(/\s/g, ""), "base64").toString("utf8");
  });
  wanted.forEach((f, i) => {
    if (bodies[i] === null) return out.set(f.path, null);
    const lines = bodies[i]!.split("\n");
    out.set(f.path, outlineOf(lines, scanHeadings(lines)));
  });
  return out;
}

/** The one place a heading outline is formatted, so read_md and list_md cannot drift apart. */
function outlineOf(lines: string[], scan: Scan): string[] {
  return scan.headings.map((h, i) => `  L${h.level} ${h.text || "(empty)"} (lines ${h.startLine + 1}-${sectionSpan(scan.headings, i, lines.length).end})`);
}

const contentsUrl = (ctx: Ctx, path: string, branch: string) =>
  `/repos/${ctx.repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(branch)}`;

/** Fetch alone, no windowing. Split out so a batch read can fetch every file concurrently and
    THEN spend one shared byte budget across them — clipping each file against its own budget
    would either waste the budget on small files or need the reads to be serial. */
async function fetchRaw(ctx: Ctx, path: string, branch: string): Promise<{ sha: string; full: string }> {
  const raw = await gh(ctx, contentsUrl(ctx, path, branch), { accept: "application/vnd.github.raw" });
  if (raw.status === 404) bail(`${path} does not exist on ${branch}.`);
  if (raw.status !== 200) classify(ctx, raw, `reading ${path}`, true);

  // The raw media type carries the blob sha in the ETag. Verified live but undocumented,
  // so validate it and fall back to the JSON media type rather than trusting it blindly.
  let sha = (raw.headers.get("etag") || "").replace(/^W\//, "").replace(/"/g, "").trim();
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    console.log(`[read_md] ETag was not a blob sha for ${path}; falling back to the JSON media type`);
    const j = await gh(ctx, contentsUrl(ctx, path, branch));
    if (j.status !== 200) classify(ctx, j, `reading ${path}`, true);
    if (j.body.encoding !== "base64") {
      bail(`${path} is too large to read through the contents API (GitHub returned encoding "${j.body.encoding}").`);
    }
    sha = j.body.sha;
  }
  return { sha, full: raw.text };
}

export type ReadWindow = ReturnType<typeof windowOf>;

/** Below this, a fully-returned file's outline describes text already on screen. */
const OUTLINE_REDUNDANT_LINES = 30;

/** Pure: no network. Given a whole file, produce the returned window plus its outline. */
export function windowOf(full: string, offsetLines: number, maxBytes: number) {
  const lines = full.split(/\r?\n/);
  const start = Math.max(0, offsetLines - 1);
  // Clip on a LINE boundary. Cutting at a byte offset splits a multi-byte character and yields
  // U+FFFD, so the returned text would no longer paste back into old_string.
  const kept: string[] = [];
  let used = 0;
  let clipped = false;
  for (let i = start; i < lines.length; i++) {
    const cost = Buffer.byteLength(lines[i]!, "utf8") + 1;
    if (used + cost > maxBytes && kept.length) {
      clipped = true;
      break;
    }
    kept.push(lines[i]!);
    used += cost;
  }
  const srcLines = full.split("\n");
  const scan = scanHeadings(srcLines);
  // An outline is a map of a file you have not read. When the whole of a short file comes back in
  // the same response, it is a map of the thing sitting directly below it — so it is suppressed.
  // The line ranges only start earning their place once the file is long enough to page through.
  const outline = !clipped && start === 0 && lines.length <= OUTLINE_REDUNDANT_LINES ? [] : outlineOf(srcLines, scan);
  return {
    content: kept.join("\n"),
    bytes: used,
    totalLines: lines.length,
    startLine: start + 1,
    nextLine: start + kept.length + 1,
    clipped,
    outline,
    unclosedFence: scan.unclosedFenceLine,
  };
}

export async function readMd(ctx: Ctx, path: string, offsetLines: number, maxBytes: number) {
  const branch = await branchOf(ctx);
  const { sha, full } = await fetchRaw(ctx, path, branch);
  return { branch, sha, ...windowOf(full, offsetLines, maxBytes) };
}

/** Batch read. Deliberately NOT all-or-nothing: a missing path among five reports its own error
    while the other four return. All-or-nothing is a property of commit_edits, where a partial
    result would be a corrupt repository; here it would only cost a round trip.
    The byte budget is shared and spent in the caller's path order, so what got cut is
    predictable rather than a race between concurrent fetches. */
export type BatchRead = { path: string } & ({ ok: true; sha: string; win: ReadWindow } | { ok: false; error: string; skipped?: boolean });

export async function readMany(ctx: Ctx, paths: string[], maxBytes: number): Promise<{ branch: string; results: BatchRead[] }> {
  const branch = await branchOf(ctx);
  const fetched = await pooled(paths, (p) =>
    fetchRaw(ctx, p, branch).then(
      (r) => ({ path: p, ...r, error: "" }),
      (err) => ({ path: p, sha: "", full: "", error: err instanceof Error ? err.message : String(err) })
    )
  );

  let budget = maxBytes;
  const results: BatchRead[] = fetched.map((f) => {
    if (f.error) return { path: f.path, ok: false as const, error: f.error };
    if (budget <= 0) return { path: f.path, ok: false as const, error: "not read — the shared max_bytes budget was already spent", skipped: true };
    const win = windowOf(f.full, 1, budget);
    budget -= win.bytes;
    return { path: f.path, ok: true as const, sha: f.sha, win };
  });
  return { branch, results };
}

/** Bounded concurrency, order-preserving. GitHub's secondary rate limiter punishes a burst of
    100 parallel requests from one token far harder than it punishes 8 at a time. */
async function pooled<T, R>(items: T[], fn: (item: T, i: number) => Promise<R>, limit = 8): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i]!, i);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/* ---------------- history ---------------- */

/** Commits are authored with each person's OWN PAT, so GitHub records the real human and
    `who edited what` is genuine git attribution rather than anything this server invents. */
export async function history(ctx: Ctx, path: string | undefined, limit: number) {
  const branch = await branchOf(ctx);
  const q = new URLSearchParams({ sha: branch, per_page: String(limit) });
  if (path) q.set("path", path);
  const r = await gh(ctx, `/repos/${ctx.repo}/commits?${q}`);
  if (r.status === 409) return { branch, commits: [] as any[] }; // empty repo
  // branchOf already proved the repo readable, so a 404 here is an unknown branch, not a
  // permissions problem — reporting it as one sends the operator to audit token scopes.
  if (r.status === 404) {
    bail(`Branch "${branch}" does not exist on ${ctx.repo}.`);
  }
  if (r.status !== 200) classify(ctx, r, "reading the commit history", true);
  const commits = (Array.isArray(r.body) ? r.body : []).map((c: any) => ({
    sha: String(c?.sha ?? ""),
    // `author` is null whenever the commit email is not linked to a GitHub account — verified
    // on ~19% of a large real repo's commits — so the fallback to the raw git name matters.
    author: c?.author?.login || c?.commit?.author?.name || "unknown",
    date: c?.commit?.author?.date || "",
    message: String(c?.commit?.message ?? "").split("\n")[0],
  }));
  return { branch, commits };
}

const PATCH_CAP = 6000;
const TOTAL_PATCH_CAP = 60000;
const MESSAGE_CAP = 4000;
const MAX_FILES_RENDERED = 100;
/** GitHub paginates a commit's files at 300 per page and we deliberately do not follow the
    Link header — but silently showing 300 of 17000 as if it were the whole commit is a lie. */
const GITHUB_FILE_PAGE = 300;

export async function showCommit(ctx: Ctx, sha: string) {
  if (!/^[0-9a-fA-F]{7,40}$/.test(sha)) bail(`"${sha}" is not a commit SHA. Pass one from history().`);
  const r = await gh(ctx, `/repos/${ctx.repo}/commits/${encodeURIComponent(sha)}`);
  // Real GitHub answers 422 "No commit found for SHA" for an unknown OR ambiguous sha, and
  // reserves 404 for a repository the token cannot see. Treating 404 as "no such commit"
  // disguised a dead or mis-scoped PAT as a missing commit.
  if (r.status === 422 && /no commit found/i.test(String(r.body?.message || ""))) {
    bail(`No commit ${sha} in ${ctx.repo}. If you abbreviated the SHA, it may also be ambiguous — pass more characters.`);
  }
  if (r.status !== 200) classify(ctx, r, `reading commit ${sha}`, true);

  const resolved = String(r.body?.sha ?? "");
  if (resolved && !resolved.toLowerCase().startsWith(sha.toLowerCase())) {
    bail(`GitHub resolved "${sha}" to a different commit (${resolved.slice(0, 12)}…). Pass the full SHA.`);
  }

  const visible: any[] = Array.isArray(r.body?.files) ? r.body.files : [];

  let budget = TOTAL_PATCH_CAP;
  const files = visible.slice(0, MAX_FILES_RENDERED).map((f: any) => {
    // A non-string patch would make `budget` NaN and silently disable the cap for the rest.
    let patch: string = typeof f?.patch === "string" ? f.patch : "";
    let clipped = false;
    if (patch.length > PATCH_CAP) { patch = patch.slice(0, PATCH_CAP); clipped = true; }
    if (patch.length > budget) { patch = patch.slice(0, Math.max(0, budget)); clipped = true; }
    budget -= patch.length;
    return {
      filename: String(f?.filename ?? "(unknown)"),
      previousFilename: typeof f?.previous_filename === "string" ? f.previous_filename : "",
      status: String(f?.status ?? "modified"),
      additions: Number(f?.additions ?? 0),
      deletions: Number(f?.deletions ?? 0),
      patch,
      clipped,
      // No patch key at all: binary, or a diff GitHub judged too large.
      noDiff: typeof f?.patch !== "string",
    };
  });

  return {
    sha: resolved || sha,
    author: r.body?.author?.login || r.body?.commit?.author?.name || "unknown",
    email: r.body?.commit?.author?.email || "",
    date: r.body?.commit?.author?.date || "",
    message: String(r.body?.commit?.message ?? "").slice(0, MESSAGE_CAP),
    messageClipped: String(r.body?.commit?.message ?? "").length > MESSAGE_CAP,
    files,
    filesShown: files.length,
    filesTotal: visible.length,
    pagedByGitHub: visible.length >= GITHUB_FILE_PAGE,
    totalChanges: Number(r.body?.stats?.total ?? 0),
  };
}

/* ---------------- repos ---------------- */

/** The visible-repo list and the index are both cached. Neither is ever a source of a blob sha,
    so a stale one cannot cause a wrong write — that is what makes caching them safe when caching
    the tree deliberately is not. */
type Cached<T> = { at: number; value: T };
const ROSTER_TTL = 5 * 60_000;
const INDEX_TTL = 2 * 60_000;
/** Only ever used to resolve a bare name to "owner/name". This list is never shown to anyone:
    a roster on every result would be a screenful of irrelevant names for any broadly-scoped PAT,
    and every tool names its repository explicitly anyway. */
export type RepoBrief = { name: string; full: string };
const rosters = new Map<string, Cached<RepoBrief[]>>();
const indexes = new Map<string, Cached<{ path: string; text: string } | null>>();
const ownerTypes = new Map<string, "User" | "Organization">();

/** Any commit through this server invalidates that repo's cached index, so a router the model
    just edited is not read back stale on the very next result. Same read-your-own-writes
    concern readHeadRef solves for refs. */
function forgetIndex(repo: string): void {
  for (const k of [...indexes.keys()]) if (k.startsWith(repo + "@")) indexes.delete(k);
}

/** Creating a repo makes the roster wrong immediately, and the roster is printed next to the
    very result that announces the new repo. Five minutes of not listing it would read as
    "it was not really created". */
function forgetRoster(id: string): void {
  rosters.delete(id);
}

export function sweepCaches(now = Date.now()): void {
  for (const [k, v] of rosters) if (now - v.at > ROSTER_TTL) rosters.delete(k);
  for (const [k, v] of indexes) if (now - v.at > INDEX_TTL) indexes.delete(k);
}

/** Every repo this PAT can see, for name resolution only. */
export async function listRepos(ctx: Ctx): Promise<RepoBrief[]> {
  const hit = rosters.get(ctx.id);
  if (hit && Date.now() - hit.at < ROSTER_TTL) return hit.value;
  const out: RepoBrief[] = [];
  // /user/repos, NOT /users/:owner/repos: the latter returns only PUBLIC repositories even for
  // your own account, so a private notes repo would be missing from its own roster. This one is
  // scoped to the token and covers owned, collaborator and organization access in one call —
  // which is the whole reason an owner never has to be configured or looked up.
  // 3 pages max: a roster is for orientation, not an inventory, and a 400-repo account would
  // otherwise spend 4 sequential round trips before the first result is rendered.
  for (let page = 1; page <= 3; page++) {
    const r = await gh(ctx, `/user/repos?per_page=100&sort=pushed&page=${page}`);
    if (r.status !== 200 || !Array.isArray(r.body)) break;
    for (const x of r.body) {
      if (typeof x?.full_name !== "string") continue;
      out.push({ name: String(x.name), full: x.full_name });
    }
    if (r.body.length < 100) break;
  }
  rosters.set(ctx.id, { at: Date.now(), value: out });
  return out;
}

/** A repo's root index: the first of INDEX.md, index.md, README.md that exists at the root.
    Case matters to git, so all three are looked for by exact name rather than lowercased. */
const INDEX_NAMES = ["INDEX.md", "index.md", "README.md"];

export async function repoIndex(ctx: Ctx): Promise<{ path: string; text: string } | null> {
  const branch = await branchOf(ctx);
  const key = `${ctx.repo}@${branch}`;
  const hit = indexes.get(key);
  if (hit && Date.now() - hit.at < INDEX_TTL) return hit.value;

  let value: { path: string; text: string } | null = null;
  try {
    // One non-recursive tree read finds all three candidates at once; three speculative
    // content GETs would cost two 404s in the common case.
    const { entries } = await fetchTree(ctx, branch, false, true);
    const root = new Set(entries.filter((e) => e.type === "blob").map((e) => e.path));
    const name = INDEX_NAMES.find((n) => root.has(n));
    if (name) value = { path: name, text: (await fetchRaw(ctx, name, branch)).full };
  } catch {
    // An unreadable index is not a failed tool call. The caller renders the result without it.
    value = null;
  }
  indexes.set(key, { at: Date.now(), value });
  return value;
}

export const REPO_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export type CreateRepoResult = {
  repo: string;
  url: string;
  private: boolean;
  branch: string;
  seeded: { sha: string; url: string; path: string } | null;
  seedError: string | null;
};

/** Two GitHub effects that cannot be one transaction: the repo, then its first commit. They are
    reported separately and honestly. A failed seed leaves an empty repo and says so, naming the
    call that finishes the job — it does NOT delete the repo it just made, because destroying a
    namespace to tidy up an error is a far worse failure than an empty repo. */
export async function createRepo(
  ctx: Ctx,
  name: string,
  overview: string,
  description: string,
  isPrivate: boolean
): Promise<CreateRepoResult> {
  // POST /user/repos creates under whatever account the token belongs to. That is the same
  // account whose repos the roster lists, so there is nothing to configure and nothing to
  // check — the full_name GitHub returns is simply reported back.
  const r = await gh(ctx, "/user/repos", {
    method: "POST",
    // auto_init:false deliberately: an auto-initialised repo arrives with a README this server
    // did not write, and the seed below would then have to overwrite a file it never read.
    body: { name, description: description.slice(0, 350), private: isPrivate, auto_init: false },
  });

  if (r.status === 422 && /already exists/i.test(JSON.stringify(r.body || ""))) {
    bail(`A repository named "${name}" already exists on this account. Nothing was created. Pick another name, or edit the existing one with repo:"${name}".`);
  }
  if (r.status === 403 || r.status === 404) {
    bail(
      `This PAT cannot create repositories (${r.status}: ${r.body?.message || "forbidden"}). Nothing was created. ` +
        `Creating a repo needs more than Contents access: a classic PAT with the "repo" scope, or a fine-grained PAT with ` +
        `"Administration: Read and write". Note that fine-grained tokens cannot create repositories in a personal account at ` +
        `all — only in an organization — and a token limited to selected repositories could not write to the new repo anyway.`
    );
  }
  if (r.status !== 201) classify(ctx, r, `creating the repository "${name}"`);

  forgetRoster(ctx.id);
  const repo: string = r.body?.full_name || name;
  if (!/^[^/]+\/[^/]+$/.test(repo)) bail(`GitHub did not return a full repository name for "${name}" (got "${repo}").`);
  const branch: string = r.body?.default_branch || "main";
  const url: string = r.body?.html_url || `https://github.com/${repo}`;
  defaultBranches.set(repo, branch);

  const child: Ctx = { id: ctx.id, pat: ctx.pat, repo };
  const seedPath = "INDEX.md";
  const body = `# ${name}\n\n${overview.replace(/\s+$/, "")}\n`;
  try {
    const commit = await commitEdits(child, `Add ${seedPath}`, [{ op: "write", path: seedPath, content: body, mode: "create" }]);
    return { repo, url, private: !!r.body?.private, branch: commit.branch, seeded: { sha: commit.sha, url: commit.url, path: seedPath }, seedError: null };
  } catch (err) {
    return { repo, url, private: !!r.body?.private, branch, seeded: null, seedError: err instanceof Error ? err.message : String(err) };
  }
}

/* ---------------- the two-phase commit ---------------- */

type Working = {
  path: string;
  doc: Doc;
  baseRaw: string;
  base?: TreeEntry;
  notes: string[];
  deleted: boolean;
  created: boolean;
  existedInBase: boolean;
};

export type CommitResult = { sha: string; url: string; branch: string; changed: string[]; deleted: string[]; notes: string[]; warnings: string[] };

type Attempt =
  | { kind: "done"; result: CommitResult }
  | { kind: "retry"; snapshot: Map<string, string | null>; fresh: Map<string, string> };

export async function commitEdits(ctx: Ctx, message: string, edits: Edit[]): Promise<CommitResult> {
  const branch = await branchOf(ctx);

  const attempt = async (prior?: { snapshot: Map<string, string | null>; fresh: Map<string, string> }): Promise<Attempt> => {
    /* ---- PHASE 1: PLAN. Only GETs. ---- */
    const ref = await readHeadRef(ctx, branch);
    if (isEmptyRepo(ref)) {
      return { kind: "done", result: await bootstrapEmptyRepo(ctx, branch, message, edits) };
    }
    if (ref.status !== 200) classify(ctx, ref, "reading the branch ref");
    const headSha: string = ref.body.object.sha;

    const commit = await gh(ctx, `/repos/${ctx.repo}/git/commits/${headSha}`);
    if (commit.status !== 200) classify(ctx, commit, "reading the head commit");
    const baseTreeSha: string = commit.body.tree.sha; // ONLY source of base_tree

    const { entries, truncated } = await fetchTree(ctx, baseTreeSha, true);
    const index = new Map<string, TreeEntry>();
    for (const e of entries) if (e.type === "blob") index.set(e.path, e);

    const touched = [...new Set(edits.map((e) => e.path))];
    if (truncated) {
      // Never silently skip validation. Resolve each touched path level by level.
      for (const p of touched) {
        if (!index.has(p)) {
          const resolved = await resolvePath(ctx, baseTreeSha, p);
          if (resolved) index.set(p, resolved);
        }
      }
    }

    // Pinned snapshot: content comes from the blob sha listed in THIS tree, never from
    // /contents?ref=branch, which resolves live and could hand back a newer commit.
    const working = new Map<string, Working>();
    const errors: string[] = [];
    for (const p of touched) {
      const base = index.get(p);
      let raw = "";
      if (base && edits.some((e) => e.path === p && e.op !== "delete")) {
        if (base.type !== "blob" || base.mode === "120000" || base.mode === "160000") {
          errors.push(`${p} is a symlink or submodule entry, not a regular file. Refusing to write it as text.`);
          continue;
        }
        const blob = await gh(ctx, `/repos/${ctx.repo}/git/blobs/${base.sha}`);
        if (blob.status !== 200) classify(ctx, blob, `reading ${p}`);
        if (blob.body.encoding !== "base64") {
          errors.push(`${p} came back with encoding "${blob.body.encoding}"; refusing to edit it.`);
          continue;
        }
        raw = Buffer.from(String(blob.body.content).replace(/\s/g, ""), "base64").toString("utf8");
      }
      working.set(p, { path: p, doc: parseDoc(raw), baseRaw: raw, base, notes: [], deleted: false, created: false, existedInBase: !!base });
    }

    const snapshot = new Map<string, string | null>(touched.map((p) => [p, index.get(p)?.sha ?? null]));
    const fresh = new Map<string, string>(touched.map((p) => [p, working.get(p)?.baseRaw ?? ""]));

    // On a retry, refuse if anything this batch TOUCHES moved. Without this the ops that carry
    // no expect_sha (edit_section, str_replace, append) silently re-apply over the colleague's
    // new content and return a success receipt while destroying their work.
    if (prior) {
      const moved = touched.filter((p) => prior.snapshot.get(p) !== snapshot.get(p));
      if (moved.length) {
        const detail = moved
          .map((p) => {
            const was = prior.snapshot.get(p);
            const now = snapshot.get(p);
            const body = fresh.get(p) ?? "";
            const shown = body.length > 2000 ? body.slice(0, 2000) + "\n… (truncated)" : body;
            return `• ${p} (${was ? was.slice(0, 8) + "…" : "absent"} → ${now ? now.slice(0, 8) + "…" : "deleted"})\n${shown}`;
          })
          .join("\n\n");
        bail(
          `Someone else pushed to ${ctx.repo}@${branch} while this commit was being prepared, and their change touches ` +
            `${moved.length} of the file(s) in this batch. Nothing was committed — re-authoring is required so their work is not lost.\n\n` +
            `Current content on ${branch}:\n\n${detail}`
        );
      }
    }

    // Apply in array order against one working copy per path. Collect ALL failures.
    for (let i = 0; i < edits.length; i++) {
      const e = edits[i]!;
      const w = working.get(e.path);
      if (!w) continue;
      try {
        applyOne(e, w, branch, headSha);
      } catch (err) {
        errors.push(`edits[${i}] (${e.op} ${e.path}): ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (errors.length) {
      bail(
        `Nothing was committed — ${errors.length} operation(s) could not be applied, and this tool is all-or-nothing.\n\n` +
          errors.map((x) => `• ${x}`).join("\n\n")
      );
    }

    // Materialize. Still non-mutative: nothing is sent until every file has been validated.
    type Pending = { path: string; mode: string; content: string };
    const pending: Pending[] = [];
    const deletions: { path: string; mode: string }[] = [];
    const changed: string[] = [];
    const notes: string[] = [];
    const warnings: string[] = [];

    for (const w of working.values()) {
      if (w.deleted) {
        deletions.push({ path: w.path, mode: w.base?.mode || "100644" });
        notes.push(...w.notes);
        continue;
      }
      let out = render(w.doc);
      if (w.created && out && !out.endsWith("\n")) out += w.doc.eol;
      if (w.existedInBase && out === w.baseRaw) continue; // no effective change
      // A lone surrogate cannot be encoded as UTF-8 at all: Buffer.from would substitute U+FFFD
      // and silently commit mojibake, so refuse rather than corrupt.
      if (!isWellFormed(out)) {
        errors.push(`${w.path} contains an unpaired surrogate (a half of a character, usually from slicing a string mid-emoji). Fix the content and retry.`);
        continue;
      }
      warnings.push(...deltaInvariants(w.baseRaw, out, w.path, !w.existedInBase).map((x) => `${w.path}: ${x}`));
      pending.push({ path: w.path, mode: w.base?.mode || "100644", content: out });
      changed.push(w.path);
      notes.push(...w.notes);
    }

    if (errors.length) {
      bail(`Nothing was committed — ${errors.length} file(s) could not be written.\n\n${errors.map((x) => `• ${x}`).join("\n\n")}`);
    }
    if (!pending.length && !deletions.length) {
      bail("No effective changes — the edits produce content identical to what is already on the branch. Nothing was committed.");
    }

    /* ---- PHASE 2: EXECUTE. Nothing above this line issued a mutative request. ---- */
    const treeEntries: { path: string; mode: string; type: "blob"; content?: string; sha?: string | null }[] = [
      ...pending.map((p) => ({ path: p.path, mode: p.mode, type: "blob" as const, content: p.content })),
      ...deletions.map((d) => ({ path: d.path, mode: d.mode, type: "blob" as const, sha: null })),
    ];

    // Omitting base_tree rebuilds the root from this list alone and wipes the repository.
    if (!/^[0-9a-f]{40}$/.test(baseTreeSha)) throw new Error(`refusing to build a tree: base_tree is not a sha (${baseTreeSha})`);
    // Per entry, not a whole-body substring: with several deletions one surviving null would
    // otherwise satisfy the check while the rest were dropped by a null-stripping serializer.
    for (const d of deletions) {
      const entry = treeEntries.find((t) => t.path === d.path)!;
      if (!("sha" in entry) || entry.sha !== null) throw new Error(`refusing to commit: deletion of ${d.path} lost its null sha`);
    }
    const body = { base_tree: baseTreeSha, tree: treeEntries };

    const tree = await gh(ctx, `/repos/${ctx.repo}/git/trees`, { method: "POST", body });
    if (tree.status !== 201) classify(ctx, tree, "creating the tree");

    const newCommit = await gh(ctx, `/repos/${ctx.repo}/git/commits`, {
      method: "POST",
      body: { message, tree: tree.body.sha, parents: [headSha] },
    });
    if (newCommit.status !== 201) classify(ctx, newCommit, "creating the commit");

    const patch = await gh(ctx, `/repos/${ctx.repo}/git/refs/heads/${refPath(branch)}`, {
      method: "PATCH",
      body: { sha: newCommit.body.sha, force: false }, // real server-side compare-and-swap
    });

    if (patch.status === 422 && /not a fast forward/i.test(JSON.stringify(patch.body))) return { kind: "retry", snapshot, fresh };
    if ((patch.status === 403 || patch.status === 422) && isProtection(patch)) {
      bail(`Branch ${branch} of ${ctx.repo} is protected: ${patch.body?.message || "changes must go through a pull request"}. Nothing was committed.`);
    }
    if (patch.status !== 200) classify(ctx, patch, "updating the branch");

    rememberCommit(ctx, branch, newCommit.body.sha);
    return {
      kind: "done",
      result: {
        sha: newCommit.body.sha,
        url: newCommit.body.html_url || `https://github.com/${ctx.repo}/commit/${newCommit.body.sha}`,
        branch,
        changed,
        deleted: deletions.map((d) => d.path),
        notes,
        warnings,
      },
    };
  };

  const first = await attempt();
  if (first.kind === "done") return first.result;

  // Ref reads go briefly stale right after a push and produce spurious non-fast-forwards.
  await new Promise((r) => setTimeout(r, 1500));
  const second = await attempt(first); // re-plans from scratch: fresh head, fresh tree, fresh blobs
  if (second.kind === "retry") {
    bail(`${ctx.repo}@${branch} is moving faster than this commit can land — two pushes landed underneath it. Nothing was committed.`);
  }
  return second.result;
}

/* Read-your-own-writes. GitHub's ref read goes briefly stale immediately after a push, so a
   commit made seconds ago may not be visible yet. Without this, an edit that follows another
   edit plans against the PREVIOUS head: expect_sha checks compare against superseded blobs and
   a file created moments ago reads as "not present on the branch". Keyed by repo+branch, not by
   ctx: two identities pointed at the same repo must share it, or the second one waits out the
   whole budget for a commit it never made and then fails with a manufactured error. */
const lastCommit = new Map<string, { sha: string; at: number }>();
const STALE_WINDOW_MS = 20_000;
const refKey = (ctx: Ctx, branch: string) => `${ctx.repo}@${branch}`;

function rememberCommit(ctx: Ctx, branch: string, sha: string) {
  lastCommit.set(refKey(ctx, branch), { sha, at: Date.now() });
  forgetIndex(ctx.repo);
}

async function readHeadRef(ctx: Ctx, branch: string): Promise<GhRes> {
  const url = `/repos/${ctx.repo}/git/ref/heads/${refPath(branch)}`;
  let r = await gh(ctx, url);
  const mine = lastCommit.get(refKey(ctx, branch));
  if (!mine || Date.now() - mine.at > STALE_WINDOW_MS) return r;

  for (let i = 0; i < 3 && r.status === 200 && r.body?.object?.sha !== mine.sha; i++) {
    // A colleague pushing on top also produces a different sha; that is legitimate, so the
    // budget is deliberately short and we proceed once it is spent.
    await new Promise((res) => setTimeout(res, 300 * (i + 1)));
    r = await gh(ctx, url);
  }
  return r;
}

function isWellFormed(s: string): boolean {
  return typeof (s as any).isWellFormed === "function"
    ? (s as any).isWellFormed()
    : !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);
}

function applyOne(e: Edit, w: Working, branch: string, headSha: string): void {
  const exists = () => !w.deleted && (w.existedInBase || w.created);
  const shaGuard = (given: string | undefined, required: boolean) => {
    if (required && !given) {
      throw new EditError(
        `requires expect_sha (the file's current blob SHA, returned by read_md and list_md). ` +
          `Refusing to destroy a whole file that was not observed.`
      );
    }
    if (given && w.base && given !== w.base.sha) {
      throw new EditError(
        `${w.path} changed on ${branch} since you read it (${given.slice(0, 8)}… → ${w.base.sha.slice(0, 8)}…). ` +
          `Nothing was committed. Call read_md("${w.path}") and rebuild this operation against the current text.`
      );
    }
    if (given && !w.base) throw new EditError(`${w.path} does not exist on ${branch} at ${headSha.slice(0, 7)}, so expect_sha cannot match.`);
  };

  if (e.op === "write") {
    const mode = e.mode || "create";
    if (mode === "create") {
      if (exists()) {
        throw new EditError(
          `${w.path} already exists${w.base ? ` (blob ${w.base.sha.slice(0, 8)}…)` : ""}. ` +
            `Use mode=overwrite with expect_sha, or a str_replace / edit_section operation.`
        );
      }
      if (e.expect_sha) throw new EditError("expect_sha applies only to mode=overwrite.");
      // Provided content is authoritative, including its own BOM and line endings — otherwise a
      // whole-file write inherits the old file's BOM and can produce a doubled one.
      w.doc = parseDoc(e.content);
      w.deleted = false;
      w.created = true;
      w.notes.push(`created ${w.path}`);
    } else if (mode === "overwrite") {
      if (!exists()) throw new EditError(`${w.path} does not exist on ${branch}. Use mode=create.`);
      shaGuard(e.expect_sha, true);
      w.doc = parseDoc(e.content);
      w.notes.push(`overwrote ${w.path}`);
    } else {
      if (!exists()) throw new EditError(`${w.path} does not exist on ${branch}. Use mode=create.`);
      if (e.expect_sha) shaGuard(e.expect_sha, false);
      const add = parseDoc(e.content.replace(/\r\n/g, "\n"));
      const lines = [...w.doc.lines];
      const eols = [...w.doc.eols];
      if (eols.length && eols[eols.length - 1] === "") eols[eols.length - 1] = w.doc.eol;
      w.doc = parseDoc(w.doc.bom + lines.map((l, i) => l + (eols[i] ?? "")).join("") + add.lines.map((l, i) => l + (add.eols[i] ?? "")).join(""));
      w.notes.push(`appended to ${w.path}`);
    }
    return;
  }

  if (e.op === "delete") {
    if (!w.existedInBase) {
      throw new EditError(
        `${w.path} is not present on ${branch} at ${headSha.slice(0, 7)} — it may already be deleted. ` +
          `GitHub rejects deleting a path that does not exist, and that would abort this whole batch.`
      );
    }
    shaGuard(e.expect_sha, true);
    w.deleted = true;
    w.notes.push(`deleted ${w.path}`);
    return;
  }

  if (!exists()) throw new EditError(`${w.path} does not exist on ${branch} at ${headSha.slice(0, 7)}.`);
  if (e.expect_sha) shaGuard(e.expect_sha, false);

  if (e.op === "str_replace") {
    const r = strReplace(w.doc, w.path, e.old_string, e.new_string, !!e.replace_all);
    w.doc = r.doc;
    w.notes.push(`${w.path}: ${r.note}`);
    return;
  }
  if (e.op === "edit_section") {
    const r = editSection(w.doc, w.path, e.heading, e.mode, e.content);
    w.doc = r.doc;
    w.notes.push(`${w.path}: ${r.note}`);
    return;
  }
  throw new EditError(`unknown op "${(e as any).op}"`);
}

/** Walk a path segment by segment when the recursive tree came back truncated. */
async function resolvePath(ctx: Ctx, treeSha: string, path: string): Promise<TreeEntry | null> {
  const segs = path.split("/");
  let sha = treeSha;
  for (let i = 0; i < segs.length; i++) {
    const { entries } = await fetchTree(ctx, sha, false);
    const hit = entries.find((e) => e.path === segs[i]);
    if (!hit) return null;
    if (i === segs.length - 1) return { ...hit, path };
    if (hit.type !== "tree") return null;
    sha = hit.sha;
  }
  return null;
}

/** An empty repository — one with no commits at all — cannot be written through the git-data
    API: GitHub answers 409 "Git Repository is empty" to blobs, trees and commits alike. The one
    endpoint that works is PUT /contents, which creates the branch and the initial commit in a
    single request. It writes exactly one file, so that is exactly what is allowed here; a
    multi-file batch is refused rather than split into two commits, because "one call, one
    commit" is the guarantee this whole server is built around.

    This is the ONLY place PUT /contents is ever used. Every ordinary edit goes through the
    three-request git-data path, and the test suite asserts that. */
async function bootstrapEmptyRepo(ctx: Ctx, branch: string, message: string, edits: Edit[]): Promise<CommitResult> {
  const only = edits[0];
  if (edits.length !== 1 || !only || only.op !== "write" || (only.mode || "create") !== "create") {
    bail(
      `${ctx.repo} has no commits yet, and GitHub's git API cannot write to a repository in that state — only a single-file ` +
        `create can start it off. Nothing was committed. Send one write with mode="create" first (that becomes the initial ` +
        `commit), then send the remaining ${Math.max(0, edits.length - 1)} operation(s) as a normal batch.`
    );
  }

  let content = render(parseDoc(only.content));
  if (content && !content.endsWith("\n")) content += "\n";
  if (!isWellFormed(content)) bail(`${only.path} contains an unpaired surrogate. Nothing was committed.`);

  const r = await gh(ctx, `/repos/${ctx.repo}/contents/${only.path.split("/").map(encodeURIComponent).join("/")}`, {
    method: "PUT",
    body: { message, content: Buffer.from(content, "utf8").toString("base64"), branch },
  });
  if (r.status === 422 && /sha/i.test(JSON.stringify(r.body || ""))) {
    bail(`${only.path} already exists in ${ctx.repo}, which was reported as empty. Nothing was committed; retry.`);
  }
  if (r.status !== 201) classify(ctx, r, `creating ${only.path} in the empty repository`);

  const sha: string = r.body?.commit?.sha || "";
  rememberCommit(ctx, branch, sha);
  return {
    sha,
    url: r.body?.commit?.html_url || `https://github.com/${ctx.repo}/commit/${sha}`,
    branch,
    changed: [only.path],
    deleted: [],
    notes: [`initialized ${ctx.repo} on ${branch}`],
    warnings: [],
  };
}
