/* Markdown surgical edits. Pure functions, no I/O.
   The scanner is a real CommonMark block scanner, not a /^#{1,6}/ regex: front matter's
   closing `---` is a legal setext H2 underline, so a naive scan invents a phantom heading
   named after the last YAML line and an agent would edit straight into the front matter.

   Documents are held as lines PLUS their individual terminators. Editing never rewrites the
   line endings of lines it did not touch, even in a file with mixed CRLF and LF. */

const HTML1 = /^<(pre|script|style|textarea)(\s|>|$)/i;
const HTML6 =
  /^<\/?(address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h1|h2|h3|h4|h5|h6|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(\s|\/?>|$)/i;

/** Markdown blank means spaces and tabs only. JS trim() also strips NBSP, U+3000 and friends,
    which are ordinary content here — using it would silently delete author's lines. */
const isBlank = (s: string) => /^[ \t]*$/.test(s);

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

/** Front matter, not a thematic break: the fence must close, contain no blank line, and hold at
    least one YAML-looking line. Without this, `---\n\n# A\n...\n---\n` swallows every heading. */
function frontMatterEndOf(lines: string[]): number | null {
  if (!lines.length || !/^---[ \t]*$/.test(lines[0]!)) return null;
  let sawYaml = false;
  for (let k = 1; k < lines.length; k++) {
    const l = lines[k]!;
    if (isBlank(l)) return null;
    if (/^(---|\.\.\.)[ \t]*$/.test(l)) return sawYaml ? k : null;
    if (/^[A-Za-z_][\w.-]*[ \t]*:/.test(l) || /^-[ \t]/.test(l) || /^[ \t]+\S/.test(l)) sawYaml = true;
  }
  return null;
}

export function scanHeadings(lines: string[]): Scan {
  const headings: Heading[] = [];
  const fm = frontMatterEndOf(lines);
  let fence: { char: string; len: number; indent: number } | null = null;
  let html: { endRe: RegExp | null } | null = null;
  let paraStart = -1;
  let unclosedFence: number | null = null;

  for (let i = fm === null ? 0 : fm + 1; i < lines.length; i++) {
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
      } else if (isBlank(line)) html = null;
      continue;
    }
    if (isBlank(line)) {
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

    // HTML blocks. CommonMark: "the start line can also be the end line", so the end condition
    // MUST be tested on the opener itself. Without this a one-line `<!-- toc -->` — the single
    // most common HTML in markdown — wedges the scanner open to EOF, every later heading
    // disappears, and editing the preceding section deletes the rest of the file.
    if (rest[0] === "<") {
      // An end condition satisfied on the opener itself closes the block immediately.
      const opened = (endRe: RegExp | null) => (endRe && endRe.test(rest) ? null : { endRe });
      let matched = true;
      if (HTML1.test(rest)) html = opened(/<\/(pre|script|style|textarea)>/i);
      else if (rest.startsWith("<!--")) html = opened(/-->/);
      else if (rest.startsWith("<?")) html = opened(/\?>/);
      else if (rest.startsWith("<![CDATA[")) html = opened(/\]\]>/);
      else if (/^<![A-Za-z]/.test(rest)) html = opened(/>/);
      else if (HTML6.test(rest)) html = opened(null); // type 6 ends at a blank line, never on itself
      else matched = false;
      if (matched) {
        paraStart = -1;
        continue;
      }
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

/* ---------------- the document model ---------------- */

export type Doc = {
  bom: string;
  eol: "\n" | "\r\n"; // used only for lines this edit CREATES
  lines: string[];
  eols: string[];     // terminator after each line; "" on the last when there is no trailing newline
  text: string;       // LF view, for matching only
  endedWithNewline: boolean;
};

function build(bom: string, lines: string[], eols: string[], eol: "\n" | "\r\n"): Doc {
  return {
    bom,
    eol,
    lines,
    eols,
    text: lines.join("\n"),
    endedWithNewline: eols.length > 0 && eols[eols.length - 1] !== "",
  };
}

/** A leading U+FEFF is split off: otherwise an old_string anchored at file start silently never
    matches, because indexOf returns 1 rather than 0. */
export function parseDoc(raw: string): Doc {
  const bom = raw.startsWith("﻿") ? "﻿" : "";
  const body = bom ? raw.slice(1) : raw;
  const lines: string[] = [];
  const eols: string[] = [];
  let i = 0;
  for (;;) {
    const nl = body.indexOf("\n", i);
    if (nl === -1) {
      lines.push(body.slice(i));
      eols.push("");
      break;
    }
    const cr = nl > i && body[nl - 1] === "\r";
    lines.push(body.slice(i, cr ? nl - 1 : nl));
    eols.push(cr ? "\r\n" : "\n");
    i = nl + 1;
    if (i === body.length) break; // trailing newline: no phantom empty final line
  }
  const crlf = eols.filter((e) => e === "\r\n").length;
  const lf = eols.filter((e) => e === "\n").length;
  return build(bom, lines, eols, crlf > lf ? "\r\n" : "\n");
}

export function render(doc: Doc): string {
  let out = doc.bom;
  for (let i = 0; i < doc.lines.length; i++) out += doc.lines[i]! + (doc.eols[i] ?? "");
  return out;
}

/** Replace a line range. Lines outside [from,to) keep their own terminators byte for byte. */
function replaceLines(doc: Doc, from: number, to: number, newLines: string[]): Doc {
  const lines = [...doc.lines.slice(0, from), ...newLines, ...doc.lines.slice(to)];
  const head = doc.eols.slice(0, from);
  const tail = doc.eols.slice(to);
  const mid: string[] = [];
  for (let i = 0; i < newLines.length; i++) {
    // Reuse the terminator of the line that used to sit here; invent one only for genuinely new lines.
    mid.push(from + i < to ? doc.eols[from + i]! : doc.eol);
  }
  // The final line of the document must not gain a terminator it never had.
  if (!tail.length && mid.length) {
    const lastOld = to > 0 ? doc.eols[to - 1] ?? "" : "";
    mid[mid.length - 1] = to <= doc.lines.length && to > from ? lastOld : doc.endedWithNewline ? doc.eol : "";
  }
  return build(doc.bom, lines, [...head, ...mid, ...tail], doc.eol);
}

export const lineOf = (doc: Doc, index: number) => offsetToLine(lineStarts(doc), index) + 1; // 1-based

function lineStarts(doc: Doc): number[] {
  const starts: number[] = new Array(doc.lines.length);
  let off = 0;
  for (let i = 0; i < doc.lines.length; i++) {
    starts[i] = off;
    off += doc.lines[i]!.length + 1; // +1 for the LF in the view
  }
  return starts;
}

/** Binary search. Doing this with slice().split() per hit is O(n * hits) and has been measured
    stalling the whole (single-threaded) server for tens of seconds on a large replace_all. */
function offsetToLine(starts: number[], index: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= index) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

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
    replacement — a wrong guess about which bytes to overwrite is silent corruption. */
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

export function strReplace(
  doc: Doc,
  path: string,
  oldString: string,
  newString: string,
  replaceAll: boolean
): { doc: Doc; note: string } {
  if (!oldString) fail("old_string must not be empty.");
  if (oldString === newString) fail("No replacement was performed: new_string and old_string must be different.");

  const needle = oldString.replace(/\r\n/g, "\n");
  const repl = newString.replace(/\r\n/g, "\n");
  const hay = doc.text;

  const hits: number[] = [];
  // Advance by needle.length: overlapping matches are not separate replacements, and counting
  // them inflates the reported count and corrupts the splice.
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + needle.length)) hits.push(i);

  const starts = lineStarts(doc);
  const lineAt = (off: number) => offsetToLine(starts, off) + 1;

  if (hits.length === 0) {
    const relaxed = relaxedFind(doc, needle);
    if (relaxed) {
      const out = spliceRange(doc, relaxed.startLine, relaxed.endLine, relaxed.pad, repl);
      return { doc: out, note: `matched after normalizing leading indentation (line ${relaxed.startLine + 1})` };
    }
    let msg =
      `No replacement was performed: old_string did not appear verbatim in ${path}. ` +
      `The text must match exactly, including whitespace and indentation.`;
    if (repl && hay.includes(repl)) {
      msg += ` Note: new_string already appears in ${path} at line ${lineAt(hay.indexOf(repl))} — this edit may already have landed.`;
    }
    const cands = nearMisses(hay, needle);
    if (cands.length) msg += `\nDid you mean to match one of these actual lines from ${path}?\n${cands.join("\n")}`;
    fail(msg);
  }

  if (hits.length > 1 && !replaceAll) {
    fail(
      `Found ${hits.length} matches for old_string in ${path} (lines ${hits.map(lineAt).join(", ")}). ` +
        `Provide more surrounding context to target one, or set replace_all=true to change all ${hits.length}.`
    );
  }

  // Rebuild the LF view once, then re-split into lines and re-attach terminators positionally.
  let out = "";
  let cur = 0;
  for (const h of hits) {
    out += hay.slice(cur, h) + repl;
    cur = h + needle.length;
  }
  out += hay.slice(cur);

  const first = offsetToLine(starts, hits[0]!);
  const last = offsetToLine(starts, hits[hits.length - 1]! + needle.length);
  const newDoc = rebuild(doc, out, first, last);
  const note = replaceAll
    ? `replaced ${hits.length} occurrence(s) at line(s) ${hits.map(lineAt).join(", ")}`
    : `replaced 1 occurrence at line ${lineAt(hits[0]!)}`;
  return { doc: newDoc, note };
}

