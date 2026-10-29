import test from 'node:test';
import assert from 'node:assert/strict';
import { targetsAt, checkedSocket, isAppTarget, type Target } from './injection-session.ts';

const target = (host: string, url = 'app://-/index.html'): Target => ({id:'native-page',type:'page',title:'ChatGPT',url,
  webSocketDebuggerUrl:`ws://${host}:9335/devtools/page/native-page`});
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), {status});

test('finds the app when IPv4 is refused and Chromium listens only on IPv6', async () => {
  const calls: string[] = [];
  const pages = await targetsAt(9335, (async url => {
    calls.push(String(url));
    if(String(url).includes('127.0.0.1')) throw new Error('ECONNREFUSED');
    return reply([target('[::1]')]);
  }) as typeof fetch);
  assert.deepEqual(calls.sort(), ['http://127.0.0.1:9335/json/list','http://[::1]:9335/json/list'].sort());
  assert.equal(checkedSocket(pages[0], 9335), 'ws://[::1]:9335/devtools/page/native-page');
});

test('preserves IPv4 discovery and prefers the app over an unrelated browser', async () => {
  for (const appHost of ['127.0.0.1','[::1]']) {
    const pages = await targetsAt(9335, (async url => reply([target(String(url).includes(appHost) ? appHost : 'localhost',
      String(url).includes(appHost) ? 'app://-/index.html' : 'https://example.test/')])) as typeof fetch);
    assert.ok(pages.some(isAppTarget));
    assert.equal(new URL(pages[0].webSocketDebuggerUrl).hostname, appHost);
  }
});

test('ignores failed or malformed endpoint responses', async () => {
  assert.deepEqual(await targetsAt(9335, (async url => String(url).includes('127.0.0.1') ? reply([],503) : reply({error:'unavailable'})) as typeof fetch), []);
  assert.deepEqual(await targetsAt(9335, (async () => reply([null,{},'invalid'])) as typeof fetch), []);
  await assert.rejects(targetsAt(80), /Invalid local debugging port/);
});

test('rejects non-loopback and mismatched WebSocket endpoints', () => {
  for (const host of ['example.test','192.168.1.1']) assert.throws(() => checkedSocket(target(host),9335), /Rejected/);
  assert.throws(() => checkedSocket({...target('[::1]'),id:'different'},9335), /Rejected/);
  assert.throws(() => checkedSocket(target('[::1]'),9336), /Rejected/);
  assert.equal(isAppTarget(target('[::1]','app://-/index.html?initialRoute=%2Favatar-overlay')), false);
});
