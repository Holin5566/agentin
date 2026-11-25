import { describe, expect, it } from 'vitest';
import { createOntology, validateOntology, type OntologyDefinition } from '../../src/index.js';

const definition: OntologyDefinition = require('../../examples/ontology-graph.json');
const fixture = (): OntologyDefinition => structuredClone(definition);
const groupQuery = { route: 'group-payment', source: { label: 'Alpha' } };

describe('ontology resolution', () => {
  it('uses route context to resolve the same label to different entity kinds', () => {
    const ontology = createOntology(fixture());
    expect(ontology.resolve(groupQuery)).toEqual({
      status: 'resolved', route: 'group-payment', sourceId: 'alpha-group', targetId: 'payment-service-a', selection: 'default',
    });
    expect(ontology.resolve({ ...groupQuery, route: 'tenant-payment' })).toEqual({
      status: 'resolved', route: 'tenant-payment', sourceId: 'shop-a', targetId: 'payment-service-a', selection: 'unique',
    });
  });

  it('normalizes exact labels without matching arbitrary text or silently treating an entity ID as a label', () => {
    const ontology = createOntology(fixture());
    expect(ontology.resolve({ route: 'tenant-lookup', source: { label: '  ＳＨＯＰ__Ａ  ' } })).toMatchObject({
      status: 'resolved', sourceId: 'shop-a', targetId: 'shop-a',
    });
    for (const label of ['status for Shop A', 'shop-b', 'Alpha-Group']) {
      expect(ontology.resolve({ ...groupQuery, source: { label } })).toMatchObject({ status: 'not_found', reason: 'unknown_source' });
    }
    expect(ontology.resolve({ ...groupQuery, source: { entityId: 'alpha-group' } })).toMatchObject({ status: 'resolved', sourceId: 'alpha-group' });
  });

  it('asks for the source entity when a label denotes several entities of the same kind', () => {
    const ontology = createOntology(fixture());
    const route = 'tenant-payment';
    expect(ontology.resolve({ route, source: { label: 'shops' }, targetId: 'payment-service-a' })).toEqual({
      status: 'clarification', route, field: 'entityId', candidates: ['shop-a', 'shop-b'],
    });
    expect(ontology.resolve({ route, source: { entityId: 'shop-b' } })).toMatchObject({
      status: 'resolved', sourceId: 'shop-b', targetId: 'payment-service-b',
    });
  });

  it('requires target clarification without a default and accepts only a reachable explicit target', () => {
    const graph = fixture();
    delete graph.edges[1].default;
    graph.edges.reverse();
    const ontology = createOntology(graph);
    expect(ontology.resolve(groupQuery)).toEqual({
      status: 'clarification', route: 'group-payment', field: 'targetId', candidates: ['payment-service-a', 'payment-service-b'],
    });
    expect(ontology.resolve({ ...groupQuery, targetId: 'payment-service-b' })).toMatchObject({
      status: 'resolved', targetId: 'payment-service-b', selection: 'explicit',
    });
    expect(ontology.resolve({ ...groupQuery, targetId: 'shop-a' })).toMatchObject({
      status: 'not_found', reason: 'unreachable_target',
    });
  });

  it('lets an explicit reachable target override the default', () => {
    expect(createOntology(fixture()).resolve({ ...groupQuery, targetId: 'payment-service-b' })).toMatchObject({
      status: 'resolved', targetId: 'payment-service-b', selection: 'explicit',
    });
  });

  it('deduplicates convergent paths to a single target', () => {
    const graph = fixture();
    delete graph.edges[1].default;
    graph.edges[3].to = 'payment-service-a';
    expect(createOntology(graph).resolve(groupQuery)).toMatchObject({
      status: 'resolved', targetId: 'payment-service-a', selection: 'unique',
    });
  });

  it('does not resolve a partial default or jump to another branch to guess', () => {
    const graph = fixture();
    graph.relations[1].cardinality = '0..*';
    graph.entities.push({ id: 'payment-service-c', kind: 'service' });
    graph.edges.push({ from: 'shop-a', relation: 'payment', to: 'payment-service-c' });
    expect(createOntology(graph).resolve(groupQuery)).toMatchObject({
      status: 'clarification', field: 'targetId', candidates: ['payment-service-a', 'payment-service-b', 'payment-service-c'],
    });
    graph.edges = graph.edges.filter(edge => edge.from !== 'shop-a');
    expect(createOntology(graph).resolve(groupQuery)).toMatchObject({
      status: 'resolved', targetId: 'payment-service-b', selection: 'unique',
    });
    graph.edges.push({ from: 'shop-b', relation: 'payment', to: 'payment-service-c', default: true });
    expect(createOntology(graph).resolve(groupQuery)).toMatchObject({
      status: 'resolved', targetId: 'payment-service-c', selection: 'default',
    });
  });

  it('distinguishes unknown routes, wrong source kinds and missing paths', () => {
    const graph = fixture();
    graph.relations[1].cardinality = '0..1';
    graph.edges = graph.edges.filter(edge => edge.relation !== 'payment');
    const ontology = createOntology(graph);
    expect(ontology.resolve({ ...groupQuery, route: 'missing' })).toMatchObject({ status: 'not_found', reason: 'unknown_route' });
    expect(ontology.resolve({ ...groupQuery, source: { entityId: 'shop-a' } })).toMatchObject({ status: 'not_found', reason: 'unknown_source' });
    expect(ontology.resolve(groupQuery)).toMatchObject({ status: 'not_found', reason: 'no_target' });
    expect(() => ontology.resolve({ ...groupQuery, source: { label: ' ', entityId: 'shop-a' } })).toThrow();
  });

  it('snapshots definitions and returns fresh candidates per call', () => {
    const graph = fixture();
    delete graph.edges[1].default;
    const ontology = createOntology(graph);
    graph.labels[0].denotes.length = 0;
    graph.edges[1].default = true;
    const first = ontology.resolve(groupQuery);
    if (first.status === 'clarification') first.candidates.pop();
    expect(ontology.resolve(groupQuery)).toMatchObject({
      status: 'clarification', candidates: ['payment-service-a', 'payment-service-b'],
    });
  });
});

