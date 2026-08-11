/* GitHub REST client + the two-phase commit.
   PLAN is entirely non-mutative: any failure aborts having issued only GETs.
   EXECUTE is 3 mutative requests regardless of how many files changed. */

import { Doc, EditError, deltaInvariants, editSection, parseDoc, render, scanHeadings, sectionSpan, strReplace } from "./md.js";

export const GITHUB_API_URL = (process.env.GITHUB_API_URL || "https://api.github.com").replace(/\/+$/, "");

export type User = {
  id: string;
  secret: string;
  pat: string;
  repo: string;      // "owner/name"
  branch?: string;
  root?: string;
  defaultBranch?: string;
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
async function gh(user: User, path: string, init: { method?: string; body?: unknown; accept?: string } = {}): Promise<GhRes> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${user.pat}`,
    Accept: init.accept || "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "mcp-github-proxy",
  };
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`${GITHUB_API_URL}${path}`, {
    method: init.method || "GET",
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body, headers: res.headers, text };
}

/** GitHub hides repo existence from tokens that cannot see it, so 404 is never "no such repo". */
function classify(user: User, r: GhRes, what: string): never {
  const msg = typeof r.body?.message === "string" ? r.body.message : r.text.slice(0, 200);
  if (r.status === 401) {
    bail(`The configured GitHub PAT was rejected (401) while ${what}. It may have expired or been revoked. Nothing was committed.`);
  }
  if (r.status === 404) {
    bail(
      `Cannot reach ${user.repo} while ${what} (404). The PAT lacks "Contents: Read and write" for ${user.repo}, ` +
        `or the repository is not among the token's selected repositories, or an organization has not approved the token.`
    );
  }
  if (r.status === 403 && /resource not accessible/i.test(msg)) {
    bail(`${user.repo} is readable but not writable by this PAT (403). "Contents: Read and write" is required. Nothing was committed.`);
  }
  bail(`GitHub returned ${r.status} while ${what}: ${msg}`);
}

const isProtection = (r: GhRes) => {
  const m = JSON.stringify(r.body || "").toLowerCase();
  return /pull request|protected|status check|ruleset|required/.test(m);
};

/* ---------------- paths ---------------- */

/** One choke point: commit_edits is the only write tool, so .md enforcement lives here alone. */
export function validatePath(user: User, p: unknown): string {
  if (typeof p !== "string" || !p) bail("path must be a non-empty string.");
  const path = p as string;
  if (path.length > 512) bail(`path is too long (${path.length} chars, max 512).`);
  if (!/\.md$/i.test(path)) bail(`${path} is not a .md file. This tool only edits markdown.`);
  if (path.startsWith("/")) bail(`${path} must be repo-relative, with no leading slash.`);
  if (path.includes("\\")) bail(`${path} must use forward slashes.`);
  if (/[\u0000-\u001f\u007f]/.test(path)) bail(`${path} contains a control character.`);
  for (const seg of path.split("/")) {
    if (seg === "" ) bail(`${path} has an empty path segment.`);
    if (seg === "." || seg === "..") bail(`${path} must not contain "." or ".." segments.`);
  }
  if (user.root) {
    const root = user.root.replace(/\/+$/, "") + "/";
    if (!path.startsWith(root)) bail(`${path} is outside the configured root "${user.root}".`);
  }
  return path;
}

/* ---------------- branch ---------------- */

/** Lazily resolved: a boot-time network call turns a slow GitHub into a restart loop. */
export async function branchOf(user: User): Promise<string> {
  if (user.branch) return user.branch;
  if (user.defaultBranch) return user.defaultBranch;
  const r = await gh(user, `/repos/${user.repo}`);
  if (r.status !== 200) classify(user, r, "resolving the default branch");
  user.defaultBranch = r.body.default_branch || "main";
  return user.defaultBranch!;
}

/* ---------------- reads ---------------- */

export type TreeEntry = { path: string; mode: string; type: string; sha: string; size?: number };

async function fetchTree(user: User, ref: string, recursive: boolean): Promise<{ entries: TreeEntry[]; truncated: boolean }> {
  const r = await gh(user, `/repos/${user.repo}/git/trees/${encodeURIComponent(ref)}${recursive ? "?recursive=1" : ""}`);
  if (r.status !== 200) classify(user, r, "listing the repository tree");
  // .sha here echoes the input and is NOT a tree sha — never read base_tree from it.
  return { entries: (r.body.tree || []) as TreeEntry[], truncated: !!r.body.truncated };
}

