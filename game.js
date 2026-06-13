// ============================================================
// Tower Wars — Complete Rewrite
// Fixed: drag-to-send, Firebase sync, all-player soldier tick
// Added: particles, screen shake, animations, visual polish
// ============================================================

// ===== CONSTANTS =====
const SOLDIER_GROWTH_INTERVAL = 600;   // ms per tick
const SOLDIER_GROWTH_AMOUNT  = 1;      // soldiers per tick
const SOLDIER_MOVE_SPEED     = 150;    // px/s on the 900×600 map
const DRAG_RATIO             = 0.5;    // send 50% of soldiers
const TOWER_RADIUS           = 30;
const MAP_W                  = 900;
const MAP_H                  = 600;
const MAP_PADDING            = 90;
const MIN_NEUTRAL            = 6;
const MAX_NEUTRAL            = 12;

const PLAYER_COLORS      = ['#ff4757', '#2f86ff', '#2ed573', '#ffa502'];
const PLAYER_COLORS_GLOW = ['#ff475780','#2f86ff80','#2ed57380','#ffa50280'];
const PLAYER_NAMES       = ['紅', '藍', '綠', '橙'];
const PLAYER_EMOJIS      = ['🔴', '🔵', '🟢', '🟠'];
const NEUTRAL_COLOR      = '#8899aa';

// ===== STATE =====
let gs = freshState();
function freshState() {
  return {
    phase: 'menu',
    roomId: null,
    playerId: null,
    playerIndex: null,
    playerCount: 2,
    towers: {},
    soldiers: [],
    dragFrom: null,
    dragPos: null,
    particles: [],
    screenShake: 0,
    isHost: false,
    winner: null,
  };
}

let canvas, ctx;
let animId;
let growthInterval;
let dbListeners = [];
let lastTimestamp = 0;

// ===== CANVAS =====
function initCanvas() {
  canvas = document.getElementById('gameCanvas');
  ctx = canvas.getContext('2d');
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);
}

function resizeCanvas() {
  const c = document.getElementById('gameContainer');
  canvas.width  = c.clientWidth;
  canvas.height = c.clientHeight;
}

// ===== SCREEN =====
function showScreen(id) {
  ['menuScreen','matchmakingScreen','gameScreen','gameoverScreen']
    .forEach(s => document.getElementById(s).classList.add('hidden'));
  document.getElementById(id).classList.remove('hidden');
}

// ===== MAP COORDS =====
function mapToCanvas(mx, my) {
  return {
    x: mx * canvas.width  / MAP_W,
    y: my * canvas.height / MAP_H,
  };
}
function canvasToMap(cx, cy) {
  return {
    x: cx * MAP_W  / canvas.width,
    y: cy * MAP_H / canvas.height,
  };
}

// ===== MATCHMAKING =====
async function startMatchmaking() {
  const count = parseInt(document.getElementById('playerCountSelect').value);
  gs.playerCount = count;
  gs.playerId = 'p_' + Math.random().toString(36).substr(2,9);

  showScreen('matchmakingScreen');
  document.getElementById('matchStatus').textContent = '搜尋中...';
  document.getElementById('matchPlayerCount').textContent = `等待 ${count} 人遊戲`;

  const snap = await db.ref('waiting').once('value');
  const waiting = snap.val() || {};
  let targetRoom = null;

  for (const [rid, room] of Object.entries(waiting)) {
    if (room.playerCount === count &&
        Object.keys(room.players || {}).length < count) {
      targetRoom = rid;
      break;
    }
  }

  if (!targetRoom) {
    targetRoom = 'room_' + Date.now() + '_' + Math.random().toString(36).substr(2,5);
  }

  gs.roomId = targetRoom;
  const roomRef = db.ref(`waiting/${targetRoom}`);

  await roomRef.child('players/' + gs.playerId).set({
    id: gs.playerId,
    joinedAt: Date.now(),
  });
  await roomRef.update({ playerCount: count });
  db.ref(`waiting/${targetRoom}/players/${gs.playerId}`).onDisconnect().remove();

  // Listen for game start
  const statusRef = db.ref(`games/${targetRoom}/status`);
  statusRef.on('value', snap => {
    if (snap.val() === 'playing') {
      statusRef.off();
      db.ref(`games/${targetRoom}`).once('value').then(snap => {
        const data = snap.val();
        const sorted = Object.values(data.players).sort((a,b)=>a.joinedAt-b.joinedAt);
        gs.playerIndex = sorted.findIndex(p => p.id === gs.playerId);
        startGame(targetRoom, data.towers);
      });
    }
  });
  dbListeners.push(() => statusRef.off());

  // Wait for enough players
  const waitUnsub = roomRef.on('value', async snap => {
    const room = snap.val();
    if (!room) return;
    const players = Object.values(room.players || {});
    const cur = players.length, need = room.playerCount;
    document.getElementById('matchStatus').textContent = `已找到 ${cur} / ${need} 位玩家`;

    if (cur >= need) {
      roomRef.off('value', waitUnsub);
      const sorted = players.sort((a,b)=>a.joinedAt-b.joinedAt);
      if (sorted[0].id === gs.playerId) {
        await initAsHost(targetRoom, sorted);
      }
    }
  });
}

