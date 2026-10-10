import { afterEach, describe, expect, it, vi } from 'vitest';
import { bind, bindMany, type FieldBindingAttributes } from '@dsl/bind';
import {
  cssBindingValue,
  parseCssTemplate,
  validCssProperty,
  validCssValue,
} from '@/types/css-binding';
import { buildBuiltinRenderers } from '@field-types/index';
import { createFragmentStrategy } from '@fragment/index';
import type { FragmentRequestBody } from '@/types/fragment-protocol';
import type { LivePreviewRuntime } from '@core/lifecycle';
import { ElementCache } from '@core/cache';
import { canPatchFragment } from '@core/fragment-patches';
import type { RuntimeDeps } from '@core/runtime-state';
import { buildSchemaIndex } from '@schema/index';
import { fireMessage, makeRuntime } from './lifecycle-startup-harness';

let runtime: LivePreviewRuntime | undefined;
afterEach(() => runtime?.destroy());
const tick = async () => {
  await vi.advanceTimersByTimeAsync(30);
};
function element(...bindings: readonly FieldBindingAttributes[]): HTMLElement {
  const el = document.createElement('div');
  for (const [name, value] of Object.entries(bindMany(...bindings))) {
    el.setAttribute(name, value as string);
  }
  return el;
}
function post(data: Record<string, unknown>): void {
  fireMessage({ type: 'payload-live-preview', globalSlug: 'home', data });
}

describe('generic CSS binding values', () => {
  it.each(['10px', 'cover', '50%', '#abcd', 'rgb(1, 2, 3)', 'calc(100% - 2px)', '0'])(
    'accepts conservative CSS tokens: %s',
    (value) => {
      expect(validCssValue(value)).toBe(true);
    },
  );
  it.each([
    'url(https://evil.test)',
    'u\\72l(x)',
    'URL(x)',
    'image-set(x)',
    'expression(x)',
    'var(--url)',
    'red;opacity:1',
    '/*x*/red',
    '"text"',
    '\nred',
    'red!important',
    'https://evil.test',
    'calc((1))',
  ])('rejects unsafe syntax: %s', (value) => {
    expect(validCssValue(value)).toBe(false);
    expect(cssBindingValue({ property: '--remote' }, value)).toBeUndefined();
    expect(cssBindingValue({ property: '--remote', fallback: value }, null)).toBeUndefined();
    expect(
      cssBindingValue({ property: '--remote', template: parseCssTemplate('{value}')! }, { value }),
    ).toBeUndefined();
  });
  it('substitutes bounded own primitive properties, preserves zero and never calls accessors or conversions', () => {
    const binding = {
      property: 'border-radius',
      template: parseCssTemplate('{value}{unit}')!,
      fallback: '0px',
    };
    expect(cssBindingValue(binding, { value: 0, unit: 'px' })).toBe('0px');
    expect(cssBindingValue(binding, { value: 12, unit: '%' })).toBe('12%');
    expect(cssBindingValue(binding, { value: 12 })).toBe('0px');
    expect(cssBindingValue(binding, Object.create({ value: 12, unit: 'px' }))).toBe('0px');
    const getter = vi.fn(() => 'px');
    expect(
      cssBindingValue(binding, {
        value: 1,
        get unit() {
          return getter();
        },
      }),
    ).toBe('0px');
    const conversion = vi.fn(() => 'px');
    expect(cssBindingValue(binding, { value: 1, unit: { toString: conversion } })).toBe('0px');
    expect(getter).not.toHaveBeenCalled();
    expect(conversion).not.toHaveBeenCalled();
    expect(cssBindingValue({ property: 'opacity' }, 0)).toBe('0');
    expect(cssBindingValue({ property: 'opacity' }, Infinity)).toBeUndefined();
    expect(cssBindingValue({ property: 'opacity' }, NaN)).toBeUndefined();
    expect(cssBindingValue({ property: 'opacity' }, {})).toBeUndefined();
    expect(cssBindingValue({ property: 'opacity', fallback: '0' }, undefined)).toBe('0');
  });
  it('rejects prototype paths, executable formats, long templates and invalid destinations', () => {
    for (const format of [
      '{__proto__}',
      '{constructor}',
      '{prototype}',
      '{value.toString()}',
      '{value.unit}',
      '{value',
      'x'.repeat(1025),
    ]) {
      expect(parseCssTemplate(format)).toBeUndefined();
    }
    for (const property of ['cssText', 'background;opacity', 'STYLE', '--', '-moz-binding']) {
      expect(validCssProperty(property)).toBe(false);
    }
    expect(() => bind('constructor.value', { cssProperty: 'opacity' })).toThrow();
    expect(() => bind('value', { cssProperty: 'background', fallback: 'url(x)' })).toThrow();
  });
});

