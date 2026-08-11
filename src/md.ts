/* Markdown surgical edits. Pure functions, no I/O.
   The scanner is a real CommonMark block scanner, not a /^#{1,6}/ regex: front matter's
   closing `---` is a legal setext H2 underline, so a naive scan invents a phantom heading
   named after the last YAML line and an agent would edit straight into the front matter. */

const HTML1 = /^<(pre|script|style|textarea)(\s|>|$)/i;
const HTML6 =
  /^<\/?(address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h1|h2|h3|h4|h5|h6|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(\s|\/?>|$)/i;

export type Heading = { level: number; text: string; startLine: number; endLine: number; kind: "atx" | "setext" };
export type Scan = { headings: Heading[]; frontMatterEnd: number | null; unclosedFenceLine: number | null };

/** Tabs advance to the next 4-column stop. A leading tab is 4 columns, so `\t## Foo` is code. */
function indentWidth(line: string): { width: number; offset: number } {
  let w = 0;
  let i = 0;
  for (; i < line.length; i++) {
    if (line[i] === " ") w += 1;
    else if (line[i] === "\t") w += 4 - (w % 4);
    else break;
  }
  return { width: w, offset: i };
}

export function scanHeadings(lines: string[]): Scan {
  const headings: Heading[] = [];
  let i = 0;
  let fm: number | null = null;
  let fence: { char: string; len: number; indent: number } | null = null;
  let html: { endRe: RegExp | null } | null = null;
  let paraStart = -1;
  let unclosedFence: number | null = null;

  // Front matter only when line 0 is exactly `---` AND a closer exists later.
  if (lines.length && /^---[ \t]*$/.test(lines[0]!)) {
    for (let k = 1; k < lines.length; k++) {
      if (/^(---|\.\.\.)[ \t]*$/.test(lines[k]!)) {
        fm = k;
        break;
      }
    }
  }
  i = fm === null ? 0 : fm + 1;

  for (; i < lines.length; i++) {
    const line = lines[i]!;

    if (fence) {
      const { width, offset } = indentWidth(line);
      const m = /^(`+|~+)[ \t]*$/.exec(line.slice(offset));
      if (m && width <= 3 && m[1]![0] === fence.char && m[1]!.length >= fence.len) fence = null;
      continue;
    }
    if (html) {
      if (html.endRe) {
        if (html.endRe.test(line)) html = null;
      } else if (/^[ \t]*$/.test(line)) html = null;
      continue;
    }
    if (/^[ \t]*$/.test(line)) {
      paraStart = -1;
      continue;
    }

    const { width, offset } = indentWidth(line);
    const rest = line.slice(offset);

    if (width >= 4) continue; // indented code, or lazy paragraph continuation

    const fo = /^(`{3,}|~{3,})(.*)$/.exec(rest);
    if (fo && !(fo[1]![0] === "`" && fo[2]!.includes("`"))) {
      fence = { char: fo[1]![0]!, len: fo[1]!.length, indent: width };
      unclosedFence = i;
      paraStart = -1;
      continue;
    }

    const atx = /^(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/.exec(rest);
    if (atx) {
      const text = (atx[2] ?? "").replace(/(^|[ \t])#+[ \t]*$/, "$1").trim();
      headings.push({ level: atx[1]!.length, text, startLine: i, endLine: i, kind: "atx" });
      paraStart = -1;
      continue;
    }

    if (rest[0] === "<") {
      if (HTML1.test(rest)) { html = { endRe: /<\/(pre|script|style|textarea)>/i }; paraStart = -1; continue; }
      if (rest.startsWith("<!--")) { html = { endRe: /-->/ }; paraStart = -1; continue; }
      if (rest.startsWith("<?")) { html = { endRe: /\?>/ }; paraStart = -1; continue; }
      if (/^<![A-Za-z]/.test(rest)) { html = { endRe: />/ }; paraStart = -1; continue; }
      if (rest.startsWith("<![CDATA[")) { html = { endRe: /\]\]>/ }; paraStart = -1; continue; }
      if (HTML6.test(rest)) { html = { endRe: null }; paraStart = -1; continue; }
    }

    if (rest[0] === ">") { paraStart = -1; continue; } // blockquote: nested doc, not addressable

    if (paraStart >= 0) {
      const su = /^(=+|-+)[ \t]*$/.exec(rest);
      if (su) {
        headings.push({
          level: su[1]![0] === "=" ? 1 : 2,
          text: lines.slice(paraStart, i).map((l) => l.trim()).join(" ").trim(),
          startLine: paraStart,
          endLine: i,
          kind: "setext",
        });
        paraStart = -1;
        continue;
      }
    }

    if (/^((\*[ \t]*){3,}|(_[ \t]*){3,}|(-[ \t]*){3,})$/.test(rest)) { paraStart = -1; continue; }
    if (paraStart < 0) paraStart = i;
  }

  return { headings, frontMatterEnd: fm, unclosedFenceLine: fence ? unclosedFence : null };
}

/** A section runs to the next heading of the same or shallower level. `end` is exclusive. */
export function sectionSpan(headings: Heading[], idx: number, totalLines: number) {
  const h = headings[idx]!;
  let end = totalLines;
  for (let j = idx + 1; j < headings.length; j++) {
    if (headings[j]!.level <= h.level) {
      end = headings[j]!.startLine;
      break;
    }
  }
  return { start: h.startLine, bodyStart: h.endLine + 1, end };
}

/* ---------------- byte fidelity ---------------- */

export type Doc = {
  bom: string;      // leading U+FEFF, split off so an anchor at file start can match
  eol: "\n" | "\r\n";
  text: string;     // LF-normalized view, BOM removed
  original: string; // exact original bytes minus BOM
};

/** An old_string anchored at file start silently never matches with a BOM present
    (indexOf returns 1, not 0), so the BOM is split off before matching. */
export function parseDoc(raw: string): Doc {
  const bom = raw.startsWith("﻿") ? "﻿" : "";
  const original = bom ? raw.slice(1) : raw;
  const crlf = (original.match(/\r\n/g) || []).length;
  const lf = (original.match(/(?<!\r)\n/g) || []).length;
  const eol: "\n" | "\r\n" = crlf > lf ? "\r\n" : "\n";
  return { bom, eol, text: original.replace(/\r\n/g, "\n"), original };
}

/** Render an LF-normalized string back out in the document's own line ending. */
export function render(doc: Doc, text: string): string {
  return doc.bom + (doc.eol === "\r\n" ? text.replace(/\n/g, "\r\n") : text);
}

export const lineOf = (text: string, index: number) => text.slice(0, index).split("\n").length; // 1-based

/* ---------------- error type ---------------- */

export class EditError extends Error {}
// Function declaration, not a const arrow — TS never-return narrowing depends on it.
function fail(msg: string): never {
  throw new EditError(msg);
}

/* ---------------- near-miss candidates ---------------- */

const trigrams = (s: string) => {
  const t = new Set<string>();
  const n = s.toLowerCase().replace(/\s+/g, " ").trim();
  for (let i = 0; i < n.length - 2; i++) t.add(n.slice(i, i + 3));
  return t;
};

/** Trigram Jaccard against the needle's first non-blank line. Deliberately NOT fuzzy
    replacement — aider ships theirs disabled; a wrong guess is silent corruption. */
export function nearMisses(text: string, needle: string, limit = 4): string[] {
  const first = needle.split("\n").find((l) => l.trim()) || needle;
  const want = trigrams(first);
  if (!want.size) return [];
  return text
    .split("\n")
    .map((line, i) => ({ line, i }))
    .filter((x) => x.line.trim())
    .map((x) => {
      const have = trigrams(x.line);
      let inter = 0;
      for (const g of have) if (want.has(g)) inter++;
      const union = want.size + have.size - inter;
      return { ...x, score: union ? inter / union : 0 };
    })
    .filter((x) => x.score > 0.12)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => `  line ${x.i + 1}: ${x.line.slice(0, 160)}`);
}

/* ---------------- ops ---------------- */

/** Exact-match replacement. Matching runs on the LF view; offsets are mapped back so a
    one-line edit to a CRLF file does not rewrite every line ending into the diff. */
export function strReplace(
  doc: Doc,
  path: string,
  oldString: string,
  newString: string,
  replaceAll: boolean
): { text: string; note: string } {
  if (!oldString) fail("old_string must not be empty.");
  if (oldString === newString) fail("No replacement was performed: new_string and old_string must be different.");

  const needle = oldString.replace(/\r\n/g, "\n");
  const repl = newString.replace(/\r\n/g, "\n");
  const hay = doc.text;

  const hits: number[] = [];
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + 1)) hits.push(i);

  if (hits.length === 0) {
    // Recovery ladder: indent-insensitive, then whitespace-collapsed. A retry that yields
    // exactly one match splices the ORIGINAL span, so the write stays byte-exact.
    const relaxed = relaxedFind(hay, needle);
    if (relaxed) {
      const out = hay.slice(0, relaxed.start) + repl + hay.slice(relaxed.end);
      return { text: out, note: `matched after normalizing leading indentation (line ${lineOf(hay, relaxed.start)})` };
    }
    let msg =
      `No replacement was performed: old_string did not appear verbatim in ${path}. ` +
      `The text must match exactly, including whitespace and indentation.`;
    if (repl && hay.includes(repl)) {
      msg += ` Note: new_string already appears in ${path} at line ${lineOf(hay, hay.indexOf(repl))} — this edit may already have landed.`;
    }
    const cands = nearMisses(hay, needle);
    if (cands.length) msg += `\nDid you mean to match one of these actual lines from ${path}?\n${cands.join("\n")}`;
    fail(msg);
  }

  if (hits.length > 1 && !replaceAll) {
    const lines = hits.map((h) => lineOf(hay, h)).join(", ");
    fail(
      `Found ${hits.length} matches for old_string in ${path} (lines ${lines}). ` +
        `Provide more surrounding context to target one, or set replace_all=true to change all ${hits.length}.`
    );
  }

  if (replaceAll) {
    const lines = hits.map((h) => lineOf(hay, h));
    let out = "";
    let cur = 0;
    for (const h of hits) {
      out += hay.slice(cur, h) + repl;
      cur = h + needle.length;
    }
    out += hay.slice(cur);
    return { text: out, note: `replaced ${hits.length} occurrence(s) at line(s) ${lines.join(", ")}` };
  }

  const at = hits[0]!;
  return { text: hay.slice(0, at) + repl + hay.slice(at + needle.length), note: `replaced 1 occurrence at line ${lineOf(hay, at)}` };
}