async function initAsHost(roomId, players) {
  const towers = generateTowers(players.length);
  const gameData = {
    status: 'playing',
    startTime: Date.now(),
    playerCount: players.length,
    players: players.reduce((acc, p, i) => {
      acc[p.id] = { id: p.id, index: i, joinedAt: p.joinedAt, color: PLAYER_COLORS[i] };
      return acc;
    }, {}),
    towers,
  };
  await db.ref(`games/${roomId}`).set(gameData);
  await db.ref(`waiting/${roomId}`).remove();
}

function cancelMatchmaking() {
  if (gs.roomId) {
    db.ref(`waiting/${gs.roomId}/players/${gs.playerId}`).remove();
  }
  dbListeners.forEach(fn => fn());
  dbListeners = [];
  gs = freshState();
  showScreen('menuScreen');
}

// ===== TOWER GENERATION =====
function generateTowers(playerCount) {
  const towers = {};
  const positions = [];
  const MIN_DIST = 120;

  const corners = [
    { x: MAP_PADDING + 40, y: MAP_PADDING + 40 },
    { x: MAP_W - MAP_PADDING - 40, y: MAP_H - MAP_PADDING - 40 },
    { x: MAP_W - MAP_PADDING - 40, y: MAP_PADDING + 40 },
    { x: MAP_PADDING + 40, y: MAP_H - MAP_PADDING - 40 },
  ];

  for (let i = 0; i < playerCount; i++) {
    positions.push(corners[i]);
    towers[`tp${i}`] = {
      id: `tp${i}`, x: corners[i].x, y: corners[i].y,
      soldiers: 15, owner: i, isStart: true,
    };
  }

  const neutralCount = MIN_NEUTRAL + Math.floor(Math.random() * (MAX_NEUTRAL - MIN_NEUTRAL + 1));
  let placed = 0, fails = 0;
  while (placed < neutralCount && fails < 10) {
    const x = MAP_PADDING + Math.random() * (MAP_W - MAP_PADDING*2);
    const y = MAP_PADDING + Math.random() * (MAP_H - MAP_PADDING*2);
    if (positions.every(p => Math.hypot(p.x-x, p.y-y) >= MIN_DIST)) {
      positions.push({x, y});
      towers[`tn${placed}`] = {
        id: `tn${placed}`, x: Math.round(x), y: Math.round(y),
        soldiers: 5 + Math.floor(Math.random() * 10), owner: -1, isStart: false,
      };
      placed++;
    } else {
      fails++;
    }
  }
  return towers;
}

// ===== START GAME =====
function startGame(roomId, towersData) {
  gs.phase = 'playing';
  gs.roomId = roomId;
  gs.towers = JSON.parse(JSON.stringify(towersData));
  gs.soldiers = [];
  gs.particles = [];

  showScreen('gameScreen');
  resizeCanvas();

  const myColor = PLAYER_COLORS[gs.playerIndex];
  document.getElementById('myColorDot').style.background = myColor;
  document.getElementById('myColorLabel').textContent = PLAYER_NAMES[gs.playerIndex] + '方';

  setupInput();
  setupFirebase(roomId);
  startGrowth(roomId);
  startRenderLoop();
}

