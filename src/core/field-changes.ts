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
      const nextPaths = pathIdentities(fields);
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
      this.previousPaths = nextPaths;
    } else {
      this.previousPaths = null;
    }
    return { changed, invalidated, baseline, paths, structuralPaths };
  }

  reset(): void {
    this.previous = null;
    this.previousPaths = null;
  }
}

/** Fingerprints using the existing identity function; no retained document copy. */
function pathIdentities(
  fields: Readonly<Record<string, unknown>>,
): Map<string, string | undefined> {
  const result = new Map<string, string | undefined>();
  const seen = new WeakSet();
  const visit = (value: unknown, path: string): void => {
    if (value === null || typeof value !== 'object') {
      result.set(path, valueIdentity(value));
      return;
    }
    if (seen.has(value)) {
      result.set(path, undefined);
      return;
    }
    seen.add(value);
    const entries = Object.entries(value);
    const shape = Array.isArray(value)
      ? ['array', arrayIdentity(value)]
      : ['object', entries.map(([key]) => key).sort()];
    const identity = valueIdentity(shape);
    result.set(path, identity === undefined ? undefined : 'container:' + identity);
    for (const [key, child] of entries) visit(child, path.length === 0 ? key : path + '.' + key);
    seen.delete(value);
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
