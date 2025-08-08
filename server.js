const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Allow setting via env; we will auto-fallback on conflicts
const START_PORT = parseInt(process.env.PORT, 10) || 3000;

app.use(express.static(path.join(__dirname, 'public')));

// Constants
const TICK_RATE = 60; // ticks per second
const WORLD = { width: 2400, height: 1800 };
const PLAYER_RADIUS = 16;
const PLAYER_SPEED = 240; // units per second
const BULLET_SPEED = 620;
const BULLET_RADIUS = 4;
const BULLET_LIFETIME_MS = 1200;

// Enemy base
const ENEMY_TYPES = {
  chaser: { radius: 16, baseHp: 3, baseSpeed: 120 },
  dasher: { radius: 18, baseHp: 4, baseSpeed: 90 },
  orbiter: { radius: 14, baseHp: 3, baseSpeed: 130 },
  splitter: { radius: 16, baseHp: 2, baseSpeed: 100 },
  sniper: { radius: 15, baseHp: 2, baseSpeed: 110 },
  mini: { radius: 10, baseHp: 1, baseSpeed: 170 }, // from splitter
};

// Utilities
function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function dist(x1, y1, x2, y2) { return Math.hypot(x2 - x1, y2 - y1); }
function length(x, y) { return Math.hypot(x, y); }
function normalize(x, y) { const l = length(x, y); return l === 0 ? { x: 0, y: 0 } : { x: x / l, y: y / l }; }
function lerp(a, b, t) { return a + (b - a) * t; }
function randomInWorld() { return { x: Math.random() * WORLD.width, y: Math.random() * WORLD.height }; }
function circleCollide(x1, y1, r1, x2, y2, r2) { const dx = x1 - x2; const dy = y1 - y2; const rr = r1 + r2; return dx * dx + dy * dy <= rr * rr; }
function choice(arr) { return arr[(Math.random() * arr.length) | 0]; }

// Rooms
/** @typedef {{ id:string, settings:{ maxPlayers:number, difficulty:string }, players:Record<string,any>, bullets:any[], monsters:any[], neutrals:any[], powerups:any[], bombs:any[], effects:any[], lastSpawnAt:number, lastPowerAt:number, lastNeutralAt:number, world:any }} Room */
const rooms = new Map();

function createRoom(roomId, settings) {
  /** @type {Room} */
  const room = {
    id: roomId,
    settings: { maxPlayers: settings.maxPlayers || 1, difficulty: settings.difficulty || 'Normal' },
    players: {},
    bullets: [],
    monsters: [],
    neutrals: [],
    powerups: [],
    bombs: [],
    effects: [],
    lastSpawnAt: 0,
    lastPowerAt: 0,
    lastNeutralAt: 0,
    world: { ...WORLD },
  };
  rooms.set(roomId, room);
  return room;
}

function getOrCreateRoom(roomId, settings) {
  return rooms.get(roomId) || createRoom(roomId, settings);
}

function countPlayers(room) { return Object.keys(room.players).length; }

function scaleForPlayers(room) {
  const n = Math.max(1, countPlayers(room));
  const f = 1 + 0.35 * (n - 1); // stronger with more players
  return { n, factor: f };
}

function spawnMonster(room, type) {
  const { n } = scaleForPlayers(room);
  const MONSTER_MAX_BASE = 16;
  const cap = MONSTER_MAX_BASE + (n - 1) * 10;
  if (room.monsters.length >= cap) return;

  const pos = randomInWorld();
  const chosenType = type || choice(['chaser', 'dasher', 'orbiter', 'splitter', 'sniper']);
  const spec = ENEMY_TYPES[chosenType];
  const { factor } = scaleForPlayers(room);
  const hp = Math.round(spec.baseHp * Math.sqrt(factor));
  room.monsters.push({
    id: uuidv4(),
    type: chosenType,
    x: pos.x,
    y: pos.y,
    vx: 0,
    vy: 0,
    radius: spec.radius,
    hp,
    maxHp: hp,
    baseSpeed: spec.baseSpeed * (0.75 + 0.25 * factor),
    state: {},
  });
}

