import { bench, describe } from 'vitest';
import { ElementCache } from '@core/cache';
import { collectFragmentBoundaries } from '@fragment/boundary';

function routing(count: number): () => void {
  const root = document.createElement('section');
  root.setAttribute('data-payload-fragment', 'list');
  root.setAttribute('data-payload-depends', 'blocks');
  root.innerHTML = Array.from(
    { length: count },
    (_, index) =>
      `<article data-payload-fragment="block" data-payload-fragment-key="${index}" data-payload-depends="blocks.${index}"><h2 data-payload-field="blocks.${index}.title">Title</h2></article>`,
  ).join('');
  const cache = new ElementCache();
  cache.buildFromRoot(root);
  const fields = new Set(['blocks']);
  const paths = new Set(['blocks.0.title']);
  return () => {
    collectFragmentBoundaries(root, fields, { paths, boundaries: cache.fragmentBoundaries });
  };
}

describe('cached nested fragment planning', () => {
  bench('10 children: one content edit', routing(10));
  bench('100 children: one content edit', routing(100));
});
