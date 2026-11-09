// Unified line diff (Myers), for the dry run and the downloaded script's preview.
// Self-contained like transform.ts, so the script embeds the same code.

type Op = {kind: ' ' | '-' | '+'; line: string};
function lineOps(a: string[], b: string[]): Op[] {
  const n = a.length, m = b.length, max = n + m, offset = max + 1;
  const v = new Int32Array(2 * max + 3), trace: Int32Array[] = [];
  outer: for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!) ? v[offset + k + 1]! : v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[offset + k] = x;
      if (x >= n && y >= m) break outer;
    }
  }
  const ops: Op[] = [];
  let x = n, y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const vd = trace[d]!, k = x - y;
    const prevK = k === -d || (k !== d && vd[offset + k - 1]! < vd[offset + k + 1]!) ? k + 1 : k - 1;
    const prevX = vd[offset + prevK]!, prevY = prevX - prevK;
    while (x > prevX && y > prevY) ops.push({kind: ' ', line: a[--x]!}), y--;
    if (d > 0) { if (x === prevX) ops.push({kind: '+', line: b[--y]!}); else ops.push({kind: '-', line: a[--x]!}); }
  }
  return ops.reverse();
}

export function unifiedDiff(path: string, before: string, after: string, context = 3): string {
  if (before === after) return '';
  const ops = lineOps(before.split('\n'), after.split('\n'));
  const changed = ops.map((op, i) => op.kind !== ' ' ? i : -1).filter(i => i >= 0);
  const out = [`--- a/${path}`, `+++ b/${path}`];
  let i = 0;
  while (i < changed.length) {
    let start = Math.max(0, changed[i]! - context), end = Math.min(ops.length, changed[i]! + context + 1);
    while (i + 1 < changed.length && changed[i + 1]! - context <= end) end = Math.min(ops.length, changed[++i]! + context + 1);
    i++;
    const aStart = ops.slice(0, start).filter(o => o.kind !== '+').length, bStart = ops.slice(0, start).filter(o => o.kind !== '-').length;
    const hunk = ops.slice(start, end), aLen = hunk.filter(o => o.kind !== '+').length, bLen = hunk.filter(o => o.kind !== '-').length;
    out.push(`@@ -${aStart + 1},${aLen} +${bStart + 1},${bLen} @@`, ...hunk.map(o => o.kind + o.line));
  }
  return out.join('\n') + '\n';
}