// ===== FIREBASE LISTENERS =====
function setupFirebase(roomId) {
  // Towers
  const towersRef = db.ref(`games/${roomId}/towers`);
  towersRef.on('value', snap => {
    const data = snap.val();
    if (data) gs.towers = data;
  });
  dbListeners.push(() => towersRef.off());

  // Moving soldiers (for remote players' animations)
  const solRef = db.ref(`games/${roomId}/movingSoldiers`);
  solRef.on('child_added', snap => {
    const sg = snap.val();
    if (!sg || gs.soldiers.find(s => s.id === sg.id)) return;
    const now = Date.now();
    const elapsed = now - sg.sentAt;
    const progress = Math.max(0, Math.min(elapsed / sg.travelTime, 0.99));
    gs.soldiers.push({ ...sg, progress });
  });
  solRef.on('child_removed', snap => {
    const sg = snap.val();
    if (sg) gs.soldiers = gs.soldiers.filter(s => s.id !== sg.id);
  });
  dbListeners.push(() => solRef.off());

  // Game status
  const statusRef = db.ref(`games/${roomId}/status`);
  statusRef.on('value', snap => {
    if (snap.val() === 'gameover') {
      db.ref(`games/${roomId}/winner`).once('value').then(w => endGame(w.val()));
    }
  });
  dbListeners.push(() => statusRef.off());
}

// ===== SOLDIER GROWTH (each player grows their own towers) =====
function startGrowth(roomId) {
  growthInterval = setInterval(async () => {
    if (gs.phase !== 'playing') return;
    const updates = {};
    for (const [tid, t] of Object.entries(gs.towers)) {
      if (t.owner === gs.playerIndex) {
        const newVal = (t.soldiers || 0) + SOLDIER_GROWTH_AMOUNT;
        updates[`games/${roomId}/towers/${tid}/soldiers`] = newVal;
      }
    }
    if (Object.keys(updates).length > 0) {
      try { await db.ref().update(updates); } catch(e) {}
    }
  }, SOLDIER_GROWTH_INTERVAL);
}

// ===== INPUT =====
function setupInput() {
  canvas.addEventListener('mousedown',  onDown,  { passive: false });
  canvas.addEventListener('mousemove',  onMove,  { passive: false });
  canvas.addEventListener('mouseup',    onUp,    { passive: false });
  canvas.addEventListener('touchstart', onDown,  { passive: false });
  canvas.addEventListener('touchmove',  onMove,  { passive: false });
  canvas.addEventListener('touchend',   onUp,    { passive: false });
  canvas.addEventListener('mouseleave', onCancel);
}

function getPos(e) {
  const rect = canvas.getBoundingClientRect();
  const src  = e.changedTouches ? e.changedTouches[0] : (e.touches ? e.touches[0] : e);
  return {
    x: (src.clientX - rect.left) * (canvas.width  / rect.width),
    y: (src.clientY - rect.top)  * (canvas.height / rect.height),
  };
}

function towerNear(cx, cy, radius) {
  const mp = canvasToMap(cx, cy);
  let best = null, bestD = Infinity;
  for (const t of Object.values(gs.towers)) {
    const d = Math.hypot(t.x - mp.x, t.y - mp.y);
    if (d < radius && d < bestD) { best = t; bestD = d; }
  }
  return best;
}

function onDown(e) {
  e.preventDefault();
  if (gs.phase !== 'playing') return;
  const pos = getPos(e);
  // Hit radius in map coords
  const hitRadius = (TOWER_RADIUS * 2.2) * MAP_W / canvas.width;
  const tower = towerNear(pos.x, pos.y, hitRadius);
  if (tower && tower.owner === gs.playerIndex && tower.soldiers > 1) {
    gs.dragFrom = tower;
    gs.dragPos  = pos;
  }
}

function onMove(e) {
  e.preventDefault();
  if (!gs.dragFrom) return;
  gs.dragPos = getPos(e);
}

function onUp(e) {
  e.preventDefault();
  if (!gs.dragFrom) return;
  const pos = getPos(e);
  const hitRadius = (TOWER_RADIUS * 3.0) * MAP_W / canvas.width;
  const target = towerNear(pos.x, pos.y, hitRadius);
  if (target && target.id !== gs.dragFrom.id) {
    sendSoldiers(gs.dragFrom, target);
  }
  gs.dragFrom = null;
  gs.dragPos  = null;
}

function onCancel() {
  gs.dragFrom = null;
  gs.dragPos  = null;
}