function spawnNeutral(room) {
  if (room.neutrals.length >= 12) return;
  const pos = randomInWorld();
  room.neutrals.push({
    id: uuidv4(),
    x: pos.x, y: pos.y, r: 12, hp: 2, maxHp: 2, vx: 0, vy: 0, wanderT: Math.random() * 3,
  });
}

function spawnPowerup(room) {
  if (room.powerups.length >= 8) return;
  const pos = randomInWorld();
  const types = ['speed', 'firerate', 'multishot', 'heal', 'shield'];
  const type = choice(types);
  room.powerups.push({
    id: uuidv4(), type, x: pos.x, y: pos.y, r: 12, expiresAt: Date.now() + 45_000,
  });
}

io.on('connection', (socket) => {
  socket.on('join', (data) => {
    const roomId = String(data?.roomId || 'default');
    const settings = data?.settings || { maxPlayers: 1, difficulty: 'Normal' };
    const room = getOrCreateRoom(roomId, settings);

    if (countPlayers(room) >= room.settings.maxPlayers) {
      socket.emit('joinDenied', { reason: 'Room full' });
      return;
    }

    socket.join(roomId);
    socket.data.roomId = roomId;

    const spawn = randomInWorld();
    room.players[socket.id] = {
      id: socket.id,
      x: spawn.x,
      y: spawn.y,
      dirX: 1,
      dirY: 0,
      up: false,
      down: false,
      left: false,
      right: false,
      shooting: false,
      lastShotAt: 0,
      color: `hsl(${Math.floor(Math.random() * 360)}, 70%, 55%)`,
      kills: 0,
      radius: PLAYER_RADIUS,
      buffs: { speed: 1, firerate: 1, multishot: 1, shieldUntil: 0 },
      abilityCd: { burst: 0, dash: 0, grenade: 0, beam: 0 },
      dashingUntil: 0,
      iFramesUntil: 0,
    };

    socket.emit('init', {
      id: socket.id,
      world: room.world,
      roomId,
      settings: room.settings,
    });
  });

  socket.on('input', (data) => {
    const room = rooms.get(socket.data.roomId);
    if (!room) return;
    const p = room.players[socket.id];
    if (!p) return;
    p.up = !!data.up;
    p.down = !!data.down;
    p.left = !!data.left;
    p.right = !!data.right;
    p.shooting = !!data.shooting;
    if (typeof data.angle === 'number' && isFinite(data.angle)) {
      p.dirX = Math.cos(data.angle);
      p.dirY = Math.sin(data.angle);
    }
  });

  socket.on('ability', (data) => {
    const room = rooms.get(socket.data.roomId);
    if (!room) return;
    const p = room.players[socket.id];
    if (!p) return;
    useAbility(room, p, String(data?.type || ''), Date.now());
  });

  socket.on('disconnect', () => {
    const room = rooms.get(socket.data.roomId);
    if (!room) return;
    delete room.players[socket.id];
    setTimeout(() => {
      const r = rooms.get(socket.data.roomId);
      if (r && countPlayers(r) === 0) {
        rooms.delete(r.id);
      }
    }, 10_000);
  });
});

function tryShoot(room, p, now) {
  const baseCooldown = 160;
  const SHOT_COOLDOWN_MS = baseCooldown / p.buffs.firerate;
  if (!p.shooting) return;
  if (now - p.lastShotAt < SHOT_COOLDOWN_MS) return;
  p.lastShotAt = now;

  const count = p.buffs.multishot;
  const spread = Math.min(0.35, 0.08 * (count - 1));
  for (let i = 0; i < count; i++) {
    const t = count === 1 ? 0 : (i / (count - 1)) * 2 - 1; // -1..1
    const angle = Math.atan2(p.dirY, p.dirX) + spread * t;
    const dirX = Math.cos(angle);
    const dirY = Math.sin(angle);
    room.bullets.push({
      id: uuidv4(),
      x: p.x + dirX * (PLAYER_RADIUS + BULLET_RADIUS + 1),
      y: p.y + dirY * (PLAYER_RADIUS + BULLET_RADIUS + 1),
      vx: dirX * BULLET_SPEED,
      vy: dirY * BULLET_SPEED,
      createdAt: now,
      ownerId: p.id,
      radius: BULLET_RADIUS,
    });
  }
}

