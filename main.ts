// mend implements SPEC.md's unified, SEARCH/REPLACE, V4A and JSON edits (MIT).
// Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

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
  readonly moves: [string, string][] = [];
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
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

type FileLines = { lines: string[]; br: string; final: boolean };
type BodyLine = { kind: string; text: string };
type Chunk = { body: BodyLine[]; at: number; anchor?: string; eof?: boolean };

function readLines(text: string): FileLines {
  const lf = text.indexOf('\n');
  const br = lf > 0 && text[lf - 1] === '\r' ? '\r\n' : '\n';
  const final = text !== '' && text.endsWith(br);
  const lines = text === '' ? [] : text.split(br);
  if (final) lines.pop();
  return { lines, br, final };
}
function writeLines(f: FileLines): string {
  return f.lines.length ? f.lines.join(f.br) + (f.final ? f.br : '') : '';
}
function paths(...ps: string[]): void {
  for (const p of ps) if (!safe(p)) throw new Fail('unsafe', p);
}
function required(tree: Tree, p: string): string {
  const text = tree.get(p);
  if (text === null) throw new Fail('missing', p);
  return text;
}
function occurrences(lines: string[], old: string[], strict: boolean, accepts = (_i: number) => true): { tier: number; positions: number[] } {
  for (let tier = 0; tier <= (strict ? 0 : 2); tier++) {
    const norm = (s: string) => tier === 0 ? s : tier === 1 ? s.replace(/[ \t]+$/, '') : s.replace(/^[ \t]+|[ \t]+$/g, '');
    const wanted = old.map(norm);
    const positions: number[] = [];
    for (let i = 0; i + old.length <= lines.length; i++) {
      if (accepts(i) && wanted.every((s, j) => s === norm(lines[i + j]!))) positions.push(i);
    }
    if (positions.length) return { tier, positions };
  }
  return { tier: 0, positions: [] };
}
function oldLines(body: BodyLine[]): string[] {
  return body.filter((l) => l.kind === ' ' || l.kind === '-').map((l) => l.text);
}
function replacement(body: BodyLine[], file: string[], at: number, tier: number): string[] {
  const old = oldLines(body);
  const p = old[0]?.match(/^[ \t]*/)![0] ?? '';
  const f = file[at]?.match(/^[ \t]*/)![0] ?? '';
  const out: string[] = [];
  let k = 0;
  for (const l of body) {
    if (l.kind === ' ') out.push(file[at + k++]!);
    else if (l.kind === '-') k++;
    else if (l.kind === '+') out.push(tier === 2 && /[^\s]/.test(l.text) && l.text.startsWith(p) ? f + l.text.slice(p.length) : l.text);
  }
  return out;
}
function parseError(line: number): never { throw new Exit2(`error: parse ${line}`); }

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  type Section = { old?: string; next?: string; fallbackOld?: string; fallbackNew?: string; renameOld?: string; renameNew?: string; create: boolean; remove: boolean; hunks: Chunk[] };
  const sections: Section[] = [];
  let section: Section | undefined;
  const start = () => {
    section = { create: false, remove: false, hunks: [] };
    sections.push(section);
    return section;
  };
  const path = (s: string) => {
    const p = s.split('\t')[0]!.trim();
    return p === '/dev/null' ? p : p.replace(/^[ab]\//, '');
  };
  for (let i = 0; i < lines.length;) {
    const l = lines[i]!;
    if (l.startsWith('diff --git')) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(l);
      if (!m) parseError(i + 1);
      const s = start();
      s.fallbackOld = m[1]; s.fallbackNew = m[2];
      i++; continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (!section || section.hunks.length) start();
      section!.old = path(l.slice(4)); section!.next = path(lines[i + 1]!.slice(4));
      i += 2; continue;
    }
    if (l.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(?:.*)$/.exec(l);
      if (!section || !m) parseError(i + 1);
      const chunk: Chunk = { at: Number(m[1]), body: [] };
      section.hunks.push(chunk); i++;
      while (i < lines.length) {
        const b = lines[i]!;
        if (b.startsWith('diff --git ') || (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ '))) break;
        if (b !== '' && ![' ', '-', '+', '\\'].includes(b[0]!)) break;
        chunk.body.push({ kind: b === '' ? ' ' : b[0]!, text: b.slice(1) });
        i++;
      }
      // Only literal empty patch lines are discarded, not explicit empty context.
      while (chunk.body.length && lines[i - 1] === '') { chunk.body.pop(); i--; }
      // Advance over those discarded lines without reading them as another body.
      while (i < lines.length && lines[i] === '') i++;
      continue;
    }
    if (section && section.hunks.length === 0) {
      if (l.startsWith('--- ')) parseError(i + 2);
      if (l.startsWith('rename from ')) section.renameOld = l.slice(12).trim();
      if (l.startsWith('rename to ')) section.renameNew = l.slice(10).trim();
      if (l.startsWith('new file mode')) section.create = true;
      if (l.startsWith('deleted file mode')) section.remove = true;
    }
    i++;
  }
  return sections.map((s): Edit => {
    const old = s.old ?? s.renameOld ?? s.fallbackOld ?? '';
    const next = s.next ?? s.renameNew ?? s.fallbackNew ?? '';
    const create = s.create || old === '/dev/null';
    const remove = s.remove || next === '/dev/null';
    return (tree) => {
      paths(...[old, next].filter((p) => p !== '/dev/null'));
      if (create) {
        if (tree.get(next) !== null) throw new Fail('exists', next);
        const body = s.hunks.flatMap((h) => h.body);
        const add = body.filter((l) => l.kind === '+').map((l) => l.text);
        const last = body.findLastIndex((l) => l.kind === '+');
        tree.now.set(next, writeLines({ lines: add, br: '\n', final: body[last + 1]?.kind !== '\\' }));
        return;
      }
      const text = required(tree, old);
      if (remove) { tree.now.set(old, null); return; }
      if (old !== next && tree.get(next) !== null) throw new Fail('exists', next);
      const f = readLines(text);
      let d = 0;
      for (const h of s.hunks) {
        const o = oldLines(h.body);
        let at = Math.max(0, Math.min(f.lines.length, h.at + d));
        let tier = 0;
        if (o.length) {
          const match = occurrences(f.lines, o, strict);
          if (!match.positions.length) throw new Fail('no-match', old);
          const target = h.at - 1 + d;
          at = match.positions.reduce((a, b) => Math.abs(b - target) < Math.abs(a - target) ? b : a);
          tier = match.tier;
        }
        const n = replacement(h.body, f.lines, at, tier);
        if (at + o.length === f.lines.length) {
          const last = h.body.findLastIndex((l) => l.kind === ' ' || l.kind === '+');
          f.final = h.body[last + 1]?.kind !== '\\';
        }
        f.lines.splice(at, o.length, ...n);
        d += n.length - o.length;
      }
      tree.now.set(next, writeLines(f));
      if (old !== next) { tree.now.set(old, null); tree.moves.push([old, next]); }
    };
  });
}

function searchEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let previousPath: string | undefined;
  let after = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') continue;
    const search = i;
    let p = previousPath;
    for (let j = i - 1; j >= after; j--) {
      const candidate = lines[j]!.trim();
      if (candidate !== '' && !candidate.startsWith('```')) { p = candidate; break; }
    }
    if (p === undefined) parseError(search + 1);
    let middle = i + 1;
    while (middle < lines.length && lines[middle]!.trimEnd() !== '=======') middle++;
    let end = middle + 1;
    while (end < lines.length && lines[end]!.trimEnd() !== '>>>>>>> REPLACE') end++;
    if (middle >= lines.length || end >= lines.length) parseError(search + 1);
    const old = lines.slice(i + 1, middle);
    const next = lines.slice(middle + 1, end);
    edits.push(searchEdit(p, old, next, strict));
    previousPath = p; after = end + 1; i = end;
  }
  return edits;
}

