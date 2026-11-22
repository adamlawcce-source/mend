// mend: one patch tool for every AI edit format (SPEC.md version 1).
// Node 22, the standard library alone; run as `node main.ts [options] [PATCH]`.
//
// Implements all of SPEC.md: the command line, output and exit codes (sections 1-2),
// files, lines and paths (section 3), format detection (section 4), three-tier line
// matching (section 5), unified diffs (section 6), SEARCH/REPLACE blocks (section 7),
// V4A patches (section 8), JSON edits (section 9) and order/atomicity (section 10).
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then
// this file hands over to runner.ts (the last lines below): keep that hand-over and
// runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<[string, string]> = [];
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

// ---------------------------------------------------------------------------
// Section 3: a file's lines, its line break, and whether it ends with one.
// ---------------------------------------------------------------------------

interface FileParts {
  br: string;
  lines: string[];
  final: boolean;
}

function fileParts(text: string): FileParts {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

function joinFile(br: string, lines: string[], final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (final ? br : '');
}

// ---------------------------------------------------------------------------
// Section 5: matching lines at three tiers, and re-indenting new lines.
// ---------------------------------------------------------------------------

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

function tierKey(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Every 0-based position where O occurs in `lines` at `tier`. */
function occurrences(lines: string[], o: string[], tier: number): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  const ok = o.map((l) => tierKey(l, tier));
  for (let i = 0; i + o.length <= lines.length; i++) {
    let good = true;
    for (let j = 0; j < o.length; j++) {
      if (tierKey(lines[i + j]!, tier) !== ok[j]) {
        good = false;
        break;
      }
    }
    if (good) out.push(i);
  }
  return out;
}

/** The first tier (0, then 1, then 2; only 0 when strict) with an occurrence at or after `from`. */
function findAtTier(
  lines: string[],
  o: string[],
  strict: boolean,
  from = 0,
): { tier: number; occ: number[] } | null {
  const max = strict ? 0 : 2;
  for (let t = 0; t <= max; t++) {
    const occ = occurrences(lines, o, t).filter((i) => i >= from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** One line of N: a context line (written as the file's own matched line) or a new line. */
interface NLine {
  text: string;
  ctx: boolean;
  oIndex: number;
}

/**
 * The replacement lines for a match of O at `at`: context lines come from the file,
 * other lines are re-indented at tier 2 (section 5) and written as they are otherwise.
 */
function buildReplacement(fileLines: string[], at: number, o: string[], n: NLine[], tier: number): string[] {
  const f = o.length > 0 && at < fileLines.length ? leadingWs(fileLines[at]!) : '';
  const p = o.length > 0 ? leadingWs(o[0]!) : '';
  return n.map((e) => {
    if (e.ctx) return fileLines[at + e.oIndex]!;
    if (tier !== 2) return e.text;
    if (e.text === '' || /^[ \t]+$/.test(e.text)) return e.text;
    if (e.text.startsWith(p)) return f + e.text.slice(p.length);
    return e.text;
  });
}

/** One body line of a hunk or chunk: context, old, new, or a `\` line (unified only). */
interface BodyItem {
  kind: 'ctx' | 'old' | 'new' | 'bslash';
  text: string;
}

function bodyItem(l: string): BodyItem {
  if (l === '') return { kind: 'ctx', text: '' };
  if (l[0] === ' ') return { kind: 'ctx', text: l.slice(1) };
  if (l[0] === '-') return { kind: 'old', text: l.slice(1) };
  if (l[0] === '+') return { kind: 'new', text: l.slice(1) };
  return { kind: 'bslash', text: l.slice(1) };
}

/** Split a body into O (context and old lines) and N (context and new lines). */
function splitBody(body: BodyItem[]): { o: string[]; n: NLine[] } {
  const o: string[] = [];
  const n: NLine[] = [];
  for (const b of body) {
    if (b.kind === 'ctx') {
      o.push(b.text);
      n.push({ text: b.text, ctx: true, oIndex: o.length - 1 });
    } else if (b.kind === 'old') {
      o.push(b.text);
    } else if (b.kind === 'new') {
      n.push({ text: b.text, ctx: false, oIndex: -1 });
    }
  }
  return { o, n };
}

// ---------------------------------------------------------------------------
// Section 6: unified diffs.
// ---------------------------------------------------------------------------

interface Hunk {
  a: number;
  body: BodyItem[];
  /** A `\` line follows this hunk's last context or `+` line. */
  lastBs: boolean;
}

interface USection {
  oldPath: string | null;
  newPath: string | null;
  isCreation: boolean;
  isDeletion: boolean;
  hunks: Hunk[];
  hasPair: boolean;
}

/** The path of a `--- ` / `+++ ` line: after the four characters, up to the first tab, trimmed, a/ or b/ removed. */
function headerPath(line: string): string | null {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function parseDiffGit(line: string, idx: number): { x: string; y: string } {
  const fail = (): never => {
    throw new Exit2(`error: parse ${idx + 1}`);
  };
  if (!line.startsWith('diff --git a/')) fail();
  const rest = line.trimEnd().slice('diff --git a/'.length);
  const cut = rest.indexOf(' b/');
  if (cut < 0) fail();
  const x = rest.slice(0, cut);
  const y = rest.slice(cut + 3);
  if (x === '' || y === '') fail();
  return { x, y };
}

function parseHunkHeader(line: string, idx: number): number {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
  if (m === null) throw new Exit2(`error: parse ${idx + 1}`);
  return Number(m[1]);
}

/** Whether a `\` line follows the body's last context or `+` line. */
function computeLastBs(body: BodyItem[]): boolean {
  let last = -1;
  for (let i = 0; i < body.length; i++) {
    if (body[i]!.kind === 'ctx' || body[i]!.kind === 'new') last = i;
  }
  if (last < 0) return false;
  return body[last + 1] !== undefined && body[last + 1]!.kind === 'bslash';
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const n = lines.length;
  const sections: USection[] = [];
  let cur: USection | null = null;
  let i = 0;
  const nextIsPlusPlus = (j: number): boolean => j + 1 < n && lines[j + 1]!.startsWith('+++ ');
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const { x, y } = parseDiffGit(line, i);
      cur = { oldPath: x, newPath: y, isCreation: false, isDeletion: false, hunks: [], hasPair: false };
      sections.push(cur);
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && nextIsPlusPlus(i)) {
      if (cur !== null && cur.hunks.length === 0 && !cur.hasPair) {
        cur.oldPath = headerPath(line);
        cur.newPath = headerPath(lines[i + 1]!);
        cur.hasPair = true;
      } else {
        cur = {
          oldPath: headerPath(line),
          newPath: headerPath(lines[i + 1]!),
          isCreation: false,
          isDeletion: false,
          hunks: [],
          hasPair: true,
        };
        sections.push(cur);
      }
      i += 2;
      continue;
    }
    if (line.startsWith('--- ') && cur !== null && cur.hunks.length === 0) {
      throw new Exit2(`error: parse ${i + 2}`);
    }
    if (line.startsWith('@@')) {
      const a = parseHunkHeader(line, i);
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      let j = i + 1;
      const body: BodyItem[] = [];
      while (j < n) {
        const l = lines[j]!;
        if (l.startsWith('diff --git ')) break;
        if (l.startsWith('--- ') && j + 1 < n && lines[j + 1]!.startsWith('+++ ')) break;
        if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\') {
          body.push(bodyItem(l));
          j += 1;
        } else break;
      }
      // Empty lines at the end of a body are not part of it.
      while (body.length > 0) {
        const last = body[body.length - 1]!;
        if (last.kind === 'ctx' && last.text === '') body.pop();
        else break;
      }
      cur.hunks.push({ a, body, lastBs: computeLastBs(body) });
      i = j;
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (line.startsWith('rename from ')) {
        if (!cur.hasPair) cur.oldPath = line.slice('rename from '.length).trim();
      } else if (line.startsWith('rename to ')) {
        if (!cur.hasPair) cur.newPath = line.slice('rename to '.length).trim();
      } else if (line.startsWith('+++ ')) {
        if (!cur.hasPair) cur.newPath = headerPath(line);
      } else if (line === 'new file mode' || line.startsWith('new file mode ')) {
        cur.isCreation = true;
      } else if (line === 'deleted file mode' || line.startsWith('deleted file mode ')) {
        cur.isDeletion = true;
      }
      // Every other header line is ignored.
    }
    // Outside bodies, lines that are not part of a section header are ignored.
    i += 1;
  }
  return sections.map((sec) => unifiedSectionEdit(sec, strict));
}

/** Apply one hunk to a file's parts; `d` is the length drift of this section's earlier hunks. */
function applyUnifiedHunk(fl: FileParts, hunk: Hunk, d: number, strict: boolean, failPath: string): FileParts {
  const { o, n } = splitBody(hunk.body);
  const lines = fl.lines;
  if (o.length === 0) {
    const pos = Math.min(Math.max(hunk.a + d, 0), lines.length);
    const out = [...lines.slice(0, pos), ...n.map((e) => e.text), ...lines.slice(pos)];
    return { br: fl.br, lines: out, final: pos === lines.length ? !hunk.lastBs : fl.final };
  }
  const found = findAtTier(lines, o, strict);
  if (found === null) throw new Fail('no-match', failPath);
  const target = hunk.a - 1 + d;
  let best = found.occ[0]!;
  let bestDist = Math.abs(best - target);
  for (const p of found.occ) {
    const dist = Math.abs(p - target);
    if (dist < bestDist) {
      best = p;
      bestDist = dist;
    }
  }
  const rep = buildReplacement(lines, best, o, n, found.tier);
  const out = [...lines.slice(0, best), ...rep, ...lines.slice(best + o.length)];
  const touchesEnd = best + o.length === lines.length;
  return { br: fl.br, lines: out, final: touchesEnd ? !hunk.lastBs : fl.final };
}

function unifiedSectionEdit(sec: USection, strict: boolean): Edit {
  const oldP = sec.oldPath;
  const newP = sec.newPath;
  const isCreation = sec.isCreation || oldP === null;
  const isDeletion = !isCreation && (sec.isDeletion || newP === null);
  const isMove = !isCreation && !isDeletion && oldP !== null && newP !== null && oldP !== newP;
  if (isCreation) {
    const p = newP as string | null;
    return (tree) => {
      if (p === null) return;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plus: string[] = [];
      let lastPlusBs = false;
      for (const h of sec.hunks) {
        for (let k = 0; k < h.body.length; k++) {
          const b = h.body[k]!;
          if (b.kind === 'new') {
            plus.push(b.text);
            lastPlusBs = h.body[k + 1] !== undefined && h.body[k + 1]!.kind === 'bslash';
          }
        }
      }
      tree.now.set(p, plus.length === 0 ? '' : plus.join('\n') + (lastPlusBs ? '' : '\n'));
    };
  }
  if (isDeletion) {
    const p = oldP as string | null;
    return (tree) => {
      if (p === null) return;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
    };
  }
  if (isMove) {
    const op = oldP!;
    const np = newP!;
    return (tree) => {
      if (!safe(op)) throw new Fail('unsafe', op);
      if (!safe(np)) throw new Fail('unsafe', np);
      const before = tree.get(op);
      if (before === null) throw new Fail('missing', op);
      if (tree.get(np) !== null) throw new Fail('exists', np);
      let fl = fileParts(before);
      let d = 0;
      for (const h of sec.hunks) {
        const { o, n } = splitBody(h.body);
        fl = applyUnifiedHunk(fl, h, d, strict, op);
        d += n.length - o.length;
      }
      const text = joinFile(fl.br, fl.lines, fl.final);
      tree.now.set(np, text);
      tree.now.set(op, null);
      tree.moves.push([op, np]);
    };
  }
  const p = oldP!;
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    let fl = fileParts(before);
    let d = 0;
    for (const h of sec.hunks) {
      const { o, n } = splitBody(h.body);
      fl = applyUnifiedHunk(fl, h, d, strict, p);
      d += n.length - o.length;
    }
    tree.now.set(p, joinFile(fl.br, fl.lines, fl.final));
  };
}

// ---------------------------------------------------------------------------
// Section 7: SEARCH/REPLACE blocks.
// ---------------------------------------------------------------------------

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let prevEnd = 0;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchIdx = i;
    let path: string | null = null;
    for (let j = searchIdx - 1; j >= prevEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
      path = prevPath;
    }
    let sep = -1;
    let j = searchIdx + 1;
    for (; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') {
        sep = j;
        break;
      }
      if (t === '>>>>>>> REPLACE' || t === '<<<<<<< SEARCH') break;
    }
    if (sep < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let end = -1;
    for (j = sep + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '>>>>>>> REPLACE') {
        end = j;
        break;
      }
      if (t === '<<<<<<< SEARCH') break;
    }
    if (end < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    const oldLines = lines.slice(searchIdx + 1, sep);
    const newLines = lines.slice(sep + 1, end);
    edits.push(srEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevEnd = end + 1;
    i = end + 1;
  }
  return edits;
}

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const fl = fileParts(before);
    const found = findAtTier(fl.lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const at = found.occ[0]!;
    const rep = buildReplacement(
      fl.lines,
      at,
      oldLines,
      newLines.map((t) => ({ text: t, ctx: false, oIndex: -1 })),
      found.tier,
    );
    const out = [...fl.lines.slice(0, at), ...rep, ...fl.lines.slice(at + oldLines.length)];
    tree.now.set(path, joinFile(fl.br, out, fl.final));
  };
}

