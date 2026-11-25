import { z } from 'zod/v4';

const id = z.string().regex(/^[a-z0-9][a-z0-9._:-]*$/);
const text = z.string().trim().min(1);
const ontologySchema = z.strictObject({
  kinds: z.array(id).min(1),
  entities: z.array(z.strictObject({ id, kind: id })),
  labels: z.array(z.strictObject({ text, denotes: z.array(id).min(1) })),
  relations: z.array(z.strictObject({
    id, from: id, to: id, cardinality: z.enum(['1', '0..1', '1..*', '0..*']),
  })),
  edges: z.array(z.strictObject({ from: id, relation: id, to: id, default: z.boolean().optional() })),
  routes: z.array(z.strictObject({ id, from: id, via: z.array(id) })),
});

export type OntologyDefinition = z.input<typeof ontologySchema>;
type Edge = OntologyDefinition['edges'][number];

export const ontologyQuerySchema = z.strictObject({
  route: id,
  source: z.union([z.strictObject({ label: text }), z.strictObject({ entityId: id })]),
  targetId: id.optional(),
});

export type OntologyQuery = z.input<typeof ontologyQuerySchema>;
export type OntologyResolution =
  | { status: 'resolved'; route: string; sourceId: string; targetId: string; selection: 'unique' | 'default' | 'explicit' }
  | { status: 'clarification'; route: string; field: 'entityId' | 'targetId'; candidates: string[] }
  | { status: 'not_found'; route: string; reason: 'unknown_route' | 'unknown_source' | 'no_target' | 'unreachable_target' };

export interface Ontology {
  resolve(query: OntologyQuery): OntologyResolution;
}

function normalizeLabel(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/[\s_-]+/g, ' ').trim();
}

function inspect(data: unknown) {
  const parsed = ontologySchema.safeParse(data);
  const issues: string[] = [];
  const entities = new Map<string, string>();
  const labels = new Map<string, string[]>();
  const outgoing = new Map<string, Map<string, Edge[]>>();
  const routes = new Map<string, OntologyDefinition['routes'][number]>();
  const graph = { issues, entities, labels, outgoing, routes };
  if (!parsed.success) {
    for (const issue of parsed.error.issues) issues.push(`${issue.path.join('.') || 'ontology'}: ${issue.message}`);
    return graph;
  }

  const kinds = new Set(parsed.data.kinds);
  if (kinds.size !== parsed.data.kinds.length) issues.push('Duplicate entity kind');
  const relations = new Map<string, OntologyDefinition['relations'][number]>();
  for (const entity of parsed.data.entities) {
    if (entities.has(entity.id)) issues.push(`Duplicate entity: ${entity.id}`);
    if (!kinds.has(entity.kind)) issues.push(`Unknown kind for entity ${entity.id}: ${entity.kind}`);
    entities.set(entity.id, entity.kind);
  }
  for (const label of parsed.data.labels) {
    const name = normalizeLabel(label.text);
    if (!name) issues.push('Label is empty after normalization');
    if (labels.has(name)) issues.push(`Duplicate normalized label: ${label.text}`);
    if (new Set(label.denotes).size !== label.denotes.length) issues.push(`Duplicate denotation: ${label.text}`);
    for (const entityId of label.denotes) {
      if (!entities.has(entityId)) issues.push(`Unknown entity ${entityId} for label ${label.text}`);
    }
    labels.set(name, label.denotes);
  }
  for (const relation of parsed.data.relations) {
    if (relations.has(relation.id)) issues.push(`Duplicate relation: ${relation.id}`);
    if (!kinds.has(relation.from) || !kinds.has(relation.to)) issues.push(`Unknown endpoint kind for relation: ${relation.id}`);
    relations.set(relation.id, relation);
  }
  for (const edge of parsed.data.edges) {
    const relation = relations.get(edge.relation);
    if (!relation) {
      issues.push(`Unknown edge relation: ${edge.relation}`);
      continue;
    }
    if (entities.get(edge.from) !== relation.from || entities.get(edge.to) !== relation.to) {
      issues.push(`Invalid edge endpoints for ${edge.relation}: ${edge.from} -> ${edge.to} (expected ${relation.from} -> ${relation.to})`);
      continue;
    }
    let byRelation = outgoing.get(edge.from);
    if (!byRelation) outgoing.set(edge.from, byRelation = new Map());
    let edges = byRelation.get(edge.relation);
    if (!edges) byRelation.set(edge.relation, edges = []);
    if (edges.some(previous => previous.to === edge.to)) {
      issues.push(`Duplicate edge for ${edge.relation}: ${edge.from} -> ${edge.to}`);
      continue;
    }
    edges.push(edge);
  }
  for (const [entity, kind] of entities) {
    for (const relation of relations.values()) {
      if (kind !== relation.from) continue;
      const edges = outgoing.get(entity)?.get(relation.id) ?? [];
      const min = relation.cardinality === '1' || relation.cardinality === '1..*' ? 1 : 0;
      const max = relation.cardinality === '1' || relation.cardinality === '0..1' ? 1 : Infinity;
      if (edges.length < min || edges.length > max) {
        issues.push(`Cardinality violation for ${entity} via ${relation.id}: expected ${relation.cardinality}, found ${edges.length}`);
      }
      if (edges.filter(edge => edge.default).length > 1) {
        issues.push(`Multiple defaults for ${entity} via ${relation.id}`);
      }
    }
  }
  for (const route of parsed.data.routes) {
    if (routes.has(route.id)) issues.push(`Duplicate route: ${route.id}`);
    if (!kinds.has(route.from)) issues.push(`Unknown source kind for route ${route.id}: ${route.from}`);
    let kind = route.from;
    for (const step of route.via) {
      const relation = relations.get(step);
      if (!relation || relation.from !== kind) {
        issues.push(`Invalid route step for ${route.id}: ${step} cannot start from ${kind}`);
        break;
      }
      kind = relation.to;
    }
    routes.set(route.id, route);
  }
  return graph;
}

