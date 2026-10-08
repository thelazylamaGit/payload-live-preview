import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test, type Frame, type Page } from '@playwright/test';
import { generateInlineScript, generateLoaderScript } from '../../../src/inline/generator';
import { LEAN_RUNTIME } from '../../../src/lean';

// Real HTTP documents and WindowProxies: no routes, synthetic message events,
// or replaced window constructors. Ephemeral ports keep the two origins isolated.
let cmsServer: Server;
let previewServer: Server;
let cmsOrigin: string;
let previewOrigin: string;

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function admin(): string {
  return `<!doctype html><button id="popup">Popup</button><button id="iframe">Iframe</button>
    <button id="update">Update form</button><output id="ready">0</output><output id="sent">0</output>
    <script>
      window.preview = null;
      const previewURL = ${JSON.stringify(previewOrigin)} + '/preview' + location.search;
      const send = title => {
        preview.postMessage({type: 'payload-live-preview', data: {title}}, ${JSON.stringify(previewOrigin)});
        document.querySelector('#sent').textContent = String(Number(document.querySelector('#sent').textContent) + 1);
      };
      addEventListener('message', event => {
        if (event.origin !== ${JSON.stringify(previewOrigin)} || event.source !== preview) return;
        if (event.data.type === 'payload-live-preview' && event.data.ready === true) {
          document.querySelector('#ready').textContent = '1';
          send('Automatic form update');
        }
      });
      document.querySelector('#popup').onclick = () => { window.preview = window.open(previewURL); };
      document.querySelector('#iframe').onclick = () => {
        const frame = document.createElement('iframe');
        frame.id = 'preview';
        frame.src = previewURL;
        document.body.append(frame);
        window.preview = frame.contentWindow;
      };
      document.querySelector('#update').onclick = () => send('Edited without refreshing');
    </script>`;
}

test.beforeAll(async () => {
  cmsServer = createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html');
    response.end(admin());
  });
  cmsOrigin = await listen(cmsServer);
  previewServer = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const config = {
      allowedOrigins: [cmsOrigin],
      defaults: 'v2' as const,
      debounceMs: 0,
      disableVisibilityGate: true,
      enableA11y: false,
    };
    if (url.pathname === '/runtime.js') {
      response.setHeader('Content-Type', 'application/javascript');
      response.end(generateInlineScript(config));
      return;
    }
    response.setHeader('Content-Type', 'text/html');
    if (url.pathname === '/unauthorized') {
      // After navigation this is still the popup's real opener, but its origin
      // is no longer allowed. Reply to a probe using the real message source.
      response.end(`<!doctype html><script>
        addEventListener('message', event => {
          if (event.data === 'probe') event.source.postMessage(
            {type: 'payload-live-preview', data: {title: 'Unauthorized opener'}},
            ${JSON.stringify(previewOrigin)});
        });
      </script>`);
      return;
    }
    const delivery = url.searchParams.get('delivery');
    const script =
      delivery === 'loader'
        ? generateLoaderScript(config, { runtimeSrc: `${previewOrigin}/runtime.js` })
        : generateInlineScript({
            ...config,
            ...(delivery === 'lean' ? { runtime: LEAN_RUNTIME } : {}),
          });
    response.end(
      `<!doctype html><h1 data-payload-field="title">Initial title</h1><script>${script}</script>`,
    );
  });
  previewOrigin = await listen(previewServer);
});

test.afterAll(async () => {
  await Promise.all(
    [cmsServer, previewServer].map(
      (server) =>
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        ),
    ),
  );
});

// Wait for actual delivery and rendering opportunities before asserting rejection.
async function observeMessages(preview: Page | Frame): Promise<void> {
  await preview.evaluate(() => {
    const titles: string[] = [];
    (window as unknown as { receivedTitles: string[] }).receivedTitles = titles;
    addEventListener('message', (event) => {
      const message = event.data as { data?: { title?: unknown } } | null;
      const title = message?.data?.title;
      if (typeof title === 'string') titles.push(title);
    });
  });
}

async function expectRejected(preview: Page | Frame, title: string): Promise<void> {
  await expect
    .poll(() =>
      preview.evaluate(
        (value) =>
          (window as unknown as { receivedTitles: string[] }).receivedTitles.includes(value),
        title,
      ),
    )
    .toBe(true);
  await preview.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await expect(preview.locator('[data-payload-field="title"]')).toHaveText(
    'Edited without refreshing',
  );
}

async function sendFromSibling(page: Page): Promise<void> {
  // This sibling has an allowed origin, but is neither parent nor opener.
  await page.evaluate(() => {
    const sibling = document.createElement('iframe');
    sibling.id = 'sibling';
    sibling.src = '/';
    document.body.append(sibling);
  });
  await expect(page.frameLocator('#sibling').locator('#popup')).toBeVisible();
  const sibling = page.frames().find((frame) => frame.url() === `${cmsOrigin}/`);
  if (sibling === undefined) throw new Error('sibling frame missing');
  await sibling.evaluate((origin) => {
    (parent as unknown as { preview: Window }).preview.postMessage(
      { type: 'payload-live-preview', data: { title: 'Unauthorized sibling' } },
      origin,
    );
  }, previewOrigin);
}

['inline', 'lean', 'loader'].forEach((delivery) => {
  test(`${delivery}: cross-origin popup announces readiness and rejects unauthorized senders`, async ({
    page,
  }) => {
    await page.goto(`${cmsOrigin}/?delivery=${delivery}`);
    const popupPromise = page.waitForEvent('popup');
    await page.locator('#popup').click();
    const popup = await popupPromise;
    await popup.waitForLoadState();
    expect(await popup.evaluate(() => window.opener !== null)).toBe(true);
    expect(await popup.evaluate(() => window.opener instanceof Window)).toBe(false);
    await expect(page.locator('#ready')).toHaveText('1');
    await expect(page.locator('#sent')).toHaveText('1');
    await expect(popup.locator('h1')).toHaveText('Automatic form update');
    const documentHandle = await popup.evaluateHandle(() => document);
    await page.locator('#update').click();
    await expect(popup.locator('h1')).toHaveText('Edited without refreshing');
    expect(await popup.evaluate((previous) => previous === document, documentHandle)).toBe(true);
    await observeMessages(popup);

    await sendFromSibling(page);
    await expectRejected(popup, 'Unauthorized sibling');

    // Preserve the actual opener identity while changing its origin.
    await page.goto(`${previewOrigin}/unauthorized`);
    await popup.evaluate((origin) => {
      const opener = window.opener as Window;
      opener.postMessage('probe', origin);
    }, previewOrigin);
    await expectRejected(popup, 'Unauthorized opener');
    await popup.close();
  });

  test(`${delivery}: cross-origin iframe still announces readiness and accepts its parent`, async ({
    page,
  }) => {
    await page.goto(`${cmsOrigin}/?delivery=${delivery}`);
    await page.locator('#iframe').click();
    await expect(page.locator('#ready')).toHaveText('1');
    await expect(page.locator('#sent')).toHaveText('1');
    const preview = page.frameLocator('#preview');
    await expect(preview.locator('h1')).toHaveText('Automatic form update');
    await page.locator('#update').click();
    await expect(preview.locator('h1')).toHaveText('Edited without refreshing');
    const frame = page.frames().find((candidate) => candidate.url().startsWith(previewOrigin));
    if (frame === undefined) throw new Error('preview frame missing');
    await observeMessages(frame);
    await sendFromSibling(page);
    await expectRejected(frame, 'Unauthorized sibling');
  });
});
