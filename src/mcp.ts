/* MCP server: JSON-RPC dispatch and the three exposed tools.
   No GitHub tool is proxied. This server terminates MCP itself. */

import { randomBytes } from "node:crypto";
import {
  Ctx,
  Edit,
  OUTLINE_MAX_FILES,
  REPO_NAME_RE,
  ToolError,
  User,
  commitEdits,
  createRepo,
  history,
  listMd,
  outlinesFor,
  overview,
  readMany,
  readMd,
  repoIndex,
  resolveRepo,
  showCommit,
  sweepCaches,
  validatePath,
  validateReadPath,
} from "./github.js";
import { EditError } from "./md.js";

const KNOWN_VERSIONS = ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"];
const FALLBACK_VERSION = "2025-06-18";

/* ---------------- the standing ledger ---------------- */

const PENDING_LINE =
  "PENDING: nothing — this server holds no uncommitted work. A file is unchanged until commit_edits returns a commit SHA.";

/** Failure-only retention. Written ONLY from an isError result; it can never produce a
    success receipt. If this ever grows a "stage for later" entry point, the safety story
    of the whole design is gone. */
type FailedBatch = { ref: string; repo: string; message: string; edits: Edit[]; failedAt: number; reason: string };
const lastFailure = new Map<string, FailedBatch>();
const commitTimes = new Map<string, number[]>();
const RETENTION_MS = 30 * 60_000;

export function sweep(): void {
  const now = Date.now();
  sweepCaches(now);
  for (const [k, v] of lastFailure) if (now - v.failedAt > RETENTION_MS) lastFailure.delete(k);
  for (const [k, v] of commitTimes) {
    const keep = v.filter((t) => now - t < 10 * 60_000);
    if (keep.length) commitTimes.set(k, keep);
    else commitTimes.delete(k);
  }
}

export function onShutdown(): void {
  for (const [sub, b] of lastFailure) {
    console.log(`held failed batch ${b.ref} (${sub}, ${b.edits.length} ops) dropped on shutdown`);
  }
}

function ledger(sub: string): string {
  const held = lastFailure.get(sub);
  let out = `\n\n${PENDING_LINE}`;
  if (held) {
    const age = Date.now() - held.failedAt;
    const mins = age < 60_000 ? `${Math.max(1, Math.round(age / 1000))}s` : `${Math.round(age / 60_000)}m`;
    const left = Math.max(1, Math.round((RETENTION_MS - age) / 60_000));
    out +=
      `\nNOTE: a batch you sent ${mins} ago failed and is held as retry_ref ${held.ref} ` +
      `(${held.edits.length} operations against ${held.repo}, "${held.message}" — ${held.reason}). ` +
      `Resend it with commit_edits({repo:"${held.repo.split("/")[1]}", message, retry_ref:"${held.ref}"}). ` +
      `It expires in ${left}m and lives in server memory only; a restart drops it.`;
  }
  return out;
}

/* ---------------- tool definitions ---------------- */

const EDIT_ITEM_SCHEMA = {
  type: "object",
  description:
    "One edit operation. Required fields depend on op: " +
    'write needs content (and expect_sha when mode="overwrite"); ' +
    "str_replace needs old_string and new_string; " +
    "edit_section needs heading and mode; " +
    "delete needs expect_sha.",
  properties: {
    op: {
      type: "string",
      enum: ["write", "str_replace", "edit_section", "delete"],
      description:
        'write = create a new file, replace a whole file, or append to one. ' +
        "str_replace = exact-text surgical replacement. " +
        "edit_section = replace/append/prepend/delete a markdown section addressed by its heading. " +
        "delete = remove a file.",
    },
    path: { type: "string", description: "Repo-relative path ending in .md, no leading slash." },
    content: {
      type: "string",
      description: "write: the whole file text (create/overwrite) or the text to add (append). edit_section: the new section text. Omit for delete.",
    },
    mode: {
      type: "string",
      enum: ["create", "overwrite", "append", "replace", "prepend", "delete"],
      description:
        'For op=write: "create" (default, fails if the path exists), "overwrite" (requires expect_sha), or "append". ' +
        'For op=edit_section: "replace" (swap the body, keep the heading), "append", "prepend", or "delete" (remove heading and body).',
    },
    old_string: { type: "string", description: "str_replace: text to find, matched byte for byte including whitespace and indentation." },
    new_string: { type: "string", description: "str_replace: replacement text. Must differ from old_string." },
    replace_all: { type: "boolean", description: "str_replace: replace every occurrence instead of requiring a unique match. Default false." },
    heading: {
      type: "string",
      description:
        'edit_section: the heading text as shown in read_md\'s outline. Accepts a breadcrumb such as "Guide > Install" ' +
        'or an occurrence index such as "Notes#2" when the text is not unique.',
    },
    expect_sha: {
      type: "string",
      description:
        "The file's current 40-character git blob SHA, from read_md or list_md. REQUIRED for delete and for " +
        'write mode="overwrite" — the two operations that destroy a whole file. Optional elsewhere as a staleness guard.',
    },
  },
  required: ["op", "path"],
  additionalProperties: false,
};

