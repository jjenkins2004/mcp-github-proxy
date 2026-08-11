// Stateful in-process fake of GitHub's REST API, for the smoke tests.
// Zero dependencies, ESM, node:http + node:crypto only. Node 22+.
//
//   node fake-github.mjs             # demo repo on http://127.0.0.1:8899
//   node fake-github.mjs --selftest  # exercises the whole write path
//
//   import { startFakeGitHub } from "./fake-github.mjs";
//   const gh = startFakeGitHub({ port: 8899 });   // await gh.ready if port === 0
//
// It models real git objects (content-addressed blobs, trees, commits, refs) so a
// write made through the API is observable by a later read through the same stub.
// Blob shas are the REAL git blob sha; tree and commit shas are synthetic but
// stable 40-hex values.
import { createHash } from "node:crypto";
import { createServer } from "node:http";

const sha1 = (data) => createHash("sha1").update(data).digest("hex");

/** The genuine git blob sha: sha1("blob " + bytelen + "\0" + bytes). */
export const gitBlobSha = (bytes) =>
  sha1(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`, "utf8"), bytes]));

/** GitHub wraps base64 payloads at 60 chars with a trailing newline. */
const wrap60 = (b64) => (b64 === "" ? "" : b64.match(/.{1,60}/g).join("\n") + "\n");

const byPath = (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
const isRawAccept = (accept) => /application\/vnd\.github(\.v3)?\.raw/.test(accept || "");
const stripRef = (r) => String(r).replace(/^refs\//, "").replace(/^heads\//, "");

// ---------------------------------------------------------------- object store

function createStore() {
  const blobs = new Map(); // sha -> Buffer
  const trees = new Map(); // sha -> [{path, mode, type:"blob", sha}] FLAT, paths relative to this tree
  const commits = new Map(); // sha -> {sha, message, tree, parents:[sha]}
  const repos = new Map(); // "owner/name" -> {name, owner, full_name, defaultBranch, permissions, empty, refs}
  let seq = 0;

  const putBlob = (bytes) => {
    const buf = Buffer.isBuffer(bytes) ? Buffer.from(bytes) : Buffer.from(String(bytes), "utf8");
    const sha = gitBlobSha(buf);
    blobs.set(sha, buf);
    return sha;
  };

  // Stores the tree flat, and materializes a subtree object for every directory
  // prefix so GET /git/trees/<dirSha> can walk one level at a time.
  const putTree = (entries) => {
    const norm = entries
      .map((e) => ({ path: e.path, mode: e.mode || "100644", type: "blob", sha: e.sha }))
      .sort(byPath);
    const sha = sha1(JSON.stringify(norm));
    if (!trees.has(sha)) {
      trees.set(sha, norm);
      const byDir = new Map();
      for (const e of norm) {
        const i = e.path.indexOf("/");
        if (i === -1) continue;
        const dir = e.path.slice(0, i);
        if (!byDir.has(dir)) byDir.set(dir, []);
        byDir.get(dir).push({ ...e, path: e.path.slice(i + 1) });
      }
      for (const sub of byDir.values()) putTree(sub);
    }
    return sha;
  };

  const putCommit = ({ message, tree, parents = [] }) => {
    const sha = sha1(JSON.stringify({ message, tree, parents, n: ++seq }));
    const commit = { sha, message: String(message ?? ""), tree, parents: [...parents] };
    commits.set(sha, commit);
    return commit;
  };

  const ensureRepo = (full, defaultBranch = "main") => {
    if (!repos.has(full)) {
      const [owner, name] = full.split("/");
      repos.set(full, {
        owner,
        name,
        full_name: full,
        defaultBranch,
        permissions: { admin: false, push: true, pull: true },
        empty: false,
        refs: new Map(), // "heads/main" -> commit sha
      });
    }
    return repos.get(full);
  };

  const headSha = (full, branch) => {
    const repo = repos.get(full);
    if (!repo) return null;
    return repo.refs.get(`heads/${branch || repo.defaultBranch}`) || null;
  };

  const headCommit = (full, branch) => {
    const sha = headSha(full, branch);
    return sha ? commits.get(sha) : null;
  };

  /** Accepts a tree sha, a commit sha, or a branch name. Returns a tree sha. */
  const resolveTree = (full, ref) => {
    if (!ref) return null;
    if (trees.has(ref)) return ref;
    if (commits.has(ref)) return commits.get(ref).tree;
    const sha = headSha(full, stripRef(ref));
    return sha ? commits.get(sha).tree : null;
  };

  const treeEntries = (treeSha) => trees.get(treeSha) || [];

  const blobEntry = (e) => ({
    path: e.path,
    mode: e.mode,
    type: "blob",
    sha: e.sha,
    size: (blobs.get(e.sha) || Buffer.alloc(0)).length,
  });

  /** One level only: files here, plus synthesized type:"tree" entries per directory. */
  const levelEntries = (treeSha) => {
    const out = [];
    const byDir = new Map();
    for (const e of treeEntries(treeSha)) {
      const i = e.path.indexOf("/");
      if (i === -1) {
        out.push(blobEntry(e));
        continue;
      }
      const dir = e.path.slice(0, i);
      if (!byDir.has(dir)) byDir.set(dir, []);
      byDir.get(dir).push({ ...e, path: e.path.slice(i + 1) });
    }
    for (const [dir, sub] of byDir) out.push({ path: dir, mode: "040000", type: "tree", sha: putTree(sub) });
    return out.sort(byPath);
  };

  const readFile = (full, path, ref) => {
    const treeSha = resolveTree(full, ref || (repos.get(full) || {}).defaultBranch);
    if (!treeSha) return undefined;
    const entry = treeEntries(treeSha).find((e) => e.path === path);
    if (!entry) return undefined;
    return blobs.get(entry.sha).toString("utf8");
  };

  /** Commits straight to the branch, bypassing the API — a third party pushing. */
  const externalEdit = (full, path, content, branch) => {
    const repo = ensureRepo(full);
    const br = branch || repo.defaultBranch;
    const parent = headSha(full, br);
    const base = parent ? treeEntries(commits.get(parent).tree) : [];
    const next = base.filter((e) => e.path !== path);
    if (content !== null && content !== undefined) {
      next.push({ path, mode: "100644", type: "blob", sha: putBlob(content) });
    }
    const commit = putCommit({
      message: `external edit: ${path}`,
      tree: putTree(next),
      parents: parent ? [parent] : [],
    });
    repo.refs.set(`heads/${br}`, commit.sha);
    repo.empty = false;
    return commit;
  };

  const seed = (full, { files = {}, defaultBranch = "main" } = {}) => {
    const repo = ensureRepo(full, defaultBranch);
    repo.defaultBranch = defaultBranch;
    repo.refs.clear();
    const fileShas = {};
    const entries = [];
    for (const [path, content] of Object.entries(files)) {
      const sha = putBlob(content);
      fileShas[path] = sha;
      entries.push({ path, mode: "100644", type: "blob", sha });
    }
    if (entries.length === 0) {
      repo.empty = true;
      return { repo: full, defaultBranch, empty: true, files: fileShas, tree: null, commit: null };
    }
    const tree = putTree(entries);
    const commit = putCommit({ message: "seed", tree, parents: [] });
    repo.refs.set(`heads/${defaultBranch}`, commit.sha);
    repo.empty = false;
    return { repo: full, defaultBranch, empty: false, files: fileShas, tree, commit: commit.sha };
  };

  return {
    blobs,
    trees,
    commits,
    repos,
    putBlob,
    putTree,
    putCommit,
    ensureRepo,
    headSha,
    headCommit,
    resolveTree,
    treeEntries,
    levelEntries,
    blobEntry,
    readFile,
    externalEdit,
    seed,
  };
}

// ---------------------------------------------------------------------- server

export function startFakeGitHub({ port = 8899, host = "127.0.0.1" } = {}) {
  const state = createStore();
  const log = [];
  const faults = new Map(); // name -> {times, ...opts}

  const armFault = (name, opts = {}) => {
    const entry = { ...opts, times: opts.persist ? Infinity : (opts.times ?? 1) };
    faults.set(name, entry);
    if (name === "409-empty-repo") {
      const targets = entry.repo ? [state.ensureRepo(entry.repo)] : [...state.repos.values()];
      for (const r of targets) r.empty = true;
    }
    return entry;
  };

  const takeFault = (name) => {
    const f = faults.get(name);
    if (!f) return null;
    if (--f.times <= 0) faults.delete(name);
    return f;
  };

  const json = (res, status, obj, headers = {}) => {
    const body = Buffer.from(JSON.stringify(obj), "utf8");
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": body.length,
      ...headers,
    });
    res.end(body);
  };
  const notFound = (res) => json(res, 404, { message: "Not Found" });
  const unprocessable = (res, message) => json(res, 422, { message });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const rawBody = Buffer.concat(chunks).toString("utf8");
    let body = null;
    try {
      body = rawBody ? JSON.parse(rawBody) : null;
    } catch {
      body = null;
    }
    log.push({
      method: req.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      authorization: req.headers.authorization ?? null,
      accept: req.headers.accept ?? null,
      body,
      rawBody,
    });

    const segs = url.pathname.split("/").filter(Boolean).map((s) => decodeURIComponent(s));
    const method = req.method;
    const isPatchRef = method === "PATCH" && segs[3] === "git" && segs[4] === "refs";

    // Fault gate, consumed in the documented order.
    if (isPatchRef && faults.has("422-once")) {
      const f = takeFault("422-once");
      if (f.thenAdvanceHeadWith) {
        state.externalEdit(
          `${segs[1]}/${segs[2]}`,
          f.thenAdvanceHeadWith.path,
          f.thenAdvanceHeadWith.content,
          stripRef(segs.slice(5).join("/")),
        );
      }
      return unprocessable(res, "Update is not a fast forward");
    }
    if (isPatchRef && faults.has("403-protected")) {
      takeFault("403-protected");
      return json(res, 403, { message: "Changes must be made through a pull request." });
    }
    if (faults.has("401")) {
      takeFault("401");
      return json(res, 401, { message: "Bad credentials" });
    }

    if (segs[0] !== "repos" || segs.length < 3) return notFound(res);
    const full = `${segs[1]}/${segs[2]}`;
    const repo = state.repos.get(full);
    if (!repo) return notFound(res);
    const rest = segs.slice(3);

    // 1. GET /repos/:o/:r
    if (method === "GET" && rest.length === 0) {
      return json(res, 200, {
        name: repo.name,
        full_name: repo.full_name,
        default_branch: repo.defaultBranch,
        permissions: { ...repo.permissions },
      });
    }

    // 2. GET /repos/:o/:r/contents/:path...
    if (method === "GET" && rest[0] === "contents") {
      const path = rest.slice(1).join("/");
      const ref = url.searchParams.get("ref") || repo.defaultBranch;
      const treeSha = state.resolveTree(full, ref);
      const entry = treeSha && state.treeEntries(treeSha).find((e) => e.path === path);
      if (!entry) return notFound(res);
      const bytes = state.blobs.get(entry.sha);
      if (isRawAccept(req.headers.accept)) {
        res.writeHead(200, {
          "Content-Type": "text/plain; charset=utf-8",
          "Content-Length": bytes.length,
          ETag: `"${entry.sha}"`,
        });
        return res.end(bytes);
      }
      return json(res, 200, {
        type: "file",
        path,
        sha: entry.sha,
        size: bytes.length,
        encoding: "base64",
        content: wrap60(bytes.toString("base64")),
      });
    }

    if (rest[0] !== "git") return notFound(res);

    // 3. GET /git/ref/heads/:branch  (SINGULAR)
    if (method === "GET" && rest[1] === "ref") {
      if (repo.empty) return json(res, 409, { message: "Git Repository is empty." });
      const name = rest.slice(2).join("/"); // "heads/main"
      const sha = repo.refs.get(name);
      if (!sha) return notFound(res);
      return json(res, 200, { ref: `refs/${name}`, object: { sha, type: "commit" } });
    }

    // 4/9. commits
    if (rest[1] === "commits") {
      if (method === "GET" && rest.length === 3) {
        const commit = state.commits.get(rest[2]);
        if (!commit) return notFound(res);
        return json(res, 200, {
          sha: commit.sha,
          message: commit.message,
          tree: { sha: commit.tree },
          parents: commit.parents.map((sha) => ({ sha })),
        });
      }
      if (method === "POST" && rest.length === 2) {
        const { message, tree, parents = [] } = body || {};
        if (!tree || !state.trees.has(tree)) return unprocessable(res, "Tree does not exist");
        for (const p of parents) {
          if (!state.commits.has(p)) return unprocessable(res, "Parent commit does not exist");
        }
        const commit = state.putCommit({ message, tree, parents });
        return json(res, 201, {
          sha: commit.sha,
          message: commit.message,
          tree: { sha: commit.tree },
          parents: commit.parents.map((sha) => ({ sha })),
          html_url: `https://github.com/${full}/commit/${commit.sha}`,
        });
      }
    }

    // 5/8. trees
    if (rest[1] === "trees") {
      if (method === "GET" && rest.length >= 3) {
        const input = rest.slice(2).join("/"); // sha, commit sha, or branch name
        const treeSha = state.resolveTree(full, input);
        if (!treeSha) return notFound(res);
        const recursive = url.searchParams.has("recursive") && url.searchParams.get("recursive") !== "0";
        let tree = recursive
          ? state.treeEntries(treeSha).map((e) => state.blobEntry(e))
          : state.levelEntries(treeSha);
        let truncated = false;
        if (recursive && faults.has("truncated-tree")) {
          const f = takeFault("truncated-tree");
          tree = tree.slice(0, Math.max(0, f.keep ?? 1));
          truncated = true;
        }
        // .sha echoes the INPUT verbatim, exactly like the real API.
        return json(res, 200, { sha: input, tree, truncated });
      }

      if (method === "POST" && rest.length === 2) {
        const { base_tree, tree } = body || {};
        if (!Array.isArray(tree)) return unprocessable(res, "Invalid request.\n\ntree is not an array.");
        const merged = new Map(); // path -> entry
        if (base_tree !== undefined && base_tree !== null) {
          if (!state.trees.has(base_tree)) return unprocessable(res, "base_tree is not a tree object");
          for (const e of state.treeEntries(base_tree)) merged.set(e.path, { ...e });
        }
        for (const e of tree) {
          const path = e && e.path;
          if (!path) return unprocessable(res, "Invalid request.\n\ntree entry is missing a path.");
          const hasContent = typeof e.content === "string";
          const hasSha = typeof e.sha === "string";
          if (hasSha && hasContent) {
            return unprocessable(res, "Invalid request.\n\nOnly one of sha or content can be supplied for a tree entry.");
          }
          if (e.sha === null) {
            if (!merged.has(path)) return unprocessable(res, "GitRPC::BadObjectState");
            merged.delete(path);
            continue;
          }
          if (hasContent) {
            merged.set(path, { path, mode: e.mode || "100644", type: "blob", sha: state.putBlob(e.content) });
            continue;
          }
          if (hasSha) {
            if (!state.blobs.has(e.sha)) return unprocessable(res, "GitRPC::BadObjectState");
            merged.set(path, { path, mode: e.mode || "100644", type: "blob", sha: e.sha });
            continue;
          }
          return unprocessable(res, "Invalid request.\n\ntree entry must supply either sha or content.");
        }
        const sha = state.putTree([...merged.values()]);
        return json(res, 201, {
          sha,
          tree: state.treeEntries(sha).map((e) => state.blobEntry(e)),
          truncated: false,
        });
      }
    }

    // 6/7. blobs
    if (rest[1] === "blobs") {
      if (method === "GET" && rest.length === 3) {
        const bytes = state.blobs.get(rest[2]);
        if (!bytes) return notFound(res);
        return json(res, 200, {
          sha: rest[2],
          size: bytes.length,
          encoding: "base64",
          content: wrap60(bytes.toString("base64")),
        });
      }
      if (method === "POST" && rest.length === 2) {
        const { content, encoding = "utf-8" } = body || {};
        if (typeof content !== "string") return unprocessable(res, "Invalid request.\n\ncontent is required.");
        let bytes;
        if (encoding === "base64") bytes = Buffer.from(content.replace(/\s+/g, ""), "base64");
        else if (encoding === "utf-8" || encoding === "utf8") bytes = Buffer.from(content, "utf8");
        else return unprocessable(res, `Invalid request.\n\nunsupported encoding: ${encoding}`);
        const sha = state.putBlob(bytes);
        return json(res, 201, { sha, url: `${url.origin}/repos/${full}/git/blobs/${sha}` });
      }
    }

    // 10/11. refs (PLURAL)
    if (rest[1] === "refs") {
      if (method === "PATCH" && rest.length >= 3) {
        const name = rest.slice(2).join("/"); // "heads/main"
        const current = repo.refs.get(name);
        if (!current) return unprocessable(res, "Reference does not exist");
        const { sha, force } = body || {};
        const commit = state.commits.get(sha);
        if (!commit) return unprocessable(res, "Object does not exist");
        const forced = force === true || force === "true";
        // Compare-and-swap: the new commit must sit directly on top of the ref.
        if (commit.parents[0] !== current && !forced) {
          return unprocessable(res, "Update is not a fast forward");
        }
        repo.refs.set(name, sha);
        repo.empty = false;
        return json(res, 200, { ref: `refs/${name}`, object: { sha, type: "commit" } });
      }
      if (method === "POST" && rest.length === 2) {
        const { ref, sha } = body || {};
        if (typeof ref !== "string" || !ref.startsWith("refs/")) {
          return unprocessable(res, "Reference must be formatted as refs/heads/branch");
        }
        if (!state.commits.has(sha)) return unprocessable(res, "Object does not exist");
        const name = ref.slice("refs/".length);
        if (repo.refs.has(name)) return unprocessable(res, "Reference already exists");
        repo.refs.set(name, sha);
        repo.empty = false;
        return json(res, 201, { ref, object: { sha, type: "commit" } });
      }
    }

    return notFound(res);
  });

  server.listen(port, host);
  const ready = new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });

  return {
    get url() {
      const a = server.address();
      return `http://${host}:${a && typeof a === "object" ? a.port : port}`;
    },
    ready,
    server,
    log,
    state,
    seed: state.seed,
    fault: armFault,
    reset() {
      log.length = 0;
      faults.clear();
    },
    close() {
      return new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      });
    },
  };
}

