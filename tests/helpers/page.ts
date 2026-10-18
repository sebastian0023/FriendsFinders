import { readFileSync } from 'fs';
import { join } from 'path';
import { JSDOM, VirtualConsole } from 'jsdom';

// Opens the real frontend/index.html in a simulated browser (jsdom) with a fake API behind it,
// so the page's behaviour can be tested without a browser, a network or AWS.

const FRONTEND_HTML = readFileSync(join(__dirname, '../../frontend/index.html'), 'utf8');

export interface ApiResponse {
  status: number;
  json?: unknown;
}
/** What the fake API answers for a request: a fixed response, or one worked out from the request. */
export type Route = ApiResponse | ((request: { body: any }) => ApiResponse);
/** Routes are keyed "METHOD /path", for example "GET /friends". Anything else answers 404. */
export type Routes = Record<string, Route>;

export interface Call {
  method: string;
  path: string;
  body?: any;
}

export interface Page {
  window: any;
  document: Document;
  $: (id: string) => HTMLElement;
  /** True when the element exists and is not hidden by the page's "hidden" class. */
  visible: (id: string) => boolean;
  /** Every request the page sent to the API, in order. */
  calls: Call[];
  /** Everything the page showed with alert(). */
  alerts: string[];
  /** Runs code in the page's own global scope, so tests can reach its top-level variables. */
  run: (code: string) => any;
}

export interface PageOptions {
  routes?: Routes;
  /** The signed-in user's token claims; null opens the page signed out. */
  claims?: Record<string, unknown> | null;
}

const base64url = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** A token the page can read the claims from (it never verifies the signature). */
export const idToken = (claims: Record<string, unknown>) => `${base64url({ alg: 'none' })}.${base64url(claims)}.sig`;

const opened: JSDOM[] = [];

/** Closes every page opened so far; call it after each test so no page keeps running timers. */
export function closeAllPages(): void {
  while (opened.length) opened.pop()!.window.close();
}

export function openPage({ routes = {}, claims = { sub: 'user-1', email: 'a@example.com' } }: PageOptions = {}): Page {
  const calls: Call[] = [];
  const alerts: string[] = [];

  const dom = new JSDOM(FRONTEND_HTML, {
    url: 'https://app.example/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole: new VirtualConsole(), // swallow jsdom's "not implemented" noise (canvas, scrolling)
    beforeParse(window) {
      const w = window as any;
      w.__APP_CONFIG__ = {
        cognitoDomain: 'https://auth.example',
        webClientId: 'client',
        httpApi: 'https://api.example',
        wsApi: 'wss://ws.example',
      };
      if (claims) w.sessionStorage.setItem('tokens', JSON.stringify({ id_token: idToken(claims), access_token: 'x' }));
      w.alert = (message: string) => alerts.push(message);
      w.scrollTo = () => undefined;
      w.fetch = async (url: string, init: { method?: string; body?: string } = {}) => {
        const path = String(url).replace('https://api.example', '');
        const method = init.method || 'GET';
        const body = init.body ? JSON.parse(init.body) : undefined;
        calls.push({ method, path, body });

        const route = routes[`${method} ${path}`];
        const reply: ApiResponse =
          typeof route === 'function' ? route({ body }) : route || { status: 404, json: { error: 'Not found' } };
        return {
          ok: reply.status < 400,
          status: reply.status,
          text: async () => JSON.stringify(reply.json ?? {}),
          json: async () => reply.json ?? {},
        };
      };
    },
  });
  opened.push(dom);

  const document = dom.window.document;
  const $ = (id: string) => document.getElementById(id) as HTMLElement;
  return {
    window: dom.window,
    document,
    $,
    visible: (id) => !!$(id) && !$(id).classList.contains('hidden'),
    calls,
    alerts,
    run: (code) => (dom.window as any).eval(code),
  };
}

/** Waits (up to `timeout` ms) until the page reaches a state, failing with `label` otherwise. */
export async function waitFor(predicate: () => boolean, label: string, timeout = 3000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      if (predicate()) return;
    } catch {
      // not ready yet
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

/** Gives the page a moment to run anything it may still do, for "nothing else happens" checks. */
export const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 60));
