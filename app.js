/* Beat the Close — a live betting-market party game.
 * The host's device is the table: it holds the hidden true chance, runs the clock,
 * validates every bet and broadcasts the public state. Players talk to it over a
 * public MQTT relay. Scouting reads and bets are end-to-end encrypted per player
 * (ECDH P-256 + AES-GCM), so nobody on the relay can see another player's read
 * or place bets in their name. */
(() => {
'use strict';

// ---------------------------------------------------------------- config
const qs = new URLSearchParams(location.search);
const FAST = qs.get('fast') === '1';
const CFG = {
  rounds: 6, betSecs: FAST ? 12 : 40, revealSecs: FAST ? 5 : 12,
  startChips: 1000, maxBets: 3, minPct: 1, maxPct: 25, bustAt: 10, maxSeats: 8,
  driftMs: 2000, driftPull: 0.12, driftNoise: 0.7, readSd: 8,
};
const BROKERS = qs.get('broker') ? [qs.get('broker')]
  : ['wss://broker.hivemq.com:8884/mqtt', 'wss://broker.emqx.io:8084/mqtt'];
const NS = 'beatclose/v1/';
const TEAMS = [
  ['Mon River', 'Rivermen'], ['Tygart Valley', 'Kingfish'], ['West Fork', 'Ferrymen'], ['Cheat River', 'Rapids'],
  ['Kanawha', 'Kilns'], ['Greenbrier', 'Owls'], ['Coal River', 'Miners'], ['Buckhannon', 'Bruins'],
];
const teamFull = i => TEAMS[i].join(' ');

// ---------------------------------------------------------------- utils
const $ = (s, r = document) => r.querySelector(s);
const rnd = () => crypto.getRandomValues(new Uint32Array(1))[0] / 4294967296;
const normal = () => { let u = 0, v = 0; while (!u) u = rnd(); while (!v) v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
const rid = (n = 8) => Array.from(crypto.getRandomValues(new Uint8Array(n)), b => 'abcdefghijkmnpqrstuvwxyz23456789'[b % 32]).join('');
const code4 = () => Array.from(crypto.getRandomValues(new Uint8Array(4)), b => 'ABCDEFGHJKLMNPQRSTUVWXYZ'[b % 24]).join('');
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const r1 = x => Math.round(x * 10) / 10;
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = n => Math.round(n).toLocaleString('en-US');
const sgn = (x, d = 1) => (x > 0 ? '+' : x < 0 ? '−' : '±') + Math.abs(x).toFixed(d);
const cls = x => x > 0 ? 'pos' : x < 0 ? 'neg' : 'muted';
const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const store = {
  get(k) { try { return JSON.parse(sessionStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { sessionStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k) { try { sessionStorage.removeItem(k); } catch {} },
};
const pref = {
  get(k) { try { return localStorage.getItem(k) || ''; } catch { return ''; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};
const payMult = (side, line) => side === 'H' ? 100 / line : 100 / (100 - line);
// Timers in a background tab get throttled to a crawl; a worker's timers keep running,
// so the host's clock and the players' heartbeats keep ticking when the tab is hidden.
function ticker(fn, ms) {
  try {
    const w = new Worker(URL.createObjectURL(new Blob([`setInterval(() => postMessage(0), ${ms})`], { type: 'text/javascript' })));
    w.onmessage = () => fn();
    return () => w.terminate();
  } catch { const id = setInterval(fn, ms); return () => clearInterval(id); }
}

// ---------------------------------------------------------------- untrusted input
// The relay is public: anyone who knows a room code can publish to its topics. A remote state is
// checked against a strict schema and rebuilt from known fields before it is used, and everything
// interpolated into innerHTML goes through esc().
const PHASES = ['lobby', 'betting', 'reveal', 'final'];
const isObj = x => !!x && typeof x === 'object' && !Array.isArray(x);
const isStr = (x, max) => typeof x === 'string' && x.length <= max;
const isInt = (x, lo, hi) => Number.isInteger(x) && x >= lo && x <= hi;
const isNum = (x, lo, hi) => typeof x === 'number' && Number.isFinite(x) && x >= lo && x <= hi;
const isId = x => typeof x === 'string' && /^[a-z0-9]{1,16}$/.test(x);
const isSide = x => x === 'H' || x === 'A';
const isCid = x => typeof x === 'string' && /^[a-z0-9]{8,24}$/.test(x);
const BIG = 1e12, MS = 1e14; // chip and epoch-ms ceilings, far above anything a real game reaches
const need = ok => { if (!ok) throw new TypeError('bad state'); };
const cleanJwk = k => { need(isObj(k) && k.kty === 'EC' && k.crv === 'P-256' && [k.x, k.y].every(c => typeof c === 'string' && /^[A-Za-z0-9_-]{43}$/.test(c))); return { kty: 'EC', crv: 'P-256', x: k.x, y: k.y }; };
const cleanList = (a, max, f) => { need(Array.isArray(a) && a.length <= max); return a.map(f); };
function cleanPlayer(p) {
  need(isObj(p) && isId(p.id) && isStr(p.name, 16) && isInt(p.chips, 0, BIG) && typeof p.busted === 'boolean' && isNum(p.clv, -BIG, BIG)
    && typeof p.host === 'boolean' && typeof p.online === 'boolean' && isInt(p.nb, 0, CFG.maxBets));
  return { id: p.id, name: p.name, chips: p.chips, busted: p.busted, clv: p.clv, host: p.host, online: p.online, nb: p.nb };
}
function cleanBet(b) {
  need(isObj(b) && isId(b.seat) && isSide(b.side) && isInt(b.stake, 1, BIG) && isNum(b.entry, 0, 100) && isNum(b.after, 0, 100) && isNum(b.t, 0, MS));
  const out = { seat: b.seat, side: b.side, stake: b.stake, entry: b.entry, after: b.after, t: b.t };
  if (b.clv !== undefined) { need(isNum(b.clv, -100, 100) && typeof b.won === 'boolean' && isNum(b.ret, 0, BIG)); Object.assign(out, { clv: b.clv, won: b.won, ret: b.ret }); }
  return out;
}
function cleanResults(r) {
  need(isObj(r) && Object.keys(r).length <= CFG.maxSeats);
  return Object.fromEntries(Object.entries(r).map(([id, x]) => {
    need(isId(id) && isObj(x) && isInt(x.staked, 0, BIG) && isNum(x.ret, 0, BIG) && isNum(x.pl, -BIG, BIG) && isNum(x.clv, -BIG, BIG)
      && isInt(x.n, 0, CFG.maxBets) && (x.read === null || isNum(x.read, 0, 100)));
    return [id, { staked: x.staked, ret: x.ret, pl: x.pl, clv: x.clv, n: x.n, read: x.read }];
  }));
}
/* a clean copy of a public table state, or null if anything is missing, mistyped or out of range */
function cleanState(st) {
  try {
    need(isObj(st) && st.v === 1 && typeof st.room === 'string' && /^[A-Z]{4}$/.test(st.room) && PHASES.includes(st.phase));
    need(isInt(st.rounds, 1, 50) && isInt(st.round, 0, st.rounds) && isNum(st.betSecs, 1, 600) && isNum(st.revealSecs, 1, 600));
    need(isNum(st.line, 0, 100) && [st.roundStart, st.endsAt, st.nextAt, st.created, st.hostNow].every(t => isNum(t, 0, MS)));
    need(isStr(st.hostName, 16) && (st.hostSeat === null || isId(st.hostSeat)));
    const players = cleanList(st.players, CFG.maxSeats, cleanPlayer);
    need(new Set(players.map(p => p.id)).size === players.length);
    const inRound = st.phase === 'betting' || st.phase === 'reveal';
    let match = null;
    if (st.match !== null || inRound) {
      need(isObj(st.match) && isInt(st.match.home, 0, TEAMS.length - 1) && isInt(st.match.away, 0, TEAMS.length - 1) && st.match.home !== st.match.away);
      match = { home: st.match.home, away: st.match.away };
    }
    let reveal = null;
    if (st.phase === 'reveal') {
      const r = st.reveal;
      need(isObj(r) && isInt(r.round, 1, st.rounds) && isNum(r.P, 0, 100) && isSide(r.winner) && isNum(r.close, 0, 100));
      reveal = { round: r.round, P: r.P, winner: r.winner, close: r.close, results: cleanResults(r.results) };
    }
    let final = null;
    if (st.phase === 'final') {
      const f = st.final;
      need(isObj(f) && (f.sharpest === null || isId(f.sharpest)));
      final = { standings: cleanList(f.standings, CFG.maxSeats, id => { need(isId(id)); return id; }), sharpest: f.sharpest };
    }
    return {
      v: 1, room: st.room, phase: st.phase, hostPub: cleanJwk(st.hostPub), hostSeat: st.hostSeat, hostName: st.hostName,
      round: st.round, rounds: st.rounds, betSecs: st.betSecs, revealSecs: st.revealSecs, match, line: st.line,
      history: cleanList(st.history, 1000, h => { need(Array.isArray(h) && h.length === 2 && isNum(h[0], 0, MS) && isNum(h[1], 0, 100)); return [h[0], h[1]]; }),
      roundStart: st.roundStart, endsAt: st.endsAt, nextAt: st.nextAt,
      bets: cleanList(st.bets, CFG.maxSeats * CFG.maxBets, cleanBet),
      feed: cleanList(st.feed, 50, f => { need(isObj(f) && isNum(f.t, 0, MS) && isStr(f.txt, 300)); return { t: f.t, txt: f.txt }; }),
      players, reveal, final, created: st.created, hostNow: st.hostNow,
    };
  } catch { return null; }
}

// ---------------------------------------------------------------- crypto
const EC = { name: 'ECDH', namedCurve: 'P-256' };
const Crypt = {
  async gen() {
    const kp = await crypto.subtle.generateKey(EC, true, ['deriveKey']);
    return { kp, jwk: { priv: await crypto.subtle.exportKey('jwk', kp.privateKey), pub: await crypto.subtle.exportKey('jwk', kp.publicKey) } };
  },
  async load(jwk) {
    return {
      kp: { privateKey: await crypto.subtle.importKey('jwk', jwk.priv, EC, true, ['deriveKey']), publicKey: await crypto.subtle.importKey('jwk', jwk.pub, EC, true, []) },
      jwk,
    };
  },
  async derive(priv, pubJwk) {
    const pub = await crypto.subtle.importKey('jwk', pubJwk, EC, false, []);
    return crypto.subtle.deriveKey({ name: 'ECDH', public: pub }, priv, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  },
  async enc(key, obj) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(obj)));
    return { iv: b64(iv), ct: b64(ct) };
  },
  async dec(key, { iv, ct }) {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, key, unb64(ct));
    return JSON.parse(new TextDecoder().decode(pt));
  },
};

// ---------------------------------------------------------------- network
class Net {
  constructor(url) { this.url = url; this.handlers = new Set(); this.up = false; }
  connect() {
    return new Promise((resolve, reject) => {
      let settled = false;
      const c = mqtt.connect(this.url, { clientId: 'btc_' + rid(12), clean: true, connectTimeout: 7000, reconnectPeriod: 1500, keepalive: 30 });
      this.c = c;
      const fail = e => { if (!settled) { settled = true; try { c.end(true); } catch {} reject(e); } };
      const timer = setTimeout(() => fail(new Error('timeout')), 8000);
      c.on('connect', () => { this.up = true; paintConn(); if (!settled) { settled = true; clearTimeout(timer); resolve(this); } });
      c.on('error', e => fail(e));
      c.on('offline', () => { this.up = false; paintConn(); });
      c.on('close', () => { this.up = false; paintConn(); });
      c.on('message', (t, m) => {
        let d; try { d = JSON.parse(m.toString()); } catch { return; }
        this.handlers.forEach(h => { try { h(t, d); } catch (e) { console.error(e); } });
      });
    });
  }
  on(h) { this.handlers.add(h); return () => this.handlers.delete(h); }
  sub(t) { this.c.subscribe(t, { qos: 1 }); }
  unsub(t) { this.c.unsubscribe(t); }
  pub(t, obj, { retain = false, qos = 0 } = {}) { this.c.publish(t, JSON.stringify(obj), { retain, qos }); }
  clear(t) { this.c.publish(t, '', { retain: true, qos: 1 }); }
  end() { try { this.c.end(true); } catch {} }
}

async function connectBroker(order) {
  let lastErr;
  for (const i of order) {
    try { const n = new Net(BROKERS[i]); await n.connect(); n.b = i; return n; } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('No relay reachable');
}

// wait for the retained public state of a room on this connection
function peekState(net, room, ms = 3500) {
  return new Promise(resolve => {
    const topic = NS + room + '/state';
    let off;
    const t = setTimeout(() => { off(); net.unsub(topic); resolve(null); }, ms);
    off = net.on((tp, d) => {
      const st = tp === topic ? cleanState(d) : null;
      if (st && st.room === room) { clearTimeout(t); off(); resolve(st); }
    });
    net.sub(topic);
  });
}

// ---------------------------------------------------------------- host (the table)
class Host {
  constructor(net, room) {
    this.net = net; this.room = room; this.T = NS + room;
    this.sec = { P: null, reads: {} }; this.cids = {}; this.keys = {}; this.lastN = {};
    this.dirty = true; this.lastPub = 0; this.lastDrift = 0;
  }
  async create(name, plays) {
    const k = await Crypt.gen(); this.kp = k.kp; this.kjwk = k.jwk;
    const now = Date.now();
    this.s = {
      v: 1, room: this.room, phase: 'lobby', hostPub: k.jwk.pub, hostSeat: null, hostName: name,
      round: 0, rounds: CFG.rounds, betSecs: CFG.betSecs, revealSecs: CFG.revealSecs,
      match: null, line: 50, history: [], roundStart: 0, endsAt: 0, nextAt: 0,
      bets: [], feed: [], players: {}, order: [], reveal: null, final: null, created: now,
    };
    if (plays) this.addHostSeat();
    this.feed(`${name} opened the table`);
    this.start();
  }
  async resume(saved) {
    Object.assign(this, { s: saved.s, sec: saved.sec, lastN: saved.lastN || {} });
    const k = await Crypt.load(saved.kjwk); this.kp = k.kp; this.kjwk = k.jwk;
    for (const id of this.s.order) {
      const p = this.s.players[id];
      if (p.host) continue;
      this.cids[p.cid] = id;
      try { this.keys[id] = await Crypt.derive(this.kp.privateKey, p.pub); } catch {}
    }
    this.start();
    if (this.s.phase === 'betting') for (const id in this.sec.reads) this.sendRead(id);
  }
  start() {
    this.lastDrift = Date.now();
    this.net.sub(this.T + '/toHost');
    this.net.on((t, d) => { if (t === this.T + '/toHost') this.onMsg(d); });
    this.stopTick = ticker(() => this.tick(), 200);
    this.changed();
  }
  addHostSeat() {
    const id = rid(6);
    this.s.players[id] = { id, name: this.s.hostName, chips: CFG.startChips, busted: false, clv: 0, nb: 0, seen: Date.now(), cid: 'host', host: true };
    this.s.order.unshift(id); this.s.hostSeat = id;
  }
  setPlays(on) {
    if (this.s.phase !== 'lobby') return;
    if (on && !this.s.hostSeat) this.addHostSeat();
    if (!on && this.s.hostSeat) { delete this.s.players[this.s.hostSeat]; this.s.order = this.s.order.filter(x => x !== this.s.hostSeat); this.s.hostSeat = null; }
    this.changed();
  }
  feed(txt) { this.s.feed.unshift({ t: Date.now(), txt }); this.s.feed = this.s.feed.slice(0, 14); }
  async onMsg(d) {
    if (!d || typeof d !== 'object') return;
    if (d.type === 'join') return this.join(d);
    const seatId = this.cids[d.cid];
    if (!seatId) return;
    const p = this.s.players[seatId];
    if (d.type === 'ping') { p.seen = Date.now(); return; }
    if (!d.ct || !this.keys[seatId]) return;
    let a; try { a = await Crypt.dec(this.keys[seatId], d); } catch { return; }
    if (!(a.n > (this.lastN[seatId] || 0))) return; // replay guard
    this.lastN[seatId] = a.n; p.seen = Date.now();
    if (a.type === 'bet') this.bet(seatId, a.side, a.pct);
  }
  async join({ cid, name, pub, jn, proof }) {
    name = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 16);
    if (!name || !isCid(cid) || !isStr(jn, 16) || !isObj(pub)) return;
    // Proof of possession: `proof` is sealed with the ECDH key between `pub` and the host key, so only
    // the holder of pub's private half can make it. It names this cid, join and name, and its counter
    // must beat the seat's last one, so a join seen on the relay can't be replayed or re-pointed.
    let key, pf;
    try { key = await Crypt.derive(this.kp.privateKey, pub); pf = await Crypt.dec(key, proof); } catch { return; }
    if (!isObj(pf) || pf.cid !== cid || pf.jn !== jn || pf.name !== name || !isNum(pf.n, 1, Number.MAX_SAFE_INTEGER)) return;
    const s = this.s, now = Date.now();
    const ack = o => this.net.pub(`${this.T}/p/${cid}/ack`, { ...o, jn }, { retain: true, qos: 1 });
    let seat = Object.values(s.players).find(p => p.name.toLowerCase() === name.toLowerCase());
    // the proof shows this is the key holder, so it is safe to tell them which seat that key already has
    const owned = Object.values(s.players).find(p => !p.host && p.pub && p.pub.x === pub.x && p.pub.y === pub.y);
    if (owned && owned !== seat) return ack({ ok: false, err: `You're already at this table as ${owned.name}. Rejoin as ${owned.name}.` });
    if (this.cids[cid] && this.cids[cid] !== seat?.id) return; // someone else's cid: ignore quietly
    if (seat) {
      if (seat.host) return ack({ ok: false, err: `${name} is the host's name here. Pick another.` });
      // A seat is bound to the key that first took it. Only that key can rejoin; nobody can swap it out.
      if (seat.pub.x !== pub.x || seat.pub.y !== pub.y) return ack({ ok: false, err: `Someone named ${name} is already at this table. Pick another name.` });
      if (!(pf.n > (this.lastN[seat.id] || 0))) return;
    } else {
      if (s.phase === 'final') return ack({ ok: false, err: 'This game just ended. Ask the host to start a new one.' });
      if (s.order.length >= CFG.maxSeats) return ack({ ok: false, err: 'This table is full (8 players).' });
    }
    if (seat) {
      if (seat.cid !== cid) { delete this.cids[seat.cid]; seat.cid = cid; this.feed(`${seat.name} rejoined`); }
    } else {
      const id = rid(6);
      seat = { id, name, chips: CFG.startChips, busted: false, clv: 0, nb: 0, seen: now, cid, pub: { kty: 'EC', crv: 'P-256', x: pub.x, y: pub.y }, host: false };
      s.players[id] = seat; s.order.push(id); this.feed(`${name} joined`);
    }
    this.lastN[seat.id] = pf.n;
    seat.seen = now; this.cids[cid] = seat.id; this.keys[seat.id] = key;
    ack({ ok: true, seat: seat.id });
    if (s.phase === 'betting' && !seat.busted) {
      if (this.sec.reads[seat.id] == null) this.sec.reads[seat.id] = this.makeRead();
      this.sendRead(seat.id);
    }
    this.changed();
  }
  makeRead() { return clamp(Math.round(this.sec.P + normal() * CFG.readSd), 5, 95); }
  async sendRead(id) {
    const p = this.s.players[id];
    if (!p || p.host || !this.keys[id]) return;
    const box = await Crypt.enc(this.keys[id], { round: this.s.round, read: this.sec.reads[id] });
    this.net.pub(`${this.T}/p/${p.cid}/read`, box, { retain: true, qos: 1 });
  }
  tell(id, text) {
    const p = this.s.players[id]; if (!p) return;
    if (p.host) toast(text); else this.net.pub(`${this.T}/p/${p.cid}/msg`, { text, t: Date.now() }, { qos: 1 });
  }
  bet(id, side, pct) {
    const s = this.s, p = s.players[id], now = Date.now();
    if (!p || (side !== 'H' && side !== 'A')) return;
    if (s.phase !== 'betting' || now >= s.endsAt) return this.tell(id, 'Betting is closed for this round.');
    if (p.busted) return this.tell(id, "You're busted, so you're spectating.");
    pct = Math.round(Number(pct));
    if (!(pct >= CFG.minPct && pct <= CFG.maxPct)) return this.tell(id, 'Stakes are 1–25% of your chips.');
    if (s.bets.filter(b => b.seat === id).length >= CFG.maxBets) return this.tell(id, 'That was your 3rd bet. Max 3 per round.');
    const stake = Math.max(1, Math.floor(p.chips * pct / 100));
    if (stake > p.chips || p.chips < 1) return this.tell(id, 'Not enough chips.');
    const entry = s.line, move = Math.min(3, stake / 100);
    const after = r1(clamp(entry + (side === 'H' ? move : -move), 5, 95));
    const t = now - s.roundStart;
    p.chips -= stake; p.nb++; s.line = after;
    s.bets.push({ seat: id, side, stake, entry, after, t });
    s.history.push([t, after]);
    this.feed(`${p.name} bet ${side === 'H' ? 'Home' : 'Away'} ${fmt(stake)} · line ${entry.toFixed(1)} → ${after.toFixed(1)}`);
    this.changed();
  }
  startGame() {
    if (this.s.phase !== 'lobby' || this.s.order.length < 2) return;
    this.startRound();
  }
  startRound() {
    const s = this.s;
    s.round++;
    const h = Math.floor(rnd() * 8); let a = Math.floor(rnd() * 7); if (a >= h) a++;
    s.match = { home: h, away: a };
    this.sec.P = r1(25 + rnd() * 50); this.sec.reads = {};
    for (const id of s.order) if (!s.players[id].busted) this.sec.reads[id] = this.makeRead();
    s.line = 50; s.roundStart = Date.now(); s.history = [[0, 50]]; s.bets = [];
    s.endsAt = s.roundStart + s.betSecs * 1000; s.phase = 'betting'; s.reveal = null; this.lastDrift = s.roundStart;
    this.feed(`Round ${s.round}: ${teamFull(a)} at ${teamFull(h)}`);
    for (const id in this.sec.reads) this.sendRead(id);
    this.changed();
  }
  close() {
    const s = this.s, P = this.sec.P, close = s.line;
    const winner = rnd() * 100 < P ? 'H' : 'A';
    const results = {};
    for (const id of s.order) {
      const p = s.players[id];
      let staked = 0, ret = 0, clv = 0, n = 0;
      for (const b of s.bets) {
        if (b.seat !== id) continue;
        const q = b.side === 'H' ? b.entry / 100 : (100 - b.entry) / 100;
        b.clv = r1(b.side === 'H' ? close - b.entry : b.entry - close);
        b.won = b.side === winner;
        b.ret = b.won ? Math.round(b.stake / q) : 0;
        staked += b.stake; ret += b.ret; clv += b.clv; n++;
      }
      p.chips += ret; p.clv = r1(p.clv + clv);
      if (p.chips < CFG.bustAt && !p.busted) { p.busted = true; this.feed(`${p.name} is busted`); }
      results[id] = { staked, ret, pl: ret - staked, clv: r1(clv), n, read: this.sec.reads[id] ?? null };
    }
    s.reveal = { round: s.round, P, winner, close, results };
    s.phase = 'reveal'; s.nextAt = Date.now() + s.revealSecs * 1000;
    const w = winner === 'H' ? s.match.home : s.match.away;
    this.feed(`${teamFull(w)} win · true chance Home ${P.toFixed(1)}% · closed ${close.toFixed(1)}%`);
    this.changed();
  }
  advance() {
    const s = this.s;
    const alive = s.order.filter(id => !s.players[id].busted);
    if (s.round >= s.rounds || alive.length === 0) this.finish(); else this.startRound();
  }
  finish() {
    const s = this.s;
    const standings = [...s.order].sort((a, b) => (s.players[b].chips - s.players[a].chips) || (s.players[b].clv - s.players[a].clv));
    const bettors = s.order.filter(id => s.players[id].nb > 0);
    const sharpest = bettors.length ? bettors.reduce((a, b) => s.players[b].clv > s.players[a].clv ? b : a) : null;
    s.final = { standings, sharpest }; s.phase = 'final';
    this.feed(`Game over · ${s.players[standings[0]]?.name || '—'} wins`);
    this.changed();
  }
  playAgain() {
    const s = this.s;
    for (const id of s.order) Object.assign(s.players[id], { chips: CFG.startChips, busted: false, clv: 0, nb: 0 });
    Object.assign(s, { round: 0, final: null, reveal: null, phase: 'lobby', bets: [], history: [], match: null, line: 50 });
    this.feed('New game · waiting for the host to start');
    this.changed();
  }
  nextNow() { if (this.s.phase === 'reveal') this.s.nextAt = Date.now(); }
  tick() {
    const s = this.s, now = Date.now();
    if (s.hostSeat) s.players[s.hostSeat].seen = now;
    if (s.phase === 'betting') {
      if (now >= s.endsAt) this.close();
      else if (now - this.lastDrift >= CFG.driftMs) {
        this.lastDrift = now;
        const nl = r1(clamp(s.line + CFG.driftPull * (this.sec.P - s.line) + normal() * CFG.driftNoise, 5, 95));
        if (nl !== s.line) { s.line = nl; s.history.push([now - s.roundStart, nl]); this.changed(); }
      }
    } else if (s.phase === 'reveal' && now >= s.nextAt) this.advance();
    if ((this.dirty && now - this.lastPub > 120) || now - this.lastPub > 2500) this.publish();
  }
  publicState() {
    const s = this.s, now = Date.now();
    const players = s.order.map(id => {
      const p = s.players[id];
      return { id, name: p.name, chips: p.chips, busted: p.busted, clv: p.clv, host: !!p.host, online: p.host || now - p.seen < 12000, nb: s.bets.filter(b => b.seat === id).length };
    });
    const { players: _p, order: _o, ...rest } = s;
    return { ...rest, players, hostNow: now };
  }
  publish() {
    this.lastPub = Date.now(); this.dirty = false;
    const st = this.publicState();
    this.net.pub(this.T + '/state', st, { retain: true, qos: 0 });
    app.onState(st, true);
  }
  changed() {
    this.dirty = true;
    store.set('btc.host.' + this.room, { s: this.s, sec: this.sec, lastN: this.lastN, kjwk: this.kjwk });
    app.onState(this.publicState(), true);
  }
}

// ---------------------------------------------------------------- client
const app = {
  view: '', net: null, room: null, host: null, me: null, cid: null, kp: null, key: null, hostPub: null,
  st: null, offset: 0, lastStateAt: 0, myRead: null, pct: 10, n: 0, jn: null, busy: false, pendingUntil: 0,
  now() { return Date.now() + this.offset; },
  onState(raw, local) {
    const st = local ? raw : cleanState(raw); // the host's own state is trusted, anything from the relay is not
    if (!st || (!local && st.room !== this.room)) return;
    // the host key is pinned when we join; a state naming any other host key isn't from our host
    if (!local && this.hostPub && (st.hostPub.x !== this.hostPub.x || st.hostPub.y !== this.hostPub.y)) return;
    if (!local) {
      const off = st.hostNow - Date.now();
      this.offset = this.lastStateAt ? this.offset * 0.7 + off * 0.3 : off;
    }
    this.st = st; this.lastStateAt = Date.now();
    if (this.host) this.me = this.st.hostSeat;
    if (this.host && st.phase === 'betting') this.myRead = { round: st.round, read: this.host.sec.reads[this.me] ?? null };
    render();
  },
  async sendJoin() {
    const jn = this.jn = rid(6);
    this.n = Math.max(this.n + 1, Date.now());
    const proof = await Crypt.enc(this.key, { cid: this.cid, name: this.name, jn, n: this.n });
    this.net.pub(NS + this.room + '/toHost', { type: 'join', cid: this.cid, name: this.name, pub: this.kjwk.pub, jn, proof }, { qos: 1 });
  },
  async act(a) {
    if (this.host) { if (a.type === 'bet') this.host.bet(this.me, a.side, a.pct); return; }
    if (!this.key) return toast('Still connecting to the table…');
    this.n = Math.max(this.n + 1, Date.now());
    const box = await Crypt.enc(this.key, { ...a, n: this.n });
    this.net.pub(NS + this.room + '/toHost', { cid: this.cid, ...box }, { qos: 1 });
  },
};

async function onPrivate(t, d) {
  const base = NS + app.room + '/p/' + app.cid + '/';
  if (!t.startsWith(base)) return;
  const kind = t.slice(base.length);
  if (kind === 'ack') {
    if (!isObj(d) || d.jn !== app.jn || (d.ok && !isId(d.seat))) return;
    if (!d.ok) { app.me = null; store.del('btc.session'); leaveTo('home', d.err); return; }
    app.me = d.seat;
    store.set('btc.session', { room: app.room, name: app.name, b: app.net.b });
    render();
  } else if (kind === 'read') {
    if (!app.key) return;
    try {
      const r = await Crypt.dec(app.key, d);
      if (isObj(r) && isInt(r.round, 0, 50) && (r.read === null || isNum(r.read, 0, 100))) { app.myRead = { round: r.round, read: r.read }; render(); }
    } catch {}
  } else if (kind === 'msg') {
    if (isObj(d) && isStr(d.text, 200) && isNum(d.t, 0, MS) && Date.now() - d.t < 15000) toast(d.text);
  }
}

async function joinRoom(room, name, bHint) {
  room = room.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
  if (room.length !== 4) return showErr('Room codes are 4 letters.');
  if (!name) return showErr('Add your name.');
  showErr(''); setBusy('Finding the table…');
  const order = bHint != null && BROKERS[bHint] ? [bHint] : BROKERS.map((_, i) => i);
  let found = null, net = null;
  for (const i of order) {
    try { net = await connectBroker([i]); } catch { continue; }
    const st = await peekState(net, room, 3500);
    if (st) { found = st; break; }
    net.end(); net = null;
  }
  setBusy('');
  if (!found) { if (net) net.end(); return showErr(`No table found with code ${room}. Check the code with your host.`); }
  if (Date.now() - found.hostNow > 20 * 60 * 1000) toast('That table looks idle. It will wake up if the host comes back.');
  pref.set('btc.name', name);
  app.net = net; app.room = room; app.name = name; app.hostPub = found.hostPub;
  const idKey = 'btc.id.' + room;
  let ident = store.get(idKey);
  if (!ident) { const k = await Crypt.gen(); ident = { cid: rid(12), jwk: k.jwk }; store.set(idKey, ident); }
  const k = await Crypt.load(ident.jwk);
  app.cid = ident.cid; app.kp = k.kp; app.kjwk = k.jwk;
  net.on((t, d) => {
    if (t === NS + room + '/state') app.onState(d, false);
    else onPrivate(t, d);
  });
  net.sub(NS + room + '/p/' + app.cid + '/#');
  net.sub(NS + room + '/state');
  app.key = await Crypt.derive(app.kp.privateKey, found.hostPub);
  app.onState(found, false);
  app.sendJoin();
  ticker(() => { if (app.net?.up) app.net.pub(NS + room + '/toHost', { type: 'ping', cid: app.cid }); }, 5000);
  history.replaceState(null, '', location.pathname + '?room=' + room + (net.b ? '&b=' + net.b : '') + (FAST ? '&fast=1' : '') + (qs.get('broker') ? '&broker=' + encodeURIComponent(qs.get('broker')) : ''));
}

async function createRoom(name, plays) {
  if (!name) return showErr('Add your name.');
  showErr(''); setBusy('Opening a table…');
  let net;
  try { net = await connectBroker(BROKERS.map((_, i) => i)); } catch { setBusy(''); return showErr("Couldn't reach the game relay. Check your connection and try again."); }
  let room = code4();
  for (let tries = 0; tries < 4; tries++) {
    const st = await peekState(net, room, 1200);
    if (!st || Date.now() - st.hostNow > 6 * 3600 * 1000) break;
    room = code4();
  }
  pref.set('btc.name', name);
  const host = new Host(net, room);
  app.net = net; app.room = room; app.name = name; app.host = host;
  await host.create(name, plays);
  store.set('btc.session', { room, name, b: net.b, host: true });
  setBusy('');
  history.replaceState(null, '', location.pathname + '?room=' + room + (net.b ? '&b=' + net.b : '') + (FAST ? '&fast=1' : '') + (qs.get('broker') ? '&broker=' + encodeURIComponent(qs.get('broker')) : ''));
  render();
}

async function resumeHost(sess) {
  const saved = store.get('btc.host.' + sess.room);
  if (!saved) return false;
  setBusy('Reopening your table…');
  let net;
  try { net = await connectBroker([sess.b ?? 0, ...BROKERS.map((_, i) => i).filter(i => i !== (sess.b ?? 0))]); } catch { setBusy(''); return false; }
  const host = new Host(net, sess.room);
  app.net = net; app.room = sess.room; app.name = sess.name; app.host = host;
  await host.resume(saved);
  setBusy('');
  render();
  return true;
}

function leaveTo(view, err) {
  const wasHost = !!app.host;
  if (app.host) { app.host.stopTick?.(); store.del('btc.host.' + app.room); }
  store.del('btc.session');
  try { app.net?.end(); } catch {}
  location.href = location.pathname + (err ? '?msg=' + encodeURIComponent(err) : '') + (wasHost || !app.room ? '' : '');
}

// ---------------------------------------------------------------- ui helpers
let toastTimer;
function toast(t) { const el = $('#toast'); el.textContent = t; el.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 2800); }
function showErr(t) { const el = $('#err'); if (el) el.textContent = t || ''; }
function setBusy(t) { app.busyText = t; document.querySelectorAll('[data-form] button').forEach(b => { b.disabled = !!t; }); const el = $('#busy'); if (el) el.textContent = t; }
function paintConn() {
  const el = $('#conn'); if (!el) return;
  const hostStale = !app.host && app.lastStateAt && Date.now() - app.lastStateAt > 8000;
  el.className = 'dot ' + (app.net?.up ? (hostStale ? 'warn' : 'on') : 'warn');
  el.title = app.net?.up ? (hostStale ? 'Waiting for the host' : 'Connected') : 'Reconnecting…';
}
const shareLink = () => location.origin + location.pathname + '?room=' + app.room + (app.net?.b ? '&b=' + app.net.b : '') + (FAST ? '&fast=1' : '') + (qs.get('broker') ? '&broker=' + encodeURIComponent(qs.get('broker')) : '');
const P = id => app.st?.players.find(p => p.id === id);
const myPlayer = () => P(app.me);
const logo = (s = 56) => `<svg class="logo" width="${s}" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="7" fill="var(--card)" stroke="var(--line)"/><path d="M5 22 L11 16 L16 19 L22 10 L27 13" fill="none" stroke="var(--home)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><circle cx="22" cy="10" r="2.6" fill="var(--away)"/></svg>`;

function topbar() {
  const st = app.st;
  const round = st && st.round ? `<span class="pill">Round <b>${esc(st.round)}</b>/${esc(st.rounds)}</span>` : '';
  return `<header class="topbar">
    <div class="brand-sm">${logo(26)}<span class="full">Beat the</span><span>Close</span></div>
    ${round}<span class="pill"><span id="conn" class="dot"></span> ${esc(app.room || '')}</span>
    <button class="icon" data-act="rules" aria-label="How to play">?</button>
    <button class="icon" data-act="leave" aria-label="Leave table" title="Leave">⏻</button>
  </header><div id="hostwarn"></div>`;
}

// ---------------------------------------------------------------- views
function viewHome() {
  const q = (qs.get('room') || '').toUpperCase();
  const msg = qs.get('msg');
  const name = esc(pref.get('btc.name'));
  const join = `<form class="card" data-form="join">
      <h2>Join a table</h2><p class="muted">Got a code from a friend? Jump in.</p>
      <label for="jcode">Room code</label><input type="text" id="jcode" name="code" class="code-in" maxlength="4" autocomplete="off" autocapitalize="characters" spellcheck="false" value="${esc(q)}" placeholder="ABCD">
      <label for="jname">Your name</label><input type="text" id="jname" name="name" maxlength="16" autocomplete="nickname" value="${name}" placeholder="e.g. Sam">
      <button class="btn primary">Join table</button></form>`;
  const create = `<form class="card" data-form="create">
      <h2>Host a table</h2><p class="muted">Your device runs the game. Friends join on their phones with a 4-letter code or QR.</p>
      <label for="cname">Your name</label><input type="text" id="cname" name="name" maxlength="16" autocomplete="nickname" value="${name}" placeholder="e.g. Ian">
      <label class="check"><input type="checkbox" name="plays" checked> I'm playing too</label>
      <button class="btn ${q ? '' : 'primary'}">Create table</button></form>`;
  return `<main class="homepage">
    <header class="brand">${logo(64)}
      <h1>Beat the <span>Close</span></h1>
      <p class="tag">A live betting-market party game. Everyone gets a private scouting read, bets into one shared line, and finds out who was actually right.</p>
      <div class="ticker"><span>2–8 players</span><span>6 rounds · ~6 min</span><span>phones + laptops</span><span>no sign-up</span></div>
    </header>
    <section class="cards">${q ? join + create : create + join}</section>
    <p class="err" id="err">${esc(msg || '')}</p><p class="center muted" id="busy"></p>
    <p class="center"><button class="link" data-act="rules">How to play</button></p>
    <p class="foot">Teams are named after the rivers around Fairmont, West Virginia, where the Tygart Valley and West Fork meet to form the Mon.</p>
  </main>`;
}

function viewLobby() {
  const st = app.st, isHost = !!app.host;
  return `${topbar()}<div class="wrap"><div class="lobby">
    <section class="card roomcard">
      <div class="muted">Room code</div><div class="code">${esc(app.room)}</div>
      <div class="qr" id="qr" aria-label="QR code to join"></div>
      <div class="share"><input type="text" readonly id="link" value="${esc(shareLink())}" aria-label="Share link"><button class="btn" data-act="copy">Copy</button></div>
      <p class="muted" style="font-size:13px">Friends scan the QR or open the link, then add their name.</p>
    </section>
    <div class="col">
      <section class="card">
        <h2>At the table <span class="muted" id="pcount"></span></h2>
        <ul class="plist" id="plist"></ul>
        ${isHost ? `<label class="check"><input type="checkbox" id="plays" ${st.hostSeat ? 'checked' : ''}> I'm playing too</label>
          <button class="btn primary wide" style="margin-top:12px" id="startBtn" data-act="start">Start game</button>
          <p class="muted center" id="startHint" style="margin:8px 0 0"></p>
          <p class="muted" style="font-size:13px">You're the table. Keep this tab open while you play. If you refresh, the game picks up where it left off.</p>`
        : `<p class="muted">Waiting for <b>${esc(st.hostName)}</b> to start the game…</p>`}
      </section>
      <section class="card">
        <h3>The short version</h3>
        <ul class="quick">
          <li>You get a private <b>scouting read</b> on who wins. It's close to the truth, but not exact.</li>
          <li>Bet into one shared <b>line</b>. Every bet moves it, and it drifts toward the truth as the clock runs.</li>
          <li><b>Bet early</b> for a better price, or <b>wait</b> and read the market.</li>
          <li>Most chips after 6 rounds wins. Best <b>closing line value</b> is crowned Sharpest.</li>
        </ul>
        <p><button class="link" data-act="rules">Full rules</button></p>
      </section>
    </div></div></div>`;
}

function viewRound() {
  const st = app.st, m = st.match;
  const reveal = st.phase === 'reveal';
  return `${topbar()}<div class="wrap"><div class="game">
    <div class="col">
      <section class="card matchup">
        <div class="teams">
          <div class="team away"><span class="tagx">AWAY</span><b>${esc(TEAMS[m.away][1])}</b><small>${esc(TEAMS[m.away][0])}</small></div>
          <div class="at">@</div>
          <div class="team home"><span class="tagx">HOME</span><b>${esc(TEAMS[m.home][1])}</b><small>${esc(TEAMS[m.home][0])}</small></div>
        </div>
        ${reveal ? '' : `<div class="timer"><div class="bar"><i id="tbar"></i></div><span class="secs" id="tsec"></span></div>`}
      </section>
      ${reveal ? `<section class="card reveal" id="reveal"></section>` : ''}
      <section class="card market">
        <div class="prices">
          <div class="price home" id="pxH"><small>HOME</small><b id="lh"></b><span id="mh"></span></div>
          <div class="price away" id="pxA"><small>AWAY</small><b id="la"></b><span id="ma"></span></div>
        </div>
        <svg class="chart" id="chart" viewBox="0 0 340 140" role="img" aria-label="Line movement this round"></svg>
        <div class="legend"><span><i></i>Home line</span><span><i class="read"></i>your read</span>${reveal ? '<span><i class="true"></i>true chance</span>' : ''}<span>● bets</span></div>
      </section>
      ${reveal ? '' : `<section class="card ticket" id="ticket"></section>`}
    </div>
    <aside class="col">
      <section class="card"><h3>Table</h3><ol class="board" id="board"></ol></section>
      <section class="card"><h3>Market feed</h3><ul class="feed" id="feed"></ul></section>
    </aside></div></div>`;
}

function viewFinal() {
  const st = app.st, f = st.final;
  const champ = P(f.standings[0]);
  const sharp = f.sharpest ? P(f.sharpest) : null;
  const rows = f.standings.map((id, i) => {
    const p = P(id); if (!p) return '';
    return `<tr><td>${i + 1}. ${esc(p.name)}${id === app.me ? ' <span class="badge">you</span>' : ''}</td><td class="n">${fmt(p.chips)}</td><td class="n ${cls(p.clv)}">${sgn(p.clv)}</td><td class="n ${cls(p.chips - 1000)}">${sgn(p.chips - 1000, 0)}</td></tr>`;
  }).join('');
  return `${topbar()}<div class="wrap final">
    <section class="card champ"><div class="kicker">Final after ${esc(st.round)} round${st.round === 1 ? '' : 's'}</div>
      <h2>${esc(champ?.name || '—')}</h2><p class="muted">wins the table with <b class="mono">${fmt(champ?.chips || 0)}</b> chips</p></section>
    <div class="awards">
      <section class="card award"><small>Top stack</small><b>${esc(champ?.name || '—')}</b><span>${fmt(champ?.chips || 0)} chips</span></section>
      <section class="card award"><small>Sharpest · best CLV</small><b>${esc(sharp?.name || 'nobody bet')}</b><span>${sharp ? sgn(sharp.clv) + ' pts vs the close' : ''}</span></section>
    </div>
    <section class="card"><table class="results"><thead><tr><th>Player</th><th class="n">Chips</th><th class="n">CLV</th><th class="n">Net</th></tr></thead><tbody>${rows}</tbody></table>
      <p class="lesson">Chips tell you who got lucky. CLV tells you who read the market best. Over enough rounds, the second one becomes the first.</p>
      <div class="nextrow">${app.host ? `<button class="btn primary" data-act="again">Play again with this table</button>` : `<span class="muted">Waiting for the host to start a rematch…</span>`}
      <button class="btn" data-act="leave">Leave</button></div></section>
  </div>`;
}

// ---------------------------------------------------------------- render
function render() {
  const st = app.st;
  let view = 'home';
  if (app.room && st) view = st.phase === 'lobby' ? 'lobby' : st.phase === 'final' ? 'final' : `round-${st.round}-${st.phase}`;
  if (app.room && st && !app.host && !app.me) view = 'joining';
  if (view !== app.view) {
    app.view = view;
    const root = $('#app');
    if (view === 'home') root.innerHTML = viewHome();
    else if (view === 'joining') root.innerHTML = `${topbar()}<div class="wrap"><section class="card center"><h2>Joining ${esc(app.room)}…</h2><p class="muted">Saying hi to the table.</p></section></div>`;
    else if (view === 'lobby') { root.innerHTML = viewLobby(); drawQR(); }
    else if (view === 'final') root.innerHTML = viewFinal();
    else root.innerHTML = viewRound();
    window.scrollTo(0, 0);
    wake(view !== 'home' && view !== 'final' && !!app.host);
  }
  update();
}

function update() {
  paintConn();
  const st = app.st;
  if (!st || !app.room) return;
  const hw = $('#hostwarn');
  if (hw) {
    const stale = !app.host && app.lastStateAt && Date.now() - app.lastStateAt > 8000;
    hw.innerHTML = stale ? `<div class="banner">Waiting for ${esc(st.hostName)}'s device. The game resumes when the host is back.</div>` : '';
  }
  if (app.view === 'lobby') return updLobby();
  if (app.view.startsWith('round-')) return updRound();
}

function updLobby() {
  const st = app.st;
  $('#pcount').textContent = `(${st.players.length}/8)`;
  $('#plist').innerHTML = st.players.map(p => `<li><span class="dot ${p.online ? 'on' : ''}"></span><b>${esc(p.name)}</b>${p.id === app.me ? '<span class="you">YOU</span>' : ''}<span class="role">${p.host ? 'host' : p.online ? 'ready' : 'away'}</span></li>`).join('')
    || '<li class="muted">Nobody yet. Share the code.</li>';
  if (app.host) {
    const n = st.players.length, btn = $('#startBtn');
    btn.disabled = n < 2;
    $('#startHint').textContent = n < 2 ? 'Need at least 2 players to start.' : `${n} players ready.`;
  }
}

function updRound() {
  const st = app.st, now = app.now(), betting = st.phase === 'betting';
  const me = myPlayer();
  // prices
  const lh = $('#lh'), la = $('#la');
  const newH = st.line.toFixed(1) + '%';
  if (lh.textContent && lh.textContent !== newH) { for (const el of [$('#pxH'), $('#pxA')]) { el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); } }
  lh.textContent = newH; la.textContent = (100 - st.line).toFixed(1) + '%';
  $('#mh').textContent = `pays ${payMult('H', st.line).toFixed(2)}×`;
  $('#ma').textContent = `pays ${payMult('A', st.line).toFixed(2)}×`;
  // timer
  if (betting) {
    const left = Math.max(0, st.endsAt - now), frac = left / (st.betSecs * 1000);
    const bar = $('#tbar'); bar.style.transform = `scaleX(${clamp(frac, 0, 1)})`; bar.classList.toggle('hot', left < 10000);
    $('#tsec').textContent = Math.ceil(left / 1000) + 's';
  }
  drawChart();
  // board
  const sorted = [...st.players].sort((a, b) => (b.chips - a.chips) || (b.clv - a.clv));
  $('#board').innerHTML = sorted.map((p, i) => {
    const pips = betting && !p.busted ? `<span class="pips">${[0, 1, 2].map(k => `<i class="${k < p.nb ? 'used' : ''}"></i>`).join('')}</span>` : '';
    return `<li class="${p.id === app.me ? 'me' : ''} ${p.busted ? 'busted' : ''}"><span class="rk">${i + 1}</span><span class="nm"><span class="dot ${p.online ? 'on' : ''}"></span> ${esc(p.name)}</span><span class="ch">${fmt(p.chips)}</span>
      <span class="sub"><span>CLV <b class="${cls(p.clv)}">${sgn(p.clv)}</b></span>${p.busted ? '<span>busted</span>' : pips}</span></li>`;
  }).join('');
  $('#feed').innerHTML = st.feed.slice(0, 10).map(f => `<li>${esc(f.txt)}</li>`).join('');
  if (betting) updTicket(me);
  else updReveal();
}

function updTicket(me) {
  const st = app.st, el = $('#ticket');
  if (!me || me.busted) {
    const why = !me ? (app.host ? "You're hosting without a seat. Enjoy the show." : 'Joining…') : "You're busted. Watch how the market moves.";
    if (el.dataset.mode !== 'spect') { el.dataset.mode = 'spect'; el.innerHTML = `<div class="spect">${why}</div>`; }
    return;
  }
  if (el.dataset.mode !== 'bet') {
    el.dataset.mode = 'bet';
    el.innerHTML = `<div class="read">Your scouting read <b id="myread">…</b><small>only you can see this</small></div>
      <div class="kelly" id="kelly"></div>
      <label class="stake" for="pct">Stake <b id="stakeAmt"></b> chips <span class="muted">(<span id="pctLbl"></span>% of <span id="myChips"></span>)</span></label>
      <input type="range" id="pct" min="1" max="25" step="1" value="${app.pct}">
      <div class="betbtns">
        <button class="bet home" data-act="bet" data-side="H"><span>Bet Home</span><small id="payH"></small></button>
        <button class="bet away" data-act="bet" data-side="A"><span>Bet Away</span><small id="payA"></small></button>
      </div>
      <div class="betsleft"><span id="betsleft"></span><span class="pips" id="mypips"></span></div>
      <ul class="mybets" id="mybets"></ul>`;
    $('#pct').addEventListener('input', e => { app.pct = +e.target.value; updTicket(myPlayer()); });
  }
  const read = app.myRead && app.myRead.round === st.round ? app.myRead.read : null;
  $('#myread').textContent = read == null ? '…' : `Home ${read}%`;
  const stake = Math.max(1, Math.floor(me.chips * app.pct / 100));
  $('#stakeAmt').textContent = fmt(stake); $('#pctLbl').textContent = app.pct; $('#myChips').textContent = fmt(me.chips);
  $('#payH').textContent = `@ ${st.line.toFixed(1)}% · returns ${fmt(stake * payMult('H', st.line))}`;
  $('#payA').textContent = `@ ${(100 - st.line).toFixed(1)}% · returns ${fmt(stake * payMult('A', st.line))}`;
  const mine = st.bets.filter(b => b.seat === app.me);
  const left = 3 - mine.length, closed = app.now() >= st.endsAt, pending = Date.now() < app.pendingUntil;
  document.querySelectorAll('#ticket .bet').forEach(b => { b.disabled = left <= 0 || closed || pending || me.chips < 1; });
  $('#betsleft').textContent = left > 0 ? `${left} bet${left === 1 ? '' : 's'} left this round` : 'All 3 bets placed. Sweat the close.';
  $('#mypips').innerHTML = [0, 1, 2].map(k => `<i class="${k < mine.length ? 'used' : ''}"></i>`).join('');
  $('#mybets').innerHTML = mine.map(b => {
    const cur = b.side === 'H' ? st.line - b.entry : b.entry - st.line;
    return `<li><b class="${b.side === 'H' ? 'hc' : 'ac'}">${b.side === 'H' ? 'Home' : 'Away'}</b> ${fmt(b.stake)} @ ${(b.side === 'H' ? b.entry : 100 - b.entry).toFixed(1)}% · to win ${fmt(b.stake * payMult(b.side, b.entry))} · <span class="${cls(cur)}">${sgn(cur)} vs line now</span></li>`;
  }).join('');
  // edge + Kelly
  const k = $('#kelly');
  if (read == null) { k.innerHTML = ''; return; }
  const r = read / 100, q = st.line / 100;
  const side = r > q ? 'H' : 'A';
  const edge = Math.abs(read - st.line);
  const kelly = side === 'H' ? (r - q) / (1 - q) : (q - r) / q;
  const half = clamp(Math.round(kelly * 50), 1, 25);
  const k0 = `${side}|${edge.toFixed(1)}|${half}`;
  if (k.dataset.k === k0) return; k.dataset.k = k0;
  k.innerHTML = edge < 0.5
    ? `<span>Your read matches the line. No edge right now, and waiting costs nothing.</span>`
    : `<span>Your read says <b class="${side === 'H' ? 'hc' : 'ac'}">${side === 'H' ? 'Home' : 'Away'}</b> is underpriced by <b>${edge.toFixed(1)} pts</b>. Kelly says ${fmt(kelly * 100)}%, half-Kelly <b>${half}%</b>.</span><button class="btn" data-act="halfk" data-v="${half}">Use ${half}%</button>`;
}

function updReveal() {
  const st = app.st, rv = st.reveal, el = $('#reveal');
  if (!rv) return;
  const winTeam = rv.winner === 'H' ? st.match.home : st.match.away;
  const myRes = rv.results[app.me];
  if (!el.dataset.done) {
    el.dataset.done = '1';
    const rows = st.players.map(p => {
      const r = rv.results[p.id]; if (!r) return '';
      const bl = st.bets.filter(b => b.seat === p.id).map(b => `${b.side === 'H' ? 'H' : 'A'} ${fmt(b.stake)}@${(b.side === 'H' ? b.entry : 100 - b.entry).toFixed(1)} <span class="${cls(b.clv)}">${sgn(b.clv)}</span>${b.won ? ' ✓' : ' ✗'}`).join(' · ');
      return `<tr><td><b>${esc(p.name)}</b>${r.clv > 0 ? '<span class="badge">beat the close</span>' : ''}<span class="bl">${bl || 'no bets'}</span></td>
        <td class="n">${r.read == null ? '—' : esc(r.read) + '%'}</td><td class="n ${cls(r.clv)}">${r.n ? sgn(r.clv) : '—'}</td><td class="n ${cls(r.pl)}">${r.n ? sgn(r.pl, 0) : '—'}</td></tr>`;
    }).join('');
    let lesson = 'Positive CLV means you got a better price than where the market closed. Do that every round and the chips follow.';
    if (myRes && myRes.n) {
      if (myRes.clv > 0 && myRes.pl < 0) lesson = `You lost this one but beat the close by ${myRes.clv.toFixed(1)} pts. You were right about the price. The result just didn't land.`;
      else if (myRes.clv < 0 && myRes.pl > 0) lesson = `You won ${fmt(myRes.pl)}, but the market closed ${Math.abs(myRes.clv).toFixed(1)} pts against your price. That was luck, and luck doesn't last.`;
      else if (myRes.clv > 0) lesson = `You beat the close by ${myRes.clv.toFixed(1)} pts and got paid. That's the whole game.`;
      else if (myRes.clv < 0) lesson = `The market closed ${Math.abs(myRes.clv).toFixed(1)} pts against you. Next time, bet earlier when your read disagrees with the line.`;
    }
    el.innerHTML = `<div class="kicker">Round ${esc(rv.round)} result</div>
      <h2 class="winner"><span class="${rv.winner === 'H' ? 'hc' : 'ac'}">${esc(TEAMS[winTeam][1])}</span> win</h2>
      <div class="facts"><div><small>True chance</small><b>Home ${esc(rv.P.toFixed(1))}%</b></div><div><small>Closing line</small><b>Home ${esc(rv.close.toFixed(1))}%</b></div>
        <div><small>Your read</small><b>${myRes && myRes.read != null ? 'Home ' + esc(myRes.read) + '%' : '—'}</b></div></div>
      <table class="results"><thead><tr><th>Player</th><th class="n">Read</th><th class="n">CLV</th><th class="n">Net</th></tr></thead><tbody>${rows}</tbody></table>
      <p class="lesson">${esc(lesson)}</p>
      <div class="nextrow"><span class="muted" id="nextIn"></span>${app.host ? '<button class="btn primary" data-act="next">Next now</button>' : ''}</div>`;
  }
  const s = Math.max(0, Math.ceil((st.nextAt - app.now()) / 1000));
  $('#nextIn').textContent = st.round >= st.rounds ? `Final standings in ${s}s` : `Round ${st.round + 1} starts in ${s}s`;
}

function drawChart() {
  const st = app.st, svg = $('#chart'); if (!svg) return;
  const W = Math.max(280, Math.round(svg.clientWidth || 340)), H = W > 520 ? 190 : 150, L = 30, R = 8, T = 10, B = 18, span = st.betSecs * 1000;
  if (svg.getAttribute('viewBox') !== `0 0 ${W} ${H}`) svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const reveal = st.phase === 'reveal' ? st.reveal : null;
  const read = app.myRead && app.myRead.round === st.round ? app.myRead.read : (reveal?.results[app.me]?.read ?? null);
  const hist = st.history.length ? st.history : [[0, 50]];
  const vals = hist.map(h => h[1]); if (read != null) vals.push(read); if (reveal) vals.push(reveal.P);
  let lo = Math.max(0, Math.floor((Math.min(...vals) - 4) / 5) * 5), hi = Math.min(100, Math.ceil((Math.max(...vals) + 4) / 5) * 5);
  if (hi - lo < 20) { const mid = (hi + lo) / 2; lo = Math.max(0, Math.round(mid - 10)); hi = Math.min(100, lo + 20); }
  const x = t => L + (W - L - R) * clamp(t / span, 0, 1);
  const y = v => T + (H - T - B) * (1 - (v - lo) / (hi - lo));
  let d = `M${x(hist[0][0])},${y(hist[0][1])}`;
  for (let i = 1; i < hist.length; i++) d += ` L${x(hist[i][0]).toFixed(1)},${y(hist[i - 1][1]).toFixed(1)} L${x(hist[i][0]).toFixed(1)},${y(hist[i][1]).toFixed(1)}`;
  const tEnd = st.phase === 'betting' ? clamp(app.now() - st.roundStart, 0, span) : span;
  d += ` L${x(tEnd).toFixed(1)},${y(hist[hist.length - 1][1]).toFixed(1)}`;
  const ticks = []; for (let v = lo; v <= hi; v += (hi - lo > 40 ? 10 : 5)) ticks.push(v);
  let g = ticks.map(v => `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)" stroke-width="1"/><text x="${L - 4}" y="${y(v) + 3}" text-anchor="end">${v}</text>`).join('');
  g += `<text x="${L}" y="${H - 4}">0s</text><text x="${W - R}" y="${H - 4}" text-anchor="end">${esc(st.betSecs)}s</text>`;
  if (read != null) g += `<line x1="${L}" x2="${W - R}" y1="${y(read)}" y2="${y(read)}" stroke="var(--accent)" stroke-width="1.5" stroke-dasharray="5 4"/><text x="${W - R - 2}" y="${y(read) - 4}" text-anchor="end" style="fill:var(--accent)">you ${esc(read)}</text>`;
  if (reveal) g += `<line x1="${L}" x2="${W - R}" y1="${y(reveal.P)}" y2="${y(reveal.P)}" stroke="var(--pos)" stroke-width="2" stroke-dasharray="2 3"/><text x="${L + 4}" y="${y(reveal.P) - 4}" style="fill:var(--pos)">true ${esc(reveal.P.toFixed(1))}</text>`;
  g += `<path d="${d}" fill="none" stroke="var(--text)" stroke-width="2.2" stroke-linejoin="round"/>`;
  g += st.bets.map(b => `<circle cx="${x(b.t).toFixed(1)}" cy="${y(b.entry).toFixed(1)}" r="${b.seat === app.me ? 5.5 : 4}" fill="${b.side === 'H' ? 'var(--home)' : 'var(--away)'}" stroke="${b.seat === app.me ? 'var(--text)' : 'var(--card)'}" stroke-width="1.5"/>`).join('');
  if (st.phase === 'betting') g += `<circle cx="${x(tEnd).toFixed(1)}" cy="${y(hist[hist.length - 1][1]).toFixed(1)}" r="3.5" fill="var(--text)"/>`;
  svg.innerHTML = g;
}

function drawQR() {
  const el = $('#qr'); if (!el || typeof qrcode !== 'function') return;
  try { const q = qrcode(0, 'M'); q.addData(shareLink()); q.make(); el.innerHTML = q.createSvgTag({ cellSize: 4, margin: 0, scalable: true }); } catch { el.remove(); }
}

let wakeLock = null;
async function wake(on) {
  try {
    if (on && !wakeLock && navigator.wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); }
    if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch {}
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && app.host) { wakeLock = null; wake(true); } });