// ---------------------------------------------------------------------------
// Section 8: V4A patches.
// ---------------------------------------------------------------------------

interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: BodyItem[];
}

/** The path after a `*** Add File: ` / `*** Delete File: ` / `*** Update File: ` / `*** Move to: ` marker, or null. */
function v4aMarkerPath(line: string, marker: string): string | null {
  const prefix = `${marker} `;
  if (line.startsWith(prefix)) return line.slice(prefix.length).trim();
  if (line === marker) return '';
  return null;
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    let p = v4aMarkerPath(line, '*** Add File:');
    if (p !== null) {
      const start = i;
      i += 1;
      const content: number[] = [];
      while (i < last) {
        const l = lines[i]!;
        if (v4aMarkerPath(l, '*** Add File:') !== null || v4aMarkerPath(l, '*** Delete File:') !== null || v4aMarkerPath(l, '*** Update File:') !== null) break;
        content.push(i);
        i += 1;
      }
      while (content.length > 0 && blank(lines[content[content.length - 1]!]!)) content.pop();
      const addLines: string[] = [];
      for (const idx of content) {
        const l = lines[idx]!;
        if (l === '') addLines.push('');
        else if (l[0] === '+') addLines.push(l.slice(1));
        else throw new Exit2(`error: parse ${idx + 1}`);
      }
      edits.push(v4aAddEdit(p, addLines));
      continue;
    }
    p = v4aMarkerPath(line, '*** Delete File:');
    if (p !== null) {
      i += 1;
      const content: number[] = [];
      while (i < last) {
        const l = lines[i]!;
        if (v4aMarkerPath(l, '*** Add File:') !== null || v4aMarkerPath(l, '*** Delete File:') !== null || v4aMarkerPath(l, '*** Update File:') !== null) break;
        content.push(i);
        i += 1;
      }
      while (content.length > 0 && blank(lines[content[content.length - 1]!]!)) content.pop();
      for (const idx of content) throw new Exit2(`error: parse ${idx + 1}`);
      edits.push(v4aDeleteEdit(p));
      continue;
    }
    p = v4aMarkerPath(line, '*** Update File:');
    if (p !== null) {
      const updateIdx = i;
      i += 1;
      const content: number[] = [];
      while (i < last) {
        const l = lines[i]!;
        if (v4aMarkerPath(l, '*** Add File:') !== null || v4aMarkerPath(l, '*** Delete File:') !== null || v4aMarkerPath(l, '*** Update File:') !== null) break;
        content.push(i);
        i += 1;
      }
      while (content.length > 0 && blank(lines[content[content.length - 1]!]!)) content.pop();
      edits.push(v4aUpdateEdit(p, content.map((idx) => lines[idx]!), content, updateIdx, strict));
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

function v4aAddEdit(path: string, addLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, addLines.length === 0 ? '' : addLines.join('\n') + '\n');
  };
}

