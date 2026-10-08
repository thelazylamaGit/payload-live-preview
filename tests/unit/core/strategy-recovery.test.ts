import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LivePreviewRuntime } from '@core/lifecycle';
import type { RouteContext, RouteStrategy } from '@core/strategies';
import {
  createFragmentStrategy,
  fragmentStrategyFrom,
  type FragmentOutcome,
  type StrategyRequest,
} from '@fragment/index';
import { deferred, fireMessage, makeRuntime } from './lifecycle-startup-harness';

let runtime: LivePreviewRuntime | undefined;
afterEach(() => runtime?.destroy());

function post(variant: string, extra: Record<string, unknown> = {}, slug = 'home'): void {
  fireMessage({
    type: 'payload-live-preview',
    globalSlug: slug,
    data: { blocks: [{ variant }], title: 'Unsaved', ...extra },
  });
}

function variant(request: StrategyRequest): string {
  return (request.fields['blocks'] as { variant: string }[])[0]!.variant;
}

function markup(patchFields = false, owner = 'home'): string {
  return `<section data-payload-owner="global:${owner}" data-payload-fragment="buttons" data-payload-depends="blocks"${patchFields ? ' data-payload-patch-fields="blocks.0.overlay"' : ''}><button class="primary">Book</button></section>`;
}

