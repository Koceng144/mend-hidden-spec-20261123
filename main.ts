// mend: the CLI SPEC.md specifies (version 1). Node 22, the standard library alone; run it as
// `node main.ts [options] [PATCH]` with the working directory as the root of a tree of text files.
//
// It reads a patch in one of four formats (unified diff, SEARCH/REPLACE blocks, V4A, JSON edits),
// finds the lines each edit names at the first of three matching tiers, and writes every change or
// none, printing what it changed or why it failed. Section numbers below are SPEC.md's.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands
// over to runner.ts (the last lines below), which runs this CLI on each check in a fresh directory.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** An exit-2 outcome: one output line, nothing written (section 2). */
class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** One failed edit (section 2): a code and the path the failure concerns. */
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';
/** Surrounding spaces (and tabs) removed. */
const trimSpaces = (s: string): string => s.replace(/^[ \t]+|[ \t]+$/g, '');
/** The leading spaces and tabs of a line. */
const leadWs = (s: string): string => /^[ \t]*/.exec(s)![0];
const onlyWs = (s: string): boolean => /^[ \t]*$/.test(s);

/** A patch's lines (section 3): split at `\n`, one trailing `\r` removed, no empty piece after a final `\n`. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** A safe path (section 3). */
function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Successful move edits, in patch order: [old path, new path] (for the `R` output lines, section 2). */
  readonly moves: [string, string][] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/** A file as lines (section 3): its own line break, and whether it ends with one. */
interface Doc {
  lines: string[];
  br: string;
  final: boolean;
}

function parseDoc(text: string): Doc {
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') return { lines: [], br, final: false };
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

/** A file of no lines is written empty (section 3). */
function serializeDoc(d: Doc): string {
  if (d.lines.length === 0) return '';
  return d.lines.join(d.br) + (d.final ? d.br : '');
}

/** Detecting the format (section 4). */
function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---- Matching lines (section 5) ----

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return a.replace(/[ \t]+$/, '') === b.replace(/[ \t]+$/, '');
  return a.replace(/^[ \t]+|[ \t]+$/g, '') === b.replace(/^[ \t]+|[ \t]+$/g, '');
}

/** A line as a tier compares it (section 5). */
function normalize(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+|[ \t]+$/g, '');
}

/** Whether O matches the file's lines at position `at` (0-based) at this tier. */
function matchesAt(lines: string[], O: string[], at: number, tier: number): boolean {
  if (at < 0 || at + O.length > lines.length) return false;
  for (let j = 0; j < O.length; j++) if (!lineEq(lines[at + j]!, O[j]!, tier)) return false;
  return true;
}

/** Every occurrence of O at or after `from` at this tier; occurrences may overlap. */
function occurrencesAt(lines: string[], O: string[], tier: number, from: number): number[] {
  const nO = O.map((s) => normalize(s, tier));
  const nL = tier === 0 ? lines : lines.map((s) => normalize(s, tier));
  const out: number[] = [];
  outer: for (let i = from; i + O.length <= lines.length; i++) {
    for (let j = 0; j < O.length; j++) if (nL[i + j] !== nO[j]) continue outer;
    out.push(i);
  }
  return out;
}

