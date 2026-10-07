/** A narrow CSS colour sink; never writes the style attribute. */
import type { FieldRenderer } from '@core/types';
const HEX_COLOR = /^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/iu;

export const hexColorRenderer: FieldRenderer = {
  name: 'hexColor',
  render({ element }, value) {
    const property = element.getAttribute('data-payload-css-property');
    if (property !== 'background-color') return;
    const style = (element as Element & { readonly style?: CSSStyleDeclaration }).style;
    if (style === undefined) return;
    const cleared = value === null || value === '';
    const colour = cleared ? element.getAttribute('data-payload-css-default') : value;
    if (cleared && (colour === null || colour === '')) {
      style.removeProperty(property);
    } else if (typeof colour === 'string' && HEX_COLOR.test(colour)) {
      style.setProperty(property, colour);
    }
  },
};
