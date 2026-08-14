import { indexRepo } from '../src/graph/indexer.js';
import { fileOutline, envelopeFor, formatEnvelope } from '../src/graph/outline.js';
import { readFileSync } from 'node:fs';

const store = await indexRepo('.');
const tok = (s) => Math.ceil(s.length / 4);

for (const f of ['src/agent/tools/files.ts', 'src/graph/resolve.ts', 'src/telemetry/metrics.ts']) {
  const src = readFileSync(f, 'utf8');
  const out = fileOutline(store, f);
  console.log(`${f}\n  whole file ${tok(src)} tok -> outline ${tok(out)} tok  (${(100 - (100 * tok(out)) / tok(src)).toFixed(0)}% smaller)`);
}

const parts = envelopeFor(store, 'computeMetrics');
if (parts) {
  const src = readFileSync(parts.node.file, 'utf8');
  const body = src.split('\n').slice(parts.node.startLine - 1, parts.node.endLine).join('\n');
  console.log(`\nenvelope(computeMetrics): ${tok(formatEnvelope(parts, body))} tok vs whole file ${tok(src)} tok`);
}
