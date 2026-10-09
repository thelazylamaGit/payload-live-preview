/** Fragment boundaries: how a `data-payload-fragment` element is read and which ones an update touches. */

import type { DiagnosticCode } from '@core/diagnostic-codes';
import { isInsideIsland } from '@core/islands';
import { parseDependencyList } from '@core/dependencies';
import { FRAGMENT_ATTRIBUTE } from '@core/strategies';
import { resolveBindingOwner } from '@core/cache';

/** Distinguishes several boundaries of one registry id; unique among siblings. @internal */
export const FRAGMENT_KEY_ATTRIBUTE = 'data-payload-fragment-key';
const DEPENDS_ATTRIBUTE = 'data-payload-depends';

/** @internal */
export interface FragmentBoundary {
  readonly element: Element;
  /** Registry id — never a path, module or function name. */
  readonly id: string;
  readonly key: string | undefined;
  /** Fields whose change re-renders the boundary; empty means any field. */
  readonly dependsOn: readonly string[];
}

/** One revision's request to a per-boundary handler. @internal */
export interface StrategyRequest {
  readonly revision: number;
  readonly receivedAt: number;
  readonly fields: Readonly<Record<string, unknown>>;
  readonly locale: string | undefined;
  readonly collectionSlug: string | undefined;
  readonly globalSlug: string | undefined;
  /** Aborted when a newer revision arrives or the runtime stops. */
  readonly signal: AbortSignal;
}

/** @internal */
export type FragmentOutcome =
  | {
      readonly status: 'rendered';
      /** The boundary's new inner HTML. */
      readonly html: string;
      readonly metadata?: Readonly<Record<string, unknown>>;
    }
  | { readonly status: 'failed'; readonly code: DiagnosticCode; readonly reason: string }
  | { readonly status: 'superseded' };

/** Renders one boundary for one revision. Must honour `request.signal`. @internal */
export type FragmentHandler = (
  request: StrategyRequest,
  boundary: FragmentBoundary,
) => Promise<FragmentOutcome>;

/** @internal */
export function describeBoundary(element: Element): FragmentBoundary | null {
  const id = element.getAttribute(FRAGMENT_ATTRIBUTE);
  if (id === null || id.length === 0) return null;
  const key = element.getAttribute(FRAGMENT_KEY_ATTRIBUTE);
  return {
    element,
    id,
    key: key === null || key.length === 0 ? undefined : key,
    dependsOn: parseDependencyList(element.getAttribute(DEPENDS_ATTRIBUTE)),
  };
}

/** The boundaries under `root` that `changedFields` touch; one inside an island is the island's business. @internal */
export function collectFragmentBoundaries(
  root: ParentNode,
  changedFields: ReadonlySet<string>,
  paths?: ReadonlySet<string>,
  elements?: readonly Element[],
): readonly FragmentBoundary[] {
  const index = boundaryIndex(elements ?? [...root.querySelectorAll(`[${FRAGMENT_ATTRIBUTE}]`)]);
  const exact = index.children.size > 0 ? paths : undefined;
  return index.boundaries.filter((boundary) => {
    if (exact === undefined) {
      return (
        boundary.dependsOn.length === 0 ||
        boundary.dependsOn.some((field) => changedFields.has(field))
      );
    }
    const relevant = [...exact].filter(
      (path) =>
        boundary.dependsOn.length === 0 ||
        boundary.dependsOn.some((field) => below(path, field) || below(field, path)),
    );
    if (relevant.length === 0) return false;
    const children = index.children.get(boundary.element) ?? [];
    // Coverage delegates rendering, never permission to patch. A changed
    // container above a child's dependency cannot be delegated to that child.
    return !relevant.every((path) =>
      children.some(
        (child) =>
          index.uniqueKeys.has(child.element) &&
          child.dependsOn.some(
            (field) =>
              below(path, field) &&
              boundary.dependsOn
                .filter((parent) => below(path, parent) || below(parent, path))
                .every((parent) => field.startsWith(parent + '.')),
          ),
      ),
    );
  });
}

const indexes = new WeakMap<
  readonly Element[],
  {
    readonly boundaries: readonly FragmentBoundary[];
    readonly children: ReadonlyMap<Element, readonly FragmentBoundary[]>;
    readonly uniqueKeys: ReadonlySet<Element>;
  }
>();

/** Cache metadata against the binding cache's immutable boundary snapshot. */
function boundaryIndex(elements: readonly Element[]): NonNullable<ReturnType<typeof indexes.get>> {
  const cached = indexes.get(elements);
  if (cached) return cached;
  const boundaries = elements.flatMap((element) => {
    const boundary = describeBoundary(element);
    return boundary === null || isInsideIsland(element) ? [] : [boundary];
  });
  const known = new Set(boundaries.map((boundary) => boundary.element));
  const children = new Map<Element, FragmentBoundary[]>();
  for (const boundary of boundaries) {
    const parent = boundary.element.parentElement?.closest(`[${FRAGMENT_ATTRIBUTE}]`);
    if (parent == null || !known.has(parent)) continue;
    const siblings = children.get(parent) ?? [];
    siblings.push(boundary);
    children.set(parent, siblings);
  }
  const uniqueKeys = new Set<Element>();
  for (const siblings of children.values()) {
    const counts = new Map<string, number>();
    for (const child of siblings) {
      const key = JSON.stringify([child.id, child.key]);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    for (const child of siblings) {
      const parent = child.element.parentElement?.closest(`[${FRAGMENT_ATTRIBUTE}]`);
      if (
        child.key !== undefined &&
        counts.get(JSON.stringify([child.id, child.key])) === 1 &&
        parent != null &&
        resolveBindingOwner(child.element) === resolveBindingOwner(parent)
      ) {
        uniqueKeys.add(child.element);
      }
    }
  }
  const index = { boundaries, children, uniqueKeys };
  indexes.set(elements, index);
  return index;
}

function below(path: string, field: string): boolean {
  return path === field || path.startsWith(field + '.');
}