/** Re-derive lines from an edited LF view, preserving the terminators of every line outside
    the touched range [firstLine, lastLine]. */
function rebuild(doc: Doc, newText: string, firstLine: number, lastLine: number): Doc {
  const newLines = newText.split("\n");
  const headCount = firstLine;
  const tailCount = doc.lines.length - 1 - lastLine;
  const eols: string[] = [];
  for (let i = 0; i < newLines.length; i++) {
    if (i < headCount) eols.push(doc.eols[i]!);
    else if (i >= newLines.length - tailCount) eols.push(doc.eols[doc.lines.length - (newLines.length - i)]!);
    else eols.push(doc.eol);
  }
  if (eols.length) {
    const lastOld = doc.eols[doc.eols.length - 1] ?? "";
    if (tailCount <= 0) eols[eols.length - 1] = lastOld;
  }
  return build(doc.bom, newLines, eols, doc.eol);
}

/** Replace whole lines [startLine,endLine] with `repl`, re-applying the original indentation. */
function spliceRange(doc: Doc, startLine: number, endLine: number, pad: string, repl: string): Doc {
  const replLines = repl.split("\n").map((l) => (l === "" ? l : pad + l));
  return replaceLines(doc, startLine, endLine + 1, replLines);
}

/** Indent-insensitive recovery. Only accepts a match whose lines share ONE leading-whitespace
    prefix, and re-applies that prefix — otherwise the "recovery" strips real indentation and
    turns an indented code block into a live heading. */