const REPO_PROP = {
  type: "string",
  description:
    'Which repository to act on — the bare name ("notes") or "owner/name". Required: there is no default repository. ' +
    "A bare name is resolved against the repositories this connection's token can see.",
};

export const TOOLS = [
  {
    name: "overview",
    title: "Repository overview",
    description:
      "Orient yourself in a repository in ONE call: its root INDEX.md verbatim, plus every file path with its size. Read-only. " +
      "Call this first when you start work in a repository — it replaces a list_md plus a read_md of the index, and the index is " +
      "the router that says which file answers which question. Folder-level index files are listed but not inlined; read the ones " +
      "the router points you at with read_md({paths:[...]}).",
    inputSchema: {
      type: "object",
      properties: {
        repo: REPO_PROP,
        max_files: { type: "integer", minimum: 1, maximum: 2000, description: "Cap on paths listed. Default 1000." },
      },
      required: ["repo"],
      additionalProperties: false,
    },
    annotations: { title: "Repository overview", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "list_md",
    title: "List markdown files",
    description:
      "List every .md file in a repository, with byte size and git blob SHA. Read-only. " +
      "The blob SHA shown is exactly what that file's expect_sha takes in commit_edits, so a file can be deleted straight from this listing with no content read. " +
      "Pass outline:true on a narrowed listing to see each file's headings without reading it.",
    inputSchema: {
      type: "object",
      properties: {
        repo: REPO_PROP,
        path_prefix: { type: "string", description: 'Repo-relative directory prefix to filter by, e.g. "docs/". Empty lists the whole repository.' },
        max_results: { type: "integer", minimum: 1, maximum: 2000, description: "Maximum files to list. Default 500." },
        outline: {
          type: "boolean",
          description:
            `Also return each file's heading outline. Costs one read per file, so it is refused above ${OUTLINE_MAX_FILES} files — ` +
            "narrow with path_prefix or max_results first. Default false.",
        },
      },
      required: ["repo"],
      additionalProperties: false,
    },
    annotations: { title: "List markdown files", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "read_md",
    title: "Read markdown file",
    description:
      "Return the exact text of one or several .md files, each with its git blob SHA and an outline of its headings with line " +
      "ranges. Read-only. Prefer paths:[...] over several calls — reading five folder indexes costs one round trip instead of five. " +
      "Content comes back without line-number gutters, so any span copied out of it matches the file byte for byte and can be pasted straight into old_string.",
    inputSchema: {
      type: "object",
      properties: {
        repo: REPO_PROP,
        path: { type: "string", description: 'Repo-relative path to a .md file, e.g. "docs/guide.md". No leading slash.' },
        paths: {
          type: "array",
          minItems: 1,
          maxItems: 20,
          items: { type: "string" },
          description:
            "Read several files in one call. Supply INSTEAD of path, never alongside it. max_bytes is then a budget shared across " +
            "the whole batch, spent in this order. A path that does not exist reports its own error and the others still return.",
        },
        offset_lines: { type: "integer", minimum: 1, description: "1-based line to start the returned window at. Default 1. Single path only." },
        max_bytes: { type: "integer", minimum: 1000, maximum: 120000, description: "Byte cap on the returned window, or on the whole batch. Default 100000." },
      },
      required: ["repo"],
      additionalProperties: false,
    },
    annotations: { title: "Read markdown file", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "history",
    title: "Commit history",
    description:
      "List recent commits, newest first, with who authored each one and when. Pass a path to get only the commits that touched " +
      "that file. Read-only. Authors are real GitHub accounts, so this answers who changed what. Use show_commit with a sha from " +
      "here to see the actual diff.",
    inputSchema: {
      type: "object",
      properties: {
        repo: REPO_PROP,
        path: {
          type: "string",
          description:
            'Optional repo-relative path — a file ("docs/guide.md") or a directory ("docs"). Omit for the whole repository. ' +
            "Does not follow renames: commits from before a rename are listed under the old path.",
        },
        limit: { type: "integer", minimum: 1, maximum: 100, description: "How many commits to return. Default 20." },
      },
      required: ["repo"],
      additionalProperties: false,
    },
    annotations: { title: "Commit history", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "show_commit",
    title: "Show a commit diff",
    description:
      "Show one commit: its author, date, full message, and the diff of every file it changed. Read-only. Take the sha from history().",
    inputSchema: {
      type: "object",
      properties: {
        repo: REPO_PROP,
        sha: { type: "string", description: "The commit SHA, full or abbreviated (at least 7 hex characters)." },
      },
      required: ["repo", "sha"],
      additionalProperties: false,
    },
    annotations: { title: "Show a commit diff", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "commit_edits",
    title: "Commit markdown edits",
    description:
      "Apply an ordered list of markdown edits and push them as EXACTLY ONE commit. This is the only tool that edits markdown. " +
      "Either every operation succeeds and one commit is created, or nothing is sent to GitHub at all — this server holds no staging area, " +
      "and a file is unchanged until this call returns a commit SHA. Batch as much as you can into a single call: several files and " +
      "several operations per file land in one commit. Operations apply in array order against one working copy per path, so a later " +
      "operation sees the result of an earlier one. Every path must end in .md.",
    inputSchema: {
      type: "object",
      properties: {
        repo: REPO_PROP,
        message: { type: "string", minLength: 1, maxLength: 2000, description: "The commit message." },
        edits: { type: "array", minItems: 1, maxItems: 100, items: EDIT_ITEM_SCHEMA, description: "Operations applied in array order." },
        retry_ref: {
          type: "string",
          description: "Resend a batch this server retained after a failed commit_edits. Supply INSTEAD of edits, never alongside it.",
        },
      },
      required: ["repo", "message"],
      additionalProperties: false,
    },
    annotations: { title: "Commit markdown edits", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "create_repo",
    title: "Create a repository",
    description:
      "Create a new repository under the account this connection's token belongs to, and seed it with its own INDEX.md carrying " +
      "the overview you give. The result names the repository GitHub actually created. " +
      "Every repository is self-describing: there is no global registry file, so the overview belongs in the new repo's own index. " +
      "The repository is reachable immediately — pass repo:\"<name>\" to the other tools, with no reconfiguration. " +
      "This makes two separate changes on GitHub (the repository, then its first commit) and reports them separately, because they " +
      "cannot be one transaction.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: 'The repository name, without the owner. Letters, digits, ".", "-" and "_".' },
        overview: {
          type: "string",
          description:
            "What this repository is for, in markdown. Becomes the body of its INDEX.md under an H1 of the repo name, so write it " +
            "as the document a reader lands on first — what lives here and where to go next — not as a one-line summary.",
        },
        description: { type: "string", description: "GitHub's own repo description field, shown on the repo page. Defaults to the overview's first line. Capped at 350 characters." },
        private: { type: "boolean", description: "Default true. Pass false only for a repository that should be world-readable." },
      },
      required: ["name", "overview"],
      additionalProperties: false,
    },
    annotations: { title: "Create a repository", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
];

const INSTRUCTIONS =
  "Markdown editing for GitHub repositories. Start work in a repository by calling overview(repo) — it returns that repository's " +
  "own INDEX.md router plus every file path, which is what tells you where anything is. Then read with read_md and list_md; change " +
  "markdown with commit_edits, which always produces exactly one commit; make a new repository with create_repo. " +
  "There is no staging area and nothing is ever " +
  "queued: an edit exists only once commit_edits returns a commit SHA. Prefer one commit_edits call carrying every change you intend, " +
  "rather than one call per file, and prefer read_md({paths:[...]}) over one call per file. " +
  "For surgical changes use str_replace (exact text) or edit_section (addressed by heading) rather than rewriting a whole file. " +
  "expect_sha is required wherever an operation destroys a whole file — delete, and write with mode=overwrite. " +
  "Every tool except create_repo REQUIRES a repo argument and there is no default repository, so name the one you were asked to " +
  "work in. Each repository documents itself in its own root INDEX.md — there is no cross-repository index — so when you create or " +
  "restructure one, that file is what you keep current.";

/* ---------------- helpers ---------------- */

const text = (s: string) => ({ content: [{ type: "text", text: s }] });
const toolError = (s: string) => ({ content: [{ type: "text", text: s }], isError: true });

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/** claude.ai silently truncates a tool result around 150k characters. Silent truncation reads
    as "that was everything", so cap below it and say so. Per-item caps bound the pieces; this
    bounds the whole, including headers and notes. */
const RESULT_CAP = 100_000;
const capResult = (s: string) =>
  s.length <= RESULT_CAP ? s : s.slice(0, RESULT_CAP) + `\n\n… output truncated at ${RESULT_CAP} characters; narrow the request (fewer commits, or a path filter).`;

function str(v: unknown, field: string): string {
  if (typeof v !== "string") throw new ToolError(`${field} must be a string.`);
  return v;
}

/** Normalize the flat wire shape into the discriminated Edit union, enforcing the
    per-op requirements the flat schema cannot express. */
const EDIT_KEYS = new Set(["op", "path", "content", "mode", "old_string", "new_string", "replace_all", "heading", "expect_sha"]);

function coerceEdit(raw: unknown, i: number): Edit {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ToolError(`edits[${i}] must be an object.`);
  const e = raw as Record<string, unknown>;
  // additionalProperties:false is advertised in the schema, and nothing validates it for us:
  // claude.ai does not enforce server-side schemas, so a stray key would be silently dropped.
  const unknown = Object.keys(e).filter((k) => !EDIT_KEYS.has(k));
  if (unknown.length) throw new ToolError(`edits[${i}] has unknown field(s): ${unknown.join(", ")}. Allowed: ${[...EDIT_KEYS].join(", ")}.`);
  const op = e.op;
  const path = str(e.path, `edits[${i}].path`);
  const sha = e.expect_sha === undefined ? undefined : str(e.expect_sha, `edits[${i}].expect_sha`);
  if (sha !== undefined && !/^[0-9a-f]{40}$/.test(sha)) {
    throw new ToolError(`edits[${i}].expect_sha must be a 40-character git blob SHA (got "${sha}").`);
  }

  if (op === "write") {
    // `?? "create"` would let an explicit null mean create, unlike every neighbouring check.
    const mode = (e.mode === undefined ? "create" : e.mode) as string;
    if (!["create", "overwrite", "append"].includes(mode)) {
      throw new ToolError(`edits[${i}]: op=write takes mode "create", "overwrite" or "append" (got ${JSON.stringify(e.mode)}).`);
    }
    // expect_sha is required wherever an op destroys a whole file. Enforced here AND in
    // shaGuard: a single layer means deleting one guard silently permits a blind overwrite.
    if (mode === "overwrite" && !sha) {
      throw new ToolError(
        `edits[${i}]: write mode="overwrite" requires expect_sha (the file's current blob SHA, from read_md or list_md). ` +
          `Refusing to replace a whole file that was not observed.`
      );
    }
    return { op: "write", path, content: str(e.content, `edits[${i}].content`), mode: mode as any, expect_sha: sha };
  }
  if (op === "str_replace") {
    return {
      op: "str_replace",
      path,
      old_string: str(e.old_string, `edits[${i}].old_string`),
      new_string: str(e.new_string, `edits[${i}].new_string`),
      replace_all: e.replace_all === true,
      expect_sha: sha,
    };
  }
  if (op === "edit_section") {
    const mode = e.mode as string;
    if (!["replace", "append", "prepend", "delete"].includes(mode)) {
      throw new ToolError(`edits[${i}]: op=edit_section takes mode "replace", "append", "prepend" or "delete" (got ${JSON.stringify(e.mode)}).`);
    }
    return {
      op: "edit_section",
      path,
      heading: str(e.heading, `edits[${i}].heading`),
      mode: mode as any,
      content: e.content === undefined ? undefined : str(e.content, `edits[${i}].content`),
      expect_sha: sha,
    };
  }
  if (op === "delete") {
    if (!sha) {
      throw new ToolError(
        `edits[${i}]: delete requires expect_sha (the file's current blob SHA, returned by read_md and list_md). ` +
          `Refusing to delete a file that was not observed.`
      );
    }
    return { op: "delete", path, expect_sha: sha };
  }
  throw new ToolError(`edits[${i}].op must be one of write, str_replace, edit_section, delete (got ${JSON.stringify(op)}).`);
}

/* ---------------- tool execution ---------------- */

async function callTool(user: User, name: string, args: Record<string, unknown>) {
  // create_repo is the one tool that does not act on an existing repository, so it is the one
  // tool that does not take a repo argument.
  if (name === "create_repo") return createRepoTool(user, args);

  const ctx = await resolveRepo(user, args.repo);

  if (name === "overview") {
    const max = typeof args.max_files === "number" ? Math.min(2000, Math.max(1, Math.floor(args.max_files))) : 1000;
    const r = await overview(ctx, max);
    const kb = (n: number) => (n < 1024 ? `${n} B` : `${Math.round(n / 1024)} KB`);
    let out = `${ctx.repo} on ${r.branch} — ${r.total} file(s), ${r.markdown} markdown, ${kb(r.bytes)} total`;
    if (r.truncated) out += ` (GitHub truncated the tree; some paths are missing)`;
    if (r.files.length < r.total) out += `\nshowing ${r.files.length} of ${r.total} paths — raise max_files for the rest`;

    out += r.index
      ? `\n\n--- ${r.index.path} ---\n${r.index.text}`
      : `\n\n(no INDEX.md, index.md or README.md at the repository root — there is no router, so the file list below is all the structure there is)`;

    // Sizes are here so the next call can avoid a 124 KB file it did not need. The widest path
    // sets the column, so the numbers stay readable rather than ragged.
    const w = Math.max(4, ...r.files.map((f) => f.path.length));
    out += `\n\n--- every file ---\n${r.files.map((f) => `${f.path.padEnd(w)}  ${String(f.size).padStart(7)}${f.md ? "" : "  (not markdown)"}`).join("\n")}`;
    return text(capResult(out) + ledger(user.id));
  }

  if (name === "list_md") {
    const prefix = args.path_prefix === undefined ? "" : str(args.path_prefix, "path_prefix");
    const max = typeof args.max_results === "number" ? Math.min(2000, Math.max(1, args.max_results)) : 500;
    const r = await listMd(ctx, prefix, max);
    if (!r.files.length) {
      return text(`No .md files${prefix ? ` under "${prefix}"` : ""} in ${ctx.repo} on ${r.branch}.` + ledger(user.id));
    }

    let outlines: Map<string, string[] | null> | null = null;
    if (args.outline === true) {
      if (r.files.length > OUTLINE_MAX_FILES) {
        throw new ToolError(
          `outline:true would read ${r.files.length} files; the limit is ${OUTLINE_MAX_FILES}. ` +
            `Narrow with path_prefix or max_results, or drop outline and read the ones you want with read_md({paths:[...]}).`
        );
      }
      outlines = await outlinesFor(ctx, r.files);
    }

    const rows = r.files
      .map((f) => {
        const row = `${f.sha}  ${String(f.size ?? 0).padStart(7)}  ${f.path}`;
        if (!outlines) return row;
        const o = outlines.get(f.path);
        if (o === null || o === undefined) return `${row}\n    (outline unavailable — too large or unreadable)`;
        return o.length ? `${row}\n${o.map((l) => "  " + l).join("\n")}` : `${row}\n    (no headings)`;
      })
      .join("\n");
    let head = `${ctx.repo} on ${r.branch} — ${r.total} markdown file(s)`;
    if (r.files.length < r.total) head += `, showing ${r.files.length}`;
    if (r.truncated) head += ` (GitHub truncated the tree; narrow with path_prefix for a complete list)`;
    return text(capResult(`${head}\n\nblob sha                                    bytes  path\n${rows}`) + ledger(user.id));
  }

  if (name === "read_md") {
    const maxBytes = typeof args.max_bytes === "number" ? Math.min(120000, Math.max(1000, args.max_bytes)) : 100000;
    const many = args.paths !== undefined;
    if (many && args.path !== undefined) throw new ToolError("Supply either path or paths, not both.");

    if (!many) {
      const path = validatePath(args.path);
      const offset = typeof args.offset_lines === "number" ? Math.max(1, args.offset_lines) : 1;
      const r = await readMd(ctx, path, offset, maxBytes);
      let out = `${ctx.repo}/${path} on ${r.branch}\nblob sha: ${r.sha}\nlines: ${r.totalLines}`;
      if (r.unclosedFence !== null) out += `\nwarning: an unclosed code fence opens at line ${r.unclosedFence + 1}; headings after it are not addressable by edit_section`;
      if (r.outline.length) out += `\n\noutline:\n${r.outline.join("\n")}`;
      out += `\n\n--- content (from line ${r.startLine}) ---\n${r.content}`;
      if (r.clipped) out += `\n--- truncated at max_bytes; continue with offset_lines ---`;
      return text(out + ledger(user.id));
    }

    if (!Array.isArray(args.paths) || !args.paths.length) throw new ToolError("paths must be a non-empty array of repo-relative .md paths.");
    if (args.paths.length > 20) throw new ToolError(`paths has ${args.paths.length} entries; the maximum is 20.`);
    if (args.offset_lines !== undefined) throw new ToolError("offset_lines applies to a single path. Read that one file on its own to page through it.");
    const paths = args.paths.map((p) => validatePath(p));
    const dupes = paths.filter((p, i) => paths.indexOf(p) !== i);
    if (dupes.length) throw new ToolError(`paths lists ${dupes[0]} more than once.`);

    const r = await readMany(ctx, paths, maxBytes);
    const parts = r.results.map((f) => {
      if (!f.ok) return `=== ${f.path} ===\nerror: ${f.error}`;
      let out = `=== ${f.path} (blob ${f.sha}, ${f.win.totalLines} lines) ===`;
      if (f.win.unclosedFence !== null) out += `\nwarning: an unclosed code fence opens at line ${f.win.unclosedFence + 1}; headings after it are not addressable by edit_section`;
      if (f.win.outline.length) out += `\noutline:\n${f.win.outline.join("\n")}`;
      out += `\n\n--- content ---\n${f.win.content}`;
      if (f.win.clipped) out += `\n--- truncated; read this file on its own for the rest ---`;
      return out;
    });
    const failed = r.results.filter((f) => !f.ok).length;
    let head = `${ctx.repo} on ${r.branch} — ${r.results.length - failed} of ${r.results.length} file(s) returned`;
    if (failed) head += `; ${failed} could not be read (each says why below)`;
    return text(capResult(`${head}\n\n${parts.join("\n\n")}`) + ledger(user.id));
  }

  if (name === "history") {
    // Deliberately NOT validatePath: history is read-only, and directory or non-markdown
    // filters are exactly what "who changed what" questions are made of.
    const path = args.path === undefined ? undefined : validateReadPath(args.path);
    const limit = typeof args.limit === "number" && Number.isFinite(args.limit) ? Math.min(100, Math.max(1, Math.floor(args.limit))) : 20;
    const r = await history(ctx, path, limit);
    if (!r.commits.length) return text(`No commits${path ? ` touching ${path}` : ""} on ${r.branch} in ${ctx.repo}.` + ledger(user.id));
    const rows = r.commits
      .map((c) => `${c.sha.slice(0, 7)}  ${(c.date || "").slice(0, 10)}  ${clip(c.author, 20).padEnd(20)}  ${clip(c.message, 100)}`)
      .join("\n");
    let out =
      `${ctx.repo} on ${r.branch}${path ? ` — commits touching ${path}` : ""} (${r.commits.length}, newest first)\n\n` +
      `sha      date        author                message\n${rows}\n\n` +
      `Use show_commit with a sha to see the diff.`;
    if (path) out += `\nNote: this follows the path as it is named now; commits from before a rename are listed under the old path.`;
    return text(capResult(out) + ledger(user.id));
  }

  if (name === "show_commit") {
    const c = await showCommit(ctx, str(args.sha, "sha"));
    let out = `commit ${c.sha} in ${ctx.repo}\nauthor: ${c.author}${c.email ? ` <${c.email}>` : ""}\ndate:   ${c.date}\n\n${c.message}`;
    if (c.messageClipped) out += `\n… message truncated`;
    out += "\n";
    if (!c.files.length) out += `\n(no file changes visible in this commit)`;
    for (const f of c.files) {
      const renamed = f.previousFilename ? ` from ${f.previousFilename}` : "";
      out += `\n--- ${f.filename} (${f.status}${renamed}, +${f.additions} -${f.deletions}) ---\n`;
      // "no textual diff" and "truncated" are different facts and must not both be claimed.
      if (f.patch) out += f.patch;
      else if (f.clipped) out += "(diff omitted — this commit's total diff budget was spent)";
      else if (f.noDiff) out += "(no textual diff: binary file, a pure rename, or too large for GitHub to diff)";
      else out += "(empty diff)";
      if (f.clipped && f.patch) out += `\n… diff truncated; read_md("${f.filename}") for the current full text`;
      out += "\n";
    }
    const notes: string[] = [];
    if (c.filesShown < c.filesTotal) notes.push(`showing ${c.filesShown} of ${c.filesTotal} changed files`);
    if (c.pagedByGitHub) notes.push(`GitHub returned only the first ${c.files.length ? 300 : 0} files of this commit${c.totalChanges ? ` (${c.totalChanges} total line changes)` : ""}`);
    if (notes.length) out += `\n${notes.map((n) => `note: ${n}`).join("\n")}`;
    return text(capResult(out) + ledger(user.id));
  }

  if (name === "commit_edits") {
    const message = str(args.message, "message");
    // The schema advertises these bounds; nothing else enforces them.
    if (!message.trim()) throw new ToolError("message must not be empty — GitHub rejects a commit with no message.");
    if (message.length > 2000) throw new ToolError(`message is ${message.length} characters; the maximum is 2000.`);
    const hasRef = typeof args.retry_ref === "string" && args.retry_ref;
    const hasEdits = Array.isArray(args.edits);
    if (hasRef && hasEdits) throw new ToolError("Supply either edits or retry_ref, not both.");

    let edits: Edit[];
    if (hasRef) {
      const held = lastFailure.get(user.id);
      if (!held || held.ref !== args.retry_ref) {
        throw new ToolError(`No retained batch matches retry_ref "${String(args.retry_ref)}" — it may have expired, already succeeded, or been dropped by a restart.`);
      }
      // A batch was authored against one repository's content. Replaying it into another would
      // apply edits built from text that repo has never contained.
      if (held.repo !== ctx.repo) {
        throw new ToolError(
          `retry_ref ${held.ref} holds a batch built against ${held.repo}, not ${ctx.repo}. ` +
            `Resend it with repo:"${held.repo.split("/")[1]}", or rebuild the edits against ${ctx.repo}.`
        );
      }
      edits = held.edits;
    } else {
      if (!hasEdits || !(args.edits as unknown[]).length) throw new ToolError("edits must be a non-empty array (or supply retry_ref).");
      if ((args.edits as unknown[]).length > 100) {
        throw new ToolError(`edits has ${(args.edits as unknown[]).length} operations; the maximum is 100. Split this into several commits.`);
      }
      edits = (args.edits as unknown[]).map(coerceEdit);
    }

    for (const e of edits) validatePath(e.path);

    let result;
    try {
      result = await commitEdits(ctx, message, edits);
    } catch (err) {
      if (!(err instanceof ToolError || err instanceof EditError)) throw err;
      const reason = err.message;
      // Retention exists so a large batch need not be retyped. A batch that can never succeed
      // as-sent gets no ref: offering to resend it would only produce the same failure.
      if (/No effective changes/i.test(reason)) return toolError(reason + ledger(user.id));
      const ref = `r_${randomBytes(3).toString("hex")}`;
      lastFailure.set(user.id, { ref, repo: ctx.repo, message, edits, failedAt: Date.now(), reason: reason.split("\n")[0]!.slice(0, 160) });
      return toolError(`${reason}\n\nThis batch is held as retry_ref ${ref} — resend it unchanged with commit_edits({message, retry_ref:"${ref}"}) once the cause is fixed.` + ledger(user.id));
    }

    lastFailure.delete(user.id);
    // Keyed by repo as well as person: working across two repositories is not the same as
    // dribbling one-file commits into one, and should not be nudged as if it were.
    const key = `${user.id}|${ctx.repo}`;
    const times = (commitTimes.get(key) || []).filter((t) => Date.now() - t < 10 * 60_000);
    times.push(Date.now());
    commitTimes.set(key, times);

    let out = `Committed ${result.sha.slice(0, 7)} to ${ctx.repo}@${result.branch}\n${result.url}`;
    if (result.changed.length) out += `\n\nchanged (${result.changed.length}): ${result.changed.join(", ")}`;
    if (result.deleted.length) out += `\ndeleted (${result.deleted.length}): ${result.deleted.join(", ")}`;
    if (result.notes.length) out += `\n\n${result.notes.map((n) => `• ${n}`).join("\n")}`;
    if (result.warnings.length) out += `\n\nwarn: ${result.warnings.join("; ")}`;

    const touched = result.changed.length + result.deleted.length;
    if (times.length >= 3 && touched === 1) {
      const span = Math.max(1, Math.round((Date.now() - times[0]!) / 60_000));
      out +=
        `\n\nNOTE: ${times.length} commits in ${span}m, this one touching a single file. ` +
        `commit_edits takes an edits array — several files and several operations per file land in one commit.`;
    }
    return text(out + ledger(user.id));
  }

  return null; // unknown tool -> caller emits a protocol error
}

async function createRepoTool(user: User, args: Record<string, unknown>) {
  const name = str(args.name, "name");
  if (!REPO_NAME_RE.test(name) || name.length > 100) {
    throw new ToolError(`"${name}" is not a valid repository name. Use letters, digits, ".", "-" and "_", starting with a letter or digit, up to 100 characters.`);
  }
  const overview = str(args.overview, "overview");
  if (!overview.trim()) throw new ToolError("overview must not be empty — it becomes the body of the new repository's INDEX.md.");
  if (overview.length > 20000) throw new ToolError(`overview is ${overview.length} characters; the maximum is 20000.`);
  const description = args.description === undefined ? overview.split("\n").find((l) => l.trim()) || name : str(args.description, "description");
  const isPrivate = args.private === undefined ? true : args.private === true;

  // No repo exists yet, so this Ctx exists only to carry the PAT.
  const ctx: Ctx = { id: user.id, pat: user.pat, repo: "(new repository)" };
  const r = await createRepo(ctx, name, overview, description, isPrivate);
  // The account is GitHub's answer, not a configured guess: a token that collaborates on someone
  // else's repos still creates new ones in its OWN account, and saying which is the point.
  let out = `Created ${r.repo} (${r.private ? "private" : "public"})\n${r.url}`;
  if (r.seeded) {
    out +=
      `\n\nSeeded ${r.seeded.path} on ${r.branch} in commit ${r.seeded.sha.slice(0, 7)}\n${r.seeded.url}\n\n` +
      `Reachable now: pass repo:"${name}" to list_md, read_md, history, show_commit and commit_edits. No reconfiguration is needed.`;
  } else {
    out +=
      `\n\nThe repository exists but is EMPTY: its INDEX.md could not be written.\n${r.seedError}\n\n` +
      `Nothing else was changed and the repository was not deleted. Finish it with a single call:\n` +
      `commit_edits({repo:"${name}", message:"Add INDEX.md", edits:[{op:"write", path:"INDEX.md", content:"# ${name}\\n\\n…"}]})`;
  }
  return text(out + ledger(user.id));
}

/** The default repository's own index, delivered in the handshake. This is the whole of the
    cold-start fix: it lands before the model's first tool call, so orientation costs zero round
    trips instead of a list_md plus a read_md.

    Best-effort by construction. A slow or rate-limited GitHub must never fail `initialize` —
    that would brick the connector entirely rather than merely leaving it uninformed. */
/* ---------------- JSON-RPC ---------------- */

const rpcError = (id: unknown, code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });
const rpcOk = (id: unknown, result: unknown) => ({ jsonrpc: "2.0", id, result });

/** Returns null for notifications (caller answers 202 with an empty body). */
export async function handleMessage(user: User, msg: any): Promise<object | null> {
  if (!msg || typeof msg !== "object" || Array.isArray(msg) || msg.jsonrpc !== "2.0") return rpcError(null, -32600, "Invalid Request");
  const { id, method } = msg;
  if (typeof method !== "string") return rpcError(id ?? null, -32600, "Invalid Request: method must be a string");
  if (id !== undefined && id !== null && typeof id !== "string" && typeof id !== "number") {
    return rpcError(null, -32600, "Invalid Request: id must be a string or number");
  }

  // A notification is fire-and-forget and MAY be retried by the client, so it must never
  // perform a write and must never get a response. Decided by the absence of `id` alone —
  // keying off the method name both executed id-less tools/call and hung real requests whose
  // method merely started with "notifications/".
  const isNotification = !("id" in msg) || msg.id === undefined;
  if (isNotification) return null;

  if (method === "initialize") {
    const asked = msg.params?.protocolVersion;
    // Never error on an unknown version: a future claude.ai bump must not brick the connector.
    const version = KNOWN_VERSIONS.includes(asked) ? asked : FALLBACK_VERSION;
    return rpcOk(id, {
      protocolVersion: version,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "md-github", version: "3.0.0" },
      // Static, and deliberately so: nothing here can name a repository, because a connection is
      // not bound to one. overview(repo) is what delivers a repository's own router, when asked.
      instructions: INSTRUCTIONS,
    });
  }

  if (method === "ping") return rpcOk(id, {});

  if (method === "tools/list") return rpcOk(id, { tools: TOOLS });

  if (method === "tools/call") {
    const name = msg.params?.name;
    const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
    if (!TOOLS.some((t) => t.name === name)) {
      return rpcError(id, -32602, `Unknown tool "${String(name)}". Available: ${TOOLS.map((t) => t.name).join(", ")}.`);
    }
    try {
      const r = await callTool(user, name, args);
      return rpcOk(id, r);
    } catch (err) {
      // SEP-1303: everything the model could fix is a TOOL error, not a protocol error.
      // The repo argument may itself be what failed, so the footer is built without a ctx.
      if (err instanceof ToolError || err instanceof EditError) return rpcOk(id, toolError(err.message + ledger(user.id)));
      console.error("tools/call failed:", err);
      return rpcOk(id, toolError(`The server hit an unexpected error: ${err instanceof Error ? err.message : String(err)}` + ledger(user.id)));
    }
  }

  return rpcError(id, -32601, `Method not found: ${method}`);
}
