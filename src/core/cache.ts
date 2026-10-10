/**
 * Maps field names to their bound elements so an update walks the cache, not
 * the DOM. Everything an update needs about a binding is resolved here, once,
 * at build time.
 */

import {
  dependencyMapFromBinding,
  mergeDependencyMaps,
  parseDependencyList,
  type DependencyMap,
} from './dependencies';
import { parseCssTemplate, validCssProperty } from '@/types/css-binding';
import { collectIslands, isInsideIsland } from './islands';
import { enclosingFragment, FRAGMENT_ATTRIBUTE, resolveStrategy } from './strategies';
import type { CachedElement, ElementPredicate, FieldType, RendererKey } from './types';

export const FIELD_ATTRIBUTE = 'data-payload-field';
export const TYPE_ATTRIBUTE = 'data-payload-type';
export const TARGET_ATTRIBUTE_ATTRIBUTE = 'data-payload-attribute';
export const HREF_ATTRIBUTE = 'data-payload-href';
export const SRC_ATTRIBUTE = 'data-payload-src';
export const ALT_ATTRIBUTE = 'data-payload-alt';
export const ARRAY_TEMPLATE_ATTRIBUTE = 'data-payload-array-template';
export const ARRAY_SEPARATOR_ATTRIBUTE = 'data-payload-array-separator';
export const LOCALE_ATTRIBUTE = 'data-payload-locale';
export const FORMAT_ATTRIBUTE = 'data-payload-format';
export const RICH_TEXT_ATTRIBUTE = 'data-payload-richtext';
export const HTML_ATTRIBUTE = 'data-payload-html';
export const ARRAY_ATTRIBUTE = 'data-payload-array';
export const STRUCTURAL_ATTRIBUTE = 'data-payload-structural';
export const OWNER_ATTRIBUTE = 'data-payload-owner';
export const DEPENDS_ATTRIBUTE = 'data-payload-depends';
export const STRATEGY_ATTRIBUTE = 'data-payload-strategy';
export const BOUNDARY_ATTRIBUTE = 'data-payload-boundary';
/**
 * Written by the runtime, never by a template: the value an auto-binding
 * matched on (ADR 0014). Its presence is what tells a guessed binding from a
 * declared one, in `inspect()` and in the overlay.
 */
export const GUESSED_ATTRIBUTE = 'data-payload-guessed';
export const INPUT_TYPE_ATTRIBUTE = 'type';

/**
 * Attributes captured in a `CachedElement`. The mutation observer watches
 * exactly this list, so a snapshot can never go stale on a mounted element.
 */
export const BINDING_ATTRIBUTES: readonly string[] = [
  FIELD_ATTRIBUTE,
  FRAGMENT_ATTRIBUTE,
  'data-payload-fragment-key',
  'data-payload-css-property',
  'data-payload-css-fallback',
  'data-payload-css-format',
  'data-payload-bindings',
  'data-payload-patch-fields',
  TYPE_ATTRIBUTE,
  TARGET_ATTRIBUTE_ATTRIBUTE,
  HREF_ATTRIBUTE,
  SRC_ATTRIBUTE,
  ALT_ATTRIBUTE,
  ARRAY_TEMPLATE_ATTRIBUTE,
  ARRAY_SEPARATOR_ATTRIBUTE,
  LOCALE_ATTRIBUTE,
  RICH_TEXT_ATTRIBUTE,
  HTML_ATTRIBUTE,
  ARRAY_ATTRIBUTE,
  STRUCTURAL_ATTRIBUTE,
  OWNER_ATTRIBUTE,
  DEPENDS_ATTRIBUTE,
  STRATEGY_ATTRIBUTE,
  BOUNDARY_ATTRIBUTE,
  INPUT_TYPE_ATTRIBUTE,
];

const FIELD_SELECTOR = `[${FIELD_ATTRIBUTE}]`;
const OWNER_SELECTOR = `[${OWNER_ATTRIBUTE}]`;

/** The document a binding belongs to: its nearest `data-payload-owner`, itself included. */
export function resolveBindingOwner(element: Element): string | undefined {
  const owner = element.closest(OWNER_SELECTOR)?.getAttribute(OWNER_ATTRIBUTE);
  return owner === null || owner === undefined || owner.length === 0 ? undefined : owner;
}

