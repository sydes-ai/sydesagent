import type { Node, Tree } from 'web-tree-sitter';
import type { DefFact, ImportFact, Lang, RefFact } from '../model.js';
import { lineOf, signatureOf, type ExtractResult, type LanguageAdapter } from './types.js';

const TEST_CALLEES = new Set(['describe', 'it', 'test', 'suite', 'context']);

/**
 * Globals and test-runner injections never resolve to a repo symbol. Filtering them at
 * extraction keeps the unresolved-reference count usable as a graph-health signal.
 */
const TS_BUILTINS = new Set([
  'console', 'JSON', 'Math', 'Object', 'Array', 'String', 'Number', 'Boolean', 'BigInt', 'Symbol',
  'Promise', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Date', 'RegExp', 'Error', 'TypeError',
  'RangeError', 'SyntaxError', 'Proxy', 'Reflect', 'globalThis', 'process', 'Buffer', 'require',
  'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'setImmediate', 'queueMicrotask',
  'structuredClone', 'fetch', 'URL', 'URLSearchParams', 'TextEncoder', 'TextDecoder',
  'AbortController', 'performance', 'Intl', 'parseInt', 'parseFloat', 'isNaN', 'encodeURIComponent',
  'decodeURIComponent',
  'string', 'number', 'boolean', 'unknown', 'any', 'void', 'never', 'undefined', 'null', 'object',
  'expect', 'vi', 'jest', 'beforeAll', 'afterAll', 'beforeEach', 'afterEach', 'Partial', 'Record',
  'Readonly', 'Required', 'Pick', 'Omit', 'Exclude', 'Extract', 'ReturnType', 'Awaited', 'T', 'K',
  'V', 'U',
]);

function unquote(text: string): string {
  return text.replace(/^['"`]/, '').replace(/['"`]$/, '');
}

function stringArg(call: Node): string | undefined {
  const args = call.childForFieldName('arguments');
  const first = args?.namedChild(0);
  if (first && (first.type === 'string' || first.type === 'template_string')) {
    return unquote(first.text);
  }
  return undefined;
}

/** First type name inside a type annotation: `: PokemonService` -> `PokemonService`. */
function annotatedTypeName(node: Node | null): string | undefined {
  if (!node) return undefined;
  const stack = [node];
  while (stack.length) {
    const n = stack.shift()!;
    if (n.type === 'type_identifier') return n.text;
    for (let i = 0; i < n.namedChildCount; i++) stack.push(n.namedChild(i)!);
  }
  return undefined;
}

/**
 * Declared types of a function's parameters. TypeScript states them outright, so a call like
 * `svc.addPokemon()` can resolve to exactly one method instead of every same-named method in
 * the repository.
 */
function parameterTypes(node: Node): Map<string, string> {
  const out = new Map<string, string>();
  const params = node.childForFieldName('parameters');
  if (!params) return out;
  for (let i = 0; i < params.namedChildCount; i++) {
    const param = params.namedChild(i)!;
    if (!param.type.endsWith('_parameter')) continue;
    const name = param.childForFieldName('pattern')?.text ?? param.childForFieldName('name')?.text;
    const type = annotatedTypeName(param.childForFieldName('type'));
    if (name && type) out.set(name, type);
  }
  return out;
}

/** Field types of a class, including constructor parameter properties. */
function classFieldTypes(node: Node): Map<string, string> {
  const out = new Map<string, string>();
  const body = node.childForFieldName('body');
  if (!body) return out;
  for (let i = 0; i < body.namedChildCount; i++) {
    const member = body.namedChild(i)!;
    if (member.type === 'public_field_definition') {
      const name = member.childForFieldName('name')?.text;
      const type = annotatedTypeName(member.childForFieldName('type'));
      if (name && type) out.set(name, type);
    } else if (member.type === 'method_definition' && member.childForFieldName('name')?.text === 'constructor') {
      const params = member.childForFieldName('parameters');
      for (let j = 0; j < (params?.namedChildCount ?? 0); j++) {
        const param = params!.namedChild(j)!;
        // `constructor(private repo: PokemonRepo)` declares a field.
        // `private repo: X` and `readonly store: X` both declare a field.
        const hasModifier =
          param.namedChildren.some((c) => c?.type === 'accessibility_modifier') ||
          /^\s*readonly\b/.test(param.text);
        if (!hasModifier) continue;
        const name = param.childForFieldName('pattern')?.text;
        const type = annotatedTypeName(param.childForFieldName('type'));
        if (name && type) out.set(name, type);
      }
    }
  }
  return out;
}

/** Names listed in `implements`/`extends` clauses of a class or interface. */
function heritageNames(node: Node): string[] {
  const out: string[] = [];
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i)!;
    if (
      child.type === 'class_heritage' ||
      child.type === 'implements_clause' ||
      child.type === 'extends_clause' ||
      child.type === 'extends_type_clause'
    ) {
      const stack = [child];
      while (stack.length) {
        const n = stack.pop()!;
        if (n.type === 'type_identifier' || n.type === 'identifier') out.push(n.text);
        for (let j = 0; j < n.namedChildCount; j++) stack.push(n.namedChild(j)!);
      }
    }
  }
  return [...new Set(out)];
}

