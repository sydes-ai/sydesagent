import { editFileTool, listDirTool, readFileTool, writeFileTool } from './files.js';
import { GRAPH_TOOLS } from './graph.js';
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
export function buildTools(options: { graph: boolean; allowBash: boolean }): Tool[] {
  const tools = CORE_TOOLS.filter((tool) => options.allowBash || tool.name !== 'bash');
  return options.graph ? [...tools, ...GRAPH_TOOLS] : tools;
}

export * from './types.js';
export { GRAPH_TOOLS };
