// ===== 遊戲常數 =====
const SOLDIER_GROWTH_INTERVAL = 500; // ms
const SOLDIER_MOVE_SPEED = 120; // px per second
const DRAG_RATIO = 0.8; // 拖曳80%士兵
const TOWER_RADIUS = 32;
const MIN_NEUTRAL_TOWERS = 5;
const MAX_NEUTRAL_TOWERS = 15;
const MAP_PADDING = 80;

const PLAYER_COLORS = ['#e74c3c', '#3498db', '#2ecc71', '#f39c12'];
const PLAYER_COLOR_NAMES = ['紅', '藍', '綠', '橙'];
const PLAYER_EMOJIS = ['🔴', '🔵', '🟢', '🟠'];

// ===== 遊戲狀態 =====
let gameState = {
  phase: 'menu', // menu | matchmaking | playing | gameover
  roomId: null,
  playerId: null,
  playerIndex: null,
  playerCount: 2,
  towers: {},
  soldiers: [], // 飛行中的士兵群
  dragStart: null,
  localSoldierTick: null,
  isHost: false,
  gameStartTime: null,
  winner: null,
};

let canvas, ctx;
let animationId;
let soldierTickInterval;
let dbListeners = [];

// ===== 初始化畫布 =====
function initCanvas() {
  canvas = document.getElementById('gameCanvas');
  ctx = canvas.getContext('2d');
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);
}

function resizeCanvas() {
  const container = document.getElementById('gameContainer');
  canvas.width = container.clientWidth;
  canvas.height = container.clientHeight;
}

// ===== UI 切換 =====
function showScreen(id) {
  ['menuScreen', 'matchmakingScreen', 'gameScreen', 'gameoverScreen'].forEach(s => {
    document.getElementById(s).classList.add('hidden');
  });
  document.getElementById(id).classList.remove('hidden');
}

// ===== 匹配系統 =====
async function startMatchmaking() {
  const count = parseInt(document.getElementById('playerCountSelect').value);
  gameState.playerCount = count;
  gameState.playerId = 'p_' + Math.random().toString(36).substr(2, 9);

  showScreen('matchmakingScreen');
  document.getElementById('matchStatus').textContent = '搜尋中...';
  document.getElementById('matchPlayerCount').textContent = `等待 ${count} 人遊戲`;

  // 尋找等待中的房間
  const waitingRef = db.ref('waiting');
  const snapshot = await waitingRef.once('value');
  const waitingRooms = snapshot.val() || {};

  let targetRoomId = null;

  for (const [roomId, room] of Object.entries(waitingRooms)) {
    if (room.playerCount === count && Object.keys(room.players || {}).length < count) {
      targetRoomId = roomId;
      break;
    }
  }

  if (!targetRoomId) {
    // 創建新房間
    targetRoomId = 'room_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
    gameState.isHost = true;
  }

  gameState.roomId = targetRoomId;
  const roomRef = db.ref(`waiting/${targetRoomId}`);

  // 加入房間
  await roomRef.child('players/' + gameState.playerId).set({
    id: gameState.playerId,
    joinedAt: Date.now()
  });

  await roomRef.update({ playerCount: count });

  // 當玩家斷線時移除
  db.ref(`waiting/${targetRoomId}/players/${gameState.playerId}`).onDisconnect().remove();

  // 監聽房間玩家數量
  const unsubWaiting = roomRef.on('value', async (snap) => {
    const room = snap.val();
    if (!room) return;

    const players = Object.keys(room.players || {});
    const current = players.length;
    const needed = room.playerCount;

    document.getElementById('matchStatus').textContent = `已找到 ${current} / ${needed} 位玩家`;

    if (current >= needed) {
      // 足夠人數，開始遊戲
      roomRef.off('value', unsubWaiting);

      // 指派玩家順序
      const sortedPlayers = Object.values(room.players).sort((a, b) => a.joinedAt - b.joinedAt);
      gameState.playerIndex = sortedPlayers.findIndex(p => p.id === gameState.playerId);

      if (gameState.isHost || gameState.playerIndex === 0) {
        await initGameAsHost(targetRoomId, sortedPlayers);
      } else {
        await waitForGameInit(targetRoomId);
      }
    }
  });
}