function nearestPlayer(room, from) {
  let target = null;
  let best = Infinity;
  for (const id in room.players) {
    const p = room.players[id];
    const d = dist(from.x, from.y, p.x, p.y);
    if (d < best) { best = d; target = p; }
  }
  return target;
}

function updateEnemies(room, dt, now) {
  for (let i = room.monsters.length - 1; i >= 0; i--) {
    const m = room.monsters[i];
    const p = nearestPlayer(room, m);
    const speed = m.baseSpeed;
    if (!p) continue;

    switch (m.type) {
      case 'chaser': {
        const to = normalize(p.x - m.x, p.y - m.y);
        m.vx = lerp(m.vx, to.x * speed, 0.08);
        m.vy = lerp(m.vy, to.y * speed, 0.08);
        m.x += m.vx * dt;
        m.y += m.vy * dt;
        break;
      }
      case 'dasher': {
        const st = m.state;
        if (!st.mode) { st.mode = 'windup'; st.timer = 0; }
        st.timer += dt;
        if (st.mode === 'windup') {
          const to = normalize(p.x - m.x, p.y - m.y);
          const tangent = { x: -to.y, y: to.x };
          m.x += (to.x * 40 + tangent.x * 70) * dt;
          m.y += (to.y * 40 + tangent.y * 70) * dt;
          if (st.timer > 0.8) {
            st.mode = 'dash';
            st.timer = 0;
            const dir = normalize(p.x - m.x, p.y - m.y);
            st.dx = dir.x; st.dy = dir.y;
          }
        } else if (st.mode === 'dash') {
          const dashSpeed = speed * 3.2;
          m.x += st.dx * dashSpeed * dt;
          m.y += st.dy * dashSpeed * dt;
          if (st.timer > 0.28) { st.mode = 'windup'; st.timer = 0; }
        }
        break;
      }
      case 'orbiter': {
        const st = m.state;
        const desired = 160 + 40 * Math.sin(now / 500 + (st.seed || 0));
        const d = dist(m.x, m.y, p.x, p.y);
        const to = normalize(p.x - m.x, p.y - m.y);
        const tangent = { x: -to.y, y: to.x };
        const inward = (d - desired);
        m.x += (tangent.x * speed + to.x * (-inward * 0.8)) * dt;
        m.y += (tangent.y * speed + to.y * (-inward * 0.8)) * dt;
        break;
      }
      case 'splitter': {
        const st = m.state;
        if (!st.cool) st.cool = 0;
        st.cool -= dt;
        if (st.cool <= 0) {
          const to = normalize(p.x - m.x, p.y - m.y);
          const rand = normalize(Math.random() - 0.5, Math.random() - 0.5);
          m.vx = (to.x * 0.8 + rand.x * 0.4) * speed * 2.0;
          m.vy = (to.y * 0.8 + rand.y * 0.4) * speed * 2.0;
          st.cool = 0.6;
        }
        m.x += m.vx * dt;
        m.y += m.vy * dt;
        m.vx *= 0.86; m.vy *= 0.86;
        break;
      }
      case 'sniper': {
        const d = dist(m.x, m.y, p.x, p.y);
        const to = normalize(p.x - m.x, p.y - m.y);
        const tangent = { x: -to.y, y: to.x };
        const desired = 420;
        const away = (desired - d);
        m.x += (tangent.x * speed * 1.1 + to.x * (-away * 0.8)) * dt;
        m.y += (tangent.y * speed * 1.1 + to.y * (-away * 0.8)) * dt;
        break;
      }
      case 'mini': {
        const to = normalize(p.x - m.x, p.y - m.y);
        m.x += to.x * speed * dt;
        m.y += to.y * speed * dt;
        break;
      }
    }

    // Keep in bounds
    m.x = clamp(m.x, m.radius, room.world.width - m.radius);
    m.y = clamp(m.y, m.radius, room.world.height - m.radius);
  }
}

