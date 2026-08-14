import { LocalGraphProvider } from '../src/graph/provider.js';

const root = process.argv[2] ?? 'fixtures/go-pokedex';
const anchor = process.argv[3] ?? 'pkg/handler/pokedex.go';

const graph = new LocalGraphProvider(root);
await graph.index();
console.log('stats:', JSON.stringify(graph.stats));
console.log('---- expand', anchor, '----');
console.log(graph.expand(anchor).text);
console.log('---- expand symbol addPokemon ----');
console.log(graph.expand('addPokemon').text);
console.log('---- tests for AddPokemon ----');
console.log(graph.testsFor('AddPokemon').text);
console.log('---- bad path ----');
console.log(graph.pathCandidates('server/handler/pokemon.go').text);
console.log('---- impact of editing service/pokemon.go ----');
console.log(graph.impact(['service/pokemon.go']).text);