/** `namespace:name` — a project renderer key can never be a typo of a built-in type. */
const CUSTOM_RENDERER_KEY = /^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/i;

const VALID_FIELD_TYPES: ReadonlySet<FieldType> = new Set<FieldType>([
  'css',
  'text',
  'textarea',
  'richText',
  'email',
  'number',
  'checkbox',
  'date',
  'select',
  'radio',
  'array',
  'blocks',
  'group',
  'tabs',
  'row',
  'collapsible',
  'relationship',
  'upload',
  'point',
  'json',
  'code',
  'ui',
  'html',
  'url',
  'image',
  'structural-array',
]);

function isRendererKey(value: string): value is RendererKey {
  return VALID_FIELD_TYPES.has(value as FieldType) || CUSTOM_RENDERER_KEY.test(value);
}

export interface CacheBuildStats {
  readonly elementCount: number;
  readonly fieldCount: number;
  readonly durationMs: number;
}

export interface ElementCacheOptions {
  /** Restricts which elements are accepted. Defaults to all. */
  readonly filter?: ElementPredicate;
}

/** Boundary declarations and nesting resolved by the existing binding cache. @internal */
export interface FragmentBoundaryMetadata {
  readonly id: string;
  readonly key: string | undefined;
  readonly patchFields: readonly string[];
  readonly dependencies: readonly string[];
  readonly owner: string | undefined;
  readonly children: Element[];
  delegatable: boolean;
}

/** Elements share field buckets; entries within each field follow DOM order. */
export class ElementCache {
  private readonly entriesByField = new Map<string, CachedElement[]>();
  private entryByElement = new WeakMap<Element, CachedElement[]>();
  private readonly filter: ElementPredicate;
  private count = 0;
  private patchPermissions = false;
  private readonly boundaries = new Map<Element, FragmentBoundaryMetadata>();
  private nestedFragments = false;
  get fragmentBoundaries(): ReadonlyMap<Element, FragmentBoundaryMetadata> {
    return this.boundaries;
  }
  get hasNestedFragments(): boolean {
    return this.nestedFragments;
  }
  boundaryMetadata(element: Element): FragmentBoundaryMetadata | undefined {
    return this.boundaries.get(element);
  }
  private indexBoundary(element: Element): void {
    if ((typeof __LEAN_BUILD__ !== 'undefined' && __LEAN_BUILD__) || isInsideIsland(element)) {
      return;
    }
    const id = element.getAttribute(FRAGMENT_ATTRIBUTE);
    if (id === null || id.length === 0) return;
    const patchFields = parseDependencyList(element.getAttribute('data-payload-patch-fields'));
    if (patchFields.length > 0) this.patchPermissions = true;
    const owner = resolveBindingOwner(element);
    const key = element.getAttribute('data-payload-fragment-key');
    this.boundaries.set(element, {
      id,
      key: key === null || key.length === 0 ? undefined : key,
      children: [],
      delegatable: false,
      patchFields,
      dependencies: parseDependencyList(element.getAttribute(DEPENDS_ATTRIBUTE)),
      owner,
    });
  }
  get hasPatchFields(): boolean {
    return this.patchPermissions;
  }
  private dependencies: DependencyMap | null = null;
  private islandRoots: readonly Element[] = [];

  constructor(options: ElementCacheOptions = {}) {
    this.filter = options.filter ?? alwaysTrue;
  }

  /** Source → dependents declared with `data-payload-depends`; memoised until the cache changes. */
  dependencyMap(): DependencyMap {
    if (this.dependencies !== null) return this.dependencies;
    const maps: DependencyMap[] = [];
    for (const binding of this.values()) {
      if (binding.dependsOn !== undefined) {
        maps.push(dependencyMapFromBinding(binding.fieldName, binding.dependsOn));
      }
    }
    this.dependencies = mergeDependencyMaps(...maps);
    return this.dependencies;
  }

  /** Island roots under the last built root, for update events. */
  get islands(): readonly Element[] {
    return this.islandRoots;
  }

