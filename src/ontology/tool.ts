import { defineTool, type FunctionTool } from '../tools/tool.js';
import { ontologyQuerySchema, type Ontology } from './model.js';

/** Exposes only route resolution through the agent's existing tool scope. */
export function createOntologyTool(ontology: Ontology): FunctionTool {
  return defineTool({
    id: 'ontology_resolve',
    description: 'Resolve a domain query route from a label or entity ID. Ask the user to choose when the result is clarification.',
    inputSchema: ontologyQuerySchema,
    execute: async (query) => {
      const result = ontology.resolve(query);
      return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    },
  });
}