// ===== SEND SOLDIERS =====
async function sendSoldiers(from, to) {
  // Re-fetch current soldier count from gs.towers (Firebase-synced)
  const liveTower = gs.towers[from.id];
  if (!liveTower || liveTower.soldiers < 2) return;

  const count = Math.max(1, Math.floor(liveTower.soldiers * DRAG_RATIO));
  const roomId = gs.roomId;
  const sgId = 'sg_' + Date.now() + '_' + Math.random().toString(36).substr(2,5);

  const newSoldiers = Math.max(0, liveTower.soldiers - count);

  // Optimistic local update
  if (gs.towers[from.id]) gs.towers[from.id].soldiers = newSoldiers;

  // Write to Firebase
  try {
    await db.ref(`games/${roomId}/towers/${from.id}/soldiers`).set(newSoldiers);
  } catch(e) { return; }

  const dist       = Math.hypot(to.x - from.x, to.y - from.y);
  const travelTime = (dist / SOLDIER_MOVE_SPEED) * 1000;
  const sentAt     = Date.now();
  const arriveAt   = sentAt + travelTime;

  const sg = {
    id: sgId,
    fromTowerId: from.id, toTowerId: to.id,
    count, ownerIndex: gs.playerIndex,
    fromX: from.x, fromY: from.y,
    toX: to.x,    toY: to.y,
    sentAt, arriveAt, travelTime,
    progress: 0,
  };

  gs.soldiers.push({ ...sg });

  // Spawn launch particles
  const cp = mapToCanvas(from.x, from.y);
  spawnParticles(cp.x, cp.y, PLAYER_COLORS[gs.playerIndex], 12);

  try {
    await db.ref(`games/${roomId}/movingSoldiers/${sgId}`).set(sg);
  } catch(e) {}

  setTimeout(() => handleArrival(sg), travelTime);
}

// ===== ARRIVAL =====
async function handleArrival(sg) {
  if (gs.phase !== 'playing') return;
  const roomId = gs.roomId;
  const tRef   = db.ref(`games/${roomId}/towers/${sg.toTowerId}`);

  try {
    await tRef.transaction(tower => {
      if (!tower) return tower;
      if (tower.owner === sg.ownerIndex) {
        tower.soldiers = (tower.soldiers || 0) + sg.count;
      } else {
        const remaining = (tower.soldiers || 0) - sg.count;
        if (remaining <= 0) {
          tower.soldiers = Math.abs(remaining);
          tower.owner    = sg.ownerIndex;
          // notify capture
          db.ref(`games/${roomId}/events`).push({
            type: 'capture', towerId: sg.toTowerId,
            by: sg.ownerIndex, at: Date.now(),
          });
        } else {
          tower.soldiers = remaining;
        }
      }
      return tower;
    });
  } catch(e) {}

  // Impact particles at destination
  const cp = mapToCanvas(sg.toX, sg.toY);
  spawnParticles(cp.x, cp.y, PLAYER_COLORS[sg.ownerIndex], 20);
  gs.screenShake = 6;

  gs.soldiers = gs.soldiers.filter(s => s.id !== sg.id);

  try {
    await db.ref(`games/${roomId}/movingSoldiers/${sg.id}`).remove();
  } catch(e) {}

  await checkWin();
}

// ===== WIN CHECK =====
async function checkWin() {
  const roomId = gs.roomId;
  try {
    const snap = await db.ref(`games/${roomId}/towers`).once('value');
    const towers = snap.val();
    if (!towers) return;
    const owners = new Set(Object.values(towers)
      .filter(t => t.owner >= 0).map(t => t.owner));
    if (owners.size === 1) {
      const winner = [...owners][0];
      await db.ref(`games/${roomId}`).update({ status: 'gameover', winner });
    }
  } catch(e) {}
}

// ===== END GAME =====
function endGame(winnerIdx) {
  gs.phase = 'gameover';
  clearInterval(growthInterval);
  cancelAnimationFrame(animId);
  dbListeners.forEach(fn => fn());
  dbListeners = [];

  const isWin = winnerIdx === gs.playerIndex;
  const titleEl = document.getElementById('gameoverTitle');
  const winnerEl = document.getElementById('winnerText');
  titleEl.textContent = isWin ? '🏆 勝利！' : '💀 失敗';
  titleEl.style.color = isWin ? '#f1c40f' : '#e74c3c';
  winnerEl.textContent = `${PLAYER_EMOJIS[winnerIdx]} ${PLAYER_NAMES[winnerIdx]}方 獲勝！`;

  showScreen('gameoverScreen');
}