/** Returns one entry per detected schema or graph violation. */
export function validateOntology(data: unknown): string[] {
  return inspect(data).issues;
}

/** Validates and indexes a private snapshot of the host's graph. */
export function createOntology(data: OntologyDefinition): Ontology {
  const { issues, entities, labels, outgoing, routes } = inspect(data);
  if (issues.length) throw new Error(`Invalid ontology:\n${issues.join('\n')}`);

  const edgesFor = (entity: string, relation: string): Edge[] => outgoing.get(entity)?.get(relation) ?? [];
  return Object.freeze({
    resolve(query: OntologyQuery): OntologyResolution {
      const { route, source, targetId } = ontologyQuerySchema.parse(query);
      const definition = routes.get(route);
      if (!definition) return { status: 'not_found', route, reason: 'unknown_route' };

      const denotations = 'label' in source ? labels.get(normalizeLabel(source.label)) ?? [] : [source.entityId];
      const candidates = denotations.filter(entityId => entities.get(entityId) === definition.from);
      if (!candidates.length) return { status: 'not_found', route, reason: 'unknown_source' };
      if (candidates.length > 1) return { status: 'clarification', route, field: 'entityId', candidates: candidates.sort() };

      const sourceId = candidates[0];
      const layers = [new Set([sourceId])];
      for (const step of definition.via) {
        const next = new Set<string>();
        for (const entity of layers[layers.length - 1]) {
          for (const edge of edgesFor(entity, step)) next.add(edge.to);
        }
        layers.push(next);
      }
      const targets = layers[layers.length - 1];
      if (targetId !== undefined) {
        return targets.has(targetId)
          ? { status: 'resolved', route, sourceId, targetId, selection: 'explicit' }
          : { status: 'not_found', route, reason: 'unreachable_target' };
      }
      if (!targets.size) return { status: 'not_found', route, reason: 'no_target' };
      if (targets.size === 1) return { status: 'resolved', route, sourceId, targetId: [...targets][0], selection: 'unique' };

      // Work backward so defaults on paths with no reachable target cannot win.
      let preferred = new Map<string, string | undefined>();
      for (const target of targets) preferred.set(target, target);
      for (let i = definition.via.length - 1; i >= 0; i--) {
        const current = new Map<string, string | undefined>();
        for (const entity of layers[i]) {
          const viable = edgesFor(entity, definition.via[i]).filter(edge => preferred.has(edge.to));
          if (!viable.length) continue;
          const choice = viable.length === 1 ? viable[0] : viable.find(edge => edge.default);
          current.set(entity, choice && preferred.get(choice.to));
        }
        preferred = current;
      }
      const selected = preferred.get(sourceId);
      return selected
        ? { status: 'resolved', route, sourceId, targetId: selected, selection: 'default' }
        : { status: 'clarification', route, field: 'targetId', candidates: [...targets].sort() };
    },
  });
}