/** O found at the first tier at which it occurs at least once at or after `from`. */
function findMatch(lines: string[], O: string[], strict: boolean, from = 0): { tier: number; occ: number[] } | null {
  const maxTier = strict ? 0 : 2;
  for (let t = 0; t <= maxTier; t++) {
    const occ = occurrencesAt(lines, O, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** Tier-2 re-indentation of one new line (section 5). */
function reindentLine(line: string, F: string, P: string): string {
  if (line !== '' && !onlyWs(line) && line.startsWith(P)) return F + line.slice(P.length);
  return line;
}

/** One body line of a unified hunk or a V4A chunk. `raw` is the patch line it came from. */
interface BodyItem {
  kind: 'ctx' | 'old' | 'new' | 'bs';
  text: string;
  raw: string;
}

/**
 * The lines N writes over the matched lines at `at`: a context line is written as the file's own
 * matched line, and at tier 2 every other line is re-indented (section 5).
 */
function buildReplacement(body: BodyItem[], fileLines: string[], at: number, tier: number, oFirst: string): string[] {
  const F = leadWs(fileLines[at]!);
  const P = leadWs(oFirst);
  const out: string[] = [];
  let o = at;
  for (const it of body) {
    if (it.kind === 'ctx') {
      out.push(fileLines[o]!);
      o += 1;
    } else if (it.kind === 'old') {
      o += 1;
    } else if (it.kind === 'new') {
      out.push(tier === 2 ? reindentLine(it.text, F, P) : it.text);
    }
  }
  return out;
}

// ---- Unified diffs (section 6) ----

interface Hunk {
  A: number;
  body: BodyItem[];
}

interface Section {
  gitOld: string | null;
  gitNew: string | null;
  hdrOld: string | null;
  hdrNew: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  newFileMode: boolean;
  deletedFileMode: boolean;
  hunks: Hunk[];
}

/** The path of a `--- `/`+++ ` line: after the four characters, up to the first tab, spaces removed, `a/`/`b/` removed. */
function headerPath(line: string): string {
  let s = line.slice(4);
  const tab = s.indexOf('\t');
  if (tab >= 0) s = s.slice(0, tab);
  s = trimSpaces(s);
  if (s.startsWith('a/') || s.startsWith('b/')) s = s.slice(2);
  return s;
}

function parseUnified(lines: string[]): Section[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let i = 0;
  const newSection = (): Section => {
    const s: Section = {
      gitOld: null, gitNew: null, hdrOld: null, hdrNew: null,
      renameFrom: null, renameTo: null, newFileMode: false, deletedFileMode: false, hunks: [],
    };
    sections.push(s);
    cur = s;
    return s;
  };
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.*?) b\/(.*)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const s = newSection();
      s.gitOld = m[1]!;
      s.gitNew = m[2]!;
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const hunk: Hunk = { A: parseInt(m[1]!, 10), body: [] };
      i += 1;
      while (i < lines.length) {
        const bl = lines[i]!;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (bl === '') hunk.body.push({ kind: 'ctx', text: '', raw: bl });
        else if (bl[0] === ' ') hunk.body.push({ kind: 'ctx', text: bl.slice(1), raw: bl });
        else if (bl[0] === '-') hunk.body.push({ kind: 'old', text: bl.slice(1), raw: bl });
        else if (bl[0] === '+') hunk.body.push({ kind: 'new', text: bl.slice(1), raw: bl });
        else if (bl[0] === '\\') hunk.body.push({ kind: 'bs', text: bl, raw: bl });
        else break;
        i += 1;
      }
      // Empty lines at the end of a body are not part of it.
      while (hunk.body.length > 0 && hunk.body[hunk.body.length - 1]!.raw === '') hunk.body.pop();
      cur.hunks.push(hunk);
      continue;
    }
    const inHeader = cur !== null && cur.hunks.length === 0;
    if (line.startsWith('--- ')) {
      const next = lines[i + 1] ?? '';
      if (inHeader) {
        if (!next.startsWith('+++ ')) throw new Exit2(`error: parse ${i + 2}`);
        cur!.hdrOld = headerPath(line);
        cur!.hdrNew = headerPath(next);
        i += 2;
        continue;
      }
      if (next.startsWith('+++ ')) {
        const s = newSection();
        s.hdrOld = headerPath(line);
        s.hdrNew = headerPath(next);
        i += 2;
        continue;
      }
      i += 1; // prose outside a section header
      continue;
    }
    if (inHeader) {
      if (line.startsWith('+++ ')) cur!.hdrNew = headerPath(line);
      else if (line.startsWith('rename from ')) cur!.renameFrom = trimSpaces(line.slice('rename from '.length));
      else if (line.startsWith('rename to ')) cur!.renameTo = trimSpaces(line.slice('rename to '.length));
      else if (line.startsWith('new file mode')) cur!.newFileMode = true;
      else if (line.startsWith('deleted file mode')) cur!.deletedFileMode = true;
      i += 1;
      continue;
    }
    i += 1; // a line outside bodies and headers: ignored
  }
  return sections;
}

/** Whether a `\` line follows the hunk's last context or `+` line (section 6). */
function bsAfterLastCtxOrNew(h: Hunk): boolean {
  for (let k = h.body.length - 1; k >= 0; k--) {
    const it = h.body[k]!;
    if (it.kind === 'ctx' || it.kind === 'new') return h.body[k + 1]?.kind === 'bs';
  }
  return false;
}

