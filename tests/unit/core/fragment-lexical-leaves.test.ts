import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildBuiltinRenderers } from '@field-types/index';
import { createFragmentStrategy } from '@fragment/index';
import { EventEmitter } from '@events/emitter';
import type { FragmentRequestBody } from '@/types/fragment-protocol';
import type { LivePreviewRuntime } from '@core/lifecycle';
import { deferred, fireMessage, makeRuntime } from './lifecycle-startup-harness';

const prefix = 'blocks.0.content.root.children.0.children';
const path = (index: number): string => `${prefix}.${index}.text`;
const text = (value: string) => ({
  type: 'text',
  version: 1,
  text: value,
  format: 0,
  style: '',
  mode: 'normal',
  detail: 0,
});
function data() {
  return {
    blocks: [
      {
        id: 'a',
        blockType: 'rich',
        colour: '#123',
        content: {
          root: {
            type: 'root',
            version: 1,
            children: [
              { type: 'paragraph', version: 1, format: '', children: [text('One'), text('Two')] },
            ],
          },
        },
      },
    ],
  };
}
type Data = ReturnType<typeof data>;
const leaves = (fields: Data) => fields.blocks[0]!.content.root.children[0]!.children;
function html(fields: Data): string {
  return (
    leaves(fields)
      .map(
        (node, index) =>
          `<span data-server-format="${node.format}" data-payload-field="${path(index)}" data-payload-type="text">${node.text}</span>`,
      )
      .join('') +
    `<div data-payload-field="blocks.0.colour" data-payload-css-property="background-color" style="background-color:${fields.blocks[0]!.colour}"></div>`
  );
}
function response(body: FragmentRequestBody): Response {
  return new Response(
    JSON.stringify({
      html: html(body.fields as Data),
      boundary: { id: body.fragment },
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
function post(fields: Data): void {
  fireMessage({ type: 'payload-live-preview', globalSlug: 'home', data: fields });
}
async function start(
  optIn = true,
  initial = data(),
  overrides: Partial<ConstructorParameters<typeof LivePreviewRuntime>[0]> = {},
) {
  document.body.innerHTML = `<section data-payload-fragment="rich" data-payload-depends="blocks" ${optIn ? `data-payload-patch-fields="blocks.0.content,blocks.0.colour"` : ''}>${html(initial)}</section>`;
  const fetchFragment = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(
    (_url, init) =>
      Promise.resolve(response(JSON.parse(init!.body as string) as FragmentRequestBody)),
  );
  const population = vi.fn<typeof fetch>((_url, init) =>
    Promise.resolve(
      new Response(JSON.stringify((JSON.parse(init!.body as string) as { data: Data }).data)),
    ),
  );
  runtime = makeRuntime({
    renderers: buildBuiltinRenderers(),
    autoBind: 'off',
    enableA11y: false,
    scopeBindingsByOwner: false,
    bindingDebounceMs: 0,
    dataMerge: { serverURL: 'https://cms.example.com', fetchFn: population },
    ...overrides,
    strategies: {
      fragment: createFragmentStrategy({ endpoint: '/payload/fragment', fetch: fetchFragment }),
    },
  });
  runtime.start();
  post(initial);
  await tick();
  expect(fetchFragment).toHaveBeenCalledTimes(1);
  fetchFragment.mockClear();
  population.mockClear();
  return { fetchFragment, population };
}

describe('direct Lexical text leaves inside an existing fragment', () => {
  it('makes progress during 150 ms rendering and sustained typing with one request and no stale text', async () => {
    const emitter = new EventEmitter();
    const { fetchFragment, population } = await start(true, data(), { emitter });
    const fields = data();
    const rendered: string[] = [];
    emitter.on('fragmentRender', () => {
      const shown = document.querySelector('span')!.textContent;
      expect(shown).toBe(leaves(fields)[0]!.text);
      rendered.push(shown);
    });
    emitter.on('cacheRefresh', () => {
      expect(document.querySelector('span')!.textContent).toBe(leaves(fields)[0]!.text);
    });
    fetchFragment.mockImplementation((_url, init) => {
      const body = JSON.parse(init!.body as string) as FragmentRequestBody;
      return new Promise((resolve) => setTimeout(() => resolve(response(body)), 150));
    });
    leaves(fields)[0]!.format = 1;
    post(fields);
    await vi.advanceTimersByTimeAsync(10);
    let updates = 0;
    let previous = 'One';
    for (let index = 1; index <= 60; index += 1) {
      leaves(fields)[0]!.text = `Typing ${index}`;
      post(fields);
      await vi.advanceTimersByTimeAsync(10);
      const shown = document.querySelector('span')!.textContent;
      if (shown !== previous) updates += 1;
      previous = shown;
      if (index === 20) {
        expect(rendered).toHaveLength(1);
        expect(shown).not.toBe('One');
      }
    }
    await tick();
    expect(document.querySelector('span')!.textContent).toBe('Typing 60');
    expect(document.querySelector('span')!.getAttribute('data-server-format')).toBe('1');
    expect(updates).toBeGreaterThan(10);
    expect(fetchFragment).toHaveBeenCalledTimes(1);
    expect(fetchFragment.mock.calls[0]![1]!.signal!.aborted).toBe(false);
    expect(population).toHaveBeenCalledTimes(1); // Only the structural edit needs population.
  });

  it('keeps an empty existing leaf direct through deletion and typing again', async () => {
    const initial = data();
    leaves(initial)[0]!.text = 'x'.repeat(40);
    const { fetchFragment } = await start(true, initial);
    fetchFragment.mockImplementation((_url, init) => {
      const body = JSON.parse(init!.body as string) as FragmentRequestBody;
      return new Promise((resolve) => setTimeout(() => resolve(response(body)), 150));
    });
    leaves(initial)[0]!.format = 1;
    post(initial);
    await vi.advanceTimersByTimeAsync(10);
    for (let length = 39; length >= 0; length -= 1) {
      leaves(initial)[0]!.text = 'x'.repeat(length);
      post(initial);
      await vi.advanceTimersByTimeAsync(10);
    }
    await tick();
    expect(document.querySelector('span')!.textContent).toBe('');
    for (let length = 1; length <= 20; length += 1) {
      leaves(initial)[0]!.text = 'y'.repeat(length);
      post(initial);
      await vi.advanceTimersByTimeAsync(10);
    }
    await tick();
    expect(document.querySelector('span')!.textContent).toBe('y'.repeat(20));
    expect(fetchFragment).toHaveBeenCalledTimes(1);
  });

  it('coalesces incompatible structure and server-owned metadata without morphing older structure', async () => {
    const { fetchFragment } = await start();
    const first = deferred<Response>();
    const second = deferred<Response>();
    fetchFragment
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const fields = data();
    leaves(fields)[0]!.format = 1;
    post(fields);
    await tick();
    const old = JSON.parse(fetchFragment.mock.calls[0]![1]!.body as string) as FragmentRequestBody;
    for (let format = 2; format <= 10; format += 1) {
      leaves(fields)[0]!.format = format;
      leaves(fields)[0]!.text = `Latest ${format}`;
      post(fields);
      await vi.advanceTimersByTimeAsync(10);
    }
    leaves(fields).pop();
    post(fields);
    await tick();
    expect(fetchFragment).toHaveBeenCalledTimes(1);
    first.resolve(response(old));
    await tick();
    expect(fetchFragment).toHaveBeenCalledTimes(2);
    expect(document.querySelector('span')!.getAttribute('data-server-format')).toBe('0');
    expect(document.querySelectorAll('span')).toHaveLength(2);
    expect(document.querySelector('section')!.getAttribute('data-payload-patch-fields')).toBe(
      'blocks.0.content,blocks.0.colour',
    );
    const latest = JSON.parse(
      fetchFragment.mock.calls[1]![1]!.body as string,
    ) as FragmentRequestBody;
    second.resolve(response(latest));
    await tick();
    expect(document.querySelector('span')!.textContent).toBe('Latest 10');
    expect(document.querySelector('span')!.getAttribute('data-server-format')).toBe('10');
    expect(document.querySelectorAll('span')).toHaveLength(1);
  });

  it('keeps edits to newly created, unbound leaves on the coalesced server path', async () => {
    const { fetchFragment } = await start();
    const first = deferred<Response>();
    const second = deferred<Response>();
    fetchFragment
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const fields = data();
    leaves(fields).push(text('New'));
    post(fields);
    await tick();
    const old = JSON.parse(fetchFragment.mock.calls[0]![1]!.body as string) as FragmentRequestBody;
    for (let index = 0; index < 20; index += 1) {
      leaves(fields)[2]!.text = `New ${index}`;
      post(fields);
      await vi.advanceTimersByTimeAsync(10);
    }
    expect(fetchFragment).toHaveBeenCalledTimes(1);
    first.resolve(response(old));
    await tick();
    expect(document.querySelectorAll('span')).toHaveLength(2);
    const latest = JSON.parse(
      fetchFragment.mock.calls[1]![1]!.body as string,
    ) as FragmentRequestBody;
    second.resolve(response(latest));
    await tick();
    expect(document.querySelectorAll('span')[2]!.textContent).toBe('New 19');
    fetchFragment.mockClear();
    leaves(fields)[2]!.text = 'Direct now';
    post(fields);
    await tick();
    expect(fetchFragment).not.toHaveBeenCalled();
    expect(document.querySelectorAll('span')[2]!.textContent).toBe('Direct now');
  });

  it('falls back with current values after a delayed failure and retries owed work', async () => {
    const { fetchFragment } = await start();
    const pending = deferred<Response>();
    fetchFragment.mockImplementationOnce(() => pending.promise);
    const fields = data();
    leaves(fields)[0]!.format = 1;
    post(fields);
    await tick();
    leaves(fields)[0]!.text = 'Latest fallback';
    post(fields);
    await tick();
    pending.resolve(new Response('failed', { status: 500 }));
    await tick();
    expect(document.querySelector('span')!.textContent).toBe('Latest fallback');
    expect(runtime!.inspect().fragments.failed).toBe(1);
    await vi.advanceTimersByTimeAsync(250);
    expect(fetchFragment).toHaveBeenCalledTimes(2);
    expect(document.querySelector('span')!.getAttribute('data-server-format')).toBe('1');
  });

  it('aborts boundary work on teardown and rejects late responses', async () => {
    const { fetchFragment } = await start();
    const pending = deferred<Response>();
    fetchFragment.mockImplementationOnce(() => pending.promise);
    const fields = data();
    leaves(fields)[0]!.format = 1;
    post(fields);
    await tick();
    const body = JSON.parse(fetchFragment.mock.calls[0]![1]!.body as string) as FragmentRequestBody;
    leaves(fields)[0]!.text = 'Never apply';
    post(fields);
    await tick();
    runtime!.destroy();
    expect(fetchFragment.mock.calls[0]![1]!.signal!.aborted).toBe(true);
    pending.resolve(response(body));
    await tick();
    expect(fetchFragment).toHaveBeenCalledTimes(1);
    expect(document.querySelector('span')!.textContent).toBe('One');
    expect(document.querySelector('section')!.getAttribute('data-payload-patch-fields')).toBe(
      'blocks.0.content,blocks.0.colour',
    );
  });
  it('renders edits to existing embedded component fields alongside text', async () => {
    const fields = data();
    const embedded = Object.assign(leaves(fields)[1]!, {
      type: 'block',
      fields: { id: 'cta', blockType: 'cta', label: 'Before' },
    });
    const { fetchFragment } = await start(true, fields);
    embedded.fields.label = 'After';
    leaves(fields)[0]!.text = 'Changed';
    post(fields);
    await tick();
    expect(fetchFragment).toHaveBeenCalledTimes(1);
  });

  it('patches multiple existing leaves and colour through native writers without requests', async () => {
    const { fetchFragment, population } = await start();
    const fields = data();
    leaves(fields)[0]!.text = '<literal>';
    leaves(fields)[1]!.text = '';
    fields.blocks[0]!.colour = '#11223380';
    post(fields);
    await tick();
    expect(document.querySelector('span')?.textContent).toBe('<literal>');
    expect(document.querySelectorAll('span')[1]?.textContent).toBe('');
    expect(document.querySelector('span')?.children.length).toBe(0);
    expect(document.querySelector('div')?.style.backgroundColor).toBe('rgba(17, 34, 51, 0.5)');
    expect(fetchFragment).not.toHaveBeenCalled();
    expect(population).not.toHaveBeenCalled();
  });

  it.each([
    'format',
    'style',
    'mode',
    'detail',
    'paragraph',
    'split',
    'merge',
    'insert',
    'remove',
    'reorder',
    'embedded',
    'mixed',
  ])('renders %s changes on the server', async (edit) => {
    const { fetchFragment } = await start();
    const fields = data();
    const nodes = leaves(fields);
    switch (edit) {
      case 'format':
        nodes[0]!.format = 1;
        break;
      case 'style':
        nodes[0]!.style = 'color:red';
        break;
      case 'mode':
        nodes[0]!.mode = 'token';
        break;
      case 'detail':
        nodes[0]!.detail = 1;
        break;
      case 'paragraph':
        fields.blocks[0]!.content.root.children[0]!.format = 'center';
        break;
      case 'split':
        nodes[0]!.text = 'O';
        nodes.splice(1, 0, text('ne'));
        break;
      case 'merge':
        nodes[0]!.text += nodes[1]!.text;
        nodes.pop();
        break;
      case 'insert':
        nodes.push(text('Three'));
        break;
      case 'remove':
        nodes.pop();
        break;
      case 'reorder':
        nodes.reverse();
        break;
      case 'embedded':
        Object.assign(nodes[0]!, { type: 'block', fields: { id: 'embed', blockType: 'cta' } });
        break;
      case 'mixed':
        nodes[0]!.text = 'Changed';
        nodes[1]!.format = 1;
        break;
    }
    post(fields);
    await tick();
    expect(fetchFragment).toHaveBeenCalledTimes(1);
  });

  it.each(['no opt-in', 'unbound', 'outside boundary'])(
    'requires opt-in and a matching binding (%s)',
    async (condition) => {
      const { fetchFragment } = await start(condition !== 'no opt-in');
      if (condition === 'unbound') {
        document.querySelector('span')!.removeAttribute('data-payload-field');
      }
      if (condition === 'outside boundary') document.body.append(document.querySelector('span')!);
      runtime!.refreshCache();
      const fields = data();
      leaves(fields)[0]!.text = 'Changed';
      post(fields);
      await tick();
      expect(fetchFragment).toHaveBeenCalledTimes(1);
    },
  );

  it('finishes pending formatting and rebases the latest compatible text without restarting', async () => {
    const { fetchFragment } = await start();
    const first = deferred<Response>();
    fetchFragment.mockImplementationOnce(() => first.promise);
    const fields = data();
    leaves(fields)[0]!.format = 1;
    post(fields);
    await tick();
    const old = JSON.parse(fetchFragment.mock.calls[0]![1]!.body as string) as FragmentRequestBody;
    leaves(fields)[0]!.text = 'Latest';
    post(fields);
    await tick();
    expect(fetchFragment).toHaveBeenCalledTimes(1);
    expect(document.querySelector('span')?.textContent).toBe('One');
    expect(fetchFragment.mock.calls[0]![1]!.signal?.aborted).toBe(false);
    first.resolve(response(old));
    await tick();
    expect(document.querySelector('span')?.textContent).toBe('Latest');
    expect(document.querySelector('section')!.getAttribute('data-payload-patch-fields')).toBe(
      'blocks.0.content,blocks.0.colour',
    );
    fetchFragment.mockClear();
    leaves(fields)[0]!.text = 'After fragment';
    post(fields);
    await tick();
    expect(document.querySelector('span')?.textContent).toBe('After fragment');
    expect(fetchFragment).not.toHaveBeenCalled();
  });

  it('indexes newly rendered bindings for inserted leaves', async () => {
    const { fetchFragment } = await start();
    const fields = data();
    leaves(fields).push(text('Three'));
    post(fields);
    await tick();
    expect(fetchFragment).toHaveBeenCalledTimes(1);
    fetchFragment.mockClear();
    leaves(fields)[2]!.text = 'New binding';
    post(fields);
    await tick();
    expect(fetchFragment).not.toHaveBeenCalled();
    fetchFragment.mockClear();
    leaves(fields)[2]!.text = 'Permitted';
    post(fields);
    await tick();
    expect(document.querySelectorAll('span')[2]?.textContent).toBe('Permitted');
    expect(fetchFragment).not.toHaveBeenCalled();
  });
});