function searchEdit(p: string, old: string[], next: string[], strict: boolean): Edit {
  return (tree) => {
    paths(p);
    if (!old.length) {
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, writeLines({ lines: next, br: '\n', final: true }));
      return;
    }
    const f = readLines(required(tree, p));
    const match = occurrences(f.lines, old, strict);
    if (!match.positions.length) throw new Fail('no-match', p);
    if (match.positions.length > 1) throw new Fail('ambiguous', p);
    const at = match.positions[0]!;
    const body = [...old.map((text) => ({ kind: '-', text })), ...next.map((text) => ({ kind: '+', text }))];
    f.lines.splice(at, old.length, ...replacement(body, f.lines, at, match.tier));
    tree.now.set(p, writeLines(f));
  };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) parseError(1);
  if (lines[first]!.trim() !== '*** Begin Patch') parseError(first + 1);
  const last = lines.findLastIndex((l) => !blank(l));
  if (lines[last]!.trim() !== '*** End Patch') parseError(lines.length + 1);
  const header = (l: string) => /^\*\*\* (Add|Delete|Update) File: /.exec(l);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    if (blank(lines[i]!)) { i++; continue; }
    const m = header(lines[i]!);
    if (!m) parseError(i + 1);
    const sectionLine = i + 1;
    const kind = m[1]!;
    const p = lines[i]!.slice(m[0].length).trim();
    const begin = ++i;
    while (i < last && !header(lines[i]!)) i++;
    let end = i;
    while (end > begin && blank(lines[end - 1]!)) end--;
    if (kind === 'Add') {
      const add: string[] = [];
      for (let j = begin; j < end; j++) {
        if (lines[j] !== '' && !lines[j]!.startsWith('+')) parseError(j + 1);
        add.push(lines[j]!.slice(1));
      }
      edits.push((tree) => {
        paths(p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, writeLines({ lines: add, br: '\n', final: true }));
      });
    } else if (kind === 'Delete') {
      if (end > begin) parseError(begin + 1);
      edits.push((tree) => { paths(p); required(tree, p); tree.now.set(p, null); });
    } else {
      let j = begin;
      let move: string | undefined;
      if (j < end && lines[j]!.startsWith('*** Move to: ')) move = lines[j++]!.slice(13).trim();
      const chunks: Chunk[] = [];
      let current: Chunk | undefined;
      while (j < end) {
        const l = lines[j]!;
        if (l.startsWith('@@')) {
          current = { at: 0, anchor: l.slice(2).trim(), body: [] };
          chunks.push(current);
        } else if (l === '*** End of File') {
          if (!current) parseError(j + 1);
          current.eof = true;
          current = undefined;
        } else if (l === '' || [' ', '-', '+'].includes(l[0]!)) {
          if (!current) {
            if (chunks.length) parseError(j + 1);
            current = { at: 0, body: [] }; chunks.push(current);
          }
          current.body.push({ kind: l === '' ? ' ' : l[0]!, text: l.slice(1) });
        } else parseError(j + 1);
        j++;
      }
      if (!chunks.length && move === undefined) parseError(sectionLine);
      edits.push(v4aUpdate(p, move, chunks, strict));
    }
  }
  return edits;
}

