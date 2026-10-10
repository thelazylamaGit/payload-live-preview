/** A generic CSS sink using the original renderer/transform pipeline. */
import type { FieldRenderer } from '@core/types';
import { cssBindingValue } from '@/types/css-binding';

export const cssRenderer: FieldRenderer = {
  name: 'css',
  render(target, input) {
    const binding = target.cssBinding;
    const style = (target.element as Element & { readonly style?: CSSStyleDeclaration }).style;
    if (binding === undefined || binding.supported === false || style === undefined) return;
    const value = cssBindingValue(binding, input);
    const supports = (
      target.element.ownerDocument.defaultView as
        | (Window & {
            readonly CSS?: { readonly supports?: (property: string, value: string) => boolean };
          })
        | null
    )?.CSS?.supports;
    if (value === undefined || (supports !== undefined && !supports(binding.property, value))) {
      style.removeProperty(binding.property);
    } else {
      style.setProperty(binding.property, value);
    }
  },
};