async function initGameAsHost(roomId, players) {
  const mapW = 900, mapH = 600;
  const towers = generateTowers(players.length, mapW, mapH);

  const gameData = {
    status: 'playing',
    startTime: Date.now(),
    playerCount: players.length,
    players: players.reduce((acc, p, i) => {
      acc[p.id] = { id: p.id, index: i, color: PLAYER_COLORS[i], alive: true };
      return acc;
    }, {}),
    towers: towers
  };

  await db.ref(`games/${roomId}`).set(gameData);
  await db.ref(`waiting/${roomId}`).remove();

  startGame(roomId, towers);
}

async function waitForGameInit(roomId) {
  return new Promise((resolve) => {
    const ref = db.ref(`games/${roomId}/status`);
    const unsub = ref.on('value', (snap) => {
      if (snap.val() === 'playing') {
        ref.off('value', unsub);
        db.ref(`games/${roomId}`).once('value').then(snap => {
          const data = snap.val();
          startGame(roomId, data.towers);
          resolve();
        });
      }
    });
  });
}

// ===== 生成地圖塔 =====
function generateTowers(playerCount, mapW, mapH) {
  const towers = {};
  const positions = [];

  const minDist = 110;

  function randomPos() {
    let attempts = 0;
    while (attempts < 200) {
      const x = MAP_PADDING + Math.random() * (mapW - MAP_PADDING * 2);
      const y = MAP_PADDING + Math.random() * (mapH - MAP_PADDING * 2);
      if (positions.every(p => Math.hypot(p.x - x, p.y - y) > minDist)) {
        return { x: Math.round(x), y: Math.round(y) };
      }
      attempts++;
    }
    return null;
  }

  // 玩家塔的角落位置
  const cornerPositions = [
    { x: MAP_PADDING + 40, y: MAP_PADDING + 40 },
    { x: mapW - MAP_PADDING - 40, y: mapH - MAP_PADDING - 40 },
    { x: mapW - MAP_PADDING - 40, y: MAP_PADDING + 40 },
    { x: MAP_PADDING + 40, y: mapH - MAP_PADDING - 40 },
  ];

  for (let i = 0; i < playerCount; i++) {
    const pos = cornerPositions[i];
    positions.push(pos);
    towers[`tower_p${i}`] = {
      id: `tower_p${i}`,
      x: pos.x,
      y: pos.y,
      soldiers: 10,
      owner: i, // player index
      isPlayerStart: true
    };
  }

  // 中立塔
  const neutralCount = MIN_NEUTRAL_TOWERS + Math.floor(Math.random() * (MAX_NEUTRAL_TOWERS - MIN_NEUTRAL_TOWERS + 1));
  for (let i = 0; i < neutralCount; i++) {
    const pos = randomPos();
    if (!pos) break;
    positions.push(pos);
    towers[`tower_n${i}`] = {
      id: `tower_n${i}`,
      x: pos.x,
      y: pos.y,
      soldiers: 10,
      owner: -1, // neutral
      isPlayerStart: false
    };
  }

  return towers;
}

// ===== 開始遊戲 =====
function startGame(roomId, towersData) {
  gameState.phase = 'playing';
  gameState.roomId = roomId;
  gameState.towers = JSON.parse(JSON.stringify(towersData));
  gameState.soldiers = [];

  showScreen('gameScreen');
  resizeCanvas();

  // 更新 HUD
  const myColor = PLAYER_COLORS[gameState.playerIndex];
  document.getElementById('myColorDot').style.background = myColor;
  document.getElementById('myColorLabel').textContent = PLAYER_COLOR_NAMES[gameState.playerIndex] + '方';

  setupInputHandlers();
  setupFirebaseListeners(roomId);
  startSoldierTick(roomId);
  startRenderLoop();
}