export async function listMd(user: User, prefix: string, max: number) {
  const branch = await branchOf(user);
  const { entries, truncated } = await fetchTree(user, prefix ? branch : branch, true);
  const files = entries
    .filter((e) => e.type === "blob" && /\.md$/i.test(e.path))
    .filter((e) => (prefix ? e.path.startsWith(prefix.replace(/^\/+/, "")) : true))
    .filter((e) => (user.root ? e.path.startsWith(user.root.replace(/\/+$/, "") + "/") : true))
    .sort((a, b) => a.path.localeCompare(b.path));
  return { branch, files: files.slice(0, max), total: files.length, truncated };
}

export async function readMd(user: User, path: string, offsetLines: number, maxBytes: number) {
  const branch = await branchOf(user);
  const raw = await gh(user, `/repos/${user.repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(branch)}`, {
    accept: "application/vnd.github.raw",
  });
  if (raw.status === 404) bail(`${path} does not exist on ${branch}.`);
  if (raw.status !== 200) classify(user, raw, `reading ${path}`);

  // The raw media type carries the blob sha in the ETag. Verified live but undocumented,
  // so validate it and fall back to the JSON media type rather than trusting it blindly.
  let sha = (raw.headers.get("etag") || "").replace(/^W\//, "").replace(/"/g, "").trim();
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    console.log(`[read_md] ETag was not a blob sha for ${path}; falling back to the JSON media type`);
    const j = await gh(user, `/repos/${user.repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(branch)}`);
    if (j.status !== 200) classify(user, j, `reading ${path}`);
    if (j.body.encoding !== "base64") {
      bail(`${path} is too large to read through the contents API (GitHub returned encoding "${j.body.encoding}").`);
    }
    sha = j.body.sha;
  }

  const full = raw.text;
  const lines = full.split(/\r?\n/);
  const start = Math.max(0, offsetLines - 1);
  let window = lines.slice(start).join("\n");
  let clipped = false;
  if (Buffer.byteLength(window, "utf8") > maxBytes) {
    window = Buffer.from(window, "utf8").subarray(0, maxBytes).toString("utf8");
    clipped = true;
  }
  const scan = scanHeadings(full.split("\n"));
  const outline = scan.headings.map((h, i) => {
    const s = sectionSpan(scan.headings, i, full.split("\n").length);
    return `  L${h.level} ${h.text || "(empty)"} (lines ${h.startLine + 1}-${s.end})`;
  });
  return { branch, sha, content: window, totalLines: lines.length, startLine: start + 1, clipped, outline, unclosedFence: scan.unclosedFenceLine };
}

/* ---------------- the two-phase commit ---------------- */

type Working = { path: string; doc: Doc; text: string; base?: TreeEntry; notes: string[]; deleted: boolean; existedInBase: boolean };

export type CommitResult = { sha: string; url: string; branch: string; changed: string[]; deleted: string[]; notes: string[]; warnings: string[] };

