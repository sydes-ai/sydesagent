import { planCompile, detectProject } from '../src/agent/verify.js';
import { LocalGraphProvider, NullGraphProvider } from '../src/graph/provider.js';

const g = new LocalGraphProvider(process.cwd());
await g.index();
console.log('sydes (TS)  :', JSON.stringify(await planCompile(process.cwd(), ['src/graph/store.ts'], g)));

const go = new LocalGraphProvider('fixtures/go-pokedex');
await go.index();
console.log('go project  :', (await detectProject('fixtures/go-pokedex')).kind);
console.log('go scoped   :', JSON.stringify(await planCompile('fixtures/go-pokedex', ['service/pokemon.go'], go)));
console.log('go baseline :', JSON.stringify(await planCompile('fixtures/go-pokedex', ['service/pokemon.go'], new NullGraphProvider())));