// ---------------------------------------------------------------- events
document.addEventListener('submit', e => {
  const f = e.target.closest('[data-form]'); if (!f) return;
  e.preventDefault();
  const name = (f.name.value || '').replace(/\s+/g, ' ').trim().slice(0, 16);
  if (f.dataset.form === 'join') joinRoom(f.code.value, name, qs.get('b') != null ? +qs.get('b') : null);
  else createRoom(name, f.plays.checked);
});
document.addEventListener('input', e => {
  if (e.target.id === 'jcode') e.target.value = e.target.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
});
document.addEventListener('change', e => { if (e.target.id === 'plays' && app.host) app.host.setPlays(e.target.checked); });
document.addEventListener('click', async e => {
  const b = e.target.closest('[data-act]'); if (!b) return;
  const act = b.dataset.act;
  if (act === 'rules') $('#rules').showModal();
  else if (act === 'leave') {
    if (confirm(app.host ? 'Close this table? The game ends for everyone.' : 'Leave this table? You can rejoin with the same name.')) leaveTo('home');
  } else if (act === 'copy') {
    const link = shareLink();
    try { await navigator.clipboard.writeText(link); toast('Link copied'); } catch { $('#link').select(); toast('Copy the highlighted link'); }
  } else if (act === 'start') app.host?.startGame();
  else if (act === 'next') app.host?.nextNow();
  else if (act === 'again') app.host?.playAgain();
  else if (act === 'halfk') { app.pct = +b.dataset.v; const r = $('#pct'); if (r) r.value = app.pct; updTicket(myPlayer()); }
  else if (act === 'bet') {
    if (Date.now() < app.pendingUntil) return;
    app.pendingUntil = Date.now() + 700;
    await app.act({ type: 'bet', side: b.dataset.side, pct: app.pct });
    updTicket(myPlayer());
    setTimeout(() => updTicket(myPlayer()), 750);
  }
});
setInterval(() => { if (app.st && app.room) update(); }, 250);

// ---------------------------------------------------------------- boot
(async function boot() {
  if (typeof mqtt === 'undefined') { $('#app').innerHTML = '<p class="boot">Could not load the game engine. Refresh to try again.</p>'; return; }
  const sess = store.get('btc.session');
  const urlRoom = (qs.get('room') || '').toUpperCase();
  if (sess && (!urlRoom || urlRoom === sess.room)) {
    if (sess.host) { if (await resumeHost(sess)) return; store.del('btc.session'); }
    else { render(); await joinRoom(sess.room, sess.name, sess.b); if (app.room) return; }
  }
  render();
  const n = $(urlRoom ? '#jname' : '#cname'); if (n && !n.value) n.focus();
})();

window.__btc = app; // handy for debugging in the console (never exposes the host's secret to players)
})();