export async function commitEdits(user: User, message: string, edits: Edit[]): Promise<CommitResult> {
  const branch = await branchOf(user);
  const attempt = async (): Promise<CommitResult | "retry"> => {
    /* ---- PHASE 1: PLAN. Only GETs. ---- */
    const ref = await gh(user, `/repos/${user.repo}/git/ref/heads/${encodeURIComponent(branch)}`);
    if (ref.status === 409 && /empty/i.test(JSON.stringify(ref.body))) return bootstrapEmptyRepo(user, branch, message, edits);
    if (ref.status !== 200) classify(user, ref, "reading the branch ref");
    const headSha: string = ref.body.object.sha;

    const commit = await gh(user, `/repos/${user.repo}/git/commits/${headSha}`);
    if (commit.status !== 200) classify(user, commit, "reading the head commit");
    const baseTreeSha: string = commit.body.tree.sha; // ONLY source of base_tree

    const { entries, truncated } = await fetchTree(user, baseTreeSha, true);
    const index = new Map<string, TreeEntry>();
    for (const e of entries) if (e.type === "blob") index.set(e.path, e);

    const touched = [...new Set(edits.map((e) => e.path))];
    if (truncated) {
      // Never silently skip validation. Resolve each touched path level by level.
      for (const p of touched) {
        if (!index.has(p)) {
          const resolved = await resolvePath(user, baseTreeSha, p);
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
      let text = "";
      let doc = parseDoc("");
      if (base && edits.some((e) => e.path === p && e.op !== "delete")) {
        if (base.type !== "blob" || base.mode === "120000" || base.mode === "160000") {
          errors.push(`${p} is a symlink or submodule entry, not a regular file. Refusing to write it as text.`);
          continue;
        }
        const blob = await gh(user, `/repos/${user.repo}/git/blobs/${base.sha}`);
        if (blob.status !== 200) classify(user, blob, `reading ${p}`);
        if (blob.body.encoding !== "base64") {
          errors.push(`${p} came back with encoding "${blob.body.encoding}"; refusing to edit it.`);
          continue;
        }
        const raw = Buffer.from(String(blob.body.content).replace(/\s/g, ""), "base64").toString("utf8");
        doc = parseDoc(raw);
        text = doc.text;
      }
      working.set(p, { path: p, doc, text, base, notes: [], deleted: false, existedInBase: !!base });
    }

    // Apply in array order against one working copy per path. Collect ALL failures.
    for (let i = 0; i < edits.length; i++) {
      const e = edits[i]!;
      const w = working.get(e.path);
      if (!w) continue;
      try {
        applyOne(e, w, i, branch, headSha);
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

    // Build tree entries; drop paths whose final bytes equal their base bytes.
    const treeEntries: { path: string; mode: string; type: "blob"; content?: string; sha?: string | null }[] = [];
    const changed: string[] = [];
    const deleted: string[] = [];
    const notes: string[] = [];
    const warnings: string[] = [];

    for (const w of working.values()) {
      if (w.deleted) {
        treeEntries.push({ path: w.path, mode: w.base?.mode || "100644", type: "blob", sha: null });
        deleted.push(w.path);
        notes.push(...w.notes);
        continue;
      }
      const before = w.existedInBase ? w.doc.text : "";
      if (w.existedInBase && w.text === before) continue; // no effective change
      warnings.push(...deltaInvariants(before, w.text, w.path).map((x) => `${w.path}: ${x}`));
      let out = render(w.doc, w.text);
      if (out && !out.endsWith("\n")) out += w.doc.eol;
      const entry: { path: string; mode: string; type: "blob"; content?: string; sha?: string | null } = {
        path: w.path,
        mode: w.base?.mode || "100644",
        type: "blob",
      };
      // tree[].content is implicitly utf-8 and cannot carry a lone surrogate.
      if (!isWellFormed(out)) {
        const b = await gh(user, `/repos/${user.repo}/git/blobs`, {
          method: "POST",
          body: { content: Buffer.from(out, "utf8").toString("base64"), encoding: "base64" },
        });
        if (b.status !== 201) classify(user, b, `uploading ${w.path}`);
        entry.sha = b.body.sha;
      } else {
        entry.content = out;
      }
      treeEntries.push(entry);
      changed.push(w.path);
      notes.push(...w.notes);
    }

    if (!treeEntries.length) {
      bail("No effective changes — the edits produce content identical to what is already on the branch. Nothing was committed.");
    }

    /* ---- PHASE 2: EXECUTE. 3 mutative requests. ---- */
    // Omitting base_tree rebuilds the root from this list alone and wipes the repository.
    if (!/^[0-9a-f]{40}$/.test(baseTreeSha)) throw new Error(`refusing to build a tree: base_tree is not a sha (${baseTreeSha})`);
    const body = { base_tree: baseTreeSha, tree: treeEntries };
    if (deleted.length && !JSON.stringify(body).includes('"sha":null')) {
      throw new Error("refusing to commit: a deletion was requested but no explicit null sha survived serialization");
    }

    const tree = await gh(user, `/repos/${user.repo}/git/trees`, { method: "POST", body });
    if (tree.status !== 201) classify(user, tree, "creating the tree");

    const newCommit = await gh(user, `/repos/${user.repo}/git/commits`, {
      method: "POST",
      body: { message, tree: tree.body.sha, parents: [headSha] },
    });
    if (newCommit.status !== 201) classify(user, newCommit, "creating the commit");

    const patch = await gh(user, `/repos/${user.repo}/git/refs/heads/${encodeURIComponent(branch)}`, {
      method: "PATCH",
      body: { sha: newCommit.body.sha, force: false }, // real server-side compare-and-swap
    });

    if (patch.status === 422 && /not a fast forward/i.test(JSON.stringify(patch.body))) return "retry";
    if ((patch.status === 403 || patch.status === 422) && isProtection(patch)) {
      bail(
        `Branch ${branch} of ${user.repo} is protected: ${patch.body?.message || "changes must go through a pull request"}. Nothing was committed.`
      );
    }
    if (patch.status !== 200) classify(user, patch, "updating the branch");

    return {
      sha: newCommit.body.sha,
      url: newCommit.body.html_url || `https://github.com/${user.repo}/commit/${newCommit.body.sha}`,
      branch,
      changed,
      deleted,
      notes,
      warnings,
    };
  };

  const first = await attempt();
  if (first !== "retry") return first;

  // Ref reads go briefly stale right after a push and produce spurious non-fast-forwards.
  await new Promise((r) => setTimeout(r, 1500));
  const second = await attempt(); // re-plans from scratch: fresh head, fresh tree, fresh blobs
  if (second === "retry") {
    bail(`${user.repo}@${branch} is moving faster than this commit can land — two pushes landed underneath it. Nothing was committed.`);
  }
  return second;
}

function isWellFormed(s: string): boolean {
  return typeof (s as any).isWellFormed === "function"
    ? (s as any).isWellFormed()
    : !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);
}

function applyOne(e: Edit, w: Working, i: number, branch: string, headSha: string): void {
  const exists = () => (w.deleted ? false : w.existedInBase || w.notes.some((n) => n.startsWith("created")));
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
      w.text = e.content.replace(/\r\n/g, "\n");
      // Writing revives a path deleted earlier in this batch: delete-then-create is the
      // sanctioned overwrite idiom, so the final entry must carry content, not sha:null.
      w.deleted = false;
      w.notes.push(`created ${w.path}`);
    } else if (mode === "overwrite") {
      if (!exists()) throw new EditError(`${w.path} does not exist on ${branch}. Use mode=create.`);
      shaGuard(e.expect_sha, true);
      w.text = e.content.replace(/\r\n/g, "\n");
      w.notes.push(`overwrote ${w.path}`);
    } else {
      if (!exists()) throw new EditError(`${w.path} does not exist on ${branch}. Use mode=create.`);
      if (e.expect_sha) shaGuard(e.expect_sha, false);
      const add = e.content.replace(/\r\n/g, "\n");
      w.text = w.text && !w.text.endsWith("\n") ? `${w.text}\n${add}` : w.text + add;
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
    const r = strReplace({ ...w.doc, text: w.text }, w.path, e.old_string, e.new_string, !!e.replace_all);
    w.text = r.text;
    w.notes.push(`${w.path}: ${r.note}`);
    return;
  }
  if (e.op === "edit_section") {
    const r = editSection({ ...w.doc, text: w.text }, w.path, e.heading, e.mode, e.content);
    w.text = r.text;
    w.notes.push(`${w.path}: ${r.note}`);
    return;
  }
  throw new EditError(`unknown op "${(e as any).op}"`);
}

/** Walk a path segment by segment when the recursive tree came back truncated. */
async function resolvePath(user: User, treeSha: string, path: string): Promise<TreeEntry | null> {
  const segs = path.split("/");
  let sha = treeSha;
  for (let i = 0; i < segs.length; i++) {
    const { entries } = await fetchTree(user, sha, false);
    const hit = entries.find((e) => e.path === segs[i]);
    if (!hit) return null;
    if (i === segs.length - 1) return { ...hit, path };
    if (hit.type !== "tree") return null;
    sha = hit.sha;
  }
  return null;
}

/** The ONLY code permitted to create a tree without base_tree. */
async function bootstrapEmptyRepo(user: User, branch: string, message: string, edits: Edit[]): Promise<CommitResult> {
  if (!edits.every((e) => e.op === "write" && (e.mode || "create") === "create")) {
    bail(`${user.repo} is empty, so only write operations with mode="create" can be committed. Nothing was committed.`);
  }
  const entries = edits.map((e) => {
    const w = e as Extract<Edit, { op: "write" }>;
    let content = w.content.replace(/\r\n/g, "\n");
    if (content && !content.endsWith("\n")) content += "\n";
    return { path: w.path, mode: "100644", type: "blob" as const, content };
  });
  if (!entries.every((e) => typeof e.content === "string")) throw new Error("bootstrap: every entry must carry content");

  const tree = await gh(user, `/repos/${user.repo}/git/trees`, { method: "POST", body: { tree: entries } });
  if (tree.status !== 201) classify(user, tree, "creating the initial tree");
  const commit = await gh(user, `/repos/${user.repo}/git/commits`, { method: "POST", body: { message, tree: tree.body.sha } });
  if (commit.status !== 201) classify(user, commit, "creating the initial commit");
  const ref = await gh(user, `/repos/${user.repo}/git/refs`, { method: "POST", body: { ref: `refs/heads/${branch}`, sha: commit.body.sha } });
  if (ref.status !== 201) classify(user, ref, "creating the branch");

  return {
    sha: commit.body.sha,
    url: commit.body.html_url || `https://github.com/${user.repo}/commit/${commit.body.sha}`,
    branch,
    changed: entries.map((e) => e.path),
    deleted: [],
    notes: [`initialized ${user.repo} on ${branch}`],
    warnings: [],
  };
}