function applyPowerup(p, type, now) {
  switch (type) {
    case 'speed': p.buffs.speed = Math.min(1.8, p.buffs.speed + 0.3); setTimeout(() => { p.buffs.speed = Math.max(1, p.buffs.speed - 0.3); }, 10_000); break;
    case 'firerate': p.buffs.firerate = Math.min(2.0, p.buffs.firerate + 0.4); setTimeout(() => { p.buffs.firerate = Math.max(1, p.buffs.firerate - 0.4); }, 10_000); break;
    case 'multishot': p.buffs.multishot = Math.min(5, p.buffs.multishot + 1); setTimeout(() => { p.buffs.multishot = Math.max(1, p.buffs.multishot - 1); }, 12_000); break;
    case 'heal': p.kills += 1; break;
    case 'shield': p.buffs.shieldUntil = Math.max(p.buffs.shieldUntil, now + 6000); break;
  }
}

function useAbility(room, p, type, now) {
  const cd = p.abilityCd;
  switch (type) {
    case 'burst': {
      const COOLDOWN = 3000;
      if (now < cd.burst) return;
      cd.burst = now + COOLDOWN;
      const base = Math.atan2(p.dirY, p.dirX);
      const num = 9; const span = Math.PI / 2.4; // wide cone
      for (let i = 0; i < num; i++) {
        const t = num === 1 ? 0 : (i / (num - 1)) * 2 - 1;
        const a = base + t * span * 0.5;
        const dx = Math.cos(a), dy = Math.sin(a);
        room.bullets.push({ id: uuidv4(), x: p.x + dx * 20, y: p.y + dy * 20, vx: dx * (BULLET_SPEED * 0.9), vy: dy * (BULLET_SPEED * 0.9), createdAt: now, ownerId: p.id, radius: BULLET_RADIUS + 1 });
      }
      break;
    }
    case 'dash': {
      const COOLDOWN = 6000;
      if (now < cd.dash) return;
      cd.dash = now + COOLDOWN;
      // trail effect
      const before = { x: p.x, y: p.y };
      p.dashingUntil = now + 240;
      p.iFramesUntil = now + 360;
      p.x += p.dirX * 60; p.y += p.dirY * 60;
      room.effects.push({ id: uuidv4(), type: 'dash', x1: before.x, y1: before.y, x2: p.x, y2: p.y, until: now + 220 });
      break;
    }
    case 'grenade': {
      const COOLDOWN = 5000;
      if (now < cd.grenade) return;
      cd.grenade = now + COOLDOWN;
      const dx = p.dirX, dy = p.dirY;
      room.bombs.push({ id: uuidv4(), x: p.x + dx * 20, y: p.y + dy * 20, vx: dx * 260, vy: dy * 260, explodeAt: now + 900, radius: 120, ownerId: p.id });
      break;
    }
    case 'beam': {
      const COOLDOWN = 8000;
      if (now < cd.beam) return;
      cd.beam = now + COOLDOWN;
      const x1 = p.x, y1 = p.y;
      const x2 = p.x + p.dirX * 800, y2 = p.y + p.dirY * 800;
      const thickness = 18;
      for (let i = room.monsters.length - 1; i >= 0; i--) {
        const m = room.monsters[i];
        const A = { x: x1, y: y1 }, B = { x: x2, y: y2 }, P = { x: m.x, y: m.y };
        const ABx = B.x - A.x, ABy = B.y - A.y;
        const t = Math.max(0, Math.min(1, ((P.x - A.x) * ABx + (P.y - A.y) * ABy) / (ABx * ABx + ABy * ABy)));
        const Cx = A.x + ABx * t, Cy = A.y + ABy * t;
        const d = dist(P.x, P.y, Cx, Cy);
        if (d <= m.radius + thickness) {
          m.hp -= 2;
          if (m.hp <= 0) {
            room.monsters.splice(i, 1);
            p.kills += 1;
          }
        }
      }
      room.effects.push({ id: uuidv4(), type: 'beam', x1, y1, x2, y2, until: now + 150 });
      break;
    }
  }
}

