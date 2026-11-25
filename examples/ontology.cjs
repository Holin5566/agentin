const assert = require('node:assert/strict');
const { createOntology, createOntologyTool, defineAgent } = require('../dist');
const definition = require('./ontology-graph.json');

const ontology = createOntology(definition);
const agent = defineAgent({
  id: 'service-assistant',
  instructions: 'Use ontology_resolve to find a route. Ask the user to choose when clarification is returned.',
  tools: [createOntologyTool(ontology)],
});

// In an application, bind the route to a specific operation and get any
// explicit selection from the caller rather than using a model's answer.
const query = { route: 'group-payment', source: { label: 'Alpha' } };
const resolved = ontology.resolve(query);
assert.equal(resolved.status, 'resolved');
assert.equal(resolved.selection, 'default');
assert.equal(resolved.targetId, 'payment-service-a');

const ambiguousGraph = structuredClone(definition);
delete ambiguousGraph.edges.find(edge => edge.default).default;
const ambiguousOntology = createOntology(ambiguousGraph);
const clarification = ambiguousOntology.resolve(query);
assert.equal(clarification.status, 'clarification');
assert.deepEqual(clarification.candidates, ['payment-service-a', 'payment-service-b']);

const paymentStatus = new Map([['payment-service-a', 'operational'], ['payment-service-b', 'maintenance']]);
const lookup = (resolver, input) => {
  const plan = resolver.resolve(input);
  if (plan.status !== 'resolved') return plan;
  assert(paymentStatus.has(plan.targetId), 'Target must be in the host scope');
  return { ...plan, serviceStatus: paymentStatus.get(plan.targetId) };
};
assert.deepEqual(lookup(ambiguousOntology, query), clarification);
assert.equal(lookup(ambiguousOntology, { ...query, targetId: 'payment-service-b' }).serviceStatus, 'maintenance');

console.log(`Agent tool: ${agent.tools[0].id}`);
console.log(JSON.stringify({ resolved, clarification }, null, 2));