function v4aUpdate(p: string, move: string | undefined, chunks: Chunk[], strict: boolean): Edit {
  return (tree) => {
    paths(p, ...(move === undefined ? [] : [move]));
    const f = readLines(required(tree, p));
    if (move !== undefined && tree.get(move) !== null) throw new Fail('exists', move);
    let cursor = 0;
    for (const chunk of chunks) {
      if (chunk.anchor) {
        const match = occurrences(f.lines, [chunk.anchor], strict, (i) => i >= cursor);
        if (!match.positions.length) throw new Fail('no-match', p);
        cursor = match.positions[0]! + 1;
      }
      const old = oldLines(chunk.body);
      let at = chunk.eof ? f.lines.length : cursor;
      let tier = 0;
      if (old.length) {
        const match = occurrences(f.lines, old, strict, (i) => i >= cursor && (!chunk.eof || i + old.length === f.lines.length));
        if (!match.positions.length) throw new Fail('no-match', p);
        at = match.positions[0]!; tier = match.tier;
      }
      const next = replacement(chunk.body, f.lines, at, tier);
      f.lines.splice(at, old.length, ...next);
      cursor = at + next.length;
    }
    tree.now.set(move ?? p, writeLines(f));
    if (move !== undefined) { tree.now.set(p, null); tree.moves.push([p, move]); }
  };
}

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
    edits = kind === 'json' ? jsonEdits(text, lines) : kind === 'unified' ? unifiedEdits(lines, strict) : kind === 'search-replace' ? searchEdits(lines, strict) : v4aEdits(lines, strict);
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
  const output = new Map<string, string>();
  const paired = new Set<string>();
  for (const [old, next] of tree.moves) {
    if (!paired.has(old) && !paired.has(next) && tree.original(old) !== null && tree.get(old) === null && tree.original(next) === null && tree.get(next) !== null) {
      paired.add(old); paired.add(next);
      output.set(next, `R ${old} -> ${next}`);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (!paired.has(p)) output.set(p, `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`);
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  const rows = [...output].sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b))).map(([, row]) => row);
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