describe('CSS writes through the existing runtime', () => {
  it('indexes nearest boundaries, owner scopes and explicit supported destinations', () => {
    document.body.innerHTML = `<section data-payload-owner="global:home" data-payload-fragment="outer" data-payload-depends="blocks" data-payload-patch-fields="blocks.0.radius,blocks.0.foreign,blocks.0.guess,blocks.0.unsupported,blocks.0.attribute">
      <section data-payload-fragment="inner" data-payload-depends="blocks" data-payload-patch-fields="blocks.0.radius,blocks.0.foreign,blocks.0.guess,blocks.0.unsupported,blocks.0.attribute">
        <div data-payload-field="blocks.0.radius" data-payload-css-property="border-radius"></div>
        <span data-payload-owner="global:other" data-payload-field="blocks.0.foreign"></span>
        <span data-payload-field="blocks.0.unlisted"></span>
        <span data-payload-field="blocks.0.guess" data-payload-guessed="old"></span>
        <span data-payload-field="blocks.0.unsupported" data-payload-css-property="invented-property"></span>
        <span data-payload-field="blocks.0.attribute" data-payload-attribute="style"></span>
      </section>
    </section>`;
    const cache = new ElementCache();
    cache.buildFromRoot(document.body);
    const deps = { cache, scopeBindingsByOwner: true } as RuntimeDeps;
    const [outer, inner] = document.querySelectorAll('section');
    const subtree = new ElementCache();
    subtree.buildFromRoot(inner!);
    expect(subtree.hasPatchFields).toBe(true);
    expect(canPatchFragment(deps, inner!, new Set(['blocks.0.radius']))).toBe(true);
    expect(canPatchFragment(deps, inner!, new Set(['blocks.0.radius.value']))).toBe(true);
    expect(
      canPatchFragment(
        deps,
        inner!,
        new Set(['blocks.0.radius']),
        new Set(),
        buildSchemaIndex([
          {
            name: 'blocks',
            type: 'array',
            fields: [{ name: 'radius', type: 'relationship', relationTo: 'media' }],
          },
        ]),
      ),
    ).toBe(false);
    expect(canPatchFragment(deps, outer!, new Set(['blocks.0.radius.value']))).toBe(false);
    for (const path of [
      'blocks.0.unlisted',
      'blocks.0.foreign',
      'blocks.0.guess',
      'blocks.0.unsupported',
      'blocks.0.attribute',
    ]) {
      expect(canPatchFragment(deps, inner!, new Set([path]))).toBe(false);
    }
    expect(
      canPatchFragment(
        deps,
        inner!,
        new Set(['blocks.0.radius.value', 'blocks']),
        new Set(['blocks']),
      ),
    ).toBe(false);
  });
  it('batches multiple bindings, uses transforms, clears missing values and preserves unrelated style and text', async () => {
    const el = element(
      bind('radius', { cssProperty: 'border-radius', format: '{value}{unit}', fallback: '0px' }),
      bind('share', { cssProperty: '--media-share', format: '{value}%', fallback: '50%' }),
      bind('fit', { cssProperty: 'object-fit', fallback: 'cover' }),
      bind('opacity', { cssProperty: 'opacity' }),
      bind('label'),
    );
    el.style.color = 'red';
    document.body.append(el);
    runtime = makeRuntime({
      skipUnchanged: true,
      renderers: buildBuiltinRenderers(),
      transformValue: (field, value) => (field === 'fit' && value === 'crop' ? 'cover' : value),
    });
    runtime.start();
    post({ radius: { value: 3, unit: 'px' }, share: 0, fit: 'crop', opacity: 0, label: 'Kept' });
    await tick();
    expect(el.style.borderRadius).toBe('3px');
    expect(el.style.getPropertyValue('--media-share')).toBe('0%');
    expect(el.style.objectFit).toBe('cover');
    expect(el.style.opacity).toBe('0');
    expect(el.textContent).toBe('Kept');
    runtime.refreshCache();
    post({ radius: { value: 3, unit: '%' }, share: null, fit: null, label: 'Updated' });
    await tick();
    expect(el.style.borderRadius).toBe('3%');
    expect(el.style.getPropertyValue('--media-share')).toBe('50%');
    expect(el.style.opacity).toBe('');
    expect(el.style.color).toBe('red');
    expect(el.textContent).toBe('Updated');
  });
  it('validates transform results and cannot read destinations or formats from messages', async () => {
    const el = element(bind('colour', { cssProperty: '--colour' }));
    document.body.append(el);
    runtime = makeRuntime({ transformValue: () => 'url(https://evil.test)' });
    runtime.start();
    post({ colour: 'red', cssProperty: 'background', format: 'url({value})' });
    await tick();
    expect(el.style.length).toBe(0);
    expect(el.getAttribute('data-payload-css-property')).toBe('--colour');
  });
  it('patches object member edits, text and attributes with zero population and fragment requests', async () => {
    const section = document.createElement('section');
    section.setAttribute('data-payload-fragment', 'page-blocks');
    section.setAttribute('data-payload-depends', 'blocks');
    section.setAttribute(
      'data-payload-patch-fields',
      'blocks.0.radius,blocks.0.title,blocks.0.label',
    );
    const el = element(
      bind('blocks.0.radius', { cssProperty: 'border-radius', format: '{value}{unit}' }),
      bind('blocks.0.title'),
      bind('blocks.0.label', { attribute: 'aria-label' }),
    );
    section.append(el);
    document.body.append(section);
    const markup = section.innerHTML;
    const fragment = vi.fn<typeof fetch>((_url, init) => {
      const body = JSON.parse(init!.body as string) as FragmentRequestBody;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            html: markup,
            boundary: { id: body.fragment },
            revision: body.revision,
            metadata: { renderedAt: '2026-10-10', renderer: 'test' },
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
      );
    });
    const population = vi.fn<typeof fetch>((_url, init) =>
      Promise.resolve(
        new Response(JSON.stringify((JSON.parse(init!.body as string) as { data: unknown }).data)),
      ),
    );
    runtime = makeRuntime({
      renderers: buildBuiltinRenderers(),
      dataMerge: { serverURL: 'https://cms.example.com', fetchFn: population },
      strategies: {
        fragment: createFragmentStrategy({ endpoint: '/payload/fragment', fetch: fragment }),
      },
    });
    runtime.start();
    const fields = {
      blocks: [
        { id: 'a', radius: { value: 2, unit: 'px' }, title: 'One', label: 'Before', server: 'old' },
      ],
    };
    post(fields);
    await tick();
    fragment.mockClear();
    population.mockClear();
    fields.blocks[0]!.radius.value = 0;
    fields.blocks[0]!.title = 'Two';
    fields.blocks[0]!.label = 'After';
    post(fields);
    await tick();
    expect(fragment).not.toHaveBeenCalled();
    expect(population).not.toHaveBeenCalled();
    const updated = document.querySelector<HTMLElement>('section div')!;
    expect(updated.style.borderRadius).toBe('0px');
    expect(updated.textContent).toBe('Two');
    expect(updated.getAttribute('aria-label')).toBe('After');
    fields.blocks[0]!.radius.unit = '%';
    post(fields);
    await tick();
    expect(updated.style.borderRadius).toBe('0%');
    expect(fragment).not.toHaveBeenCalled();
    expect(population).not.toHaveBeenCalled();
    fields.blocks[0]!.title = 'Three';
    fields.blocks[0]!.server = 'new';
    post(fields);
    await tick();
    expect(fragment).toHaveBeenCalledTimes(1);
    fragment.mockClear();
    document
      .querySelector('section')!
      .setAttribute('data-payload-patch-fields', 'blocks.0.radius,blocks.0.title');
    runtime.refreshCache();
    fields.blocks[0]!.label = 'Bound but not permitted';
    post(fields);
    await tick();
    expect(fragment).toHaveBeenCalledTimes(1);
  });
});
