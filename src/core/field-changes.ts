/**
 * The one per-message diff of top-level field values. Strategies, dependency
 * invalidation and reveal all consume it, so "changed" means the same thing
 * everywhere.
 */

import type { DependencyMap } from './dependencies';
import { valueIdentity } from './value-identity';

export interface FieldChanges {
  /** Fields whose value differs from the previous message; every field on the first one. */
  readonly changed: ReadonlySet<string>;
  /** Dependents of changed fields, per the dependency map. */
  readonly invalidated: ReadonlySet<string>;
  /**
   * The first message of a connection, where `changed` means "everything the
   * document has" rather than "what the editor just did". A caller that acts on
   * a change rather than rendering one has to sit this message out.
   */
  readonly baseline: boolean;
  /** Exact paths, including changed container shape and array identity. */
  readonly paths: ReadonlySet<string>;
  readonly structuralPaths: ReadonlySet<string>;
}

export class FieldChangeTracker {
  private previous: Map<string, string | undefined> | null = null;

  private previousPaths: Map<string, string | undefined> | null = null;
  private lexicalOrders: Map<string, readonly (string | undefined)[]> | null = null;

  /** Whether the current diff includes precise paths rather than only top-level fields. */
  get trackingPaths(): boolean {
    return this.previousPaths !== null;
  }

  /** Diff `fields` against the previous message and remember them for the next call. */
  diff(
    fields: Readonly<Record<string, unknown>>,
    dependencies: DependencyMap,
    trackPaths = false,
  ): FieldChanges {
    const previous = this.previous;
    const baseline = previous === null;
    const next = new Map<string, string | undefined>();
    const changed = new Set<string>();
    for (const [name, value] of Object.entries(fields)) {
      const identity = valueIdentity(value);
      next.set(name, identity);
      // A value without an identity always counts as changed: rendering once
      // more is cheap, a stale binding is not.
      if (previous === null || identity === undefined || previous.get(name) !== identity) {
        changed.add(name);
      }
    }
    if (previous !== null) {
      for (const name of previous.keys()) if (!next.has(name)) changed.add(name);
    }
    this.previous = next;
    const invalidated = new Set<string>();
    for (const [source, dependents] of Object.entries(dependencies)) {
      if (!changed.has(source)) continue;
      for (const dependent of dependents) invalidated.add(dependent);
    }
    const paths = new Set<string>();
    const structuralPaths = new Set<string>();
    if (trackPaths && !(typeof __LEAN_BUILD__ !== 'undefined' && __LEAN_BUILD__)) {
      const orders = new Map<string, readonly (string | undefined)[]>();
      const nextPaths = pathIdentities(fields, orders);
      for (const [path, identity] of nextPaths) {
        if (identity === undefined || this.previousPaths?.get(path) !== identity) {
          paths.add(path);
          if (
            identity?.startsWith('container:') ||
            this.previousPaths?.get(path)?.startsWith('container:')
          ) {
            structuralPaths.add(path);
          }
        }
      }
      if (this.previousPaths !== null) {
        for (const [path, identity] of this.previousPaths) {
          if (!nextPaths.has(path)) {
            paths.add(path);
            if (identity?.startsWith('container:')) structuralPaths.add(path);
          }
        }
      }
      for (const [path, order] of orders) {
        const previousOrder = this.lexicalOrders?.get(path);
        // A surviving node at another position is a move, even when its only
        // distinguishing value is text. Ambiguous edits stay on the server.
        if (
          previousOrder &&
          order.some(
            (id, index) =>
              id !== undefined && id !== previousOrder[index] && previousOrder.includes(id),
          )
        ) {
          paths.add(path);
          structuralPaths.add(path);
        }
      }
      this.previousPaths = nextPaths;
      this.lexicalOrders = orders;
    } else {
      this.previousPaths = null;
      this.lexicalOrders = null;
    }
    return { changed, invalidated, baseline, paths, structuralPaths };
  }

  reset(): void {
    this.previous = null;
    this.previousPaths = null;
    this.lexicalOrders = null;
  }
}

/** Fingerprints using the existing identity function; no retained document copy. */
function pathIdentities(
  fields: Readonly<Record<string, unknown>>,
  orders: Map<string, readonly (string | undefined)[]>,
): Map<string, string | undefined> {
  const result = new Map<string, string | undefined>();
  const lexicalIdentities = new WeakMap<object, string | undefined>();
  const seen = new WeakSet();
  const visit = (value: unknown, path: string, lexical = false): string | undefined => {
    if (value === null || typeof value !== 'object') {
      const identity = valueIdentity(value);
      result.set(path, identity);
      return identity;
    }
    if (seen.has(value)) {
      result.set(path, undefined);
      return undefined;
    }
    seen.add(value);
    const entries = Object.entries(value);
    const record = value as Record<string, unknown>;
    // Only follow Lexical children edges from a root. Embedded node fields
    // keep their full identity; ordinary positional arrays are unchanged.
    const node =
      !Array.isArray(value) &&
      typeof record['type'] === 'string' &&
      (lexical || (path.endsWith('.root') && record['type'] === 'root'));
    // Lexical exports can change object insertion order; children positions stay ordered.
    if (node) entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const children =
      lexical &&
      Array.isArray(value) &&
      value.every(
        (item) =>
          item !== null &&
          typeof item === 'object' &&
          !Array.isArray(item) &&
          typeof (item as Record<string, unknown>)['type'] === 'string',
      );
    const content: unknown[][] = [];
    const fullContent: unknown[][] = [];
    for (const [key, child] of entries) {
      const childLexical = children || (node && key === 'children');
      const identity = visit(child, path + '.' + key, childLexical);
      if (lexical || node) {
        const fullIdentity =
          childLexical && child !== null && typeof child === 'object'
            ? lexicalIdentities.get(child as object)
            : valueIdentity(child);
        fullContent.push([key, fullIdentity]);
        content.push([
          key,
          node && record['type'] === 'text' && key === 'text' && typeof child === 'string'
            ? 'text-value'
            : childLexical
              ? identity
              : fullIdentity,
        ]);
      }
    }
    if (children) {
      orders.set(
        path,
        value.map((item) => lexicalIdentities.get(item as object)),
      );
    }
    if (lexical || node) {
      lexicalIdentities.set(
        value,
        fullContent.some(([, identity]) => identity === undefined)
          ? undefined
          : valueIdentity(fullContent),
      );
    }
    const shape = Array.isArray(value)
      ? ['array', children ? [value.length, content] : arrayIdentity(value)]
      : ['object', entries.map(([key]) => key).sort()];
    const identity = valueIdentity(shape);
    result.set(path, identity === undefined ? undefined : 'container:' + identity);
    seen.delete(value);
    return (!lexical && !node) || content.some(([, identity]) => identity === undefined)
      ? undefined
      : valueIdentity(content);
  };
  for (const [key, value] of Object.entries(fields)) visit(value, key);
  return result;
}

/** Positional arrays and ambiguous identities always require server rendering. */
function arrayIdentity(items: readonly unknown[]): unknown {
  const keys = new Set<string | number>();
  const identity: unknown[] = [];
  for (const item of items) {
    if (item === null || typeof item !== 'object') return valueIdentity(items);
    const record = item as Record<string, unknown>;
    const id = Object.hasOwn(record, 'id') ? record['id'] : undefined;
    if ((typeof id !== 'string' && typeof id !== 'number') || id === '' || keys.has(id)) {
      return valueIdentity(items);
    }
    keys.add(id);
    identity.push([id, record['blockType']]);
  }
  return identity;
}
