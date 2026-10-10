import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFragmentStrategy } from '@fragment/index';
import type { FragmentRequestBody } from '@/types/fragment-protocol';
import type { LivePreviewRuntime } from '@core/lifecycle';
import { deferred, fireMessage, makeRuntime } from './lifecycle-startup-harness';

const blocks = () => [
  { id: 'a', blockType: 'banner', title: 'One', label: 'A' },
  { id: 'b', blockType: 'banner', title: 'Two', label: 'B' },
  { id: 'c', blockType: 'banner', title: 'Three', label: 'C' },
];
type Block = ReturnType<typeof blocks>[number];
function content(block: Block, index: number): string {
  return `<h2 data-payload-field="blocks.${index}.title">${block.title}</h2><button data-payload-field="blocks.${index}.label" data-payload-attribute="aria-label" aria-label="${block.label}">Widget</button><input value="saved">`;
}
function list(items: readonly Block[]): string {
  return items
    .map(
      (block, index) =>
        `<article data-payload-key="${block.id}" data-payload-fragment="block" data-payload-fragment-key="${block.id}" data-payload-depends="blocks.${index}" data-payload-patch-fields="blocks.${index}.label">${content(block, index)}</article>`,
    )
    .join('');
}
function body(call: [string, (RequestInit | undefined)?]): FragmentRequestBody {
  return JSON.parse(call[1]!.body as string) as FragmentRequestBody;
}
function response(request: FragmentRequestBody): Response {
  const items = request.fields['blocks'] as Block[];
  const index = items.findIndex((block) => block.id === request.key);
  return new Response(
    JSON.stringify({
      html: request.fragment === 'list' ? list(items) : content(items[index]!, index),
      boundary: { id: request.fragment, key: request.key },
      revision: request.revision,
      metadata: { renderedAt: '2026-10-11T00:00:00Z', renderer: 'test' },
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
function node(key: string): HTMLElement {
  return document.querySelector(`[data-payload-fragment-key="${key}"]`)!;
}
async function start(initial: readonly Block[] = blocks()) {
  document.body.innerHTML = `<section data-payload-owner="global:home" data-payload-fragment="list" data-payload-depends="blocks,layout">${list(initial)}</section>`;
  const fetchFragment = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(
    (_url, init) => Promise.resolve(response(body([_url, init]))),
  );
  runtime = makeRuntime({
    autoBind: 'off',
    enableA11y: false,
    bindingDebounceMs: 0,
    scopeBindingsByOwner: true,
    strategies: {
      fragment: createFragmentStrategy({ endpoint: '/payload/fragment', fetch: fetchFragment }),
    },
  });
  runtime.start();
  post(initial);
  await tick();
  expect(fetchFragment.mock.calls.map((call) => body(call).fragment)).toEqual(['list']);
  fetchFragment.mockClear();
  return fetchFragment;
}

describe('nested keyed fragment targeting', () => {
  it('targets the smallest child without a planning DOM scan and preserves sibling widget state', async () => {
    const fetchFragment = await start();
    const widget = node('b').querySelector('input')!;
    widget.value = 'unsaved widget';
    const listener = vi.fn();
    widget.addEventListener('click', listener);
    const pending = deferred<Response>();
    fetchFragment.mockImplementationOnce(() => pending.promise);
    const scan = vi.spyOn(document, 'querySelectorAll');
    const items = blocks();
    items[0]!.title = 'Edited';
    post(items);
    await tick();
    expect(fetchFragment.mock.calls.map((call) => [body(call).fragment, body(call).key])).toEqual([
      ['block', 'a'],
    ]);
    expect(scan).not.toHaveBeenCalled();
    scan.mockRestore();
    expect(node('a').querySelector('h2')?.textContent).toBe('One');
    pending.resolve(response(body(fetchFragment.mock.calls[0]!)));
    await tick();
    expect(node('a').querySelector('h2')?.textContent).toBe('Edited');
    expect(node('b').querySelector('input')).toBe(widget);
    expect(widget.value).toBe('unsaved widget');
    widget.click();
    expect(listener).toHaveBeenCalledOnce();
  });

  it('keeps independent sibling work in flight through newer sibling edits', async () => {
    const fetchFragment = await start();
    const first = deferred<Response>();
    const second = deferred<Response>();
    fetchFragment
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const items = blocks();
    items[0]!.title = 'A';
    post(items);
    await tick();
    const firstBody = body(fetchFragment.mock.calls[0]!);
    items[2]!.title = 'C';
    post(items);
    await tick();
    expect(fetchFragment.mock.calls.map((call) => body(call).key)).toEqual(['a', 'c']);
    expect(fetchFragment.mock.calls[0]![1]!.signal?.aborted).toBe(false);
    second.resolve(response(body(fetchFragment.mock.calls[1]!)));
    await tick();
    first.resolve(response(firstBody));
    await tick();
    expect(node('a').querySelector('h2')?.textContent).toBe('A');
    expect(node('c').querySelector('h2')?.textContent).toBe('C');
  });

  it('coalesces same-child edits into one trailing render using the latest values', async () => {
    const fetchFragment = await start();
    const pending = deferred<Response>();
    fetchFragment.mockImplementationOnce(() => pending.promise);
    const items = blocks();
    items[0]!.title = 'First';
    post(items);
    await tick();
    const old = body(fetchFragment.mock.calls[0]!);
    items[0]!.title = 'Second';
    post(items);
    await tick();
    items[0]!.title = 'Latest';
    post(items);
    await tick();
    expect(fetchFragment).toHaveBeenCalledOnce();
    pending.resolve(response(old));
    await tick();
    expect(fetchFragment.mock.calls.map((call) => body(call).key)).toEqual(['a', 'a']);
    expect(node('a').querySelector('h2')?.textContent).toBe('Latest');
  });

  it('indexes new children after an empty list becomes populated without patch permissions', async () => {
    const fetchFragment = await start();
    for (const element of document.querySelectorAll('[data-payload-patch-fields]')) {
      element.removeAttribute('data-payload-patch-fields');
    }
    runtime!.refreshCache();
    post([]);
    await tick();
    expect(document.querySelectorAll('article')).toHaveLength(0);
    const items = [blocks()[0]!];
    post(items);
    await tick();
    fetchFragment.mockClear();
    node('a').removeAttribute('data-payload-patch-fields');
    runtime!.refreshCache();
    items[0]!.title = 'New child';
    post(items);
    await tick();
    expect(fetchFragment.mock.calls.map((call) => body(call).key)).toEqual(['a']);
    expect(node('a').querySelector('h2')?.textContent).toBe('New child');
  });

  it('targets a child immediately after an initially empty list gains children', async () => {
    const fetchFragment = await start([]);
    const items = blocks();
    post(items);
    await tick();
    fetchFragment.mockClear();
    items[1]!.title = 'First edit';
    post(items);
    await tick();
    expect(fetchFragment.mock.calls.map((call) => body(call).key)).toEqual(['b']);
    fetchFragment.mockClear();
    items[1]!.label = 'Direct after insertion';
    post(items);
    await tick();
    expect(fetchFragment).not.toHaveBeenCalled();
    expect(node('b').querySelector('button')?.getAttribute('aria-label')).toBe(
      'Direct after insertion',
    );
  });

  it('delegates through multiple levels to the smallest keyed boundary', async () => {
    const fetchFragment = await start();
    const heading = node('a').querySelector('h2')!;
    heading.outerHTML =
      '<div data-payload-fragment="title" data-payload-fragment-key="a-title" data-payload-depends="blocks.0.title">' +
      heading.outerHTML +
      '</div>';
    runtime!.refreshCache();
    fetchFragment.mockImplementationOnce((_url, init) => {
      const request = body([_url, init]);
      return Promise.resolve(
        new Response(
          JSON.stringify({
            html: '<h2 data-payload-field="blocks.0.title">Deep edit</h2>',
            boundary: { id: request.fragment, key: request.key },
            revision: request.revision,
            metadata: { renderedAt: '2026-10-11T00:00:00Z', renderer: 'test' },
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
      );
    });
    const items = blocks();
    items[0]!.title = 'Deep edit';
    post(items);
    await tick();
    expect(fetchFragment.mock.calls.map((call) => [body(call).fragment, body(call).key])).toEqual([
      ['title', 'a-title'],
    ]);
    expect(node('a').querySelector('h2')?.textContent).toBe('Deep edit');
  });

  it.each(['insert', 'remove', 'reorder', 'type'])(
    'renders only the containing list for %s',
    async (edit) => {
      const fetchFragment = await start();
      const items = blocks();
      if (edit === 'insert') items.push({ ...items[0]!, id: 'd' });
      if (edit === 'remove') items.pop();
      if (edit === 'reorder') items.reverse();
      if (edit === 'type') items[0]!.blockType = 'card';
      items[0]!.label = 'New';
      post(items);
      await tick();
      expect(fetchFragment.mock.calls.map((call) => body(call).fragment)).toEqual(['list']);
      fetchFragment.mockClear();
      items[0]!.title = 'After structure';
      post(items);
      await tick();
      expect(fetchFragment.mock.calls.map((call) => body(call).key)).toEqual([items[0]!.id]);
      expect(node(items[0]!.id).querySelector('h2')?.textContent).toBe('After structure');
    },
  );

  it('permits a sibling direct binding while suppressing writes in the requested child', async () => {
    const fetchFragment = await start();
    const pending = deferred<Response>();
    fetchFragment.mockImplementationOnce(() => pending.promise);
    const items = blocks();
    items[0]!.label = 'Direct';
    items[1]!.label = 'Server';
    items[1]!.title = 'Server';
    post(items);
    await tick();
    expect(fetchFragment.mock.calls.map((call) => body(call).key)).toEqual(['b']);
    expect(node('a').querySelector('button')?.getAttribute('aria-label')).toBe('Direct');
    expect(node('b').querySelector('button')?.getAttribute('aria-label')).toBe('B');
    pending.resolve(response(body(fetchFragment.mock.calls[0]!)));
    await tick();
    expect(node('b').querySelector('button')?.getAttribute('aria-label')).toBe('Server');
  });

  it('falls back through existing descendant bindings when a parent render fails', async () => {
    const fetchFragment = await start();
    fetchFragment.mockImplementationOnce(() => Promise.resolve(new Response('', { status: 503 })));
    const items = blocks();
    items[0]!.title = 'Fallback title';
    post(items, { layout: 'wide' });
    await tick();
    expect(fetchFragment.mock.calls.map((call) => body(call).fragment)).toEqual(['list']);
    expect(node('a').querySelector('h2')?.textContent).toBe('Fallback title');
    expect(runtime!.inspect().fragments.failed).toBe(1);
  });

  it.each(['uncovered', 'unkeyed', 'duplicate', 'broad', 'owner', 'specific parent', 'empty id'])(
    'retains the parent fallback for %s',
    async (condition) => {
      const fetchFragment = await start();
      if (condition === 'empty id') node('a').setAttribute('data-payload-fragment', '');
      if (condition === 'unkeyed') node('a').removeAttribute('data-payload-fragment-key');
      if (condition === 'duplicate') node('b').setAttribute('data-payload-fragment-key', 'a');
      if (condition === 'broad') node('a').setAttribute('data-payload-depends', 'blocks');
      if (condition === 'owner') node('a').setAttribute('data-payload-owner', 'global:other');
      if (condition === 'specific parent') {
        document
          .querySelector('section')!
          .setAttribute('data-payload-depends', 'blocks,blocks.0.title');
      }
      runtime!.refreshCache();
      const items = blocks();
      items[0]!.title = 'Edited';
      post(items, condition === 'uncovered' ? { layout: 'wide' } : {});
      await tick();
      expect(fetchFragment.mock.calls.map((call) => body(call).fragment)).toEqual(['list']);
    },
  );

  it.each(['child then parent', 'parent then child'])(
    'suppresses descendant requests and stale writes: %s',
    async (sequence) => {
      const fetchFragment = await start();
      const first = deferred<Response>();
      fetchFragment.mockImplementationOnce(() => first.promise);
      const items = blocks();
      if (sequence === 'child then parent') items[0]!.title = 'Pending';
      else items.reverse();
      post(items);
      await tick();
      const old = body(fetchFragment.mock.calls[0]!);
      if (sequence === 'child then parent') items.reverse();
      else items[0]!.title = 'Latest';
      items[0]!.label = 'Latest label';
      post(items);
      await tick();
      if (sequence === 'child then parent') {
        expect(fetchFragment.mock.calls.map((call) => body(call).fragment)).toEqual([
          'block',
          'list',
        ]);
        expect(node('c').querySelector('button')?.getAttribute('aria-label')).toBe('Latest label');
      } else {
        expect(fetchFragment).toHaveBeenCalledOnce();
        expect(node('c').querySelector('button')?.getAttribute('aria-label')).toBe('C');
      }
      first.resolve(response(old));
      await tick();
      expect(
        [...document.querySelectorAll('article')].map((element) =>
          element.getAttribute('data-payload-fragment-key'),
        ),
      ).toEqual(['c', 'b', 'a']);
      expect(node('c').querySelector('button')?.getAttribute('aria-label')).toBe('Latest label');
      expect(
        node(sequence === 'child then parent' ? 'a' : 'c').querySelector('h2')?.textContent,
      ).toBe(sequence === 'child then parent' ? 'Pending' : 'Latest');
      fetchFragment.mockClear();
      items[1]!.title = 'Next';
      post(items);
      await tick();
      expect(fetchFragment.mock.calls.map((call) => body(call).key)).toEqual(['b']);
    },
  );
});