describe('strategy recovery without another edit', () => {
  it.each([false, true])(
    'carries unfinished boundaries through repeated identical snapshots (patch fields: %s)',
    async (patchFields) => {
      document.body.innerHTML = markup(patchFields);
      const requests: StrategyRequest[] = [];
      const responses: ReturnType<typeof deferred<FragmentOutcome>>[] = [];
      runtime = makeRuntime({
        scopeBindingsByOwner: true,
        strategies: {
          fragment: fragmentStrategyFrom((request) => {
            requests.push(request);
            const response = deferred<FragmentOutcome>();
            responses.push(response);
            return response.promise;
          }),
        },
      });
      runtime.start();
      for (let i = 0; i < 4; i++) {
        post('outline');
        await vi.advanceTimersByTimeAsync(1);
      }
      expect(requests).toHaveLength(4);
      expect(requests.slice(0, -1).every((request) => request.signal.aborted)).toBe(true);
      expect(runtime.inspect().revisions.completed).toBe(0);
      responses
        .at(-1)!
        .resolve({ status: 'rendered', html: '<button class="outline">Book</button>' });
      await vi.advanceTimersByTimeAsync(50);
      for (const response of responses.slice(0, -1)) {
        response.resolve({ status: 'rendered', html: '<button class="old">Book</button>' });
      }
      await vi.advanceTimersByTimeAsync(50);
      expect(document.querySelector('button')?.className).toBe('outline');
      expect(runtime.inspect().revisions.completed).toBe(1);
    },
  );

  it('restarts an interrupted route request for an unchanged document', async () => {
    document.body.innerHTML =
      '<h1 data-payload-field="title" data-payload-strategy="route">Saved</h1>';
    const first = deferred<'refreshed'>();
    const requests: RouteContext[] = [];
    const route: RouteStrategy = {
      plan: (_root, touched) => touched.has('title'),
      refresh: (context) => {
        requests.push(context);
        return requests.length === 1 ? first.promise : Promise.resolve('refreshed');
      },
    };
    runtime = makeRuntime({ strategies: { route } });
    runtime.start();
    post('outline');
    await vi.advanceTimersByTimeAsync(1);
    post('outline');
    await vi.advanceTimersByTimeAsync(50);
    expect(requests).toHaveLength(2);
    expect(requests[0]!.signal.aborted).toBe(true);
    first.resolve('refreshed');
    await vi.advanceTimersByTimeAsync(50);
    expect(document.querySelector('h1')?.textContent).toBe('Unsaved');
    expect(runtime.inspect().route.refreshes).toBe(1);
    expect(runtime.inspect().revisions.completed).toBe(1);
  });

  it('replays the latest populated fragments after a delayed saved route replaces the DOM', async () => {
    document.body.innerHTML = markup() + markup(false, 'other');
    const delayed = deferred<'refreshed'>();
    let refreshes = 0;
    const route: RouteStrategy = {
      plan: (_root, touched) => touched.has('title'),
      refresh: async () => {
        if (++refreshes === 1) return 'refreshed';
        await delayed.promise;
        document.body.innerHTML = markup() + markup(false, 'other');
        return 'refreshed';
      },
    };
    const rendered: StrategyRequest[] = [];
    const merge = vi.fn<typeof fetch>().mockImplementation((_url, init) => {
      const { data } = JSON.parse(init!.body as string) as { data: Record<string, unknown> };
      return Promise.resolve(
        Response.json({
          ...data,
          populated: `resolved-${(data['blocks'] as { variant: string }[])[0]!.variant}`,
        }),
      );
    });
    runtime = makeRuntime({
      debounceMs: 200,
      bindingDebounceMs: 0,
      scopeBindingsByOwner: true,
      dataMerge: { serverURL: 'https://cms.example.com', fetchFn: merge },
      strategies: {
        route,
        fragment: fragmentStrategyFrom((request) => {
          rendered.push(request);
          return Promise.resolve({
            status: 'rendered',
            html: `<button class="${variant(request)}">${String(request.fields['populated'])}</button>`,
          });
        }),
      },
    });
    runtime.start();
    post('primary');
    await vi.advanceTimersByTimeAsync(10);
    post('outline', { title: 'Changed' });
    await vi.advanceTimersByTimeAsync(250);
    expect(merge).toHaveBeenCalledTimes(2);
    delayed.resolve('refreshed');
    await vi.advanceTimersByTimeAsync(100);
    expect(document.querySelector('[data-payload-owner="global:home"] button')?.className).toBe(
      'outline',
    );
    expect(document.querySelector('[data-payload-owner="global:home"] button')?.textContent).toBe(
      'resolved-outline',
    );
    expect(document.querySelector('[data-payload-owner="global:other"] button')?.className).toBe(
      'primary',
    );
    expect(rendered.at(-1)?.fields['populated']).toBe('resolved-outline');
    expect(runtime.inspect().revisions.completed).toBe(2);
  });

  it('retries a final transient failure and catches up without another message', async () => {
    document.body.innerHTML = markup();
    const handler = vi
      .fn()
      .mockResolvedValueOnce({ status: 'failed', code: 'LP0801', reason: 'timeout' })
      .mockResolvedValue({ status: 'rendered', html: '<button class="outline">Book</button>' });
    runtime = makeRuntime({ strategies: { fragment: fragmentStrategyFrom(handler) } });
    runtime.start();
    post('outline');
    await vi.advanceTimersByTimeAsync(100);
    expect(runtime.inspect().revisions.completed).toBe(0);
    await vi.advanceTimersByTimeAsync(500);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(document.querySelector('button')?.className).toBe('outline');
    expect(runtime.inspect().revisions.completed).toBe(1);
  });

  it('replays refinement arriving during an HTTP render without sharing an aborted request', async () => {
    document.body.innerHTML = markup();
    const delayed = deferred<Response>();
    const requests: { fields: Record<string, unknown>; revision: number; signal: AbortSignal }[] =
      [];
    const merge = vi.fn<typeof fetch>((_url, init) => {
      const { data } = JSON.parse(init!.body as string) as { data: Record<string, unknown> };
      return Promise.resolve(
        Response.json({
          ...data,
          populated: (data['blocks'] as { variant: string }[])[0]!.variant,
        }),
      );
    });
    const response = (body: { fields: Record<string, unknown>; revision: number }) =>
      Response.json({
        html: `<button class="${(body.fields['blocks'] as { variant: string }[])[0]!.variant}">${String(body.fields['populated'])}</button>`,
        boundary: { id: 'buttons' },
        revision: body.revision,
        metadata: { renderedAt: '2026-10-09T00:00:00Z', renderer: 'test' },
      });
    runtime = makeRuntime({
      debounceMs: 200,
      bindingDebounceMs: 0,
      dataMerge: { serverURL: 'https://cms.example.com', fetchFn: merge },
      strategies: {
        fragment: createFragmentStrategy({
          endpoint: '/payload/fragment',
          fetch: (_url, init) => {
            const body = JSON.parse(init!.body as string) as {
              fields: Record<string, unknown>;
              revision: number;
            };
            requests.push({ ...body, signal: init!.signal! });
            return requests.length === 2 ? delayed.promise : Promise.resolve(response(body));
          },
        }),
      },
    });
    runtime.start();
    post('primary');
    await vi.advanceTimersByTimeAsync(10);
    post('outline');
    await vi.advanceTimersByTimeAsync(250);
    expect(merge).toHaveBeenCalledTimes(2);
    expect(requests).toHaveLength(2);
    expect(requests[1]!.signal.aborted).toBe(false);
    delayed.resolve(response(requests[1]!));
    await vi.advanceTimersByTimeAsync(100);
    expect(requests).toHaveLength(3);
    expect(requests[2]!.fields['populated']).toBe('outline');
    expect(document.querySelector('button')?.className).toBe('outline');
    expect(document.querySelector('button')?.textContent).toBe('outline');
    expect(runtime.inspect().revisions.completed).toBe(2);
  });

  it('bounds persistent failures and leaves stale content incomplete', async () => {
    document.body.innerHTML = markup();
    const handler = vi
      .fn()
      .mockResolvedValue({ status: 'failed', code: 'LP0801', reason: 'unavailable' });
    runtime = makeRuntime({ strategies: { fragment: fragmentStrategyFrom(handler) } });
    runtime.start();
    post('outline');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(handler).toHaveBeenCalledTimes(3);
    expect(document.querySelector('button')?.className).toBe('primary');
    expect(runtime.inspect().revisions.completed).toBe(0);
    expect(runtime.inspect().fragments.failed).toBe(3);
  });

  it('recovers a real fragment-client timeout on the next bounded attempt', async () => {
    document.body.innerHTML = markup();
    let requests = 0;
    runtime = makeRuntime({
      strategies: {
        fragment: createFragmentStrategy({
          endpoint: '/payload/fragment',
          timeoutMs: 80,
          fetch: (_url, init) => {
            if (++requests === 1) {
              return new Promise((_resolve, reject) => {
                init!.signal!.addEventListener(
                  'abort',
                  () => reject(new DOMException('Aborted', 'AbortError')),
                  { once: true },
                );
              });
            }
            const body = JSON.parse(init!.body as string) as { revision: number };
            return Promise.resolve(
              Response.json({
                html: '<button class="outline">Book</button>',
                boundary: { id: 'buttons' },
                revision: body.revision,
                metadata: { renderedAt: '2026-10-09T00:00:00Z', renderer: 'test' },
              }),
            );
          },
        }),
      },
    });
    runtime.start();
    post('outline');
    await vi.advanceTimersByTimeAsync(100);
    expect(runtime.inspect().revisions.completed).toBe(0);
    await vi.advanceTimersByTimeAsync(500);
    expect(requests).toBe(2);
    expect(document.querySelector('button')?.className).toBe('outline');
    expect(runtime.inspect().fragments.failed).toBe(1);
    expect(runtime.inspect().revisions.completed).toBe(1);
  });

  it.each(['LP0802', 'LP0803'] as const)(
    'does not automatically retry permanent %s failures',
    async (code) => {
      document.body.innerHTML = markup();
      const handler = vi.fn().mockResolvedValue({ status: 'failed', code, reason: 'refused' });
      runtime = makeRuntime({ strategies: { fragment: fragmentStrategyFrom(handler) } });
      runtime.start();
      post('outline');
      await vi.advanceTimersByTimeAsync(10_000);
      expect(handler).toHaveBeenCalledTimes(1);
      expect(runtime.inspect().revisions.completed).toBe(0);
    },
  );

  it('retries only failed boundaries while successful siblings remain current', async () => {
    document.body.innerHTML = markup() + markup().replace('buttons', 'footer');
    const calls: string[] = [];
    const handler = (
      request: StrategyRequest,
      boundary: { id: string },
    ): Promise<FragmentOutcome> => {
      calls.push(boundary.id);
      if (boundary.id === 'footer' && calls.filter((id) => id === 'footer').length === 1) {
        return Promise.resolve({ status: 'failed', code: 'LP0801', reason: 'timeout' });
      }
      return Promise.resolve({
        status: 'rendered',
        html: `<button class="${variant(request)}">Book</button>`,
      });
    };
    runtime = makeRuntime({ strategies: { fragment: fragmentStrategyFrom(handler) } });
    runtime.start();
    post('outline');
    await vi.advanceTimersByTimeAsync(600);
    expect(calls).toEqual(['buttons', 'footer', 'footer']);
    expect([...document.querySelectorAll('button')].map((button) => button.className)).toEqual([
      'outline',
      'outline',
    ]);
    expect(runtime.inspect().revisions.completed).toBe(1);
  });

  it('cancels retry timers on supersession and destruction', async () => {
    document.body.innerHTML = markup();
    const requests: StrategyRequest[] = [];
    const handler = vi.fn((request: StrategyRequest) => {
      requests.push(request);
      return Promise.resolve({
        status: 'failed' as const,
        code: 'LP0801' as const,
        reason: 'timeout',
      });
    });
    runtime = makeRuntime({ strategies: { fragment: fragmentStrategyFrom(handler) } });
    runtime.start();
    post('outline');
    await vi.advanceTimersByTimeAsync(100);
    post('secondary');
    await vi.advanceTimersByTimeAsync(250);
    expect(requests.map(variant)).toEqual(['outline', 'secondary', 'secondary']);
    runtime.destroy();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(handler).toHaveBeenCalledTimes(3);
  });
});
