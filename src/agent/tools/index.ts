import { editFileTool, listDirTool, readFileTool, writeFileTool } from './files.js';
import { GRAPH_TOOLS, GRAPH_TOOLS_COMPACT } from './graph.js';
import { globTool, grepTool } from './search.js';
import { bashTool, finishTool } from './shell.js';
import type { Tool } from './types.js';
import { verifyTool } from './verify.js';

/** The baseline toolset. Identical in both arms of the experiment. */
export const CORE_TOOLS: Tool[] = [
  readFileTool,
  listDirTool,
  grepTool,
  globTool,
  editFileTool,
  writeFileTool,
  bashTool,
  verifyTool,
  finishTool,
];

/**
 * With the graph off, the graph tools are not merely disabled - they are absent from the
 * schema and the prompt, so the baseline is a genuinely ordinary coding agent rather than one
 * being told about a capability it does not have.
 */
export function buildTools(options: {
  graph: boolean;
  allowBash: boolean;
  compactGraphTools?: boolean;
}): Tool[] {
  const tools = CORE_TOOLS.filter((tool) => options.allowBash || tool.name !== 'bash');
  if (!options.graph) return tools;
  return [...tools, ...(options.compactGraphTools ? GRAPH_TOOLS_COMPACT : GRAPH_TOOLS)];
}

export * from './types.js';
export { GRAPH_TOOLS, GRAPH_TOOLS_COMPACT };
