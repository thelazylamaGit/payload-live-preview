import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildBuiltinRenderers } from '@field-types/index';
import { createFragmentStrategy } from '@fragment/index';
import type { FragmentRequestBody } from '@/types/fragment-protocol';
import type { LivePreviewRuntime } from '@core/lifecycle';
import { deferred, fireMessage, makeRuntime } from './lifecycle-startup-harness';

interface Block {
  id: string;
  blockType: string;
  colour: string | null;
  title: string;
  image: unknown;
}
const blocks = (): Block[] => [
  { id: 'a', blockType: 'banner', colour: '#123', title: 'One', image: 'old' },
  { id: 'b', blockType: 'banner', colour: '#456', title: 'Two', image: 'old' },
];
function markup(items: readonly Block[]): string {
  return items
    .map(
      (item, index) => `<article data-payload-key="${item.id}" id="${item.id}">
    <div data-payload-field="blocks.${index}.colour" data-payload-type="hexColor" data-payload-css-property="background-color" style="background-color:${item.colour ?? '#000'};opacity:0.5"></div>
    <h2 data-payload-field="blocks.${index}.title">${item.title}</h2>
    <span class="image">${typeof item.image === 'string' ? item.image : 'populated'}</span>
  </article>`,
    )
    .join('');
}
const fields = 'blocks.0.colour,blocks.0.title,blocks.1.colour,blocks.1.title';
function response(body: FragmentRequestBody): Response {
  return new Response(
    JSON.stringify({
      html:
        body.fragment === 'other'
          ? '<p data-payload-field="footer">Server footer</p>'
          : markup(body.fields['blocks'] as Block[]),
      boundary: { id: body.fragment },
      revision: body.revision,
      metadata: { renderedAt: '2026-10-08T00:00:00Z', renderer: 'test' },
    }),
    { headers: { 'content-type': 'application/json' } },
  );
}
let runtime: LivePreviewRuntime | undefined;
afterEach(() => {
  runtime?.destroy();
  runtime = undefined;
});
function post(items: readonly Block[], extra: Record<string, unknown> = {}): void {
  fireMessage({
    type: 'payload-live-preview',
    globalSlug: 'home',
    data: { blocks: items, ...extra },
  });
}
const tick = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(30);
};
function start(
  options: {
    optIn?: boolean;
    debounceMs?: number;
    population?: typeof fetch;
    scopeBindingsByOwner?: boolean;
  } = {},
) {
  document.body.innerHTML = `<section data-payload-fragment="page-blocks" data-payload-depends="blocks" ${options.optIn === false ? '' : `data-payload-patch-fields="${fields}"`}>${markup(blocks())}</section>`;
  const fetchFragment = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(
    (_url, init) =>
      Promise.resolve(response(JSON.parse(init?.body as string) as FragmentRequestBody)),
  );
  runtime = makeRuntime({
    renderers: buildBuiltinRenderers(),
    scopeBindingsByOwner: options.scopeBindingsByOwner ?? false,
    autoBind: 'off',
    enableA11y: false,
    ...(options.debounceMs === undefined ? {} : { debounceMs: options.debounceMs }),
    ...(options.population === undefined
      ? {}
      : { dataMerge: { serverURL: 'https://cms.example.com', fetchFn: options.population } }),
    strategies: {
      fragment: createFragmentStrategy({ endpoint: '/payload/fragment', fetch: fetchFragment }),
    },
  });
  runtime.start();
  return fetchFragment;
}
function colour(id = 'a'): HTMLElement {
  return document.querySelector(`#${id} div`)!;
}
async function baseline(fetchFragment: ReturnType<typeof start>, items = blocks()): Promise<void> {
  post(items);
  await tick();
  expect(fetchFragment).toHaveBeenCalledTimes(1);
  fetchFragment.mockClear();
}

