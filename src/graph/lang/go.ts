import type { Node, Tree } from 'web-tree-sitter';
import type { DefFact, ImportFact, RefFact } from '../model.js';
import { lineOf, signatureOf, type ExtractResult, type LanguageAdapter } from './types.js';

/**
 * Builtins never resolve to a repo symbol. Filtering them at extraction keeps the
 * unresolved-reference count meaningful as a graph-health signal instead of a constant.
 */
const GO_BUILTINS = new Set([
  'append', 'cap', 'clear', 'close', 'complex', 'copy', 'delete', 'imag', 'len', 'make', 'max',
  'min', 'new', 'panic', 'print', 'println', 'real', 'recover',
  'bool', 'byte', 'comparable', 'complex64', 'complex128', 'error', 'float32', 'float64', 'int',
  'int8', 'int16', 'int32', 'int64', 'rune', 'string', 'uint', 'uint8', 'uint16', 'uint32',
  'uint64', 'uintptr', 'any', 'nil', 'true', 'false', 'iota',
]);

/** Go exports by capitalisation - the one place the language makes visibility trivial. */
function isExported(name: string): boolean {
  return /^[A-Z]/.test(name);
}

function unquote(text: string): string {
  return text.replace(/^[`"]/, '').replace(/[`"]$/, '');
}

/** Strips `*` and package qualifiers from a receiver type: `*Handler` -> `Handler`. */
function receiverTypeName(node: Node | null): string | undefined {
  if (!node) return undefined;
  const stack = [node];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.type === 'type_identifier') return n.text;
    for (let i = 0; i < n.namedChildCount; i++) stack.push(n.namedChild(i)!);
  }
  return undefined;
}

export const goAdapter: LanguageAdapter = {
  id: 'go',
  extensions: ['.go'],

  isTestFile(relPath) {
    return relPath.endsWith('_test.go');
  },

  extract(tree: Tree, source: string, relPath: string): ExtractResult {
    const defs: DefFact[] = [];
    const refs: RefFact[] = [];
    const imports: ImportFact[] = [];
    let pkg: string | undefined;
    const isTest = relPath.endsWith('_test.go');

    const addDef = (def: DefFact): number => {
      defs.push(def);
      return defs.length - 1;
    };

    const walk = (node: Node, enclosing: number | undefined): void => {
      let nextEnclosing = enclosing;

      switch (node.type) {
        case 'package_clause': {
          pkg = node.namedChild(0)?.text ?? pkg;
          break;
        }

        case 'import_spec': {
          const pathNode = node.childForFieldName('path');
          const nameNode = node.childForFieldName('name');
          if (pathNode) {
            const spec = unquote(pathNode.text);
            imports.push({
              spec,
              alias: nameNode ? nameNode.text : spec.split('/').pop(),
              line: lineOf(node),
            });
          }
          break;
        }

        case 'function_declaration': {
          const nameNode = node.childForFieldName('name');
          if (nameNode) {
            const name = nameNode.text;
            // Go's test convention: any `TestXxx` in a _test.go file is a test entry point.
            const kind = isTest && /^(Test|Benchmark|Fuzz|Example)/.test(name) ? 'test' : 'function';
            nextEnclosing = addDef({
              name,
              kind,
              startLine: lineOf(node),
              endLine: node.endPosition.row + 1,
              exported: isExported(name),
              signature: signatureOf(node, source),
            });
          }
          break;
        }

        case 'method_declaration': {
          const nameNode = node.childForFieldName('name');
          const receiver = receiverTypeName(node.childForFieldName('receiver'));
          if (nameNode) {
            nextEnclosing = addDef({
              name: nameNode.text,
              kind: 'method',
              startLine: lineOf(node),
              endLine: node.endPosition.row + 1,
              exported: isExported(nameNode.text),
              receiver,
              signature: signatureOf(node, source),
            });
          }
          break;
        }

        case 'type_spec': {
          const nameNode = node.childForFieldName('name');
          const typeNode = node.childForFieldName('type');
          if (nameNode) {
            nextEnclosing = addDef({
              name: nameNode.text,
              kind: typeNode?.type === 'interface_type' ? 'interface' : 'type',
              startLine: lineOf(node),
              endLine: node.endPosition.row + 1,
              exported: isExported(nameNode.text),
              signature: signatureOf(node, source),
            });
          }
          break;
        }

        case 'const_spec':
        case 'var_spec': {
          // Package-level only; locals live inside a function and would flood the graph.
          if (enclosing === undefined) {
            const nameNode = node.childForFieldName('name');
            if (nameNode) {
              addDef({
                name: nameNode.text,
                kind: 'const',
                startLine: lineOf(node),
                endLine: node.endPosition.row + 1,
                exported: isExported(nameNode.text),
                signature: signatureOf(node, source),
              });
            }
          }
          break;
        }

        case 'call_expression': {
          const fn = node.childForFieldName('function');
          if (fn?.type === 'identifier') {
            if (!GO_BUILTINS.has(fn.text)) {
              refs.push({ name: fn.text, line: lineOf(fn), kind: 'call', enclosing });
            }
          } else if (fn?.type === 'selector_expression') {
            const operand = fn.childForFieldName('operand');
            const field = fn.childForFieldName('field');
            if (field) {
              refs.push({
                name: field.text,
                // A bare identifier operand is usually a package alias; anything else
                // (`h.svc`, `r.Body`) is a value whose type we do not infer in v1.
                qualifier: operand?.type === 'identifier' ? operand.text : undefined,
                line: lineOf(field),
                kind: 'call',
                enclosing,
              });
            }
          }
          break;
        }

        case 'qualified_type': {
          const pkgNode = node.childForFieldName('package');
          const nameNode = node.childForFieldName('name');
          if (nameNode) {
            refs.push({
              name: nameNode.text,
              qualifier: pkgNode?.text,
              line: lineOf(nameNode),
              kind: 'reference',
              enclosing,
            });
          }
          break;
        }

        default:
          break;
      }

      for (let i = 0; i < node.namedChildCount; i++) {
        walk(node.namedChild(i)!, nextEnclosing);
      }
    };

    walk(tree.rootNode, undefined);
    return { pkg, defs, refs, imports };
  },
};
