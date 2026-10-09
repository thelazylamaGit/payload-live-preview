import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildBuiltinRenderers } from '@field-types/index';
import { createFragmentStrategy } from '@fragment/index';
import type { FragmentRequestBody } from '@/types/fragment-protocol';
import type { LivePreviewRuntime } from '@core/lifecycle';
import { deferred, fireMessage, makeRuntime } from './lifecycle-startup-harness';

const blocks = () => [
  { id: 'a', blockType: 'banner', title: 'One', colour: '#123' },
  { id: 'b', blockType: 'banner', title: 'Two', colour: '#456' },
  { id: 'c', blockType: 'banner', title: 'Three', colour: '#789' },
];
type Block = ReturnType<typeof blocks>[number];
function content(block: Block, index: number): string {
  return `<h2 data-payload-field="blocks.${index}.title">${block.title}</h2><div data-payload-field="blocks.${index}.colour" data-payload-type="hexColor" data-payload-css-property="background-color" style="background-color:${block.colour}"></div>`;
}
function list(items: readonly Block[]): string {
  return items
    .map(
      (block, index) =>
        `<article data-payload-key="${block.id}" data-payload-fragment="block" data-payload-fragment-key="${block.id}" data-payload-depends="blocks.${index}" data-payload-patch-fields="blocks.${index}.colour">${content(block, index)}</article>`,
    )
    .join('');
}
function response(body: FragmentRequestBody): Response {
  const items = body.fields['blocks'] as Block[];
  const index = items.findIndex((block) => block.id === body.key);
  return new Response(
    JSON.stringify({
      html: body.fragment === 'list' ? list(items) : content(items[index]!, index),
      boundary: { id: body.fragment, key: body.key },
      revision: body.revision,
      metadata: { renderedAt: '2026-10-10T00:00:00Z', renderer: 'test' },
    }),
    { headers: { 'content-type': 'application/json' } },
  );
}
let runtime: LivePreviewRuntime | undefined;
afterEach(() => {
  runtime?.destroy();
  runtime = undefined;
});
const tick = async () => {
  await vi.advanceTimersByTimeAsync(30);
};
function post(items: readonly Block[], extra: Record<string, unknown> = {}): void {
  fireMessage({
    type: 'payload-live-preview',
    globalSlug: 'home',
    data: { blocks: items, ...extra },
  });
}
function body(call: [string, (RequestInit | undefined)?]): FragmentRequestBody {
  return JSON.parse(call[1]!.body as string) as FragmentRequestBody;
}
function node(key: string): HTMLElement {
  return document.querySelector(`[data-payload-fragment-key="${key}"]`)!;
}
async function start() {
  document.body.innerHTML = `<section data-payload-owner="global:home" data-payload-fragment="list" data-payload-depends="blocks,layout">${list(blocks())}</section>`;
  const fetchFragment = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(
    (_url, init) => Promise.resolve(response(body([_url, init]))),
  );
  runtime = makeRuntime({
    renderers: buildBuiltinRenderers(),
    autoBind: 'off',
    enableA11y: false,
    bindingDebounceMs: 0,
    scopeBindingsByOwner: true,
    strategies: {
      fragment: createFragmentStrategy({ endpoint: '/payload/fragment', fetch: fetchFragment }),
    },
  });
  runtime.start();
  post(blocks());
  await tick();
  expect(fetchFragment.mock.calls.map((call) => body(call).fragment)).toEqual(['list']);
  fetchFragment.mockClear();
  return fetchFragment;
}
describe('targeted keyed child fragments', () => {
  it('requests only one affected child without rescanning the DOM during planning', async () => {
    const fetchFragment = await start();
    const pending = deferred<Response>();
    fetchFragment.mockImplementationOnce(() => pending.promise);
    const scan = vi.spyOn(document, 'querySelectorAll');
    const items = blocks();
    items[1]!.title = 'Edited';
    post(items);
    await tick();
    expect(fetchFragment.mock.calls.map((call) => [body(call).fragment, body(call).key])).toEqual([
      ['block', 'b'],
    ]);
    expect(scan).not.toHaveBeenCalled();
    scan.mockRestore();
    expect(node('b').querySelector('h2')?.textContent).toBe('Two');
    pending.resolve(response(body(fetchFragment.mock.calls[0]!)));
    await tick();
    expect(node('b').querySelector('h2')?.textContent).toBe('Edited');
  });

  it('renders only affected siblings independently', async () => {
    const fetchFragment = await start();
    const items = blocks();
    items[0]!.title = 'A';
    items[2]!.title = 'C';
    post(items);
    await tick();
    expect(fetchFragment.mock.calls.map((call) => body(call).key).sort()).toEqual(['a', 'c']);
    expect(node('b').querySelector('h2')?.textContent).toBe('Two');
  });

  it('refreshes child dependencies when an empty list gains its first block', async () => {
    const fetchFragment = await start();
    post([]);
    await tick();
    expect(document.querySelectorAll('article')).toHaveLength(0);
    const items = [blocks()[0]!];
    post(items);
    await tick();
    fetchFragment.mockClear();
    items[0]!.title = 'First child';
    post(items);
    await tick();
    expect(fetchFragment.mock.calls.map((call) => [body(call).fragment, body(call).key])).toEqual([
      ['block', 'a'],
    ]);
  });

  it.each(['insert', 'remove', 'reorder', 'type'])('renders only the list on %s', async (edit) => {
    const fetchFragment = await start();
    const items = blocks();
    if (edit === 'insert') items.push({ ...items[0]!, id: 'd' });
    if (edit === 'remove') items.pop();
    if (edit === 'reorder') items.reverse();
    if (edit === 'type') items[0]!.blockType = 'card';
    items[0]!.colour = '#f00';
    post(items);
    await tick();
    expect(fetchFragment.mock.calls.map((call) => body(call).fragment)).toEqual(['list']);
    fetchFragment.mockClear();
    items[0]!.title = 'After structure';
    post(items);
    await tick();
    expect(fetchFragment.mock.calls.map((call) => body(call).key)).toEqual([items[0]!.id]);
    expect(node(items[0]!.id).querySelector('h2')?.textContent).toBe('After structure');
  });

  it('patches an explicitly permitted sibling while leaving server-owned writes alone', async () => {
    const fetchFragment = await start();
    const pending = deferred<Response>();
    fetchFragment.mockImplementationOnce(() => pending.promise);
    const items = blocks();
    items[0]!.colour = '#f00';
    items[1]!.colour = '#0f0';
    items[1]!.title = 'Server';
    post(items);
    await tick();
    expect(fetchFragment.mock.calls.map((call) => body(call).key)).toEqual(['b']);
    expect(node('a').querySelector('div')?.style.backgroundColor).toBe('rgb(255, 0, 0)');
    expect(node('b').querySelector('div')?.style.backgroundColor).toBe('rgb(68, 85, 102)');
    pending.resolve(response(body(fetchFragment.mock.calls[0]!)));
    await tick();
    expect(node('b').querySelector('div')?.style.backgroundColor).toBe('rgb(0, 255, 0)');
  });

  it('does not infer permission from child coverage', async () => {
    const fetchFragment = await start();
    document.querySelector('section')!.setAttribute('data-payload-patch-fields', 'blocks.0.colour');
    node('a').removeAttribute('data-payload-patch-fields');
    runtime!.refreshCache();
    const items = blocks();
    items[0]!.colour = '#f00';
    post(items);
    await tick();
    expect(fetchFragment.mock.calls.map((call) => body(call).key)).toEqual(['a']);
  });

  it('selects a child on a nested page with no patchFields declarations', async () => {
    const fetchFragment = await start();
    for (const element of document.querySelectorAll('[data-payload-patch-fields]')) {
      element.removeAttribute('data-payload-patch-fields');
    }
    runtime!.refreshCache();
    const items = blocks();
    items[1]!.title = 'Server';
    post(items);
    await tick();
    expect(fetchFragment.mock.calls.map((call) => body(call).key)).toEqual(['b']);
  });

  it('retains a specific parent dependency used for shared markup', async () => {
    const fetchFragment = await start();
    document
      .querySelector('section')!
      .setAttribute('data-payload-depends', 'blocks,blocks.0.title');
    runtime!.refreshCache();
    const items = blocks();
    items[0]!.title = 'Also changes parent';
    post(items);
    await tick();
    expect(fetchFragment.mock.calls.map((call) => body(call).fragment)).toEqual(['list']);
  });

  it('carries pending child work through a direct edit in another sibling', async () => {
    const fetchFragment = await start();
    const first = deferred<Response>();
    const second = deferred<Response>();
    fetchFragment
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const items = blocks();
    items[0]!.title = 'Pending';
    post(items);
    await tick();
    const old = body(fetchFragment.mock.calls[0]!);
    items[1]!.colour = '#f00';
    post(items);
    await tick();
    expect(fetchFragment.mock.calls.map((call) => body(call).key)).toEqual(['a', 'a']);
    expect(node('b').querySelector('div')?.style.backgroundColor).toBe('rgb(255, 0, 0)');
    second.resolve(response(body(fetchFragment.mock.calls[1]!)));
    await tick();
    first.resolve(response(old));
    await tick();
    expect(node('a').querySelector('h2')?.textContent).toBe('Pending');
    expect(node('b').querySelector('div')?.style.backgroundColor).toBe('rgb(255, 0, 0)');
  });

  it.each(['uncovered', 'unkeyed', 'duplicate', 'broad', 'owner'])(
    'keeps the parent for incomplete child coverage (%s)',
    async (condition) => {
      const fetchFragment = await start();
      if (condition === 'unkeyed') node('a').removeAttribute('data-payload-fragment-key');
      if (condition === 'duplicate') node('b').setAttribute('data-payload-fragment-key', 'a');
      if (condition === 'broad') node('a').setAttribute('data-payload-depends', 'blocks');
      if (condition === 'owner') node('a').setAttribute('data-payload-owner', 'global:other');
      runtime!.refreshCache();
      const items = blocks();
      items[0]!.title = 'Edited';
      post(items, condition === 'uncovered' ? { layout: 'wide' } : {});
      await tick();
      expect(fetchFragment.mock.calls.map((call) => body(call).fragment)).toEqual(['list']);
    },
  );

  it.each(['child then reorder', 'parent then child'])(
    'preserves pending work and rejects stale responses (%s)',
    async (sequence) => {
      const fetchFragment = await start();
      const first = deferred<Response>();
      const second = deferred<Response>();
      fetchFragment
        .mockImplementationOnce(() => first.promise)
        .mockImplementationOnce(() => second.promise);
      const items = blocks();
      if (sequence === 'child then reorder') items[0]!.title = 'Pending';
      else items.reverse();
      post(items);
      await tick();
      const old = body(fetchFragment.mock.calls[0]!);
      if (sequence === 'child then reorder') items.reverse();
      else items[0]!.title = 'Latest';
      items[0]!.colour = '#f00';
      post(items);
      await tick();
      expect(fetchFragment).toHaveBeenCalledTimes(2);
      expect(fetchFragment.mock.calls[0]![1]!.signal?.aborted).toBe(true);
      const latest = body(fetchFragment.mock.calls[1]!);
      expect(latest.fragment).toBe('list');
      expect(node('c').querySelector('div')?.style.backgroundColor).toBe('rgb(119, 136, 153)');
      second.resolve(response(latest));
      await tick();
      first.resolve(response(old));
      await tick();
      expect(
        [...document.querySelectorAll('article')].map((element) =>
          element.getAttribute('data-payload-fragment-key'),
        ),
      ).toEqual(['c', 'b', 'a']);
      expect(node('c').querySelector('div')?.style.backgroundColor).toBe('rgb(255, 0, 0)');
      expect(
        node(sequence === 'child then reorder' ? 'a' : 'c').querySelector('h2')?.textContent,
      ).toBe(sequence === 'child then reorder' ? 'Pending' : 'Latest');
      fetchFragment.mockClear();
      items[1]!.title = 'Next';
      post(items);
      await tick();
      expect(fetchFragment.mock.calls.map((call) => body(call).key)).toEqual(['b']);
    },
  );
});