// ===== RETURN TO MENU =====
function returnToMenu() {
  clearInterval(growthInterval);
  cancelAnimationFrame(animId);
  dbListeners.forEach(fn => fn());
  dbListeners = [];
  gs = freshState();
  showScreen('menuScreen');
}

// ============================================================
// RENDER LOOP
// ============================================================
function startRenderLoop() {
  lastTimestamp = performance.now();
  function loop(ts) {
    const dt = Math.min((ts - lastTimestamp) / 1000, 0.1);
    lastTimestamp = ts;
    update(dt);
    draw();
    animId = requestAnimationFrame(loop);
  }
  animId = requestAnimationFrame(loop);
}

function update(dt) {
  const now = Date.now();

  // Update soldier progress
  for (const sg of gs.soldiers) {
    const elapsed = now - sg.sentAt;
    sg.progress   = Math.max(0, Math.min(elapsed / sg.travelTime, 1));
  }

  // Update particles
  for (const p of gs.particles) {
    p.x  += p.vx * dt;
    p.y  += p.vy * dt;
    p.vy += 120 * dt; // gravity
    p.life -= dt;
    p.alpha = Math.max(0, p.life / p.maxLife);
    p.r    = p.maxR * p.alpha;
  }
  gs.particles = gs.particles.filter(p => p.life > 0);

  // Screen shake decay
  if (gs.screenShake > 0) gs.screenShake = Math.max(0, gs.screenShake - dt * 40);

  // Update HUD
  updateHUD();
}

function updateHUD() {
  let myTowers = 0, mySoldiers = 0;
  for (const t of Object.values(gs.towers)) {
    if (t.owner === gs.playerIndex) {
      myTowers++;
      mySoldiers += t.soldiers || 0;
    }
  }
  document.getElementById('myTowerCount').textContent = myTowers;
  document.getElementById('mySoldierCount').textContent = Math.floor(mySoldiers);
}

// ============================================================
// DRAWING
// ============================================================
function draw() {
  ctx.save();

  // Screen shake
  if (gs.screenShake > 0) {
    const sx = (Math.random() - 0.5) * gs.screenShake * 2;
    const sy = (Math.random() - 0.5) * gs.screenShake * 2;
    ctx.translate(sx, sy);
  }

  drawBackground();
  drawConnections();
  drawTowers();
  drawSoldiers();
  drawDragLine();
  drawParticles();

  ctx.restore();
}

// ----- Background -----
function drawBackground() {
  // Deep space fill
  ctx.fillStyle = '#070b14';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Subtle grid
  ctx.save();
  ctx.strokeStyle = 'rgba(100,150,255,0.04)';
  ctx.lineWidth   = 1;
  const gs2 = 55;
  for (let x = 0; x < canvas.width; x += gs2) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, canvas.height); ctx.stroke();
  }
  for (let y = 0; y < canvas.height; y += gs2) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(canvas.width, y); ctx.stroke();
  }
  ctx.restore();
}

// ----- Connection lines between player towers -----
function drawConnections() {
  const towers = Object.values(gs.towers);
  ctx.save();
  ctx.lineWidth = 0.5;
  for (let i = 0; i < towers.length; i++) {
    for (let j = i + 1; j < towers.length; j++) {
      const a = towers[i], b = towers[j];
      if (a.owner >= 0 && a.owner === b.owner) {
        const pa = mapToCanvas(a.x, a.y);
        const pb = mapToCanvas(b.x, b.y);
        const col = PLAYER_COLORS[a.owner];
        ctx.strokeStyle = col + '22';
        ctx.beginPath();
        ctx.moveTo(pa.x, pa.y);
        ctx.lineTo(pb.x, pb.y);
        ctx.stroke();
      }
    }
  }
  ctx.restore();
}