describe('ontology validation', () => {
  it('accepts a valid graph and reports bad runtime shapes', () => {
    expect(validateOntology(fixture())).toEqual([]);
    expect(validateOntology(null)).toHaveLength(1);
    expect(validateOntology({ ...fixture(), edges: [null] })[0]).toMatch(/^edges\.0:/);
    expect(validateOntology({ ...fixture(), routes: [false] })[0]).toMatch(/^routes\.0:/);
  });

  it('checks kind, ID, label and denotation constraints', () => {
    const graph = fixture();
    graph.kinds.push('tenant');
    graph.entities.push(graph.entities[0], { id: 'shop-c', kind: 'missing' });
    graph.labels.push({ text: 'ＡＬＰＨＡ', denotes: ['missing', 'missing'] }, { text: '---', denotes: ['shop-a'] });
    expect(validateOntology(graph)).toEqual(expect.arrayContaining([
      'Duplicate entity kind',
      'Duplicate entity: alpha-group',
      'Unknown kind for entity shop-c: missing',
      'Duplicate normalized label: ＡＬＰＨＡ',
      'Duplicate denotation: ＡＬＰＨＡ',
      'Unknown entity missing for label ＡＬＰＨＡ',
      'Label is empty after normalization',
    ]));
    expect(() => createOntology(graph)).toThrow(/Invalid ontology/);
  });

  it('checks edge relations, endpoints, duplicates, cardinalities and default uniqueness', () => {
    const graph = fixture();
    graph.relations.push({ id: 'bad', from: 'missing', to: 'tenant', cardinality: '0..*' }, graph.relations[1]);
    graph.edges[0].default = true;
    graph.edges.splice(3, 1);
    graph.edges.push(
      graph.edges[0],
      { from: 'shop-a', to: 'shop-b', relation: 'missing' },
      { from: 'shop-a', to: 'shop-b', relation: 'payment' },
      { from: 'shop-a', to: 'payment-service-c', relation: 'payment' },
      { from: 'shop-a', to: 'payment-service-b', relation: 'payment' },
    );
    expect(validateOntology(graph)).toEqual(expect.arrayContaining([
      'Unknown endpoint kind for relation: bad',
      'Duplicate relation: payment',
      'Duplicate edge for contains: alpha-group -> shop-b',
      'Unknown edge relation: missing',
      'Invalid edge endpoints for payment: shop-a -> shop-b (expected tenant -> service)',
      'Invalid edge endpoints for payment: shop-a -> payment-service-c (expected tenant -> service)',
      'Multiple defaults for alpha-group via contains',
      'Cardinality violation for shop-a via payment: expected 1, found 2',
      'Cardinality violation for shop-b via payment: expected 1, found 0',
    ]));
  });

  it('validates route IDs, source kinds and every relation hop', () => {
    const graph = fixture();
    graph.routes.push(graph.routes[0], { id: 'invalid', from: 'tenant-group', via: ['contains', 'contains'] },
      { id: 'unknown-kind', from: 'missing', via: [] }, { id: 'unknown-hop', from: 'tenant-group', via: ['missing'] });
    expect(validateOntology(graph)).toEqual(expect.arrayContaining([
      'Duplicate route: group-payment',
      'Invalid route step for invalid: contains cannot start from tenant',
      'Unknown source kind for route unknown-kind: missing',
      'Invalid route step for unknown-hop: missing cannot start from tenant-group',
    ]));
  });
});
