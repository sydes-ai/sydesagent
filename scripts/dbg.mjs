import { indexRepo } from '../src/graph/indexer.js';
import { walkRepo } from '../src/util/fs.js';
const root = process.argv[2];
const walked = await walkRepo(root);
console.log('walkRepo saw', walked.length, 'files;', walked.filter(f=>f.endsWith('.go')).length, 'go files');
console.log('sample:', walked.filter(f=>f.endsWith('.go')).slice(0,3));
const store = await indexRepo(root);
console.log('indexed', store.files().length, 'files');
console.log('sample indexed:', store.files().slice(0,3));
for (const g of ['core/logc/logs.go','core/logx/fields.go']) {
  console.log(g, '-> walked:', walked.includes(g), 'indexed:', store.files().includes(g));
}