function unifiedEdits(sections: Section[], strict: boolean): Edit[] {
  return sections.map((s) => (tree: Tree) => {
    const oldPath = s.hdrOld ?? s.renameFrom ?? s.gitOld ?? '';
    const newPath = s.hdrNew ?? s.renameTo ?? s.gitNew ?? '';
    const oldNull = s.hdrOld === '/dev/null';
    const newNull = s.hdrNew === '/dev/null';
    if (!oldNull && !safe(oldPath)) throw new Fail('unsafe', oldPath);
    if (!newNull && !safe(newPath)) throw new Fail('unsafe', newPath);
    const creation = oldNull || s.newFileMode;
    const deletion = !creation && (newNull || s.deletedFileMode);
    if (creation) {
      if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
      const fileLines: string[] = [];
      let lastPlusBs = false;
      for (const h of s.hunks) {
        h.body.forEach((it, idx) => {
          if (it.kind === 'new') {
            fileLines.push(it.text);
            lastPlusBs = h.body[idx + 1]?.kind === 'bs';
          }
        });
      }
      tree.now.set(newPath, serializeDoc({ lines: fileLines, br: '\n', final: !lastPlusBs }));
      return;
    }
    if (deletion) {
      if (tree.get(oldPath) === null) throw new Fail('missing', oldPath);
      tree.now.set(oldPath, null);
      return;
    }
    const before = tree.get(oldPath);
    if (before === null) throw new Fail('missing', oldPath);
    const move = oldPath !== newPath;
    if (move && tree.get(newPath) !== null) throw new Fail('exists', newPath);
    let doc = parseDoc(before);
    let d = 0;
    for (const h of s.hunks) {
      const oTexts = h.body.filter((it) => it.kind === 'ctx' || it.kind === 'old').map((it) => it.text);
      const nCount = h.body.filter((it) => it.kind === 'ctx' || it.kind === 'new').length;
      const bsAfter = bsAfterLastCtxOrNew(h);
      if (oTexts.length === 0) {
        const pos = Math.max(0, Math.min(h.A + d, doc.lines.length));
        const ins = h.body.filter((it) => it.kind === 'new').map((it) => it.text);
        const atEnd = pos === doc.lines.length;
        doc = {
          lines: [...doc.lines.slice(0, pos), ...ins, ...doc.lines.slice(pos)],
          br: doc.br,
          final: atEnd ? !bsAfter : doc.final,
        };
      } else {
        const found = findMatch(doc.lines, oTexts, strict);
        if (found === null) throw new Fail('no-match', oldPath);
        const target = h.A - 1 + d;
        let best = found.occ[0]!;
        for (const o of found.occ) if (Math.abs(o - target) < Math.abs(best - target)) best = o;
        const repl = buildReplacement(h.body, doc.lines, best, found.tier, oTexts[0]!);
        const runsToEnd = best + oTexts.length === doc.lines.length;
        doc = {
          lines: [...doc.lines.slice(0, best), ...repl, ...doc.lines.slice(best + oTexts.length)],
          br: doc.br,
          final: runsToEnd ? !bsAfter : doc.final,
        };
      }
      d += nCount - oTexts.length;
    }
    const text = serializeDoc(doc);
    if (move) {
      tree.now.set(newPath, text);
      tree.now.set(oldPath, null);
      tree.moves.push([oldPath, newPath]);
    } else {
      tree.now.set(oldPath, text);
    }
  });
}

// ---- SEARCH/REPLACE blocks (section 7) ----

interface SrBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function parseSearchReplace(lines: string[]): SrBlock[] {
  const blocks: SrBlock[] = [];
  let prevEnd = -1;
  let i = 0;
  const isMarker = (l: string, m: string): boolean => l.trimEnd() === m;
  while (i < lines.length) {
    if (!isMarker(lines[i]!, '<<<<<<< SEARCH')) {
      i += 1;
      continue;
    }
    let path: string | null = null;
    for (let j = i - 1; j > prevEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (blocks.length === 0) throw new Exit2(`error: parse ${i + 1}`);
      path = blocks[blocks.length - 1]!.path;
    }
    let k = i + 1;
    while (k < lines.length && !isMarker(lines[k]!, '=======')) k += 1;
    if (k >= lines.length) throw new Exit2(`error: parse ${i + 1}`);
    let m = k + 1;
    while (m < lines.length && !isMarker(lines[m]!, '>>>>>>> REPLACE')) m += 1;
    if (m >= lines.length) throw new Exit2(`error: parse ${i + 1}`);
    blocks.push({ path, oldLines: lines.slice(i + 1, k), newLines: lines.slice(k + 1, m) });
    prevEnd = m;
    i = m + 1;
  }
  return blocks;
}

