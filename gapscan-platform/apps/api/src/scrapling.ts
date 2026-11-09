// The Scrapling reader: an alternative to GapScan's own browser for websites. Scrapling's HTTP
// fetcher (Python, run as a child process through scrapling/bridge.py) downloads the pages and
// their stylesheets; GapScan finds the stylesheets and same-site pages in the HTML and reads the
// CSS with its usual code reader. Nothing is rendered, so there are no screenshots, measured
// states, extra widths or dark mode. Every request goes through GapScan's egress proxy, which
// connects only to vetted public addresses on 443, and every URL passes the same public-URL check.
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {codeAdapter, startEgressProxy} from '@gapscan/adapters';
import type {Adapter, AdapterResult, EgressResolver, Observation} from '@gapscan/adapters';

export const BRIDGE = fileURLToPath(new URL('../scrapling/bridge.py', import.meta.url));
export type ScraplingOptions = {
  python?: string; script?: string;                  // the interpreter with Scrapling installed, and the bridge
  allowUrl: (url: URL) => Promise<boolean>; resolve: EgressResolver;
  maxPages?: number; maxStylesheets?: number; timeoutSeconds?: number;
};
type Answer = {id: number; status?: number; url?: string; contentType?: string; body?: string; error?: string; ok?: boolean};

// One bridge process per read: requests go in as lines, answers come back as lines.
function startBridge(python: string, script: string, args: string[], signal: AbortSignal) {
  const child = spawn(python, [script, ...args], {stdio: ['pipe', 'pipe', 'pipe'], signal});
  const waiting = new Map<number, (answer: Answer) => void>();
  let next = 0, stderr = '';
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2000); });
  createInterface({input: child.stdout}).on('line', line => {
    let answer: Answer;
    try { answer = JSON.parse(line) as Answer; } catch { return; }
    waiting.get(answer.id)?.(answer); waiting.delete(answer.id);
  });
  const failAll = (error: string) => { for (const resolve of waiting.values()) resolve({id: -1, error}); waiting.clear(); };
  child.on('error', error => failAll(error.message));
  child.on('exit', code => failAll(`Scrapling stopped (exit ${code}). ${stderr.trim().split('\n').pop() ?? ''}`.trim()));
  const ask = (request: Record<string, unknown>) => new Promise<Answer>(resolve => {
    const id = ++next; waiting.set(id, resolve);
    child.stdin.write(JSON.stringify({id, ...request}) + '\n');
  });
  return {ask, close: async () => { child.stdin.end(); if (child.exitCode === null) await Promise.race([once(child, 'exit'), new Promise(r => setTimeout(r, 2000))]); child.kill(); }};
}

// Whether this server can use Scrapling at all (asked once; the answer is cached).
let availability: Promise<{available: boolean; reason?: string}> | null = null;
export function scraplingAvailable(python = process.env.GAPSCAN_SCRAPLING_PYTHON || 'python3', script = BRIDGE): Promise<{available: boolean; reason?: string}> {
  availability ??= (async () => {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 20_000);
    try {
      const bridge = startBridge(python, script, [], controller.signal);
      const answer = await bridge.ask({check: true});
      await bridge.close();
      if (answer.ok) return {available: true};
      if (answer.error?.startsWith('Scrapling is not available')) return {available: false, reason: 'Scrapling isn’t installed on this server.'};
      if (/ENOENT/.test(answer.error ?? '')) return {available: false, reason: `No Python at “${python}”. Set GAPSCAN_SCRAPLING_PYTHON to a Python 3.10+ that has Scrapling installed.`};
      return {available: false, reason: answer.error ?? 'Scrapling didn’t answer.'};
    } catch (error) { return {available: false, reason: `Scrapling can’t start: ${error instanceof Error ? error.message : String(error)}`}; }
    finally { clearTimeout(timer); }
  })();
  return availability;
}
export const resetScraplingCheck = () => { availability = null; };

// Errors from the fetcher, in words a person can act on.
function plainError(error: string): string {
  if (/internal IP|SSRF/i.test(error)) return 'The page redirected to a private address, which is never followed.';
  if (/timed? ?out|Timeout/i.test(error)) return 'The site took too long to answer.';
  if (/resolve host|Could not resolve/i.test(error)) return 'The site’s address could not be found.';
  return error;
}