function relaxedFind(hay: string, needle: string): { start: number; end: number } | null {
  const strip = (s: string) => s.split("\n").map((l) => l.replace(/^[ \t]+/, "")).join("\n");
  const nStrip = strip(needle);
  const hLines = hay.split("\n");
  const nLines = nStrip.split("\n");
  const found: number[] = [];
  for (let i = 0; i + nLines.length <= hLines.length; i++) {
    let ok = true;
    for (let j = 0; j < nLines.length; j++) {
      if (hLines[i + j]!.replace(/^[ \t]+/, "") !== nLines[j]) { ok = false; break; }
    }
    if (ok) found.push(i);
  }
  if (found.length !== 1) return null;
  const startLine = found[0]!;
  const start = hLines.slice(0, startLine).reduce((a, l) => a + l.length + 1, 0);
  const end = start + hLines.slice(startLine, startLine + nLines.length).join("\n").length;
  return { start, end };
}

/** Resolve a heading by exact text, a `Guide > Install` breadcrumb, or a `Notes#2` index.
    Ambiguity is always an error — never first-match-wins. */
export function resolveHeading(scan: Scan, lines: string[], spec: string, path: string): number {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  const outline = () =>
    scan.headings.map((h) => `  L${h.level} ${h.text || "(empty)"} (line ${h.startLine + 1}) [${breadcrumb(scan, scan.headings.indexOf(h))}]`).join("\n");

  let want = norm(spec);
  let occurrence: number | null = null;
  const idxMatch = /^(.*)#(\d+)$/.exec(want);
  if (idxMatch) {
    want = norm(idxMatch[1]!);
    occurrence = Number(idxMatch[2]);
  }
  let crumbs: string[] | null = null;
  if (want.includes(">")) {
    crumbs = want.split(">").map(norm);
    want = crumbs[crumbs.length - 1]!;
  }

  let cands = scan.headings.map((h, i) => ({ h, i })).filter((x) => norm(x.h.text) === want);
  if (!cands.length) cands = scan.headings.map((h, i) => ({ h, i })).filter((x) => norm(x.h.text).toLowerCase() === want.toLowerCase());

  if (crumbs && crumbs.length > 1) {
    cands = cands.filter((x) => {
      const bc = breadcrumb(scan, x.i).split(" > ").map(norm);
      return crumbs!.every((c) => bc.includes(c));
    });
  }

  if (!cands.length) {
    let msg = `No heading matched "${spec}" in ${path}.`;
    if (scan.unclosedFenceLine !== null) {
      msg +=
        ` An unclosed \`\`\` fence opened at line ${scan.unclosedFenceLine + 1}, which makes everything after it a code block, ` +
        `so no heading past that line is addressable.`;
    }
    msg += scan.headings.length ? `\nHeadings in this file:\n${outline()}` : ` This file has no headings.`;
    fail(msg);
  }

  if (occurrence !== null) {
    const pick = cands[occurrence - 1];
    if (!pick) fail(`"${spec}" asks for occurrence ${occurrence} but only ${cands.length} heading(s) match in ${path}.\n${outline()}`);
    return pick!.i;
  }

  if (cands.length > 1) {
    const list = cands.map((x) => `L${x.h.level} ${x.h.text} (line ${x.h.startLine + 1}) [${breadcrumb(scan, x.i)}]`).join("; ");
    fail(
      `"${spec}" matches ${cands.length} headings in ${path}: ${list}. ` +
        `Pass a breadcrumb such as "${breadcrumb(scan, cands[0]!.i)}", or an occurrence index such as "${want}#2".`
    );
  }
  return cands[0]!.i;
}