function srEdits(blocks: SrBlock[], strict: boolean): Edit[] {
  return blocks.map((b) => (tree: Tree) => {
    if (!safe(b.path)) throw new Fail('unsafe', b.path);
    if (b.oldLines.length === 0) {
      if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
      tree.now.set(b.path, serializeDoc({ lines: b.newLines, br: '\n', final: true }));
      return;
    }
    const before = tree.get(b.path);
    if (before === null) throw new Fail('missing', b.path);
    const doc = parseDoc(before);
    const found = findMatch(doc.lines, b.oldLines, strict);
    if (found === null) throw new Fail('no-match', b.path);
    if (found.occ.length > 1) throw new Fail('ambiguous', b.path);
    const at = found.occ[0]!;
    let repl = b.newLines;
    if (found.tier === 2) {
      const F = leadWs(doc.lines[at]!);
      const P = leadWs(b.oldLines[0]!);
      repl = b.newLines.map((l) => reindentLine(l, F, P));
    }
    doc.lines = [...doc.lines.slice(0, at), ...repl, ...doc.lines.slice(at + b.oldLines.length)];
    tree.now.set(b.path, serializeDoc(doc));
  });
}

// ---- V4A patches (section 8) ----

interface V4aChunk {
  anchor: string | null;
  body: BodyItem[];
  eof: boolean;
}

interface V4aSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  fileLines: string[];
  moveTo: string | null;
  chunks: V4aChunk[];
}

function v4aBodyItem(text: string): BodyItem {
  if (text === '') return { kind: 'ctx', text: '', raw: text };
  if (text[0] === ' ') return { kind: 'ctx', text: text.slice(1), raw: text };
  if (text[0] === '-') return { kind: 'old', text: text.slice(1), raw: text };
  return { kind: 'new', text: text.slice(1), raw: text };
}

function parseV4a(lines: string[]): V4aSection[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last -= 1;
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sectionStart = (l: string): { kind: 'add' | 'delete' | 'update'; prefix: string } | null => {
    if (l.startsWith('*** Add File: ')) return { kind: 'add', prefix: '*** Add File: ' };
    if (l.startsWith('*** Delete File: ')) return { kind: 'delete', prefix: '*** Delete File: ' };
    if (l.startsWith('*** Update File: ')) return { kind: 'update', prefix: '*** Update File: ' };
    return null;
  };
  const sections: V4aSection[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    const st = sectionStart(line);
    if (st === null) throw new Exit2(`error: parse ${i + 1}`);
    const headerNo = i + 1;
    const path = trimSpaces(line.slice(st.prefix.length));
    i += 1;
    const raw: { text: string; no: number }[] = [];
    while (i < last && sectionStart(lines[i]!) === null) {
      raw.push({ text: lines[i]!, no: i + 1 });
      i += 1;
    }
    // Blank lines at the end of a section are not part of it.
    while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
    const section: V4aSection = { kind: st.kind, path, fileLines: [], moveTo: null, chunks: [] };
    if (st.kind === 'add') {
      for (const r of raw) {
        if (r.text.startsWith('+')) section.fileLines.push(r.text.slice(1));
        else if (r.text === '') section.fileLines.push('');
        else throw new Exit2(`error: parse ${r.no}`);
      }
    } else if (st.kind === 'delete') {
      if (raw.length > 0) throw new Exit2(`error: parse ${raw[0]!.no}`);
    } else {
      let idx = 0;
      if (raw.length > 0 && raw[0]!.text.startsWith('*** Move to: ')) {
        section.moveTo = trimSpaces(raw[0]!.text.slice('*** Move to: '.length));
        idx = 1;
      }
      let cur: V4aChunk | null = null;
      let anyChunk = false;
      for (; idx < raw.length; idx++) {
        const { text, no } = raw[idx]!;
        if (text.startsWith('@@')) {
          if (cur !== null) section.chunks.push(cur);
          const a = trimSpaces(text.slice(2));
          cur = { anchor: a === '' ? null : a, body: [], eof: false };
          anyChunk = true;
        } else if (text === '*** End of File') {
          if (cur === null) {
            cur = { anchor: null, body: [], eof: false };
            anyChunk = true;
          }
          cur.eof = true;
          section.chunks.push(cur);
          cur = null;
        } else if (text === '' || text[0] === ' ' || text[0] === '-' || text[0] === '+') {
          if (cur === null) {
            if (anyChunk) throw new Exit2(`error: parse ${no}`);
            cur = { anchor: null, body: [], eof: false };
            anyChunk = true;
          }
          cur.body.push(v4aBodyItem(text));
        } else {
          throw new Exit2(`error: parse ${no}`);
        }
      }
      if (cur !== null) section.chunks.push(cur);
      if (section.chunks.length === 0 && section.moveTo === null) throw new Exit2(`error: parse ${headerNo}`);
    }
    sections.push(section);
  }
  return sections;
}