// ===== Firebase 監聽 =====
function setupFirebaseListeners(roomId) {
  // 監聽塔狀態
  const towersRef = db.ref(`games/${roomId}/towers`);
  towersRef.on('value', snap => {
    const data = snap.val();
    if (data) {
      // 合併飛行中士兵的本地狀態
      gameState.towers = data;
    }
  });
  dbListeners.push(() => towersRef.off());

  // 監聽飛行士兵（child_added 顯示動畫，child_removed 清除）
  const soldiersRef = db.ref(`games/${roomId}/movingSoldiers`);

  soldiersRef.on('child_added', snap => {
    const sg = snap.val();
    if (!sg) return;
    // 自己發的已經在本地了，不重複加
    if (gameState.soldiers.find(s => s.id === sg.id)) return;
    // 計算目前進度（考慮網路延遲）
    const now = Date.now();
    const elapsed = now - sg.sentAt;
    const progress = Math.max(0, Math.min(elapsed / sg.travelTime, 0.98));
    gameState.soldiers.push({ ...sg, progress });
  });

  soldiersRef.on('child_removed', snap => {
    const sg = snap.val();
    if (sg) gameState.soldiers = gameState.soldiers.filter(s => s.id !== sg.id);
  });

  dbListeners.push(() => soldiersRef.off());

  // 監聽遊戲結束
  const statusRef = db.ref(`games/${roomId}/status`);
  statusRef.on('value', snap => {
    if (snap.val() === 'gameover') {
      db.ref(`games/${roomId}/winner`).once('value').then(w => {
        endGame(w.val());
      });
    }
  });
  dbListeners.push(() => statusRef.off());
}

// ===== 士兵增長（只有 host 執行，寫入 Firebase）=====
function startSoldierTick(roomId) {
  // 所有玩家本地各自算，但只有塔的 owner 更新自己的塔
  soldierTickInterval = setInterval(async () => {
    if (gameState.phase !== 'playing') return;

    const updates = {};
    for (const [tid, tower] of Object.entries(gameState.towers)) {
      if (tower.owner === gameState.playerIndex) {
        updates[`games/${roomId}/towers/${tid}/soldiers`] = (tower.soldiers || 0) + 1;
      }
    }
    if (Object.keys(updates).length > 0) {
      await db.ref().update(updates);
    }
  }, SOLDIER_GROWTH_INTERVAL);
}

// ===== 拖曳輸入 =====
function setupInputHandlers() {
  let dragFromTower = null;
  let mousePos = { x: 0, y: 0 };

  function getMousePos(e) {
    const rect = canvas.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    return {
      x: (clientX - rect.left) * (canvas.width / rect.width),
      y: (clientY - rect.top) * (canvas.height / rect.height)
    };
  }

  function getTowerAt(pos) {
    for (const tower of Object.values(gameState.towers)) {
      const tx = tower.x * canvas.width / 900;
      const ty = tower.y * canvas.height / 600;
      if (Math.hypot(pos.x - tx, pos.y - ty) < TOWER_RADIUS) {
        return tower;
      }
    }
    return null;
  }

  function onPointerDown(e) {
    e.preventDefault();
    const pos = getMousePos(e);
    const tower = getTowerAt(pos);
    if (tower && tower.owner === gameState.playerIndex && tower.soldiers > 1) {
      dragFromTower = tower;
      gameState.dragStart = { x: pos.x, y: pos.y, tower };
    }
  }

  function onPointerMove(e) {
    e.preventDefault();
    const pos = getMousePos(e);
    mousePos = pos;
    if (gameState.dragStart) {
      gameState.dragStart.currentX = pos.x;
      gameState.dragStart.currentY = pos.y;
    }
  }

  function onPointerUp(e) {
    e.preventDefault();
    if (!dragFromTower) return;

    const pos = getMousePos(e);
    const targetTower = getTowerAt(pos);

    if (targetTower && targetTower.id !== dragFromTower.id) {
      sendSoldiers(dragFromTower, targetTower);
    }

    dragFromTower = null;
    gameState.dragStart = null;
  }

  canvas.addEventListener('mousedown', onPointerDown);
  canvas.addEventListener('mousemove', onPointerMove);
  canvas.addEventListener('mouseup', onPointerUp);
  canvas.addEventListener('touchstart', onPointerDown, { passive: false });
  canvas.addEventListener('touchmove', onPointerMove, { passive: false });
  canvas.addEventListener('touchend', onPointerUp, { passive: false });
}