function breadcrumb(scan: Scan, idx: number): string {
  const h = scan.headings[idx]!;
  const parts = [h.text];
  let level = h.level;
  for (let j = idx - 1; j >= 0 && level > 1; j--) {
    const p = scan.headings[j]!;
    if (p.level < level) {
      parts.unshift(p.text);
      level = p.level;
    }
  }
  return parts.join(" > ");
}

export function editSection(
  doc: Doc,
  path: string,
  headingSpec: string,
  mode: "replace" | "append" | "prepend" | "delete",
  content: string | undefined
): { text: string; note: string } {
  if (mode === "delete" && content !== undefined) fail("edit_section mode=delete does not take content.");
  if (mode !== "delete" && content === undefined) fail(`edit_section mode=${mode} requires content.`);

  const lines = doc.text.split("\n");
  const scan = scanHeadings(lines);
  const idx = resolveHeading(scan, lines, headingSpec, path);
  const span = sectionSpan(scan.headings, idx, lines.length);

  const body = (content ?? "").replace(/\r\n/g, "\n");
  const bodyLines = body === "" ? [] : body.replace(/\n+$/, "").split("\n");
  const label = scan.headings[idx]!.text || "(empty)";

  if (mode === "delete") {
    const out = [...lines.slice(0, span.start), ...lines.slice(span.end)];
    return {
      text: out.join("\n"),
      note: `deleted section "${label}" (${span.end - span.start} lines, from line ${span.start + 1})`,
    };
  }

  const head = lines.slice(0, span.bodyStart); // everything up to and including the heading
  const tail = lines.slice(span.end);
  let section = lines.slice(span.bodyStart, span.end);
  let note: string;

  if (mode === "replace") {
    note = `replaced body of "${label}" (${section.length} lines removed, ${bodyLines.length} added)`;
    section = bodyLines;
  } else if (mode === "prepend") {
    note = `prepended ${bodyLines.length} line(s) after "${label}"`;
    section = [...bodyLines, ...section];
  } else {
    while (section.length && !section[section.length - 1]!.trim()) section.pop();
    note = `appended ${bodyLines.length} line(s) to "${label}"`;
    section = [...section, ...bodyLines];
  }

  // Exactly one blank line before whatever follows, but only when something follows.
  if (tail.some((l) => l.trim())) {
    while (section.length && !section[section.length - 1]!.trim()) section.pop();
    section.push("");
  }

  return { text: [...head, ...section, ...tail].join("\n"), note };
}

/** Two delta invariants only. Checked before AND after, so a pre-existing problem
    is never blamed on this edit. There is no such thing as invalid markdown. */
export function deltaInvariants(before: string, after: string, path: string): string[] {
  const warn: string[] = [];
  const b = scanHeadings(before.split("\n"));
  const a = scanHeadings(after.split("\n"));

  if (a.unclosedFenceLine !== null && b.unclosedFenceLine === null) {
    fail(
      `${path} would end inside an unclosed code fence opened at line ${a.unclosedFenceLine + 1}. ` +
        `Nothing was committed. Close the fence or adjust the edit.`
    );
  }
  if ((b.frontMatterEnd === null) !== (a.frontMatterEnd === null)) {
    fail(
      b.frontMatterEnd === null
        ? `${path} would gain YAML front matter it did not have. Nothing was committed.`
        : `${path} would lose its YAML front matter. Nothing was committed.`
    );
  }
  const d = a.headings.length - b.headings.length;
  if (d !== 0) warn.push(`headings ${d > 0 ? `+${d}` : d}`);
  return warn;
}
