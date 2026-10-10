/** Conservative CSS token policy: no URLs, escapes, strings, comments or unlisted functions. */
export interface CssBinding {
  readonly property: string;
  readonly supported?: boolean;
  readonly template?: readonly string[];
  readonly fallback?: string;
}

export function validCssProperty(property: string): boolean {
  return /^(?:[a-z][a-z0-9]*(?:-[a-z0-9]+)*|--[a-zA-Z][a-zA-Z0-9_-]*)$/u.test(property);
}

export function parseCssTemplate(format: string): CssBinding['template'] {
  if (format.length > 1024) return undefined;
  const parts = format.split(/\{([a-zA-Z_$][\w$]*)\}/u);
  return parts.length > 65 ||
    parts.some((part, index) =>
      index % 2 === 0 ? /[{}]/u.test(part) : /^(?:__proto__|prototype|constructor)$/u.test(part),
    )
    ? undefined
    : parts;
}

function scalar(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

/** Same policy for scalars, substitutions, transforms and fallbacks, including custom properties. */
export function validCssValue(value: string): boolean {
  if (
    value.length === 0 ||
    value.length > 2048 ||
    !/^[\w #.,%()+*/-]+$/u.test(value) ||
    /\/\*|\*\//u.test(value)
  ) {
    return false;
  }
  let depth = 0;
  for (const match of value.matchAll(/#[\w-]*|([\w-]+) *\(|[()]/gu)) {
    const token = match[0];
    if (token.startsWith('#')) {
      if (!/^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/iu.test(token)) return false;
    } else if (match[1] !== undefined) {
      if (
        !/^(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|calc|min|max|clamp|(?:repeating-)?(?:linear|radial)-gradient|translate(?:[XYZ]|3d)?|scale(?:[XYZ]|3d)?|rotate[XYZ]?|skew[XY]?|matrix(?:3d)?)$/u.test(
          match[1],
        )
      ) {
        return false;
      }
      depth += 1;
    } else if (token === '(' || --depth < 0) return false;
  }
  return depth === 0;
}

export function cssBindingValue(binding: CssBinding, input: unknown): string | undefined {
  let value = scalar(input);
  if (binding.template !== undefined && input !== null && input !== undefined) {
    value = '';
    for (const [index, part] of binding.template.entries()) {
      const replacement =
        index % 2 === 0
          ? part
          : scalar(
              typeof input === 'object'
                ? Object.getOwnPropertyDescriptor(input, part)?.value
                : part === 'value'
                  ? input
                  : undefined,
            );
      if (replacement === undefined || value.length + replacement.length > 2048) {
        value = undefined;
        break;
      }
      value += replacement;
    }
  }
  if (value === undefined || value === '') value = binding.fallback;
  return value !== undefined && validCssValue(value) ? value : undefined;
}
