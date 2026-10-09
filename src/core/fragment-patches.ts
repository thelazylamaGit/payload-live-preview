/** Explicit patch contract shared by fragment and population planning. */
import { parseDependencyList } from './dependencies';
import type { RuntimeDeps } from './runtime-state';
import type { FragmentPlan } from './strategy-runner';
import type { FragmentStrategy } from './strategies';

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

/** A parent owns its descendants' requests and writes for this revision. */
export function planBoundaries(
  strategy: FragmentStrategy,
  boundaries: readonly Element[],
): FragmentPlan {
  const covered = new Set(boundaries);
  const ancestorCovered = (element: Element): boolean => {
    let parent = element.parentElement?.closest('[data-payload-fragment]');
    while (parent != null) {
      if (covered.has(parent)) return true;
      parent = parent.parentElement?.closest('[data-payload-fragment]');
    }
    return false;
  };
  boundaries = boundaries.filter((boundary) => !ancestorCovered(boundary));
  const ownership = new WeakMap<Element, boolean>();
  return {
    boundaries,
    strategy,
    covers: (target) => {
      const boundary = target.fragmentBoundary;
      if (boundary === undefined) return false;
      const cached = ownership.get(boundary);
      if (cached !== undefined) return cached;
      const result = covered.has(boundary) || ancestorCovered(boundary);
      ownership.set(boundary, result);
      return result;
    },
  };
}
