import { Parser, Language, Query } from 'web-tree-sitter';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire('/Users/ksnaik/claudeprojects/sydes-agent/');
const wasmDir = require.resolve('tree-sitter-wasms/package.json').replace('package.json', 'out/');

await Parser.init();

const goSrc = `package handler

import (
	"net/http"
	"example.com/pokedex/helpers"
	"example.com/pokedex/service"
)

func addPokemon(w http.ResponseWriter, r *http.Request) {
	p, err := helpers.DecodePokemonJSON(r.Body)
	if err != nil {
		helpers.RespondWithError(w, 400, err)
		return
	}
	service.AddPokemon(p)
}

type Server struct { port int }

func (s *Server) Start() error { return nil }
`;

for (const lang of ['go', 'typescript']) {
  const bytes = await readFile(wasmDir + `tree-sitter-${lang}.wasm`);
  const L = await Language.load(bytes);
  const parser = new Parser();
  parser.setLanguage(L);
  const src = lang === 'go' ? goSrc : `import {a} from './b';\nexport function f(){ return a(1); }\nclass C { m(){ return f(); } }\n`;
  const tree = parser.parse(src);
  console.log(`[${lang}] abi=${L.abiVersion ?? L.version} root=${tree.rootNode.type} hasError=${tree.rootNode.hasError} children=${tree.rootNode.childCount}`);

  const qSrc = lang === 'go'
    ? `(function_declaration name: (identifier) @fn)
       (method_declaration name: (field_identifier) @method)
       (call_expression function: (selector_expression operand: (identifier) @pkg field: (field_identifier) @callee))`
    : `(function_declaration name: (identifier) @fn)
       (method_definition name: (property_identifier) @method)
       (call_expression function: (identifier) @callee)`;
  const q = new Query(L, qSrc);
  const caps = q.captures(tree.rootNode);
  console.log(`[${lang}] captures:`, caps.map(c => `${c.name}=${c.node.text}@${c.node.startPosition.row + 1}`).join(', '));
}
console.log('SPIKE OK');
