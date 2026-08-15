import { loadDataset } from '../src/bench/dataset.js';
const before = process.memoryUsage().heapUsed;
const t = Date.now();
const rows = await loadDataset([process.argv[2]]);
const mb = (n) => (n / 1024 / 1024).toFixed(0);
console.log(`loaded ${rows.length} instances in ${Date.now() - t}ms`);
console.log(`heap used: ${mb(process.memoryUsage().heapUsed - before)} MB (file is 572 MB)`);
console.log(`fields kept:`, Object.keys(rows[0]).join(', '));
console.log(`run_result dropped:`, !('run_result' in rows[0]));