function applyV4aUpdate(doc: Doc, chunks: V4aChunk[], strict: boolean, path: string): Doc {
  let lines = doc.lines;
  let cursor = 0;
  const maxTier = strict ? 0 : 2;
  for (const chunk of chunks) {
    if (chunk.anchor !== null) {
      let foundAt = -1;
      for (let t = 0; t <= maxTier && foundAt < 0; t++) {
        for (let j = cursor; j < lines.length; j++) {
          if (lineEq(lines[j]!, chunk.anchor, t)) {
            foundAt = j;
            break;
          }
        }
      }
      if (foundAt < 0) throw new Fail('no-match', path);
      cursor = foundAt + 1;
    }
    const oTexts = chunk.body.filter((it) => it.kind === 'ctx' || it.kind === 'old').map((it) => it.text);
    if (oTexts.length === 0) {
      const ins = chunk.body.filter((it) => it.kind === 'new').map((it) => it.text);
      const pos = chunk.eof ? lines.length : cursor;
      lines = [...lines.slice(0, pos), ...ins, ...lines.slice(pos)];
      cursor = pos + ins.length;
      continue;
    }
    let pos = -1;
    let tier = 0;
    if (chunk.eof) {
      const p = lines.length - oTexts.length;
      if (p >= cursor) {
        for (let t = 0; t <= maxTier; t++) {
          if (matchesAt(lines, oTexts, p, t)) {
            pos = p;
            tier = t;
            break;
          }
        }
      }
      if (pos < 0) throw new Fail('no-match', path);
    } else {
      const found = findMatch(lines, oTexts, strict, cursor);
      if (found === null) throw new Fail('no-match', path);
      pos = found.occ[0]!;
      tier = found.tier;
    }
    const repl = buildReplacement(chunk.body, lines, pos, tier, oTexts[0]!);
    lines = [...lines.slice(0, pos), ...repl, ...lines.slice(pos + oTexts.length)];
    cursor = pos + repl.length;
  }
  return { lines, br: doc.br, final: doc.final };
}

function v4aEdits(sections: V4aSection[], strict: boolean): Edit[] {
  return sections.map((s) => (tree: Tree) => {
    if (!safe(s.path)) throw new Fail('unsafe', s.path);
    if (s.kind === 'add') {
      if (tree.get(s.path) !== null) throw new Fail('exists', s.path);
      tree.now.set(s.path, serializeDoc({ lines: s.fileLines, br: '\n', final: true }));
      return;
    }
    if (s.kind === 'delete') {
      if (tree.get(s.path) === null) throw new Fail('missing', s.path);
      tree.now.set(s.path, null);
      return;
    }
    if (s.moveTo !== null && !safe(s.moveTo)) throw new Fail('unsafe', s.moveTo);
    const before = tree.get(s.path);
    if (before === null) throw new Fail('missing', s.path);
    if (s.moveTo !== null && tree.get(s.moveTo) !== null) throw new Fail('exists', s.moveTo);
    const doc = applyV4aUpdate(parseDoc(before), s.chunks, strict, s.path);
    const text = serializeDoc(doc);
    if (s.moveTo !== null) {
      tree.now.set(s.moveTo, text);
      tree.now.set(s.path, null);
      tree.moves.push([s.path, s.moveTo]);
    } else {
      tree.now.set(s.path, text);
    }
  });
}

// ---- JSON edits (section 9) ----

/** One JSON edit object, or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const doc = parseDoc(before);
      if (line < 0 || line > doc.lines.length) throw new Fail('no-match', p);
      doc.lines.splice(line, 0, ...add);
      tree.now.set(p, serializeDoc(doc));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---- Invocation, output, atomicity (sections 1, 2, 10) ----

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(parseUnified(lines), strict);
    else if (kind === 'search-replace') edits = srEdits(parseSearchReplace(lines), strict);
    else edits = v4aEdits(parseV4a(lines), strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // One line for each path whose state changed, in byte order; a successful move whose old path
  // is gone and whose new path is new is one `R` line sorted by the new path (section 2).
  const consumed = new Set<string>();
  const rows: { key: string; text: string }[] = [];
  for (const [o, n] of tree.moves) {
    if (consumed.has(o) || consumed.has(n)) continue;
    if (tree.original(o) !== null && tree.get(o) === null && tree.original(n) === null && tree.get(n) !== null) {
      rows.push({ key: n, text: `R ${o} -> ${n}` });
      consumed.add(o);
      consumed.add(n);
    }
  }
  for (const p of tree.now.keys()) {
    if (consumed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const [p, now] of tree.now) {
      if (tree.original(p) === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
