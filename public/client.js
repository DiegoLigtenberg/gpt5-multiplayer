(() => {
  const socket = io();

  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  const menu = document.getElementById('menu');
  const ui = document.getElementById('ui');
  const btnPlay = document.getElementById('btnPlay');
  const optPlayers = document.getElementById('optPlayers');
  const optDiff = document.getElementById('optDiff');
  const audioToggle = document.getElementById('audioToggle');
  const bgmMenu = document.getElementById('bgmMenu');
  const bgmGame = document.getElementById('bgmGame');

  let myId = null;
  let world = { width: 2400, height: 1800 };
  let joined = false;

  const state = {
    players: [],
    bullets: [],
    monsters: [],
    neutrals: [],
    powerups: [],
    bombs: [],
    effects: [],
    serverTime: 0,
    settings: { maxPlayers: 1, difficulty: 'Normal' }
  };

  const input = {
    up: false,
    down: false,
    left: false,
    right: false,
    shooting: false,
    mouseX: 0,
    mouseY: 0,
    angle: 0,
  };

  // Ability config (UI + keys + cooldowns must match server)
  const ABILITIES = [
    { type: 'burst', keyLabel: 'Q', codes: ['KeyQ'], cooldownMs: 3000 },
    { type: 'dash', keyLabel: 'Shift', codes: ['ShiftLeft', 'ShiftRight'], cooldownMs: 6000 },
    { type: 'grenade', keyLabel: 'E', codes: ['KeyE'], cooldownMs: 5000 },
    { type: 'beam', keyLabel: 'R', codes: ['KeyR'], cooldownMs: 8000 },
  ];

  // Menu setup
  const playerOpts = [1, 2, 3, 4];
  const diffOpts = ['Easy', 'Normal', 'Hard', 'Insane'];
  let selectedPlayers = 1;
  let selectedDiff = 'Normal';

  function buildOptions(container, options, selected, onPick) {
    container.innerHTML = '';
    options.forEach((opt) => {
      const b = document.createElement('button');
      b.className = 'btn' + (opt === selected ? ' active' : '');
      b.textContent = String(opt);
      b.onclick = () => { onPick(opt); build(); };
      container.appendChild(b);
    });
  }

  function build() {
    buildOptions(optPlayers, playerOpts, selectedPlayers, (v) => selectedPlayers = v);
    buildOptions(optDiff, diffOpts, selectedDiff, (v) => selectedDiff = v);
  }
  build();

  // --------- Audio helpers (robust loader with fallbacks) ---------
  const menuCandidates = [
    'audio/menu/track.mp3', 'audio/menu/track.ogg',
    'audio/menu/music.mp3', 'audio/menu/music.ogg',
    'audio/menu/song.mp3', 'audio/menu/song.ogg'
  ];
  const gameCandidates = [
    'audio/game/track.mp3', 'audio/game/track.ogg',
    'audio/game/music.mp3', 'audio/game/music.ogg',
    'audio/game/song.mp3', 'audio/game/song.ogg'
  ];

  function attachFallbackLoader(audioEl, candidates) {
    let idx = 0;
    audioEl.volume = 0.6;
    audioEl.preload = 'auto';

    function tryNext() {
      if (idx >= candidates.length) return; // none found; stays silent
      const src = candidates[idx++];
      audioEl.src = src;
      audioEl.load();
      const onError = () => { audioEl.removeEventListener('error', onError); tryNext(); };
      audioEl.addEventListener('error', onError, { once: true });
    }

    tryNext();

    return {
      play: async () => { try { await audioEl.play(); } catch (_) {} },
      pause: () => audioEl.pause(),
      element: audioEl,
    };
  }

  const menuMusic = attachFallbackLoader(bgmMenu, menuCandidates);
  const gameMusic = attachFallbackLoader(bgmGame, gameCandidates);

  // Unlock audio on first user gesture
  let audioUnlocked = false;
  function unlockAudio() {
    if (audioUnlocked) return;
    audioUnlocked = true;
    menuMusic.play().then(() => menuMusic.pause()).catch(() => {});
    gameMusic.play().then(() => gameMusic.pause()).catch(() => {});
  }
  window.addEventListener('pointerdown', unlockAudio, { once: true });
  window.addEventListener('keydown', unlockAudio, { once: true });

  let musicOn = false;
  async function updateMusic() {
    if (!musicOn) {
      menuMusic.pause();
      gameMusic.pause();
      audioToggle.textContent = 'Music: Off';
      audioToggle.classList.remove('active');
      return;
    }
    audioToggle.textContent = 'Music: On';
    audioToggle.classList.add('active');
    if (joined) {
      menuMusic.pause();
      gameMusic.element.currentTime = 0;
      await gameMusic.play();
    } else {
      gameMusic.pause();
      menuMusic.element.currentTime = 0;
      await menuMusic.play();
    }
  }
  audioToggle.onclick = async () => { musicOn = !musicOn; await updateMusic(); };

  // ---------------------------------------------------------------

  btnPlay.onclick = async () => {
    if (joined) return;
    joined = true;
    menu.style.display = 'none';
    ui.style.display = 'block';
    await updateMusic();
    socket.emit('join', { roomId: `local-${selectedPlayers}-${selectedDiff}`, settings: { maxPlayers: selectedPlayers, difficulty: selectedDiff } });
  };

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(canvas.clientWidth * dpr);
    canvas.height = Math.floor(canvas.clientHeight * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  window.addEventListener('resize', resize); resize();

  socket.on('init', (data) => {
    myId = data.id;
    world = data.world;
    state.settings = data.settings || state.settings;
  });
  socket.on('joinDenied', (msg) => {
    alert(msg?.reason || 'Join denied');
    joined = false; menu.style.display = 'grid'; ui.style.display = 'none';
  });

  socket.on('state', (s) => {
    Object.assign(state, s);
    world = s.world;
  });

  // Input handling
  const keyDown = new Set();
  const keyMap = {
    KeyW: 'up', ArrowUp: 'up',
    KeyS: 'down', ArrowDown: 'down',
    KeyA: 'left', ArrowLeft: 'left',
    KeyD: 'right', ArrowRight: 'right'
  };

  function handleAbilityKey(code) {
    for (const a of ABILITIES) {
      if (a.codes.includes(code)) {
        useAbility(a.type);
        return true;
      }
    }
    return false;
  }

  window.addEventListener('keydown', (e) => {
    keyDown.add(e.code);
    const k = keyMap[e.code];
    if (k) { input[k] = true; sendInput(); e.preventDefault(); }
    if (handleAbilityKey(e.code)) e.preventDefault();
  });
  window.addEventListener('keyup', (e) => {
    keyDown.delete(e.code);
    const k = keyMap[e.code];
    if (k) { input[k] = false; sendInput(); e.preventDefault(); }
  });

  canvas.addEventListener('mousedown', () => { input.shooting = true; sendInput(); });
  window.addEventListener('mouseup', () => { input.shooting = false; sendInput(); });
  canvas.addEventListener('mousemove', (e) => {
    const rect = canvas.getBoundingClientRect();
    input.mouseX = e.clientX - rect.left;
    input.mouseY = e.clientY - rect.top;
  });

  function useAbility(type) { socket.emit('ability', { type }); }

  function sendInput() { socket.emit('input', input); }

  function getMe() { return state.players.find((p) => p.id === myId) || null; }

  function getCamera() {
    const me = getMe();
    const vw = canvas.clientWidth, vh = canvas.clientHeight;
    const halfW = vw / 2, halfH = vh / 2;
    let cx = world.width / 2, cy = world.height / 2;
    if (me) { cx = Math.max(halfW, Math.min(world.width - halfW, me.x)); cy = Math.max(halfH, Math.min(world.height - halfH, me.y)); }
    return { x: cx - halfW, y: cy - halfH };
  }

  // Visual helpers
  function drawGrid(cam) {
    const spacing = 100; ctx.strokeStyle = '#1a2230'; ctx.lineWidth = 1;
    const startX = Math.floor(cam.x / spacing) * spacing;
    const startY = Math.floor(cam.y / spacing) * spacing;
    for (let x = startX; x < cam.x + canvas.clientWidth; x += spacing) {
      ctx.beginPath(); ctx.moveTo(Math.floor(x - cam.x) + 0.5, 0); ctx.lineTo(Math.floor(x - cam.x) + 0.5, canvas.clientHeight); ctx.stroke();
    }
    for (let y = startY; y < cam.y + canvas.clientHeight; y += spacing) {
      ctx.beginPath(); ctx.moveTo(0, Math.floor(y - cam.y) + 0.5); ctx.lineTo(canvas.clientWidth, Math.floor(y - cam.y) + 0.5); ctx.stroke();
    }
  }

  function drawCircle(x, y, r, color) { ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill(); }
  function strokeCircle(x, y, r, color, w=2) { ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.lineWidth = w; ctx.strokeStyle = color; ctx.stroke(); }

  function drawHealthBar(x, y, w, h, pct) {
    ctx.fillStyle = '#0007'; ctx.fillRect(x - w/2 - 1, y - 20 - 1, w + 2, h + 2);
    ctx.fillStyle = '#222a'; ctx.fillRect(x - w/2, y - 20, w, h);
    ctx.fillStyle = pct > 0.5 ? '#58d68d' : pct > 0.25 ? '#f7c948' : '#ff6b6b';
    ctx.fillRect(x - w/2, y - 20, w * Math.max(0, Math.min(1, pct)), h);
  }

  function drawPlayer(p, cam) {
    const x = p.x - cam.x, y = p.y - cam.y;
    drawCircle(x, y, p.r, p.color);
    strokeCircle(x, y, p.r + 2, '#0008');
    const me = getMe();
    if (p.id === myId) {
      ctx.beginPath(); ctx.moveTo(x, y); const len = 20; ctx.lineTo(x + Math.cos(input.angle) * len, y + Math.sin(input.angle) * len); ctx.strokeStyle = '#bdf'; ctx.lineWidth = 2; ctx.stroke();
    }
  }

  function drawMonster(m, cam) {
    const x = m.x - cam.x, y = m.y - cam.y;
    switch (m.type) {
      case 'chaser': drawCircle(x, y, m.r, '#e45757'); break;
      case 'dasher': drawDiamond(x, y, m.r, '#ff8f40'); break;
      case 'orbiter': drawRing(x, y, m.r, '#9b59b6'); break;
      case 'splitter': drawTri(x, y, m.r, '#4cd3c2'); break;
      case 'sniper': drawHex(x, y, m.r, '#f1c40f'); break;
      case 'mini': drawCircle(x, y, m.r, '#e7a0a0'); break;
    }
    drawHealthBar(x, y, m.r * 2, 4, m.hp / m.maxHp);
  }

  function drawBullet(b, cam) {
    const x = b.x - cam.x, y = b.y - cam.y; drawCircle(x, y, b.r, '#f7c948');
  }

  function drawNeutral(n, cam) {
    const x = n.x - cam.x, y = n.y - cam.y; drawCircle(x, y, n.r, '#7fb3d5'); strokeCircle(x, y, n.r + 2, '#0006'); drawHealthBar(x, y, n.r * 2, 3, n.hp / n.maxHp);
  }

  function drawPowerup(u, cam) {
    const x = u.x - cam.x, y = u.y - cam.y; const colors = { speed: '#6cd4ff', firerate: '#ffd166', multishot: '#a29bfe', heal: '#7bed9f', shield: '#74b9ff' };
    drawDiamond(x, y, u.r, colors[u.type] || '#ddd');
  }

  function drawEffect(e, cam) {
    if (e.type === 'explosion') {
      const x = e.x - cam.x, y = e.y - cam.y; ctx.fillStyle = '#ffcc00aa'; ctx.beginPath(); ctx.arc(x, y, e.r * 0.6, 0, Math.PI * 2); ctx.fill(); strokeCircle(x, y, e.r, '#ffaa00aa', 3);
    }
    if (e.type === 'beam') {
      ctx.strokeStyle = '#b5f5ffaa'; ctx.lineWidth = 6; ctx.beginPath(); ctx.moveTo(e.x1 - cam.x, e.y1 - cam.y); ctx.lineTo(e.x2 - cam.x, e.y2 - cam.y); ctx.stroke();
    }
    if (e.type === 'dash') {
      ctx.strokeStyle = '#9ad1ffbb'; ctx.lineWidth = 6; ctx.beginPath(); ctx.moveTo(e.x1 - cam.x, e.y1 - cam.y); ctx.lineTo(e.x2 - cam.x, e.y2 - cam.y); ctx.stroke();
    }
  }

  function drawDiamond(x, y, r, color) { ctx.fillStyle = color; ctx.beginPath(); ctx.moveTo(x, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r, y); ctx.closePath(); ctx.fill(); }
  function drawTri(x, y, r, color) { ctx.fillStyle = color; ctx.beginPath(); ctx.moveTo(x, y - r); ctx.lineTo(x + r * 0.86, y + r * 0.5); ctx.lineTo(x - r * 0.86, y + r * 0.5); ctx.closePath(); ctx.fill(); }
  function drawHex(x, y, r, color) { ctx.fillStyle = color; ctx.beginPath(); for (let i=0;i<6;i++){ const a = Math.PI/3*i; const px=x+Math.cos(a)*r, py=y+Math.sin(a)*r; if(i===0)ctx.moveTo(px,py); else ctx.lineTo(px,py);} ctx.closePath(); ctx.fill(); }
  function drawRing(x, y, r, color) { strokeCircle(x, y, r, color, 4); drawCircle(x, y, r*0.45, '#111b'); }

  function updateAimAngle() {
    const me = getMe(); if (!me) return;
    const cam = getCamera(); const px = me.x - cam.x, py = me.y - cam.y; const dx = input.mouseX - px, dy = input.mouseY - py; input.angle = Math.atan2(dy, dx);
  }

  // Ability HUD
  function drawRoundedRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function drawAbilityIcon(type, x, y, size) {
    const s = size / 2;
    switch (type) {
      case 'burst': {
        // Cone: three small triangles
        ctx.fillStyle = '#ffd166';
        for (let i = -1; i <= 1; i++) {
          const a = i * 0.3; const dx = Math.cos(a), dy = Math.sin(a);
          ctx.beginPath();
          ctx.moveTo(x, y);
          ctx.lineTo(x + dx * s, y + dy * s);
          const a2 = a + 0.25; ctx.lineTo(x + Math.cos(a2) * s * 0.9, y + Math.sin(a2) * s * 0.9);
          ctx.closePath(); ctx.fill();
        }
        break;
      }
      case 'dash': {
        // Double chevron
        ctx.strokeStyle = '#6cd4ff'; ctx.lineWidth = 4; ctx.lineCap = 'round';
        for (let k = 0; k < 2; k++) {
          ctx.beginPath();
          ctx.moveTo(x - s * 0.6 + k * 10, y - s * 0.2);
          ctx.lineTo(x, y);
          ctx.lineTo(x - s * 0.6 + k * 10, y + s * 0.2);
          ctx.stroke();
        }
        break;
      }
      case 'grenade': {
        ctx.fillStyle = '#a29bfe'; drawCircle(x, y, s * 0.5, '#a29bfe');
        ctx.strokeStyle = '#a29bfe'; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(x + s * 0.3, y - s * 0.5, s * 0.25, Math.PI, Math.PI * 1.7); ctx.stroke();
        break;
      }
      case 'beam': {
        ctx.strokeStyle = '#b5f5ff'; ctx.lineWidth = 5; ctx.beginPath(); ctx.moveTo(x - s * 0.8, y); ctx.lineTo(x + s * 0.8, y); ctx.stroke();
        break;
      }
    }
  }

  function drawAbilityBar() {
    const me = getMe(); if (!me) return;
    const pad = 10; const box = 56; const gap = 10; const totalW = ABILITIES.length * box + (ABILITIES.length - 1) * gap;
    const x0 = (canvas.clientWidth - totalW) / 2; const y0 = canvas.clientHeight - (box + pad);

    for (let i = 0; i < ABILITIES.length; i++) {
      const a = ABILITIES[i];
      const x = x0 + i * (box + gap); const y = y0;
      // background box
      drawRoundedRect(x, y, box, box, 10);
      ctx.fillStyle = '#0f1524cc'; ctx.fill();
      ctx.lineWidth = 2; ctx.strokeStyle = '#2a3552'; ctx.stroke();

      // icon
      drawAbilityIcon(a.type, x + box / 2, y + box / 2, box * 0.9);

      // key label
      ctx.fillStyle = '#cfe7ff'; ctx.font = '12px system-ui, sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
      ctx.fillText(a.keyLabel, x + 6, y + box - 6);

      // cooldown overlay
      const cdMap = me.cd || {};
      const now = state.serverTime || Date.now();
      const nextReady = cdMap[a.type] || 0;
      const remaining = Math.max(0, nextReady - now);
      if (remaining > 0) {
        const frac = Math.max(0, Math.min(1, remaining / a.cooldownMs));
        ctx.fillStyle = '#000a';
        ctx.fillRect(x, y, box, box * frac);
        ctx.fillStyle = '#e9eef7'; ctx.textAlign = 'right'; ctx.font = '12px system-ui, sans-serif';
        ctx.fillText((remaining / 1000).toFixed(1) + 's', x + box - 6, y + box - 6);
      }
    }
  }

  function render() {
    updateAimAngle();
    ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
    const cam = getCamera();

    drawGrid(cam);
    ctx.strokeStyle = '#334'; ctx.lineWidth = 2; ctx.strokeRect(-cam.x + 0.5, -cam.y + 0.5, world.width, world.height);

    for (const u of state.powerups) drawPowerup(u, cam);
    for (const n of state.neutrals) drawNeutral(n, cam);
    for (const b of state.bullets) drawBullet(b, cam);
    for (const m of state.monsters) drawMonster(m, cam);
    for (const p of state.players) drawPlayer(p, cam);
    for (const e of state.effects) drawEffect(e, cam);

    const me = getMe();
    if (me) {
      ui.textContent = `WASD/Arrows move | Mouse aim/click shoot | Kills: ${me.kills}`;
    }

    drawAbilityBar();

    requestAnimationFrame(render);
  }
  render();

  setInterval(() => { sendInput(); }, 50);
})(); 