function updateRoom(room, dt, now) {
  const { factor } = scaleForPlayers(room);

  // Spawns
  const MONSTER_SPAWN_INTERVAL_MS_BASE = 2400;
  const spawnInterval = MONSTER_SPAWN_INTERVAL_MS_BASE / factor;
  if (now - room.lastSpawnAt > spawnInterval) { room.lastSpawnAt = now; spawnMonster(room); }

  if (now - room.lastPowerAt > 6000) { room.lastPowerAt = now; spawnPowerup(room); }
  if (now - room.lastNeutralAt > 7000) { room.lastNeutralAt = now; spawnNeutral(room); }

  // Move players
  for (const id in room.players) {
    const p = room.players[id];
    const inputX = (p.right ? 1 : 0) - (p.left ? 1 : 0);
    const inputY = (p.down ? 1 : 0) - (p.up ? 1 : 0);
    const dir = normalize(inputX, inputY);
    const dashBoost = now < p.dashingUntil ? 3.2 : 1;
    const speed = PLAYER_SPEED * p.buffs.speed * dashBoost;
    p.x += dir.x * speed * dt;
    p.y += dir.y * speed * dt;
    p.x = clamp(p.x, p.radius, room.world.width - p.radius);
    p.y = clamp(p.y, p.radius, room.world.height - p.radius);
    tryShoot(room, p, now);
  }

  // Enemies
  updateEnemies(room, dt, now);

  // Bombs
  for (let i = room.bombs.length - 1; i >= 0; i--) {
    const b = room.bombs[i];
    b.x += b.vx * dt; b.y += b.vy * dt; b.vx *= 0.98; b.vy *= 0.98;
    if (now >= b.explodeAt) {
      for (let j = room.monsters.length - 1; j >= 0; j--) {
        const m = room.monsters[j];
        if (dist(b.x, b.y, m.x, m.y) <= b.radius + m.radius) {
          m.hp -= 3;
          if (m.hp <= 0) { room.monsters.splice(j, 1); }
        }
      }
      room.effects.push({ id: uuidv4(), type: 'explosion', x: b.x, y: b.y, r: b.radius, until: now + 220 });
      room.bombs.splice(i, 1);
    }
  }

  for (let i = room.effects.length - 1; i >= 0; i--) { if (room.effects[i].until <= now) room.effects.splice(i, 1); }

  // Move bullets and cull
  for (let i = room.bullets.length - 1; i >= 0; i--) {
    const b = room.bullets[i];
    b.x += b.vx * dt; b.y += b.vy * dt;
    const expired = now - b.createdAt > BULLET_LIFETIME_MS;
    const outOfBounds = b.x < -50 || b.y < -50 || b.x > room.world.width + 50 || b.y > room.world.height + 50;
    if (expired || outOfBounds) { room.bullets.splice(i, 1); continue; }
  }

  // Collisions bullets vs monsters
  for (let i = room.bullets.length - 1; i >= 0; i--) {
    const b = room.bullets[i];
    let hit = false;
    for (let j = room.monsters.length - 1; j >= 0; j--) {
      const m = room.monsters[j];
      if (circleCollide(b.x, b.y, b.radius, m.x, m.y, m.radius)) {
        m.hp -= 1; hit = true;
        if (m.hp <= 0) {
          const owner = room.players[b.ownerId]; if (owner) owner.kills += 1;
          if (m.type === 'splitter') {
            for (let k = 0; k < 2; k++) {
              const mini = { ...ENEMY_TYPES['mini'] };
              const hp = mini.baseHp;
              room.monsters.push({ id: uuidv4(), type: 'mini', x: m.x + (Math.random() - 0.5) * 20, y: m.y + (Math.random() - 0.5) * 20, vx: 0, vy: 0, radius: mini.radius, hp, maxHp: hp, baseSpeed: mini.baseSpeed, state: {} });
            }
          }
          room.monsters.splice(j, 1);
        }
        break;
      }
    }
    if (hit) room.bullets.splice(i, 1);
  }

  // Player vs powerups
  for (const id in room.players) {
    const p = room.players[id];
    for (let i = room.powerups.length - 1; i >= 0; i--) {
      const u = room.powerups[i];
      if (u.expiresAt <= now) { room.powerups.splice(i, 1); continue; }
      if (circleCollide(p.x, p.y, p.radius, u.x, u.y, u.r)) {
        applyPowerup(p, u.type, now);
        room.powerups.splice(i, 1);
      }
    }
  }

  // Neutrals wander and can be hit by bullets
  for (const n of room.neutrals) {
    n.wanderT -= dt;
    if (n.wanderT <= 0) { n.wanderT = 1 + Math.random() * 2.5; const dir = normalize(Math.random() - 0.5, Math.random() - 0.5); n.vx = dir.x * 80; n.vy = dir.y * 80; }
    n.x += n.vx * dt; n.y += n.vy * dt; n.vx *= 0.98; n.vy *= 0.98;
    n.x = clamp(n.x, n.r, room.world.width - n.r);
    n.y = clamp(n.y, n.r, room.world.height - n.r);
  }
  for (let i = room.bullets.length - 1; i >= 0; i--) {
    const b = room.bullets[i];
    for (let j = room.neutrals.length - 1; j >= 0; j--) {
      const n = room.neutrals[j];
      if (circleCollide(b.x, b.y, b.radius, n.x, n.y, n.r)) {
        n.hp -= 1; room.bullets.splice(i, 1);
        if (n.hp <= 0) { room.neutrals.splice(j, 1); }
        break;
      }
    }
  }

  // Monsters collide with players -> respawn & penalty (unless shield/iFrames)
  for (const id in room.players) {
    const p = room.players[id];
    let collided = false;
    for (const m of room.monsters) {
      if (circleCollide(p.x, p.y, p.radius, m.x, m.y, m.radius)) { collided = true; break; }
    }
    if (collided && now > p.iFramesUntil && now > p.buffs.shieldUntil) {
      const pos = randomInWorld(); p.x = pos.x; p.y = pos.y; p.kills = Math.max(0, p.kills - 1); p.iFramesUntil = now + 1000;
    }
  }
}

