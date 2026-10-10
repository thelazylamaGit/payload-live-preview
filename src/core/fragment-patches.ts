/** Manual patch permissions shared by fragment and population planning. */
import { type ElementCache } from './cache';
import { isWritableAttribute } from './attribute-binding';
import type { RuntimeDeps } from './runtime-state';
import { lookupSchema, type SchemaIndex } from '@schema/index';
import type { CachedElement } from './types';
export function bindingsForPath(cache: ElementCache, path: string): readonly CachedElement[] {
  const result: CachedElement[] = [...(cache.get(path) ?? [])];
  let parent = path;
  while (parent.includes('.')) {
    parent = parent.slice(0, parent.lastIndexOf('.'));
    for (const target of cache.get(parent) ?? []) {
      if (target.cssBinding !== undefined) result.push(target);
    }
  }
  return result;
}
export function canPatchFragment(
  deps: RuntimeDeps,
  boundary: Element,
  paths: ReadonlySet<string>,
  structuralPaths: ReadonlySet<string> = new Set(),
  schema?: SchemaIndex,
): boolean {
  const metadata = deps.cache.boundaryMetadata(boundary);
  if (metadata === undefined || metadata.patchFields.length === 0 || paths.size === 0) return false;
  const { dependencies, owner, patchFields } = metadata;
  const relevant = [...paths].filter(
    (path) =>
      dependencies.length === 0 ||
      dependencies.some(
        (field) => path === field || path.startsWith(field + '.') || field.startsWith(path + '.'),
      ),
  );
  return (
    relevant.length > 0 &&
    relevant.every(
      (path) =>
        patchFields.some((field) => path === field || path.startsWith(field + '.')) &&
        !structuralPaths.has(path) &&
        !referencePath(path, schema) &&
        bindingsForPath(deps.cache, path).some(
          (target) =>
            target.fragmentBoundary === boundary &&
            (!deps.scopeBindingsByOwner || target.owner === owner) &&
            target.guessed === undefined &&
            target.strategyKind !== 'unknown' &&
            target.strategyKind !== 'route' &&
            target.cssBinding?.supported !== false &&
            (target.targetAttribute === undefined ||
              isWritableAttribute(target.targetAttribute.toLowerCase())),
        ),
    )
  );
}

export function referencePath(path: string, schema: SchemaIndex | undefined): boolean {
  if (schema === undefined) return false;
  let current = path;
  while (current.length > 0) {
    const type = lookupSchema(schema, current)?.type;
    if (type === 'relationship' || type === 'upload') return true;
    const dot = current.lastIndexOf('.');
    if (dot < 0) return false;
    current = current.slice(0, dot);
  }
  return false;
}
