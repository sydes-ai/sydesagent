import { indexRepo } from '../src/graph/indexer.js';
import { unknownSymbols } from '../src/graph/validate.js';

const root = process.argv[2] ?? 'fixtures/go-pokedex';
const store = await indexRepo(root);

let total = 0;
for (const file of store.files()) {
  const unknowns = unknownSymbols(store, file);
  total += unknowns.length;
  for (const u of unknowns) {
    const label = u.qualifier ? `${u.qualifier}.${u.name}` : u.name;
    console.log(`${file}:${u.line}  ${label}  [${u.reason}]`);
  }
}
console.log(`\n${total} unknown symbol(s) across ${store.files().length} clean file(s)`);