// ----- Towers -----
const towerAnimTime = {};   // tower pulse animation phase
function drawTowers() {
  const now = Date.now() / 1000;

  for (const tower of Object.values(gs.towers)) {
    const { x: tx, y: ty } = mapToCanvas(tower.x, tower.y);
    const r   = TOWER_RADIUS;
    const col = tower.owner >= 0 ? PLAYER_COLORS[tower.owner] : NEUTRAL_COLOR;
    const isMe = tower.owner === gs.playerIndex;

    // Pulsing glow for owned towers
    if (tower.owner >= 0) {
      const pulse = 0.5 + 0.5 * Math.sin(now * 2 + tower.x * 0.01);
      const glowR = r * (2.5 + pulse * 0.5);
      const grd = ctx.createRadialGradient(tx, ty, r * 0.3, tx, ty, glowR);
      grd.addColorStop(0, col + '55');
      grd.addColorStop(1, 'transparent');
      ctx.fillStyle = grd;
      ctx.beginPath();
      ctx.arc(tx, ty, glowR, 0, Math.PI * 2);
      ctx.fill();
    }

    // Hexagon shadow
    ctx.save();
    ctx.translate(tx, ty + 3);
    ctx.globalAlpha = 0.25;
    hexPath(ctx, 0, 0, r);
    ctx.fillStyle = '#000';
    ctx.fill();
    ctx.restore();

    // Hexagon body
    ctx.save();
    ctx.translate(tx, ty);

    // Subtle rotation animation for player's own towers
    if (isMe) {
      ctx.rotate(now * 0.3);
    }

    hexPath(ctx, 0, 0, r);

    // Fill with gradient
    const fillGrd = ctx.createRadialGradient(0, -r*0.3, 1, 0, 0, r);
    if (tower.owner >= 0) {
      fillGrd.addColorStop(0, col + 'ee');
      fillGrd.addColorStop(1, col + '77');
    } else {
      fillGrd.addColorStop(0, '#334455ee');
      fillGrd.addColorStop(1, '#22334499');
    }
    ctx.fillStyle = fillGrd;
    ctx.fill();

    // Border
    ctx.strokeStyle = col;
    ctx.lineWidth   = isMe ? 3 : 1.5;
    if (isMe) ctx.shadowBlur = 12, ctx.shadowColor = col;
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.restore();

    // Drag highlight ring
    if (gs.dragFrom && gs.dragFrom.id === tower.id) {
      ctx.save();
      ctx.translate(tx, ty);
      ctx.strokeStyle = col;
      ctx.lineWidth   = 2;
      ctx.globalAlpha = 0.6 + 0.4 * Math.sin(now * 8);
      ctx.beginPath();
      ctx.arc(0, 0, r + 8, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    // Soldier count
    ctx.save();
    ctx.fillStyle   = '#ffffff';
    ctx.font        = `bold ${Math.round(13 * canvas.width / 700 + 2)}px 'Courier New', monospace`;
    ctx.textAlign   = 'center';
    ctx.textBaseline= 'middle';
    ctx.shadowBlur  = 4;
    ctx.shadowColor = '#000';
    ctx.fillText(Math.floor(tower.soldiers), tx, ty);
    ctx.shadowBlur  = 0;
    ctx.restore();

    // Owner emoji above tower
    if (tower.owner >= 0) {
      ctx.save();
      ctx.font        = `${Math.round(11 * canvas.width / 700 + 2)}px sans-serif`;
      ctx.textAlign   = 'center';
      ctx.textBaseline= 'middle';
      ctx.fillText(PLAYER_EMOJIS[tower.owner], tx, ty - r - 12);
      ctx.restore();
    }
  }
}

function hexPath(ctx, cx, cy, r) {
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const a  = (Math.PI / 3) * i - Math.PI / 6;
    const px = cx + r * Math.cos(a);
    const py = cy + r * Math.sin(a);
    i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
  }
  ctx.closePath();
}

// ----- Moving soldiers -----
function drawSoldiers() {
  const now = Date.now() / 1000;

  for (const sg of gs.soldiers) {
    const fx = sg.fromX + (sg.toX - sg.fromX) * sg.progress;
    const fy = sg.fromY + (sg.toY - sg.fromY) * sg.progress;
    const { x, y } = mapToCanvas(fx, fy);
    const col = PLAYER_COLORS[sg.ownerIndex];

    // Trail dots
    for (let i = 1; i <= 5; i++) {
      const tp = Math.max(0, sg.progress - i * 0.04);
      const tx2 = sg.fromX + (sg.toX - sg.fromX) * tp;
      const ty2 = sg.fromY + (sg.toY - sg.fromY) * tp;
      const { x: trx, y: try_ } = mapToCanvas(tx2, ty2);
      ctx.save();
      ctx.globalAlpha = (1 - i / 6) * 0.35;
      ctx.beginPath();
      ctx.arc(trx, try_, 5 - i * 0.5, 0, Math.PI * 2);
      ctx.fillStyle = col;
      ctx.fill();
      ctx.restore();
    }

    // Dashed path line
    const fromC = mapToCanvas(sg.fromX, sg.fromY);
    const toC   = mapToCanvas(sg.toX,   sg.toY);
    ctx.save();
    ctx.strokeStyle = col + '30';
    ctx.lineWidth   = 1;
    ctx.setLineDash([4, 6]);
    ctx.beginPath();
    ctx.moveTo(fromC.x, fromC.y);
    ctx.lineTo(toC.x, toC.y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();

    // Soldier blob with glow
    ctx.save();
    ctx.shadowBlur  = 14;
    ctx.shadowColor = col;
    const pulse = 0.9 + 0.1 * Math.sin(now * 10 + sg.sentAt);
    ctx.beginPath();
    ctx.arc(x, y, 11 * pulse, 0, Math.PI * 2);
    ctx.fillStyle = col;
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = '#ffffffaa';
    ctx.lineWidth   = 1.5;
    ctx.stroke();
    ctx.restore();

    // Count
    ctx.save();
    ctx.fillStyle    = '#fff';
    ctx.font         = 'bold 9px monospace';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(sg.count, x, y);
    ctx.restore();
  }
}

// ----- Drag line -----
function drawDragLine() {
  if (!gs.dragFrom || !gs.dragPos) return;
  const from = mapToCanvas(gs.dragFrom.x, gs.dragFrom.y);
  const to   = gs.dragPos;
  const col  = PLAYER_COLORS[gs.playerIndex];
  const now  = Date.now() / 1000;

  // Animated dashes
  ctx.save();
  ctx.strokeStyle = col + 'cc';
  ctx.lineWidth   = 2.5;
  ctx.setLineDash([8, 5]);
  ctx.lineDashOffset = -(now * 30) % 13;
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x, to.y);
  ctx.stroke();
  ctx.setLineDash([]);

  // Arrowhead
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  ctx.fillStyle = col;
  ctx.shadowBlur  = 8;
  ctx.shadowColor = col;
  ctx.beginPath();
  ctx.moveTo(to.x, to.y);
  ctx.lineTo(to.x - 16 * Math.cos(angle - 0.4), to.y - 16 * Math.sin(angle - 0.4));
  ctx.lineTo(to.x - 16 * Math.cos(angle + 0.4), to.y - 16 * Math.sin(angle + 0.4));
  ctx.closePath();
  ctx.fill();
  ctx.shadowBlur = 0;

  // Count preview
  const liveTower = gs.towers[gs.dragFrom.id];
  if (liveTower) {
    const sendCount = Math.max(1, Math.floor(liveTower.soldiers * DRAG_RATIO));
    const mx = (from.x + to.x) / 2;
    const my = (from.y + to.y) / 2 - 16;
    ctx.fillStyle    = '#fff';
    ctx.font         = 'bold 12px monospace';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`派遣 ${sendCount}`, mx, my);
  }
  ctx.restore();
}