function makeAdapter(id: Lang, extensions: string[]): LanguageAdapter {
  return {
    id,
    extensions,

    isTestFile(relPath) {
      return (
        /\.(test|spec)\.[cm]?[jt]sx?$/.test(relPath) ||
        /(^|\/)(__tests__|test|tests)\//.test(relPath)
      );
    },

    extract(tree: Tree, source: string, relPath: string): ExtractResult {
      const defs: DefFact[] = [];
      const refs: RefFact[] = [];
      const imports: ImportFact[] = [];
      const isTest = this.isTestFile(relPath);

      const addDef = (def: DefFact): number => {
        defs.push(def);
        return defs.length - 1;
      };

      interface Ctx {
        enclosing: number | undefined;
        exported: boolean;
        /** Local name -> declared type, for the enclosing function. */
        scope: Map<string, string>;
        /** Field name -> declared type, for the enclosing class. */
        fields: Map<string, string>;
        className?: string;
      }

      const walk = (node: Node, ctx: Ctx): void => {
        const { enclosing, exported } = ctx;
        let nextEnclosing = enclosing;
        let childExported = false;
        let nextScope = ctx.scope;
        let nextFields = ctx.fields;
        let nextClassName = ctx.className;

        switch (node.type) {
          case 'export_statement': {
            // Everything under an export statement is part of the module's public surface.
            childExported = true;
            break;
          }

          case 'import_statement': {
            const sourceNode = node.childForFieldName('source');
            if (sourceNode) {
              const spec = unquote(sourceNode.text);
              const names: Record<string, string> = {};
              let alias: string | undefined;
              const clause = node.namedChildren.find((c) => c?.type === 'import_clause');
              if (clause) {
                for (let i = 0; i < clause.namedChildCount; i++) {
                  const part = clause.namedChild(i)!;
                  if (part.type === 'identifier') {
                    names[part.text] = 'default';
                  } else if (part.type === 'namespace_import') {
                    alias = part.namedChild(0)?.text;
                  } else if (part.type === 'named_imports') {
                    for (let j = 0; j < part.namedChildCount; j++) {
                      const spec2 = part.namedChild(j)!;
                      if (spec2.type !== 'import_specifier') continue;
                      const original = spec2.childForFieldName('name')?.text;
                      const local = spec2.childForFieldName('alias')?.text ?? original;
                      if (original && local) names[local] = original;
                    }
                  }
                }
              }
              imports.push({ spec, alias, names, line: lineOf(node) });
            }
            break;
          }

          case 'function_declaration':
          case 'generator_function_declaration': {
            const nameNode = node.childForFieldName('name');
            if (nameNode) {
              nextScope = parameterTypes(node);
              nextEnclosing = addDef({
                name: nameNode.text,
                kind: 'function',
                startLine: lineOf(node),
                endLine: node.endPosition.row + 1,
                exported,
                signature: signatureOf(node, source),
              });
            }
            break;
          }

          case 'class_declaration':
          case 'abstract_class_declaration': {
            const nameNode = node.childForFieldName('name');
            if (nameNode) {
              nextFields = classFieldTypes(node);
              nextClassName = nameNode.text;
              nextEnclosing = addDef({
                name: nameNode.text,
                kind: 'type',
                startLine: lineOf(node),
                endLine: node.endPosition.row + 1,
                exported,
                signature: signatureOf(node, source),
                implementsNames: heritageNames(node),
              });
            }
            break;
          }

          case 'method_definition': {
            const nameNode = node.childForFieldName('name');
            // Walk up to the owning class for the receiver name.
            let owner: Node | null = node.parent;
            while (owner && !owner.type.endsWith('class_declaration')) owner = owner.parent;
            const receiver = owner?.childForFieldName('name')?.text ?? ctx.className;
            if (nameNode) {
              nextScope = parameterTypes(node);
              nextEnclosing = addDef({
                name: nameNode.text,
                kind: 'method',
                startLine: lineOf(node),
                endLine: node.endPosition.row + 1,
                exported,
                receiver,
                signature: signatureOf(node, source),
              });
            }
            break;
          }

          case 'interface_declaration': {
            const nameNode = node.childForFieldName('name');
            if (nameNode) {
              nextEnclosing = addDef({
                name: nameNode.text,
                kind: 'interface',
                startLine: lineOf(node),
                endLine: node.endPosition.row + 1,
                exported,
                signature: signatureOf(node, source),
                implementsNames: heritageNames(node),
              });
            }
            break;
          }

          case 'type_alias_declaration':
          case 'enum_declaration': {
            const nameNode = node.childForFieldName('name');
            if (nameNode) {
              nextEnclosing = addDef({
                name: nameNode.text,
                kind: node.type === 'enum_declaration' ? 'type' : 'interface',
                startLine: lineOf(node),
                endLine: node.endPosition.row + 1,
                exported,
                signature: signatureOf(node, source),
              });
            }
            break;
          }

          case 'variable_declarator': {
            // Only module-level bindings become nodes; locals would flood the graph.
            if (enclosing === undefined) {
              const nameNode = node.childForFieldName('name');
              const value = node.childForFieldName('value');
              if (nameNode?.type === 'identifier') {
                const isFn =
                  value?.type === 'arrow_function' ||
                  value?.type === 'function_expression' ||
                  value?.type === 'function';
                if (isFn && value) nextScope = parameterTypes(value);
                nextEnclosing = addDef({
                  name: nameNode.text,
                  kind: isFn ? 'function' : 'const',
                  startLine: lineOf(node),
                  endLine: node.endPosition.row + 1,
                  exported,
                  signature: signatureOf(node, source),
                });
              }
            }
            break;
          }

          case 'call_expression': {
            const fn = node.childForFieldName('function');
            if (fn?.type === 'identifier') {
              const label = isTest && TEST_CALLEES.has(fn.text) ? stringArg(node) : undefined;
              if (label !== undefined) {
                // `describe('addPokemonHandler', ...)` is the test entry point users navigate to.
                nextEnclosing = addDef({
                  name: label,
                  kind: 'test',
                  startLine: lineOf(node),
                  endLine: node.endPosition.row + 1,
                  exported: false,
                  signature: `${fn.text}('${label}')`,
                });
              } else if (!TS_BUILTINS.has(fn.text)) {
                refs.push({ name: fn.text, line: lineOf(fn), kind: 'call', enclosing });
              }
            } else if (fn?.type === 'member_expression') {
              const object = fn.childForFieldName('object');
              const property = fn.childForFieldName('property');
              if (property) {
                let qualifierType: string | undefined;
                if (object?.type === 'identifier') {
                  qualifierType = ctx.scope.get(object.text);
                } else if (object?.type === 'this') {
                  qualifierType = ctx.className;
                } else if (object?.type === 'member_expression') {
                  // `this.repo.insert(...)` - the field's declared type names the receiver.
                  const inner = object.childForFieldName('object');
                  const field = object.childForFieldName('property');
                  if (inner?.type === 'this' && field) qualifierType = ctx.fields.get(field.text);
                }
                refs.push({
                  name: property.text,
                  qualifier: object?.type === 'identifier' ? object.text : undefined,
                  qualifierType,
                  line: lineOf(property),
                  kind: 'call',
                  enclosing,
                });
              }
            }
            break;
          }

          case 'new_expression': {
            const ctor = node.childForFieldName('constructor');
            if (ctor?.type === 'identifier' && !TS_BUILTINS.has(ctor.text)) {
              refs.push({ name: ctor.text, line: lineOf(ctor), kind: 'reference', enclosing });
            }
            break;
          }

          case 'type_identifier': {
            if (!TS_BUILTINS.has(node.text)) {
              refs.push({ name: node.text, line: lineOf(node), kind: 'reference', enclosing });
            }
            break;
          }

          default:
            break;
        }

        for (let i = 0; i < node.namedChildCount; i++) {
          walk(node.namedChild(i)!, {
            enclosing: nextEnclosing,
            exported: childExported,
            scope: nextScope,
            fields: nextFields,
            className: nextClassName,
          });
        }
      };

      walk(tree.rootNode, {
        enclosing: undefined,
        exported: false,
        scope: new Map(),
        fields: new Map(),
      });
      return { defs, refs, imports };
    },
  };
}

export const typescriptAdapter = makeAdapter('typescript', ['.ts', '.mts', '.cts']);
export const tsxAdapter = makeAdapter('tsx', ['.tsx']);
export const javascriptAdapter = makeAdapter('javascript', ['.js', '.mjs', '.cjs', '.jsx']);