describe('explicit fragment patch fields through runtime and HTTP strategy', () => {
  it('patches colour including alpha and native text without fragment or population requests', async () => {
    const populated = blocks();
    populated[0]!.image = { id: 'old', url: '/old.png' };
    const population = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response(JSON.stringify({ blocks: populated }))),
    );
    const fetchFragment = start({ population });
    await baseline(fetchFragment);
    population.mockClear();
    const items = blocks();
    items[0]!.colour = '#11223380';
    items[1]!.title = 'Changed';
    post(items);
    await tick();
    expect(colour().style.backgroundColor).toBe('rgba(17, 34, 51, 0.5)');
    expect(document.querySelector('#b h2')?.textContent).toBe('Changed');
    expect(document.querySelector('#a .image')?.textContent).toBe('populated');
    expect(fetchFragment).not.toHaveBeenCalled();
    expect(population).not.toHaveBeenCalled();
  });

  it('renders mixed changes once without competing inner DOM patches', async () => {
    const fetchFragment = start();
    await baseline(fetchFragment);
    const pending = deferred<Response>();
    fetchFragment.mockImplementationOnce(() => pending.promise);
    const items = blocks();
    items[0]!.colour = '#f00';
    items[0]!.image = 'new';
    post(items);
    await tick();
    expect(fetchFragment).toHaveBeenCalledTimes(1);
    expect(colour().style.backgroundColor).toBe('rgb(17, 34, 51)');
    pending.resolve(
      response(JSON.parse(fetchFragment.mock.calls[0]![1]!.body as string) as FragmentRequestBody),
    );
    await tick();
    expect(colour().style.backgroundColor).toBe('rgb(255, 0, 0)');
    expect(document.querySelector('#a .image')?.textContent).toBe('new');
  });

  it('retains fragment rendering without opt-in and for an opted-in but unbound field', async () => {
    const fetchFragment = start({ optIn: false });
    await baseline(fetchFragment);
    const items = blocks();
    items[0]!.colour = '#f00';
    post(items);
    await tick();
    expect(fetchFragment).toHaveBeenCalledTimes(1);
    document
      .querySelector('section')
      ?.setAttribute('data-payload-patch-fields', fields + ',blocks.0.image');
    fetchFragment.mockClear();
    items[0]!.image = 'new';
    post(items);
    await tick();
    expect(fetchFragment).toHaveBeenCalledTimes(1);
  });

  it('lets independent boundaries choose different paths', async () => {
    const fetchFragment = start();
    document.body.insertAdjacentHTML(
      'beforeend',
      '<section data-payload-fragment="other" data-payload-depends="footer"><p data-payload-field="footer">Old footer</p></section>',
    );
    runtime?.refreshCache();
    post(blocks(), { footer: 'Old footer' });
    await tick();
    fetchFragment.mockClear();
    const items = blocks();
    items[0]!.colour = '#f00';
    post(items, { footer: 'New footer' });
    await tick();
    expect(colour().style.backgroundColor).toBe('rgb(255, 0, 0)');
    expect(fetchFragment).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchFragment.mock.calls[0]![1]!.body as string)).toMatchObject({
      fragment: 'other',
    });
  });

  it('renders reorder before patching indexed bindings and updates the correct block afterwards', async () => {
    const fetchFragment = start();
    await baseline(fetchFragment);
    const items = blocks().reverse();
    post(items);
    await tick();
    expect(fetchFragment).toHaveBeenCalledTimes(1);
    fetchFragment.mockClear();
    items[0]!.colour = '#f00';
    post(items);
    await tick();
    expect(colour('b').style.backgroundColor).toBe('rgb(255, 0, 0)');
    expect(colour('a').style.backgroundColor).toBe('rgb(17, 34, 51)');
    expect(fetchFragment).not.toHaveBeenCalled();
  });

  it('carries pending image rendering into the latest colour revision and rejects late responses', async () => {
    const fetchFragment = start();
    await baseline(fetchFragment);
    const first = deferred<Response>();
    const second = deferred<Response>();
    fetchFragment
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const items = blocks();
    items[0]!.image = 'new';
    post(items);
    await tick();
    const firstBody = JSON.parse(
      fetchFragment.mock.calls[0]![1]!.body as string,
    ) as FragmentRequestBody;
    items[0]!.colour = '#f00';
    post(items);
    await tick();
    expect(fetchFragment).toHaveBeenCalledTimes(2);
    expect(fetchFragment.mock.calls[0]![1]!.signal?.aborted).toBe(true);
    const latest = JSON.parse(
      fetchFragment.mock.calls[1]![1]!.body as string,
    ) as FragmentRequestBody;
    second.resolve(response(latest));
    await tick();
    first.resolve(response(firstBody));
    await tick();
    expect(document.querySelector('#a .image')?.textContent).toBe('new');
    expect(colour().style.backgroundColor).toBe('rgb(255, 0, 0)');
    expect(runtime?.inspect().fragments.superseded).toBeGreaterThan(0);
  });

  it('updates during sustained dragging using the existing maximum wait and the newest revision', async () => {
    const fetchFragment = start({ debounceMs: 50 });
    await baseline(fetchFragment);
    const items = blocks();
    let updates = 0;
    let previous = colour().style.backgroundColor;
    for (let index = 1; index <= 40; index += 1) {
      items[0]!.colour = '#' + index.toString(16).padStart(6, '0');
      post(items);
      await vi.advanceTimersByTimeAsync(10);
      if (colour().style.backgroundColor !== previous) updates += 1;
      previous = colour().style.backgroundColor;
    }
    expect(updates).toBeGreaterThanOrEqual(2);
    await vi.advanceTimersByTimeAsync(250);
    expect(colour().style.backgroundColor).toBe('rgb(0, 0, 40)');
    expect(fetchFragment).not.toHaveBeenCalled();
  });

  it('keeps initial sync, structure changes and unknown fields on the server path', async () => {
    const fetchFragment = start();
    await baseline(fetchFragment);
    const items = blocks();
    items.push({ ...items[0]!, id: 'c' });
    post(items);
    await tick();
    expect(fetchFragment).toHaveBeenCalledTimes(1);
    fetchFragment.mockClear();
    post(items, { blocksUnknown: 'new' });
    await tick();
    expect(fetchFragment).not.toHaveBeenCalled(); // dependsOn still defines relevance.
    (items[0] as Block & { unknown: string }).unknown = 'new';
    post(items);
    await tick();
    expect(fetchFragment).toHaveBeenCalledTimes(1);
  });

  it('handles all hex lengths, clearing and defaults without accepting CSS expressions or other writes', async () => {
    const fetchFragment = start();
    await baseline(fetchFragment);
    const items = blocks();
    for (const [hex, css] of [
      ['#abc', 'rgb(170, 187, 204)'],
      ['#abcd', 'rgba(170, 187, 204, 0.867)'],
      ['#abcdef', 'rgb(171, 205, 239)'],
      ['#abcdef80', 'rgba(171, 205, 239, 0.5)'],
    ]) {
      items[0]!.colour = hex!;
      post(items);
      await tick();
      expect(colour().style.backgroundColor).toBe(css);
    }
    const previous = colour().style.backgroundColor;
    for (const invalid of [
      '#',
      '#12',
      '#zzzzzz',
      'red',
      'url(https://evil.example)',
      '#fff;opacity:1',
    ]) {
      items[0]!.colour = invalid;
      post(items);
      await tick();
      expect(colour().style.backgroundColor).toBe(previous);
    }
    colour().setAttribute('data-payload-css-default', '#0008');
    items[0]!.colour = null;
    post(items);
    await tick();
    expect(colour().style.backgroundColor).toBe('rgba(0, 0, 0, 0.533)');
    colour().removeAttribute('data-payload-css-default');
    items[0]!.colour = '';
    post(items);
    await tick();
    expect(colour().style.backgroundColor).toBe('');
    colour().setAttribute('data-payload-css-property', 'opacity');
    items[0]!.colour = '#f00';
    post(items);
    await tick();
    expect(colour().style.opacity).toBe('0.5');
    colour().setAttribute('data-payload-attribute', 'style');
    runtime?.refreshCache();
    items[0]!.colour = 'background-color:red';
    post(items);
    await tick();
    expect(colour().style.backgroundColor).toBe('');
    expect(colour().style.opacity).toBe('0.5');
    expect(fetchFragment).not.toHaveBeenCalled();
  });
});

