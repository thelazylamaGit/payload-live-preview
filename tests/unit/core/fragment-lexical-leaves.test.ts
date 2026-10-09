import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildBuiltinRenderers } from '@field-types/index';
import { createFragmentStrategy } from '@fragment/index';
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
const permissions = `${path(0)},${path(1)},blocks.0.colour`;
function html(fields: Data): string {
  return (
    leaves(fields)
      .map(
        (node, index) =>
          `<span data-payload-field="${path(index)}" data-payload-type="text">${node.text}</span>`,
      )
      .join('') +
    `<div data-payload-field="blocks.0.colour" data-payload-type="hexColor" data-payload-css-property="background-color" style="background-color:${fields.blocks[0]!.colour}"></div>`
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
async function start(optIn = true, initial = data()) {
  document.body.innerHTML = `<section data-payload-fragment="rich" data-payload-depends="blocks" ${optIn ? `data-payload-patch-fields="${permissions}"` : ''}>${html(initial)}</section>`;
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
    // Even explicit permission for formatting must not turn it into a text edit.
    document
      .querySelector('section')!
      .setAttribute(
        'data-payload-patch-fields',
        permissions + `,${prefix}.0.format,${prefix}.1.format`,
      );
    post(fields);
    await tick();
    expect(fetchFragment).toHaveBeenCalledTimes(1);
  });

  it.each(['no opt-in', 'not permitted', 'unbound', 'outside boundary'])(
    'requires exact permission and a matching binding (%s)',
    async (condition) => {
      const { fetchFragment } = await start(condition !== 'no opt-in');
      if (condition === 'not permitted') {
        document.querySelector('section')!.setAttribute('data-payload-patch-fields', path(1));
      }
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

  it('carries pending formatting into the latest text revision and discards the late response', async () => {
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
    leaves(fields)[0]!.text = 'Latest';
    post(fields);
    await tick();
    expect(fetchFragment).toHaveBeenCalledTimes(2);
    expect(document.querySelector('span')?.textContent).toBe('One');
    expect(fetchFragment.mock.calls[0]![1]!.signal?.aborted).toBe(true);
    const latest = JSON.parse(
      fetchFragment.mock.calls[1]![1]!.body as string,
    ) as FragmentRequestBody;
    expect(leaves(latest.fields as Data)[0]).toMatchObject({ text: 'Latest', format: 1 });
    second.resolve(response(latest));
    await tick();
    first.resolve(response(old));
    await tick();
    expect(document.querySelector('span')?.textContent).toBe('Latest');
    fetchFragment.mockClear();
    leaves(fields)[0]!.text = 'After fragment';
    post(fields);
    await tick();
    expect(document.querySelector('span')?.textContent).toBe('After fragment');
    expect(fetchFragment).not.toHaveBeenCalled();
  });

  it('uses refreshed bindings and requires refreshed exact permissions for inserted leaves', async () => {
    const { fetchFragment } = await start();
    const fields = data();
    leaves(fields).push(text('Three'));
    post(fields);
    await tick();
    expect(fetchFragment).toHaveBeenCalledTimes(1);
    fetchFragment.mockClear();
    leaves(fields)[2]!.text = 'Unpermitted';
    post(fields);
    await tick();
    expect(fetchFragment).toHaveBeenCalledTimes(1);
    fetchFragment.mockClear();
    document
      .querySelector('section')!
      .setAttribute('data-payload-patch-fields', permissions + ',' + path(2));
    leaves(fields)[2]!.text = 'Permitted';
    post(fields);
    await tick();
    expect(document.querySelectorAll('span')[2]?.textContent).toBe('Permitted');
    expect(fetchFragment).not.toHaveBeenCalled();
  });
});
