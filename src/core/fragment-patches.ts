/** Explicit patch contract shared by fragment and population planning. */
import { parseDependencyList } from './dependencies';
import type { RuntimeDeps } from './runtime-state';

export function canPatchFragment(
  deps: RuntimeDeps,
  boundary: Element,
  paths: ReadonlySet<string>,
  structuralPaths: ReadonlySet<string> = new Set(),
): boolean {
  const allowed = parseDependencyList(boundary.getAttribute('data-payload-patch-fields'));
  if (allowed.length === 0 || paths.size === 0) return false;
  const dependencies = parseDependencyList(boundary.getAttribute('data-payload-depends'));
  const relevant = [...paths].filter(
    (path) =>
      dependencies.length === 0 ||
      dependencies.some((field) => path === field || path.startsWith(field + '.')),
  );
  return (
    relevant.length > 0 &&
    relevant.every(
      (path) =>
        !structuralPaths.has(path) &&
        allowed.includes(path) &&
        deps.cache
          .get(path)
          ?.some(
            (target) =>
              boundary.contains(target.element) &&
              target.guessed === undefined &&
              target.strategyKind !== 'unknown' &&
              target.strategyKind !== 'route',
          ) === true,
    )
  );
}