  buildFromRoot(root: ParentNode): CacheBuildStats {
    const t0 = performance.now();
    this.clear();
    const includeFragments = !(typeof __LEAN_BUILD__ !== 'undefined' && __LEAN_BUILD__);
    if (
      includeFragments &&
      'getAttribute' in root &&
      (root as Element).hasAttribute(FRAGMENT_ATTRIBUTE)
    ) {
      this.indexBoundary(root as Element);
    }
    let elementCount = 0;
    for (const element of root.querySelectorAll(
      includeFragments ? FIELD_SELECTOR + ',[' + FRAGMENT_ATTRIBUTE + ']' : FIELD_SELECTOR,
    )) {
      if (includeFragments && element.hasAttribute(FRAGMENT_ATTRIBUTE)) this.indexBoundary(element);
      if (element.hasAttribute(FIELD_ATTRIBUTE) && this.add(element) !== undefined) {
        elementCount += 1;
      }
    }
    if (includeFragments) {
      // Resolve nesting and sibling identities once, alongside binding indexing.
      for (const [element] of this.boundaries) {
        if ('contains' in root && !(root as Node).contains(element)) {
          this.boundaries.delete(element);
          continue;
        }
        const parent = element.parentElement?.closest('[' + FRAGMENT_ATTRIBUTE + ']');
        if (parent != null && this.boundaries.has(parent)) {
          this.boundaries.get(parent)?.children.push(element);
          this.nestedFragments = true;
        }
      }
      for (const parent of this.boundaries.values()) {
        const counts = new Map<string, number>();
        for (const element of parent.children) {
          const child = this.boundaries.get(element);
          if (child === undefined) continue;
          if (child.key !== undefined) counts.set(child.key, (counts.get(child.key) ?? 0) + 1);
        }
        for (const element of parent.children) {
          const child = this.boundaries.get(element);
          if (child === undefined) continue;
          child.delegatable =
            child.key !== undefined && counts.get(child.key) === 1 && child.owner === parent.owner;
        }
      }
    }
    this.islandRoots = collectIslands(root);
    return {
      elementCount,
      fieldCount: this.entriesByField.size,
      durationMs: performance.now() - t0,
    };
  }

  /**
   * Insert or replace a single element's binding. Re-adding refreshes the
   * snapshot in place; an element that is now filtered or unbound is removed.
   */
  add(element: Element): CachedElement | undefined {
    // Resolve before mutating so a throwing filter leaves the old entry intact.
    const entry = this.filter(element) ? this.resolveBinding(element) : undefined;
    const bindings = this.entryByElement.get(element) ?? [];
    for (const extra of bindings.slice(1)) this.removeEntry(element, extra);
    const previous = bindings[0];
    const entries = entry === undefined ? [] : [entry, ...this.addExtras(element)];
    this.dependencies = null;
    if (entry === undefined) {
      if (previous !== undefined) this.removeEntry(element, previous);
      return undefined;
    }
    if (previous !== undefined && this.replaceEntry(previous, entry)) {
      this.entryByElement.set(element, entries);
      return entry;
    }
    if (previous !== undefined) this.removeEntry(element, previous);
    this.append(entry);
    this.entryByElement.set(element, entries);
    return entry;
  }

  /** Returns whether a binding was removed. */
  remove(element: Element): boolean {
    const entries = this.entryByElement.get(element);
    if (entries === undefined) return false;
    for (const extra of entries.slice(1)) this.removeEntry(element, extra);
    const entry = entries[0];
    if (entry === undefined) return false;
    this.dependencies = null;
    return this.removeEntry(element, entry);
  }

  get(fieldName: string): readonly CachedElement[] | undefined {
    return this.entriesByField.get(fieldName);
  }

  getByElement(element: Element): CachedElement | undefined {
    return this.entryByElement.get(element)?.[0];
  }

  get fieldCount(): number {
    return this.entriesByField.size;
  }

  get elementCount(): number {
    return this.count;
  }

  entries(): IterableIterator<[string, readonly CachedElement[]]> {
    return this.entriesByField.entries() as IterableIterator<[string, readonly CachedElement[]]>;
  }