// ===== 派遣士兵 =====
async function sendSoldiers(fromTower, toTower) {
  const count = Math.floor(fromTower.soldiers * DRAG_RATIO);
  if (count < 1) return;

  const roomId = gameState.roomId;
  const soldierGroupId = 'sg_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);

  // 立即扣除兵力
  const newFromSoldiers = Math.max(0, fromTower.soldiers - count);
  await db.ref(`games/${roomId}/towers/${fromTower.id}/soldiers`).set(newFromSoldiers);

  // 計算飛行時間（基於地圖座標距離）
  const dist = Math.hypot(toTower.x - fromTower.x, toTower.y - fromTower.y);
  const travelTime = (dist / SOLDIER_MOVE_SPEED) * 1000;
  const sentAt = Date.now();
  const arriveAt = sentAt + travelTime;

  const soldierGroup = {
    id: soldierGroupId,
    fromTowerId: fromTower.id,
    toTowerId: toTower.id,
    count: count,
    ownerIndex: gameState.playerIndex,
    fromX: fromTower.x,
    fromY: fromTower.y,
    toX: toTower.x,
    toY: toTower.y,
    sentAt: sentAt,
    arriveAt: arriveAt,
    travelTime: travelTime,
    progress: 0
  };

  // 加入本地動畫
  gameState.soldiers.push({ ...soldierGroup });

  // 寫入 Firebase（讓其他玩家看到動畫）
  await db.ref(`games/${roomId}/movingSoldiers/${soldierGroupId}`).set(soldierGroup);

  // 只有發送方負責處理抵達
  setTimeout(() => handleSoldierArrival(soldierGroup), travelTime);
}

// ===== 士兵抵達 =====
async function handleSoldierArrival(sg) {
  if (gameState.phase !== 'playing') return;

  const roomId = gameState.roomId;
  const towerRef = db.ref(`games/${roomId}/towers/${sg.toTowerId}`);

  // 用 transaction 確保原子性
  await towerRef.transaction(tower => {
    if (!tower) return tower;

    if (tower.owner === sg.ownerIndex) {
      // 友方塔：增援
      tower.soldiers = (tower.soldiers || 0) + sg.count;
    } else {
      // 敵方或中立塔：戰鬥
      const remaining = (tower.soldiers || 0) - sg.count;
      if (remaining <= 0) {
        tower.soldiers = Math.abs(remaining);
        tower.owner = sg.ownerIndex;
      } else {
        tower.soldiers = remaining;
      }
    }
    return tower;
  });

  // 移除飛行士兵資料
  await db.ref(`games/${roomId}/movingSoldiers/${sg.id}`).remove();

  // 移除本地動畫
  gameState.soldiers = gameState.soldiers.filter(s => s.id !== sg.id);

  // 檢查勝利條件
  await checkWinCondition();
}

