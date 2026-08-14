/**
 * Unified-diff parsing, used only to read the benchmark's answer key.
 *
 * `fix_patch` names exactly the files a correct change touches, which makes it a ground truth
 * for graph quality that costs no model calls to evaluate against.
 */

export type PatchStatus = 'added' | 'modified' | 'deleted';

export interface PatchFile {
  path: string;
  status: PatchStatus;
}

/** git quotes paths containing unusual characters; unwrap and unescape them. */
function unquote(value: string): string {
  if (!value.startsWith('"') || !value.endsWith('"')) return value;
  return value
    .slice(1, -1)
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\')
    .replace(/\\t/g, '\t');
}

function stripPrefix(value: string): string {
  const cleaned = unquote(value.trim());
  return cleaned.replace(/^[ab]\//, '');
}

export function parsePatchFiles(patch: string): PatchFile[] {
  const out: PatchFile[] = [];
  if (!patch) return out;

  const lines = patch.split('\n');
  let current: { a?: string; b?: string; status: PatchStatus } | undefined;

  const flush = () => {
    if (!current) return;
    const path = current.status === 'deleted' ? current.a : (current.b ?? current.a);
    if (path && path !== '/dev/null') out.push({ path, status: current.status });
    current = undefined;
  };

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      flush();
      // `diff --git a/x b/y` - split on ` b/` so paths containing spaces survive.
      const rest = line.slice('diff --git '.length);
      const marker = rest.lastIndexOf(' b/');
      const a = marker >= 0 ? rest.slice(0, marker) : rest;
      const b = marker >= 0 ? rest.slice(marker + 1) : rest;
      current = { a: stripPrefix(a), b: stripPrefix(b), status: 'modified' };
      continue;
    }
    if (!current) continue;

    if (line.startsWith('new file mode')) current.status = 'added';
    else if (line.startsWith('deleted file mode')) current.status = 'deleted';
    else if (line.startsWith('rename to ')) current.b = stripPrefix(line.slice('rename to '.length));
    else if (line.startsWith('rename from ')) current.a = stripPrefix(line.slice('rename from '.length));
    else if (line.startsWith('--- ') && line.slice(4).trim() === '/dev/null') current.status = 'added';
    else if (line.startsWith('+++ ') && line.slice(4).trim() === '/dev/null') current.status = 'deleted';
  }
  flush();

  return out;
}

/** Files that a correct change modifies or adds - the target set for change-surface recall. */
export function changedFiles(patch: string): string[] {
  return [...new Set(parsePatchFiles(patch).map((f) => f.path))];
}