  *values(): IterableIterator<CachedElement> {
    for (const bucket of this.entriesByField.values()) yield* bucket;
  }

  has(element: Element): boolean {
    return this.entryByElement.has(element);
  }

  clear(): void {
    this.entriesByField.clear();
    // WeakMap cannot be cleared; a detached element must not observe stale membership.
    this.entryByElement = new WeakMap();
    this.count = 0;
    this.boundaries.clear();
    this.nestedFragments = false;
    this.patchPermissions = false;
    this.dependencies = null;
    this.islandRoots = [];
  }

  /** Replace in place when the field bucket is unchanged, preserving order. */
  private replaceEntry(previous: CachedElement, next: CachedElement): boolean {
    if (previous.fieldName !== next.fieldName) return false;
    const bucket = this.entriesByField.get(previous.fieldName);
    const index = bucket === undefined ? -1 : bucket.indexOf(previous);
    if (bucket === undefined || index < 0) return false;
    bucket[index] = next;
    return true;
  }

  private removeEntry(element: Element, entry: CachedElement): boolean {
    if (this.entryByElement.get(element)?.[0] === entry) this.entryByElement.delete(element);
    const bucket = this.entriesByField.get(entry.fieldName);
    const index = bucket === undefined ? -1 : bucket.indexOf(entry);
    if (bucket === undefined || index < 0) return false;
    bucket.splice(index, 1);
    if (bucket.length === 0) this.entriesByField.delete(entry.fieldName);
    this.count -= 1;
    return true;
  }

  private append(entry: CachedElement): void {
    const bucket = this.entriesByField.get(entry.fieldName);
    if (bucket) bucket.push(entry);
    else this.entriesByField.set(entry.fieldName, [entry]);
    this.count += 1;
  }

  private addExtras(element: Element): CachedElement[] {
    const raw = element.getAttribute('data-payload-bindings');
    if (raw === null || raw.length > 32768) return [];
    try {
      const declarations: unknown = JSON.parse(raw);
      if (!Array.isArray(declarations) || declarations.length > 32) return [];
      const entries: CachedElement[] = [];
      for (const declaration of declarations) {
        if (declaration === null || typeof declaration !== 'object') continue;
        const attributes = declaration as Record<string, unknown>;
        const entry = this.resolveBinding(element, {
          getAttribute: (name) => (typeof attributes[name] === 'string' ? attributes[name] : null),
          hasAttribute: (name) => typeof attributes[name] === 'string',
        });
        if (entry !== undefined) {
          entries.push(entry);
          this.append(entry);
        }
      }
      return entries;
    } catch {
      /* Malformed developer declaration is not a binding. */
      return [];
    }
  }