function relaxedFind(doc: Doc, needle: string): { startLine: number; endLine: number; pad: string } | null {
  const nLines = needle.split("\n").map((l) => l.replace(/^[ \t]*/, ""));
  const hLines = doc.lines;
  const found: number[] = [];
  for (let i = 0; i + nLines.length <= hLines.length; i++) {
    let ok = true;
    for (let j = 0; j < nLines.length; j++) {
      if (hLines[i + j]!.replace(/^[ \t]*/, "") !== nLines[j]) { ok = false; break; }
    }
    if (ok) found.push(i);
  }
  if (found.length !== 1) return null;
  const startLine = found[0]!;
  const endLine = startLine + nLines.length - 1;
  const pads = new Set<string>();
  for (let i = startLine; i <= endLine; i++) {
    if (!isBlank(hLines[i]!)) pads.add(/^[ \t]*/.exec(hLines[i]!)![0]);
  }
  if (pads.size > 1) return null; // ragged indentation: refuse rather than guess
  return { startLine, endLine, pad: [...pads][0] ?? "" };
}

/** Resolve a heading by literal text first, then by `Guide > Install` breadcrumb or a `Notes#2`
    index. Literal-first is what makes headings like `## Issue #42` and `## A > B` addressable
    at all — parsing the sigils unconditionally silently retargets a different section. */