// ===== 勝利條件 =====
async function checkWinCondition() {
  const roomId = gameState.roomId;
  const snap = await db.ref(`games/${roomId}/towers`).once('value');
  const towers = snap.val();
  if (!towers) return;

  const owners = new Set(Object.values(towers).filter(t => t.owner >= 0).map(t => t.owner));

  // 確認每個玩家是否還有塔
  for (let i = 0; i < gameState.playerCount; i++) {
    if (!owners.has(i)) {
      // 玩家i被消滅了
    }
  }

  if (owners.size === 1) {
    const winner = [...owners][0];
    await db.ref(`games/${roomId}`).update({ status: 'gameover', winner });
  }
}

// ===== 遊戲結束 =====
function endGame(winnerIndex) {
  gameState.phase = 'gameover';
  clearInterval(soldierTickInterval);
  dbListeners.forEach(off => off());
  dbListeners = [];

  const isWinner = winnerIndex === gameState.playerIndex;
  document.getElementById('gameoverTitle').textContent = isWinner ? '🏆 勝利！' : '💀 失敗';
  document.getElementById('gameoverTitle').style.color = isWinner ? '#f1c40f' : '#e74c3c';
  document.getElementById('winnerText').textContent = `${PLAYER_EMOJIS[winnerIndex]} ${PLAYER_COLOR_NAMES[winnerIndex]}方 獲勝！`;

  showScreen('gameoverScreen');
  cancelAnimationFrame(animationId);
}

// ===== 渲染迴圈 =====
function startRenderLoop() {
  let lastTime = 0;

  function render(timestamp) {
    const dt = (timestamp - lastTime) / 1000;
    lastTime = timestamp;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // 更新飛行士兵進度
    updateMovingSoldiers(dt);

    // 繪製
    drawBackground();
    drawTowers();
    drawMovingSoldiers();
    drawDragLine();
    drawHUD();

    animationId = requestAnimationFrame(render);
  }

  animationId = requestAnimationFrame(render);
}

// ===== 更新士兵動畫 =====
function updateMovingSoldiers(dt) {
  const now = Date.now();
  gameState.soldiers.forEach(sg => {
    const total = sg.arriveAt - sg.sentAt;
    const elapsed = now - sg.sentAt;
    sg.progress = Math.min(1, elapsed / total);
  });
}

// ===== 繪製背景 =====
function drawBackground() {
  ctx.fillStyle = '#0a0e1a';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // 網格線
  ctx.strokeStyle = 'rgba(255,255,255,0.04)';
  ctx.lineWidth = 1;
  const gridSize = 60;
  for (let x = 0; x < canvas.width; x += gridSize) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, canvas.height); ctx.stroke();
  }
  for (let y = 0; y < canvas.height; y += gridSize) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(canvas.width, y); ctx.stroke();
  }
}