  private resolveBinding(
    element: Element,
    attributes: Pick<Element, 'getAttribute' | 'hasAttribute'> = element,
  ): CachedElement | undefined {
    const fieldName = attributes.getAttribute(FIELD_ATTRIBUTE);
    if (
      fieldName === null ||
      fieldName.length === 0 ||
      fieldName.split('.').some((part) => ['__proto__', 'prototype', 'constructor'].includes(part))
    ) {
      return undefined;
    }
    const property = attributes.getAttribute('data-payload-css-property');
    const cssFormat = attributes.getAttribute('data-payload-css-format');
    const template = cssFormat === null ? undefined : parseCssTemplate(cssFormat);
    if (
      property !== null &&
      (!validCssProperty(property) || (cssFormat !== null && template === undefined))
    ) {
      return undefined;
    }
    if (
      property !== null &&
      (attributes.hasAttribute(TARGET_ATTRIBUTE_ATTRIBUTE) ||
        attributes.hasAttribute(RICH_TEXT_ATTRIBUTE) ||
        attributes.hasAttribute(HTML_ATTRIBUTE))
    ) {
      return undefined;
    }
    const fallback = attributes.getAttribute('data-payload-css-fallback');
    const explicit = attributes.getAttribute(TYPE_ATTRIBUTE);
    const targetAttribute = attributes.getAttribute(TARGET_ATTRIBUTE_ATTRIBUTE);
    const hrefField = attributes.getAttribute(HREF_ATTRIBUTE);
    const srcField = attributes.getAttribute(SRC_ATTRIBUTE);
    const altField = attributes.getAttribute(ALT_ATTRIBUTE);
    const arrayTemplate = attributes.getAttribute(ARRAY_TEMPLATE_ATTRIBUTE);
    const arraySeparator = attributes.getAttribute(ARRAY_SEPARATOR_ATTRIBUTE);
    const locale = attributes.getAttribute(LOCALE_ATTRIBUTE);
    const format = attributes.getAttribute(FORMAT_ATTRIBUTE);
    const owner = resolveBindingOwner(element);
    const dependsOn = parseDependencyList(attributes.getAttribute(DEPENDS_ATTRIBUTE));
    const strategy = attributes.getAttribute(STRATEGY_ATTRIBUTE);
    const guessed = attributes.getAttribute(GUESSED_ATTRIBUTE);
    const fragmentBoundary = enclosingFragment(element);
    if (fragmentBoundary !== null && !this.boundaries.has(fragmentBoundary)) {
      this.indexBoundary(fragmentBoundary);
    }
    return {
      element,
      fieldName,
      ...(property === null
        ? {}
        : {
            cssBinding: {
              property,
              supported:
                property.startsWith('--') ||
                property in
                  ((element as Element & { readonly style?: CSSStyleDeclaration }).style ?? {}),
              ...(template === undefined ? {} : { template }),
              ...(fallback === null ? {} : { fallback }),
            },
          }),
      fieldType: property === null ? resolveFieldType(element, attributes) : 'css',
      explicitFieldType: property !== null || (explicit !== null && isRendererKey(explicit)),
      strategyKind: resolveStrategy(element) ?? 'unknown',
      ...(fragmentBoundary !== null ? { fragmentBoundary } : {}),
      ...(targetAttribute !== null && targetAttribute.length > 0 ? { targetAttribute } : {}),
      ...(hrefField !== null && hrefField.length > 0 ? { hrefField } : {}),
      ...(srcField !== null && srcField.length > 0 ? { srcField } : {}),
      ...(altField !== null && altField.length > 0 ? { altField } : {}),
      ...(arrayTemplate !== null ? { arrayTemplate } : {}),
      ...(arraySeparator !== null ? { arraySeparator } : {}),
      ...(locale !== null && locale.length > 0 ? { locale } : {}),
      ...(format !== null && format.length > 0 ? { format } : {}),
      ...(owner !== undefined ? { owner } : {}),
      ...(dependsOn.length > 0 ? { dependsOn } : {}),
      ...(strategy !== null && strategy.length > 0 ? { strategy } : {}),
      ...(attributes.hasAttribute(BOUNDARY_ATTRIBUTE) ? { hidesWhenEmpty: true } : {}),
      ...(guessed !== null ? { guessed } : {}),
    };
  }
}

/** Explicit `data-payload-type`, then element heuristics, then `text`. */
export function resolveFieldType(
  element: Element,
  attributes: Pick<Element, 'getAttribute' | 'hasAttribute'> = element,
): RendererKey {
  const explicit = attributes.getAttribute(TYPE_ATTRIBUTE);
  if (explicit !== null && isRendererKey(explicit)) return explicit;
  if (attributes.hasAttribute(RICH_TEXT_ATTRIBUTE)) return 'richText';
  if (attributes.hasAttribute(HTML_ATTRIBUTE)) return 'html';
  if (attributes.hasAttribute(STRUCTURAL_ATTRIBUTE)) return 'structural-array';
  if (attributes.hasAttribute(ARRAY_ATTRIBUTE)) return 'array';
  if (element.tagName === 'IMG') return 'image';
  if (element.tagName === 'A') return 'url';
  if (element.tagName === 'TIME') return 'date';
  if (element.tagName === 'INPUT') {
    const inputType = (element as HTMLInputElement).type;
    if (inputType === 'checkbox') return 'checkbox';
    if (inputType === 'number') return 'number';
    if (inputType === 'date' || inputType === 'datetime-local') return 'date';
  }
  return 'text';
}

function alwaysTrue(): boolean {
  return true;
}