// ----- Particles -----
function spawnParticles(x, y, color, count) {
  for (let i = 0; i < count; i++) {
    const angle = Math.random() * Math.PI * 2;
    const speed = 60 + Math.random() * 150;
    const life  = 0.4 + Math.random() * 0.5;
    gs.particles.push({
      x, y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed - 50,
      color,
      maxLife: life, life,
      maxR: 3 + Math.random() * 4, r: 4,
      alpha: 1,
    });
  }
}

function drawParticles() {
  for (const p of gs.particles) {
    ctx.save();
    ctx.globalAlpha = p.alpha * 0.9;
    ctx.beginPath();
    ctx.arc(p.x, p.y, Math.max(0.5, p.r), 0, Math.PI * 2);
    ctx.fillStyle   = p.color;
    ctx.shadowBlur  = 6;
    ctx.shadowColor = p.color;
    ctx.fill();
    ctx.restore();
  }
}

// ===== BOOT =====
window.addEventListener('load', () => {
  initCanvas();
  showScreen('menuScreen');

  document.getElementById('startMatchBtn').addEventListener('click', startMatchmaking);
  document.getElementById('cancelMatchBtn').addEventListener('click', cancelMatchmaking);
  document.getElementById('backToMenuBtn').addEventListener('click', returnToMenu);
});