// Links and stylesheets from HTML. Attribute values only; nothing in the page is run.
const attr = (tag: string, name: string) => new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag)?.slice(1).find(v => v !== undefined) ?? null;
export function readHtml(html: string, base: URL) {
  const resolve = (href: string | null) => { if (!href) return null; try { const url = new URL(href.replace(/&amp;/g, '&'), base); url.hash = ''; return url; } catch { return null; } };
  const stylesheets = [...html.matchAll(/<link\b[^>]*>/gi)].map(m => m[0]).filter(tag => /\brel\s*=\s*["']?[^"'>]*\bstylesheet\b/i.test(tag)).map(tag => resolve(attr(tag, 'href'))).filter((u): u is URL => u !== null);
  const styles = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map(m => m[1]!).filter(css => css.trim());
  const links = [...html.matchAll(/<a\b[^>]*>/gi)].map(m => resolve(attr(m[0], 'href'))).filter((u): u is URL => u !== null && u.origin === base.origin && !/\.(?:pdf|zip|png|jpe?g|gif|svg|webp|mp4|xml|json)$/i.test(u.pathname));
  return {stylesheets, styles, links};
}

export function createScraplingAdapter({python = process.env.GAPSCAN_SCRAPLING_PYTHON || 'python3', script = BRIDGE, allowUrl, resolve, maxPages = 8, maxStylesheets = 30, timeoutSeconds = 30}: ScraplingOptions): Adapter {
  return async (input, context) => {
    const start = new URL(input.uri);
    if (!await allowUrl(start)) throw new Error('Only public https:// websites can be read.');
    const proxy = await startEgressProxy({resolve});
    const server = new URL(proxy.launchProxy.server);
    server.username = proxy.launchProxy.username; server.password = proxy.launchProxy.password;
    const bridge = startBridge(python, script, [server.href.replace(/\/$/, ''), String(timeoutSeconds), String(4_000_000)], context.signal);
    const failed: AdapterResult['failed'] = [], observations: Observation[] = [], seenPages = new Set<string>(), seenCss = new Set<string>();
    let fetched = 0, budgetHit = false;
    const get = async (url: URL) => {
      if (!await allowUrl(url)) { failed.push({locator: url.href, reason: 'Not a public https:// address.'}); return null; }
      const answer = await bridge.ask({url: url.href});
      if (answer.error) { failed.push({locator: url.href, reason: plainError(answer.error)}); return null; }
      if (!answer.status || answer.status >= 400) { failed.push({locator: url.href, reason: `The site answered ${answer.status ?? 'nothing'}.`}); return null; }
      return {url: new URL(answer.url ?? url.href), contentType: answer.contentType ?? '', text: Buffer.from(answer.body ?? '', 'base64').toString('utf8')};
    };
    const readCss = async (css: string, name: string) => { observations.push(...(await codeAdapter({assetId: input.assetId, name, uri: input.uri, bytes: Buffer.from(css)}, context)).observations); };
    // Pages that use none of the first page's stylesheets belong to another design (an archived
    // version, a separate product), so their styles are left out and their links not followed.
    let design: Set<string> | null = null;
    try {
      const queue = [start];
      while (queue.length && seenPages.size < maxPages) {
        context.signal.throwIfAborted();
        const url = queue.shift()!;
        if (seenPages.has(url.href)) continue;
        seenPages.add(url.href);
        await context.progress?.(`Scrapling: reading ${url.pathname} (${seenPages.size} of up to ${maxPages})`);
        const page = await get(url);
        if (!page) continue;
        if (/text\/css/i.test(page.contentType)) { await readCss(page.text, `${url.hostname}${url.pathname}`); fetched++; continue; }
        const {stylesheets, styles, links} = readHtml(page.text, page.url);
        if (!design) design = new Set(stylesheets.map(s => s.href));
        else if (design.size && stylesheets.length && !stylesheets.some(s => design!.has(s.href))) {
          failed.push({locator: url.href, reason: 'Uses different stylesheets from the first page (another design or an archived version), so it was left out.'});
          continue;
        }
        fetched++;
        for (const [i, css] of styles.entries()) await readCss(css, `${url.hostname}${url.pathname} <style> ${i + 1}.css`);
        for (const sheet of stylesheets) {
          if (seenCss.has(sheet.href)) continue;
          if (seenCss.size >= maxStylesheets) { budgetHit = true; break; }
          seenCss.add(sheet.href);
          const css = await get(sheet);
          if (css) { await readCss(css.text, `${sheet.hostname}${sheet.pathname}`); fetched++; }
        }
        for (const link of links) if (!seenPages.has(link.href) && !queue.some(q => q.href === link.href)) queue.push(link);
      }
      if (queue.length) budgetHit = true;
      if (!fetched) throw new Error(failed[0]?.reason ? `Scrapling couldn’t read the site: ${failed[0].reason}` : 'Scrapling couldn’t read the site.');
      return {observations, fetched, failed, budgetHit, viewports: [], themes: []};
    } finally {
      await bridge.close();
      await proxy.close();
    }
  };
}