export function resolveHeading(scan: Scan, spec: string, path: string): number {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  const all = scan.headings.map((h, i) => ({ h, i }));
  const outline = () => all.map((x) => `  L${x.h.level} ${x.h.text || "(empty)"} (line ${x.h.startLine + 1}) [${breadcrumb(scan, x.i)}]`).join("\n");

  const exact = all.filter((x) => norm(x.h.text) === norm(spec));
  if (exact.length === 1) return exact[0]!.i;
  if (exact.length > 1) return ambiguous(scan, exact, spec, path);

  let want = norm(spec);
  let occurrence: number | null = null;
  const idx = /^(.*?)\s*#(\d+)$/.exec(want);
  if (idx) {
    want = norm(idx[1]!);
    occurrence = Number(idx[2]);
  }
  let crumbs: string[] | null = null;
  if (want.includes(">")) {
    crumbs = want.split(">").map(norm);
    want = crumbs[crumbs.length - 1]!;
  }

  let cands = all.filter((x) => norm(x.h.text) === want);
  if (!cands.length) cands = all.filter((x) => norm(x.h.text).toLowerCase() === want.toLowerCase());

  if (crumbs && crumbs.length > 1) {
    cands = cands.filter((x) => {
      const bc = breadcrumb(scan, x.i).split(" > ").map(norm);
      let at = 0;
      for (const c of crumbs!) {
        const found = bc.indexOf(c, at);
        if (found === -1) return false; // ancestors must appear IN ORDER
        at = found + 1;
      }
      return true;
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
    return pick.i;
  }
  if (cands.length > 1) return ambiguous(scan, cands, spec, path);
  return cands[0]!.i;
}

function ambiguous(scan: Scan, cands: { h: Heading; i: number }[], spec: string, path: string): never {
  const list = cands.map((x) => `L${x.h.level} ${x.h.text} (line ${x.h.startLine + 1}) [${breadcrumb(scan, x.i)}]`).join("; ");
  fail(
    `"${spec}" matches ${cands.length} headings in ${path}: ${list}. ` +
      `Pass a breadcrumb such as "${breadcrumb(scan, cands[0]!.i)}", or an occurrence index such as "${spec}#2".`
  );
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
): { doc: Doc; note: string } {
  if (mode === "delete" && content !== undefined) fail("edit_section mode=delete does not take content.");
  if (mode !== "delete" && content === undefined) fail(`edit_section mode=${mode} requires content.`);

  const scan = scanHeadings(doc.lines);
  const idx = resolveHeading(scan, headingSpec, path);
  const span = sectionSpan(scan.headings, idx, doc.lines.length);
  const label = scan.headings[idx]!.text || "(empty)";

  const body = (content ?? "").replace(/\r\n/g, "\n");
  const bodyLines = body === "" ? [] : body.replace(/\n+$/, "").split("\n");

  if (mode === "delete") {
    return {
      doc: replaceLines(doc, span.start, span.end, []),
      note: `deleted section "${label}" (${span.end - span.start} lines, from line ${span.start + 1})`,
    };
  }

  let section = doc.lines.slice(span.bodyStart, span.end);
  let note: string;

  if (mode === "replace") {
    note = `replaced body of "${label}" (${section.length} lines removed, ${bodyLines.length} added)`;
    section = bodyLines;
  } else if (mode === "prepend") {
    note = `prepended ${bodyLines.length} line(s) after "${label}"`;
    section = [...bodyLines, ...section];
  } else {
    while (section.length && isBlank(section[section.length - 1]!)) section.pop();
    note = `appended ${bodyLines.length} line(s) to "${label}"`;
    section = [...section, ...bodyLines];
  }

  // Exactly one blank line before whatever follows, but only when something follows.
  if (doc.lines.slice(span.end).some((l) => !isBlank(l))) {
    while (section.length && isBlank(section[section.length - 1]!)) section.pop();
    section.push("");
  }

  return { doc: replaceLines(doc, span.bodyStart, span.end, section), note };
}

/** Two delta invariants only. Checked before AND after, so a pre-existing problem is never
    blamed on this edit. Skipped entirely for a file being created: a document that does not
    exist has no delta, and blaming it for "gaining" front matter makes every Jekyll/Hugo/
    Obsidian note impossible to create. */
export function deltaInvariants(before: string, after: string, path: string, isNew: boolean): string[] {
  if (isNew) return [];
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
