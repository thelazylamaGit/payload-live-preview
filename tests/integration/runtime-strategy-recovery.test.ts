import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateInlineScript } from '@inline/generator';
import type { LivePreviewRuntime } from '@core/lifecycle';
import './runtime-harness';

const ADMIN = 'https://admin.example.com';
interface API {
  destroy: () => void;
  inspect: LivePreviewRuntime['inspect'];
}
function api(): API {
  return window.__livePreview as API;
}
function markup(value: string, patchFields: boolean): string {
  return `<main data-payload-owner="collection:pages:7" data-payload-fragment="buttons" data-payload-depends="blocks"${patchFields ? ' data-payload-patch-fields="blocks.0.overlay"' : ''}><button class="${value}">Book</button></main>`;
}
function fields(value: string) {
  return {
    id: 7,
    blocks: [
      {
        content: {
          root: {
            children: [{ type: 'block', fields: { blockType: 'inlineButton', variant: value } }],
          },
        },
      },
    ],
  };
}
function variant(data: ReturnType<typeof fields>): string {
  return data.blocks[0]!.content.root.children[0]!.fields.variant;
}
function post(value: string): void {
  window.dispatchEvent(
    new MessageEvent('message', {
      origin: ADMIN,
      source: window.parent,
      data: { type: 'payload-live-preview', collectionSlug: 'pages', data: fields(value) },
    }),
  );
}
afterEach(() => {
  (window.__livePreview as API | undefined)?.destroy();
  vi.unstubAllGlobals();
});

describe('generated browser strategy recovery', () => {
  it.each([false, true])(
    'catches up after rapid edits and repeated final snapshots (patch fields: %s)',
    async (patchFields) => {
      document.body.innerHTML = markup('primary', patchFields);
      const requests: { kind: string; signal: AbortSignal | null | undefined }[] = [];
      vi.stubGlobal('fetch', (_url: string, init: RequestInit = {}) => {
        const kind = _url.includes('/payload/fragment')
          ? 'fragment'
          : _url.includes('/api/')
            ? 'merge'
            : 'route';
        requests.push({ kind, signal: init.signal });
        const body = init.body
          ? (JSON.parse(init.body as string) as {
              data?: ReturnType<typeof fields>;
              fields?: ReturnType<typeof fields>;
              revision: number;
            })
          : undefined;
        return new Promise<Response>((resolve, reject) => {
          const timer = setTimeout(
            () => {
              if (kind === 'merge') resolve(Response.json(body!.data));
              else if (kind === 'fragment') {
                resolve(
                  Response.json({
                    html: `<button class="${variant(body!.fields!)}">Book</button>`,
                    boundary: { id: 'buttons' },
                    revision: body!.revision,
                    metadata: { renderedAt: '2026-10-09T00:00:00Z', renderer: 'test' },
                  }),
                );
              } else {
                resolve(
                  new Response(
                    `<html><head></head><body>${markup('primary', patchFields)}</body></html>`,
                    { headers: { 'content-type': 'text/html' } },
                  ),
                );
              }
            },
            kind === 'merge' ? 20 : 120,
          );
          init.signal?.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              reject(new DOMException('Aborted', 'AbortError'));
            },
            { once: true },
          );
        });
      });
      const script = generateInlineScript({
        allowedOrigins: [ADMIN],
        disableLocalhostMatching: true,
        disableReferrerDetection: true,
        eventSourcePolicy: 'any',
        serverURL: ADMIN,
        mergeDepth: 1,
        debounceMs: 200,
        bindingDebounceMs: 0,
        fragmentEndpoint: '/payload/fragment',
        scopeBindingsByOwner: true,
        enableA11y: false,
        disableVisibilityGate: true,
      });
      // Execute the generated classic script exactly as a script tag does.
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      const evaluate = new Function(script) as () => void;
      evaluate();
      post('primary');
      await vi.advanceTimersByTimeAsync(500);
      expect(api().inspect().fragments.rendered).toBe(1);
      for (const value of ['secondary', 'navy', 'outline', 'outline', 'outline']) {
        post(value);
        await vi.advanceTimersByTimeAsync(25);
      }
      await vi.advanceTimersByTimeAsync(2_000);
      expect(document.querySelector('button')?.className).toBe('outline');
      expect(api().inspect().fragments.failed).toBe(0);
      expect(api().inspect().route.failed).toBe(0);
      expect(
        requests.some((request) => request.kind === 'fragment' && request.signal?.aborted),
      ).toBe(true);
    },
  );
});
