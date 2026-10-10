import { bench, describe } from 'vitest';
import { FieldChangeTracker } from '@core/field-changes';
import { cssBindingValue, parseCssTemplate } from '@/types/css-binding';
import { ElementCache } from '@core/cache';
import { canPatchFragment } from '@core/fragment-patches';
import type { RuntimeDeps } from '@core/runtime-state';

describe('generic CSS binding costs', () => {
  const binding = { property: 'border-radius', template: parseCssTemplate('{value}{unit}')! };
  const input = { value: 0, unit: 'px' };
  bench('cached object substitution and value validation', () => {
    cssBindingValue(binding, input);
  });

  const root = document.createElement('section');
  root.setAttribute('data-payload-fragment', 'blocks');
  root.setAttribute('data-payload-depends', 'blocks');
  root.setAttribute('data-payload-patch-fields', 'blocks.0.radius');
  root.innerHTML =
    '<div data-payload-field="blocks.0.radius" data-payload-css-property="border-radius" data-payload-css-format="{value}{unit}"></div>';
  const cache = new ElementCache();
  cache.buildFromRoot(root);
  const deps = { cache, scopeBindingsByOwner: false } as RuntimeDeps;
  const paths = new Set(['blocks.0.radius.value']);
  bench('cached boundary routing for one object member', () => {
    canPatchFragment(deps, root, paths);
  });

  bench('10 blocks: ordinary top-level diff', diffBenchmark(10, false));
  bench('10 blocks: patch-permitted detailed diff', diffBenchmark(10, true));
  bench('100 blocks: ordinary top-level diff', diffBenchmark(100, false));
  bench('100 blocks: patch-permitted detailed diff', diffBenchmark(100, true));
});
function diffBenchmark(count: number, detailed: boolean): () => void {
  const fields = [0, 1].map((value) => ({
    blocks: Array.from({ length: count }, (_, index) => ({
      id: String(index),
      blockType: 'card',
      radius: { value: index === 0 ? value : 10, unit: 'px' },
      title: 'Example',
      share: 50,
    })),
  }));
  const tracker = new FieldChangeTracker();
  let index = 0;
  return () => {
    tracker.diff(fields[index++ % 2]!, {}, detailed);
  };
}