// ------------------------------------------------------------------- self-test

async function selfTest() {
  const gh = startFakeGitHub({ port: 0 });
  await gh.ready;
  const B = gh.url;
  const REPO = "acme/widgets";
  let pass = 0;
  let total = 0;
  const check = (name, cond) => {
    total++;
    if (cond) pass++;
    console.log(`${cond ? "ok  " : "FAIL"}  ${name}`);
  };
  const README =
    "# widgets\n\nthis readme is deliberately long enough that its base64 wraps past sixty characters.\n";
  const seeded = gh.seed(REPO, {
    files: { "README.md": README, "docs/a.md": "alpha\n", "docs/b.md": "beta\n", "src/keep.txt": "keep\n" },
  });

  // raw read
  const raw = await fetch(`${B}/repos/${REPO}/contents/README.md`, {
    headers: { accept: "application/vnd.github.raw", authorization: "Bearer pat-alice" },
  });
  const rawText = await raw.text();
  check(
    "raw read returns bytes + quoted blob-sha ETag",
    raw.status === 200 &&
      rawText === README &&
      (raw.headers.get("content-type") || "").startsWith("text/plain") &&
      raw.headers.get("etag") === `"${gitBlobSha(Buffer.from(README))}"`,
  );

  // json read
  const meta = await (await fetch(`${B}/repos/${REPO}/contents/README.md`)).json();
  const lines = meta.content.trimEnd().split("\n");
  check(
    "json read is base64 wrapped at 60 and decodes back",
    meta.type === "file" &&
      meta.encoding === "base64" &&
      meta.sha === seeded.files["README.md"] &&
      meta.size === Buffer.byteLength(README) &&
      lines.length > 1 &&
      lines.every((l) => l.length <= 60) &&
      Buffer.from(meta.content.replace(/\s+/g, ""), "base64").toString("utf8") === README,
  );

  // ref + commit + tree reads
  const ref = await (await fetch(`${B}/repos/${REPO}/git/ref/heads/main`)).json();
  check("GET git/ref (singular) returns head", ref.ref === "refs/heads/main" && ref.object.sha === seeded.commit);

  const headCommit = await (await fetch(`${B}/repos/${REPO}/git/commits/${seeded.commit}`)).json();
  check("GET git/commits resolves the tree", headCommit.tree.sha === seeded.tree && headCommit.parents.length === 0);

  const recursive = await (await fetch(`${B}/repos/${REPO}/git/trees/main?recursive=1`)).json();
  check(
    "recursive tree echoes the input in .sha and lists every file",
    recursive.sha === "main" &&
      recursive.truncated === false &&
      recursive.tree.map((e) => e.path).sort().join(",") === "README.md,docs/a.md,docs/b.md,src/keep.txt",
  );

  const level = await (await fetch(`${B}/repos/${REPO}/git/trees/main`)).json();
  const docsDir = level.tree.find((e) => e.path === "docs");
  const docsLevel = await (await fetch(`${B}/repos/${REPO}/git/trees/${docsDir.sha}`)).json();
  check(
    "non-recursive tree walks one level at a time",
    docsDir.type === "tree" &&
      level.tree.filter((e) => e.type === "blob").map((e) => e.path).join(",") === "README.md" &&
      docsLevel.tree.map((e) => e.path).join(",") === "a.md,b.md",
  );

  // write path: blob -> tree(base_tree, content + sha + sha:null) -> commit -> ref
  const NEW = "brand new file\n";
  const blob = await fetch(`${B}/repos/${REPO}/git/blobs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: NEW, encoding: "utf-8" }),
  });
  const blobJson = await blob.json();
  check(
    "POST git/blobs returns the real git blob sha",
    blob.status === 201 && blobJson.sha === gitBlobSha(Buffer.from(NEW)),
  );

  const EDIT = "alpha edited\n";
  const treeRes = await fetch(`${B}/repos/${REPO}/git/trees`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      base_tree: seeded.tree,
      tree: [
        { path: "docs/a.md", mode: "100644", type: "blob", content: EDIT },
        { path: "new.md", mode: "100644", type: "blob", sha: blobJson.sha },
        { path: "docs/b.md", mode: "100644", type: "blob", sha: null },
      ],
    }),
  });
  const newTree = await treeRes.json();
  const paths = newTree.tree.map((e) => e.path);
  check(
    "POST git/trees merges content + sha and applies the sha:null deletion",
    treeRes.status === 201 && !paths.includes("docs/b.md") && paths.includes("new.md") && paths.includes("docs/a.md"),
  );

  const treePost = [...gh.log].reverse().find((e) => e.method === "POST" && e.path.endsWith("/git/trees"));
  check('raw body is logged verbatim, including "sha":null', treePost.rawBody.includes('"sha":null'));

  const commitRes = await fetch(`${B}/repos/${REPO}/git/commits`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "edit docs", tree: newTree.sha, parents: [seeded.commit] }),
  });
  const commit = await commitRes.json();
  check("POST git/commits returns one commit", commitRes.status === 201 && commit.tree.sha === newTree.sha);

  const patch = await fetch(`${B}/repos/${REPO}/git/refs/heads/main`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sha: commit.sha, force: false }),
  });
  const patched = await patch.json();
  check(
    "PATCH git/refs (plural) fast-forwards the branch",
    patch.status === 200 && patched.object.sha === commit.sha && gh.state.headCommit(REPO).sha === commit.sha,
  );

  // read back through the same stub
  const editedRaw = await fetch(`${B}/repos/${REPO}/contents/docs/a.md`, {
    headers: { accept: "application/vnd.github.raw" },
  });
  const deleted = await fetch(`${B}/repos/${REPO}/contents/docs/b.md`, {
    headers: { accept: "application/vnd.github.raw" },
  });
  const added = await fetch(`${B}/repos/${REPO}/contents/new.md`, {
    headers: { accept: "application/vnd.github.raw" },
  });
  check(
    "a later read sees the edit, the addition, and the deletion",
    editedRaw.status === 200 &&
      (await editedRaw.text()) === EDIT &&
      deleted.status === 404 &&
      added.status === 200 &&
      (await added.text()) === NEW,
  );
  check(
    "state.readFile agrees with the API",
    gh.state.readFile(REPO, "docs/a.md") === EDIT && gh.state.readFile(REPO, "docs/b.md") === undefined,
  );

  // stale parent -> compare-and-swap rejects
  const staleCommit = await (
    await fetch(`${B}/repos/${REPO}/git/commits`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "stale", tree: newTree.sha, parents: [seeded.commit] }),
    })
  ).json();
  const stalePatch = await fetch(`${B}/repos/${REPO}/git/refs/heads/main`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sha: staleCommit.sha }),
  });
  const staleBody = await stalePatch.json();
  check(
    "PATCH with a stale first parent is 422 non-fast-forward",
    stalePatch.status === 422 &&
      staleBody.message === "Update is not a fast forward" &&
      gh.state.headCommit(REPO).sha === commit.sha,
  );

  console.log(`${pass}/${total} passed`);
  await gh.close();
  if (pass !== total) process.exitCode = 1;
}

// ------------------------------------------------------------------------- cli

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.includes("--selftest")) {
    await selfTest();
  } else {
    const gh = startFakeGitHub({ port: 8899 });
    await gh.ready;
    gh.seed("acme/widgets", {
      files: {
        "README.md": "# widgets\n\nDemo repo served by fake-github.mjs.\n",
        "docs/guide.md": "# guide\n\nstep one\n",
        "src/index.ts": "export const hello = () => 'hi';\n",
      },
    });
    console.log(`fake-github listening on ${gh.url} (seeded acme/widgets @ main)`);
  }
}
