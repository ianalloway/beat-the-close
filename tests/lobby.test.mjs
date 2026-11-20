import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

async function table(playerCount, crypto = webcrypto) {
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
    crypto, TextEncoder, TextDecoder, btoa, atob,
    setTimeout() { return 1; }, clearTimeout() {}, setInterval() { return 1; }, clearInterval() {},
  });
  vm.runInContext(source + '\nglobalThis.api={Host,cleanState,updLobby,updReveal,projectedStacks,app,code4};})();', context);
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

test('projected stacks use personal entry prices, round each ticket, and match settlement', async () => {
  const { host, projectedStacks } = await table(2);
  host.startGame();
  host.s.line = 60;
  host.bet('p0', 'H', 10);
  host.s.line = 32;
  host.bet('p0', 'A', 20);
  host.s.line = 60;
  host.bet('p0', 'H', 10);
  host.bet('p1', 'A', 25);
  const me = host.s.players.p0;
  const mine = host.s.bets.filter(b => b.seat === 'p0');
  const stack = projectedStacks(me.chips, mine);
  assert.equal(me.chips, 648);
  assert.deepEqual({ ...stack }, { H: 935, A: 913 });
  host.close();
  assert.equal(me.chips, stack[host.s.reveal.winner]);
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

test('room codes discard the uneven tail of the random byte range', async () => {
  const batches = [[240, 255, 0, 23], [24, 239]];
  const crypto = {
    subtle: webcrypto.subtle,
    getRandomValues(bytes) {
      if (bytes.length > 4) return webcrypto.getRandomValues(bytes);
      bytes.set(batches.shift());
      return bytes;
    },
  };
  const { code4 } = await table(0, crypto);
  assert.equal(code4(), 'AZAZ');
  assert.equal(batches.length, 0);
});