// ===== 繪製塔 =====
function drawTowers() {
  const scaleX = canvas.width / 900;
  const scaleY = canvas.height / 600;

  for (const tower of Object.values(gameState.towers)) {
    const tx = tower.x * scaleX;
    const ty = tower.y * scaleY;
    const r = TOWER_RADIUS;

    const color = tower.owner >= 0 ? PLAYER_COLORS[tower.owner] : '#7f8c8d';
    const isMyTower = tower.owner === gameState.playerIndex;

    // 外光暈
    if (tower.owner >= 0) {
      const glow = ctx.createRadialGradient(tx, ty, r * 0.5, tx, ty, r * 2);
      glow.addColorStop(0, color + '40');
      glow.addColorStop(1, 'transparent');
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(tx, ty, r * 2, 0, Math.PI * 2);
      ctx.fill();
    }

    // 主體六角形
    ctx.save();
    ctx.translate(tx, ty);
    hexagon(ctx, 0, 0, r);
    ctx.fillStyle = tower.owner >= 0 ? color + 'cc' : '#2c3e5099';
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = isMyTower ? 3 : 1.5;
    ctx.stroke();
    ctx.restore();

    // 士兵數字
    ctx.fillStyle = '#fff';
    ctx.font = `bold ${Math.round(14 * scaleX + 2)}px 'Courier New', monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(Math.floor(tower.soldiers), tx, ty);

    // 玩家標記
    if (tower.owner >= 0) {
      ctx.font = `${Math.round(10 * scaleX + 2)}px sans-serif`;
      ctx.fillStyle = color;
      ctx.fillText(PLAYER_EMOJIS[tower.owner], tx, ty - r - 10);
    }
  }
}

function hexagon(ctx, x, y, r) {
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 3) * i - Math.PI / 6;
    const px = x + r * Math.cos(angle);
    const py = y + r * Math.sin(angle);
    i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
  }
  ctx.closePath();
}

// ===== 繪製移動士兵 =====
function drawMovingSoldiers() {
  const scaleX = canvas.width / 900;
  const scaleY = canvas.height / 600;

  for (const sg of gameState.soldiers) {
    const x = (sg.fromX + (sg.toX - sg.fromX) * sg.progress) * scaleX;
    const y = (sg.fromY + (sg.toY - sg.fromY) * sg.progress) * scaleY;
    const color = PLAYER_COLORS[sg.ownerIndex];

    // 軌跡線
    ctx.strokeStyle = color + '30';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(sg.fromX * scaleX, sg.fromY * scaleY);
    ctx.lineTo(sg.toX * scaleX, sg.toY * scaleY);
    ctx.stroke();
    ctx.setLineDash([]);

    // 士兵球
    ctx.beginPath();
    ctx.arc(x, y, 10, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // 數字
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 9px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(sg.count, x, y);
  }
}

// ===== 繪製拖曳線 =====
function drawDragLine() {
  if (!gameState.dragStart || !gameState.dragStart.currentX) return;
  const ds = gameState.dragStart;
  const color = PLAYER_COLORS[gameState.playerIndex];

  ctx.strokeStyle = color + 'aa';
  ctx.lineWidth = 2;
  ctx.setLineDash([6, 4]);
  ctx.beginPath();
  ctx.moveTo(ds.x, ds.y);
  ctx.lineTo(ds.currentX, ds.currentY);
  ctx.stroke();
  ctx.setLineDash([]);

  // 箭頭
  const angle = Math.atan2(ds.currentY - ds.y, ds.currentX - ds.x);
  const ax = ds.currentX, ay = ds.currentY;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(ax, ay);
  ctx.lineTo(ax - 12 * Math.cos(angle - 0.4), ay - 12 * Math.sin(angle - 0.4));
  ctx.lineTo(ax - 12 * Math.cos(angle + 0.4), ay - 12 * Math.sin(angle + 0.4));
  ctx.closePath();
  ctx.fill();
}

// ===== HUD =====
function drawHUD() {
  // 統計我的塔數和士兵總數
  let myTowers = 0, mySoldiers = 0;
  for (const t of Object.values(gameState.towers)) {
    if (t.owner === gameState.playerIndex) {
      myTowers++;
      mySoldiers += t.soldiers;
    }
  }
  document.getElementById('myTowerCount').textContent = myTowers;
  document.getElementById('mySoldierCount').textContent = Math.floor(mySoldiers);
}

// ===== 返回主選單 =====
function returnToMenu() {
  gameState = {
    phase: 'menu', roomId: null, playerId: null, playerIndex: null,
    playerCount: 2, towers: {}, soldiers: [], dragStart: null,
    localSoldierTick: null, isHost: false, gameStartTime: null, winner: null
  };
  clearInterval(soldierTickInterval);
  cancelAnimationFrame(animationId);
  dbListeners.forEach(off => off());
  dbListeners = [];
  showScreen('menuScreen');
}

// ===== 啟動 =====
window.addEventListener('load', () => {
  initCanvas();
  showScreen('menuScreen');

  document.getElementById('startMatchBtn').addEventListener('click', startMatchmaking);
  document.getElementById('cancelMatchBtn').addEventListener('click', returnToMenu);
  document.getElementById('backToMenuBtn').addEventListener('click', returnToMenu);
});