function snapshot(room) {
  return {
    players: Object.values(room.players).map((p) => ({ id: p.id, x: Math.round(p.x), y: Math.round(p.y), color: p.color, kills: p.kills, r: p.radius, cd: p.abilityCd, buffs: { speed: p.buffs.speed, firerate: p.buffs.firerate, multishot: p.buffs.multishot, shieldUntil: p.buffs.shieldUntil } })),
    bullets: room.bullets.map((b) => ({ x: Math.round(b.x), y: Math.round(b.y), r: b.radius })),
    monsters: room.monsters.map((m) => ({ id: m.id, x: Math.round(m.x), y: Math.round(m.y), r: m.radius, hp: m.hp, maxHp: m.maxHp, type: m.type })),
    neutrals: room.neutrals.map((n) => ({ x: Math.round(n.x), y: Math.round(n.y), r: n.r, hp: n.hp, maxHp: n.maxHp })),
    powerups: room.powerups.map((u) => ({ id: u.id, type: u.type, x: Math.round(u.x), y: Math.round(u.y), r: u.r })),
    bombs: room.bombs.map((b) => ({ x: Math.round(b.x), y: Math.round(b.y), r: 8 })),
    effects: room.effects.slice(0),
    world: room.world,
    serverTime: Date.now(),
    settings: room.settings,
  };
}

let last = Date.now();
setInterval(() => {
  const now = Date.now();
  const dt = (now - last) / 1000;
  last = now;

  for (const room of rooms.values()) {
    updateRoom(room, dt, now);
    io.to(room.id).emit('state', snapshot(room));
  }
}, 1000 / TICK_RATE);

// Robust startup: auto-fallback to next ports if busy
(function startListening(startPort, maxAttempts) {
  let port = startPort;
  let attemptsLeft = Math.max(1, maxAttempts);

  function tryListen() {
    server.listen(port, () => {
      console.log(`Server listening on http://localhost:${port}`);
    });
  }

  server.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE' && attemptsLeft > 1) {
      console.warn(`Port ${port} in use, trying ${port + 1}...`);
      attemptsLeft -= 1;
      port += 1;
      setTimeout(tryListen, 150);
    } else {
      console.error('Fatal server error:', err);
      process.exit(1);
    }
  });

  tryListen();
})(START_PORT, 10); 