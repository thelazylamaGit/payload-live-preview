/** Fragment boundaries: how a `data-payload-fragment` element is read and which ones an update touches. */

import type { DiagnosticCode } from '@core/diagnostic-codes';
import { isInsideIsland } from '@core/islands';
import { parseDependencyList } from '@core/dependencies';
import type { FragmentStrategy } from '@core/strategies';
import { FRAGMENT_ATTRIBUTE } from '@core/strategies';

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
  options?: Parameters<FragmentStrategy['plan']>[2],
): readonly FragmentBoundary[] {
  const boundaries: FragmentBoundary[] = [];
  const indexed = options?.boundaries;
  const elements = indexed?.keys() ?? root.querySelectorAll('[' + FRAGMENT_ATTRIBUTE + ']');
  for (const element of elements) {
    const metadata = indexed?.get(element);
    const boundary =
      metadata === undefined
        ? describeBoundary(element)
        : {
            element,
            id: metadata.id,
            key: metadata.key,
            dependsOn: metadata.dependencies,
          };
    if (
      boundary === null ||
      boundary.id.length === 0 ||
      (indexed === undefined && isInsideIsland(element))
    ) {
      continue;
    }
    const paths = options?.paths;
    if (paths === undefined) {
      if (
        boundary.dependsOn.length === 0 ||
        boundary.dependsOn.some((field) => changedFields.has(field))
      ) {
        boundaries.push(boundary);
      }
      continue;
    }
    const relevant = [...paths].filter(
      (path) =>
        boundary.dependsOn.length === 0 ||
        boundary.dependsOn.some((field) => below(path, field) || below(field, path)),
    );
    if (relevant.length === 0) continue;
    // Delegate content only to a unique, same-owner child with narrower dependencies.
    // A container change above a child's dependency always stays with the parent.
    if (
      metadata !== undefined &&
      relevant.every((path) =>
        metadata.children.some((element) => {
          const child = indexed?.get(element);
          return (
            child?.delegatable === true &&
            child.dependencies.some(
              (field) =>
                below(path, field) &&
                boundary.dependsOn
                  .filter((parent) => below(path, parent) || below(parent, path))
                  .every((parent) => field.startsWith(parent + '.')),
            )
          );
        }),
      )
    ) {
      continue;
    }
    boundaries.push(boundary);
  }
  return boundaries;
}

function below(path: string, field: string): boolean {
  return path === field || path.startsWith(field + '.');
}