it('preserves owner scoping for opted-in colour patches', async () => {
  const fetchFragment = start({ scopeBindingsByOwner: true });
  document.querySelector('section')?.setAttribute('data-payload-owner', 'global:home');
  runtime?.refreshCache();
  await baseline(fetchFragment);
  const other = document.createElement('aside');
  other.setAttribute('data-payload-owner', 'global:other');
  other.innerHTML =
    '<div data-payload-field="blocks.0.colour" data-payload-type="hexColor" data-payload-css-property="background-color" style="background-color:#000"></div>';
  document.body.append(other);
  runtime?.refreshCache();
  const items = blocks();
  items[0]!.colour = '#f00';
  post(items);
  await tick();
  expect(colour().style.backgroundColor).toBe('rgb(255, 0, 0)');
  expect((other.firstElementChild as HTMLElement).style.backgroundColor).toBe('rgb(0, 0, 0)');
  expect(fetchFragment).not.toHaveBeenCalled();
});

it('cannot opt a structural array into a scalar patch', async () => {
  const fetchFragment = start();
  await baseline(fetchFragment);
  document.querySelector('section')?.setAttribute('data-payload-patch-fields', fields + ',blocks');
  document
    .querySelector('section')
    ?.insertAdjacentHTML('beforeend', '<div data-payload-field="blocks"></div>');
  runtime?.refreshCache();
  post(blocks().reverse());
  await tick();
  expect(fetchFragment).toHaveBeenCalledTimes(1);
});

it('conservatively renders arrays with duplicate or missing item identities', async () => {
  const fetchFragment = start();
  await baseline(fetchFragment);
  const items = blocks();
  items[1]!.id = 'a';
  post(items);
  await tick();
  fetchFragment.mockClear();
  items[0]!.colour = '#f00';
  post(items);
  await tick();
  expect(fetchFragment).toHaveBeenCalledTimes(1);
});

it('keeps an image edit when its population request is superseded by a direct colour edit', async () => {
  const population = vi.fn<typeof fetch>(() =>
    Promise.resolve(new Response(JSON.stringify({ blocks: blocks() }))),
  );
  const fetchFragment = start({ population });
  await baseline(fetchFragment);
  population.mockClear();
  const pending = deferred<Response>();
  population.mockImplementationOnce(() => pending.promise);
  const items = blocks();
  items[0]!.image = 'new';
  post(items);
  await tick();
  expect(population).toHaveBeenCalledTimes(1);
  items[0]!.colour = '#f00';
  post(items);
  await tick();
  expect(population).toHaveBeenCalledTimes(1);
  expect(fetchFragment).toHaveBeenCalledTimes(1);
  expect(document.querySelector('#a .image')?.textContent).toBe('new');
  expect(colour().style.backgroundColor).toBe('rgb(255, 0, 0)');
  pending.resolve(new Response(JSON.stringify({ blocks: blocks() })));
  await tick();
  expect(document.querySelector('#a .image')?.textContent).toBe('new');
  expect(colour().style.backgroundColor).toBe('rgb(255, 0, 0)');
});