function v4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function v4aUpdateEdit(path: string, content: string[], contentIdx: number[], updateIdx: number, strict: boolean): Edit {
  let moveTo: string | null = null;
  let idx = 0;
  if (content.length > 0) {
    const m = v4aMarkerPath(content[0]!, '*** Move to:');
    if (m !== null) {
      moveTo = m;
      idx = 1;
    }
  }
  const chunks: VChunk[] = [];
  let curChunk: VChunk | null = null;
  for (; idx < content.length; idx++) {
    const l = content[idx]!;
    const lineNo = contentIdx[idx]! + 1;
    if (l.startsWith('@@')) {
      curChunk = { anchor: l.slice(2).trim(), eof: false, body: [] };
      if (curChunk.anchor === '') curChunk.anchor = null;
      chunks.push(curChunk);
    } else if (l === '*** End of File') {
      if (curChunk === null) throw new Exit2(`error: parse ${lineNo}`);
      curChunk.eof = true;
      curChunk = null;
    } else if (l.startsWith('*** Move to:')) {
      throw new Exit2(`error: parse ${lineNo}`);
    } else if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
      if (curChunk === null) {
        if (chunks.length > 0) throw new Exit2(`error: parse ${lineNo}`);
        curChunk = { anchor: null, eof: false, body: [] };
        chunks.push(curChunk);
      }
      curChunk.body.push(bodyItem(l));
    } else {
      throw new Exit2(`error: parse ${lineNo}`);
    }
  }
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateIdx + 1}`);
  const move = moveTo;
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (move !== null && !safe(move)) throw new Fail('unsafe', move);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (move !== null && tree.get(move) !== null) throw new Fail('exists', move);
    const fl = fileParts(before);
    let cur = fl.lines;
    let cursor = 0;
    for (const chunk of chunks) {
      if (chunk.anchor !== null) {
        const found = findAtTier(cur, [chunk.anchor], strict, cursor);
        if (found === null) throw new Fail('no-match', path);
        cursor = found.occ[0]! + 1;
      }
      const { o, n } = splitBody(chunk.body);
      if (o.length === 0) {
        const pos = chunk.eof ? cur.length : cursor;
        const ins = n.map((e) => e.text);
        cur = [...cur.slice(0, pos), ...ins, ...cur.slice(pos)];
        cursor = pos + ins.length;
      } else {
        const found = findAtTier(cur, o, strict, cursor);
        if (found === null) throw new Fail('no-match', path);
        let at: number;
        if (chunk.eof) {
          const lastPos = cur.length - o.length;
          if (lastPos < cursor || !found.occ.includes(lastPos)) throw new Fail('no-match', path);
          at = lastPos;
        } else {
          at = found.occ[0]!;
        }
        const rep = buildReplacement(cur, at, o, n, found.tier);
        cur = [...cur.slice(0, at), ...rep, ...cur.slice(at + o.length)];
        cursor = at + rep.length;
      }
    }
    const text = joinFile(fl.br, cur, fl.final);
    if (move !== null) {
      tree.now.set(move, text);
      tree.now.set(path, null);
      tree.moves.push([path, move]);
    } else {
      tree.now.set(path, text);
    }
  };
}

// ---------------------------------------------------------------------------
// Section 9: JSON edits.
// ---------------------------------------------------------------------------

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
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
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
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

// ---------------------------------------------------------------------------
// Sections 1, 2 and 10: the command line, the output, and the all-or-nothing write.
// ---------------------------------------------------------------------------

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
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
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
  // The output rows, in byte order of the paths (an R row sorts by its new path).
  const rows: Array<{ key: string; line: string; path: string; now: string | null }> = [];
  const suppressed = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    if (tree.original(oldP) !== null && tree.original(newP) === null && tree.get(oldP) === null && tree.get(newP) !== null) {
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}`, path: newP, now: tree.get(newP) });
      suppressed.add(oldP);
      suppressed.add(newP);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (suppressed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`, path: p, now });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const out = [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`];
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const now = tree.now.get(p)!;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out };
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
