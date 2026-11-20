import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

async function table(playerCount) {
  const source = readFileSync(new URL('../app.js', import.meta.url), 'utf8')
    .split('// ---------------------------------------------------------------- boot')[0];
  const nodes = new Map();
  const document = {
    addEventListener() {},
    querySelector(selector) {
      if (!nodes.has(selector)) nodes.set(selector, { textContent: '', innerHTML: '', dataset: {}, classList: { add() {}, remove() {} } });
      return nodes.get(selector);
    },
  };
  const context = vm.createContext({
    document, window: {}, location: { search: '' }, URLSearchParams,
    crypto: webcrypto, TextEncoder, TextDecoder, btoa, atob,
    setTimeout() { return 1; }, clearTimeout() {}, setInterval() { return 1; }, clearInterval() {},
  });
  vm.runInContext(source + '\nglobalThis.api={Host,cleanState,updLobby,updReveal,app};})();', context);
  const { Host } = context.api;
  const host = new Host({}, 'ABCD');
  host.start = () => {};
  host.changed = () => {};
  await host.create('Host', false);
  for (let i = 0; i < playerCount; i++) {
    const id = `p${i}`;
    host.s.order.push(id);
    host.s.players[id] = { id, name: `Player ${i}`, chips: 1000, busted: false, clv: 0, nb: 0, seen: Date.now(), host: false };
  }
  return { ...context.api, host, nodes };
}

test('a spectator host cannot add a ninth seat and break remote state validation', async () => {
  const { host, cleanState } = await table(8);
  host.setPlays(true);
  assert.equal(host.s.order.length, 8);
  assert.equal(host.s.hostSeat, null);
  assert.ok(cleanState(host.publicState()), 'players must still receive a valid public table');
});

test('holding published results keeps a round visible until the host advances', async () => {
  const { host, cleanState, app, updReveal, nodes } = await table(2);
  host.publish = () => {};
  host.startGame();
  host.holdResults();
  assert.equal(host.s.phase, 'betting');
  host.close();
  assert.ok(host.s.nextAt > 0);
  host.holdResults();
  assert.equal(host.s.nextAt, 0);
  host.tick();
  assert.equal(host.s.phase, 'reveal');
  app.st = cleanState(host.publicState());
  updReveal();
  assert.match(nodes.get('#nextIn').textContent, /on hold/);
  assert.doesNotMatch(nodes.get('#reveal').innerHTML, /data-act="hold"/);
  app.host = host;
  nodes.get('#reveal').dataset = {};
  updReveal();
  assert.equal(nodes.get('#holdResults').hidden, true);
  host.nextNow();
  host.tick();
  assert.equal(host.s.round, 2);
  assert.equal(host.s.phase, 'betting');
  host.close();
  assert.ok(host.s.nextAt > 0);
});

test('the host can take the last free seat and return to spectating', async () => {
  const { host, cleanState } = await table(7);
  host.setPlays(true);
  assert.equal(host.s.order.length, 8);
  assert.ok(host.s.hostSeat);
  assert.ok(cleanState(host.publicState()));
  host.setPlays(false);
  assert.equal(host.s.order.length, 7);
  assert.equal(host.s.hostSeat, null);
  assert.ok(cleanState(host.publicState()));
});

test('the lobby disables joining a full table but still lets a seated host leave', async () => {
  const { host, app, updLobby, nodes } = await table(8);
  app.host = host;
  app.st = host.publicState();
  updLobby();
  assert.equal(nodes.get('#plays').checked, false);
  assert.equal(nodes.get('#plays').disabled, true);

  const id = host.s.order.pop();
  delete host.s.players[id];
  host.setPlays(true);
  app.st = host.publicState();
  updLobby();
  assert.equal(nodes.get('#plays').checked, true);
  assert.equal(nodes.get('#plays').disabled, false);
});
