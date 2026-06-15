// ============================================================
// Tower Wars — Lobby System (room-based matchmaking)
// Replaces the old auto-matchmaking flow
// ============================================================

const ROOM_TIMEOUT_MS   = 2 * 60 * 1000; // 2 minutes
const MAX_PLAYERS       = 4;
const AI_NAMES          = ['AI-阿紅','AI-阿藍','AI-阿綠','AI-阿橙'];

// AI difficulty tiers
const AI_INTERVAL_MS    = 1800;  // how often AI makes a decision

// ── Lobby state (separate from game state gs) ──
let lobby = freshLobby();
function freshLobby() {
  return {
    playerId: null,
    playerName: null,
    roomId: null,
    isHost: false,
    roomTimeoutHandle: null,
    roomListUnsub: null,
    roomUnsub: null,
    aiInterval: null,
  };
}

// ============================================================
//  SCREENS — uses showScreen() defined in game.js
// ============================================================
function showLobbyScreen(id){ showScreen(id); }

// ============================================================
//  ENTRY: open lobby
// ============================================================
function openLobby() {
  if (!lobby.playerId) {
    lobby.playerId = 'p_' + Math.random().toString(36).substr(2,9);
    lobby.playerName = '玩家' + lobby.playerId.slice(-4).toUpperCase();
  }
  showLobbyScreen('lobbyListScreen');
  subscribeRoomList();
}

// ============================================================
//  ROOM LIST
// ============================================================
function subscribeRoomList() {
  if (lobby.roomListUnsub) { lobby.roomListUnsub(); lobby.roomListUnsub=null; }
  const ref = db.ref('rooms');
  const unsub = ref.on('value', snap => {
    const rooms = snap.val() || {};
    renderRoomList(rooms);
  });
  lobby.roomListUnsub = () => ref.off('value', unsub);
}

function renderRoomList(rooms) {
  const list = document.getElementById('roomListContainer');
  const entries = Object.values(rooms).filter(r => r.status === 'waiting');
  if (entries.length === 0) {
    list.innerHTML = '<div class="room-empty">目前沒有開放的房間</div>';
    return;
  }
  list.innerHTML = entries.map(r => {
    const cur = Object.keys(r.players||{}).length + (r.ais?.length||0);
    const full = cur >= MAX_PLAYERS;
    return `<div class="room-entry ${full?'room-full':''}">
      <div class="room-entry-name">${escHtml(r.name||r.id)}</div>
      <div class="room-entry-info">
        ${cur}/${MAX_PLAYERS} 人
        ${r.ais?.length ? `· ${r.ais.length} AI` : ''}
      </div>
      <button class="btn-sm" onclick="joinRoom('${r.id}')" ${full?'disabled':''}>
        ${full?'已滿':'加入'}
      </button>
    </div>`;
  }).join('');
}

function escHtml(s){ return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

// ============================================================
//  CREATE ROOM
// ============================================================
async function createRoom() {
  const nameInput = document.getElementById('newRoomNameInput').value.trim();
  if (!nameInput) { alert('請輸入房間名稱'); return; }
  if (nameInput.length > 20) { alert('房間名稱最多20字'); return; }

  const roomId = 'room_' + Date.now() + '_' + Math.random().toString(36).substr(2,4);
  const room = {
    id: roomId,
    name: nameInput,
    hostPlayerId: lobby.playerId,
    status: 'waiting',
    createdAt: Date.now(),
    players: {
      [lobby.playerId]: { id: lobby.playerId, name: lobby.playerName, joinedAt: Date.now(), troop: gs.selectedTroop }
    },
    ais: [],
  };

  try {
    await db.ref(`rooms/${roomId}`).set(room);
    db.ref(`rooms/${roomId}/players/${lobby.playerId}`).onDisconnect().remove();
    // Auto-dissolve after 2 minutes
    db.ref(`rooms/${roomId}/createdAt`).onDisconnect().remove();
  } catch(e) { alert('建立失敗，請重試'); return; }

  lobby.roomId = roomId;
  lobby.isHost = true;
  if (lobby.roomListUnsub) { lobby.roomListUnsub(); lobby.roomListUnsub=null; }

  // Auto-dissolve timer (host side)
  lobby.roomTimeoutHandle = setTimeout(() => dissolveRoom(), ROOM_TIMEOUT_MS);

  enterRoomScreen(roomId);
}

// ============================================================
//  JOIN ROOM
// ============================================================
async function joinRoom(roomId) {
  // Check room still exists and not full
  const snap = await db.ref(`rooms/${roomId}`).once('value');
  const room = snap.val();
  if (!room || room.status !== 'waiting') { alert('房間不存在或已開始'); return; }
  const cur = Object.keys(room.players||{}).length + (room.ais?.length||0);
  if (cur >= MAX_PLAYERS) { alert('房間已滿'); return; }

  await db.ref(`rooms/${roomId}/players/${lobby.playerId}`).set({
    id: lobby.playerId, name: lobby.playerName, joinedAt: Date.now(), troop: gs.selectedTroop
  });
  db.ref(`rooms/${roomId}/players/${lobby.playerId}`).onDisconnect().remove();

  lobby.roomId = roomId;
  lobby.isHost = false;
  if (lobby.roomListUnsub) { lobby.roomListUnsub(); lobby.roomListUnsub=null; }

  enterRoomScreen(roomId);
}

async function joinRoomByCode() {
  const code = document.getElementById('joinRoomCodeInput').value.trim();
  if (!code) { alert('請輸入房間名稱'); return; }
  // Search by name
  const snap = await db.ref('rooms').orderByChild('name').equalTo(code).once('value');
  const rooms = snap.val();
  if (!rooms) { alert('找不到該房間'); return; }
  const roomId = Object.keys(rooms)[0];
  joinRoom(roomId);
}

// ============================================================
//  ROOM SCREEN
// ============================================================
function enterRoomScreen(roomId) {
  showLobbyScreen('lobbyRoomScreen');
  subscribeRoom(roomId);
}

function subscribeRoom(roomId) {
  if (lobby.roomUnsub) { lobby.roomUnsub(); lobby.roomUnsub=null; }
  const ref = db.ref(`rooms/${roomId}`);
  const unsub = ref.on('value', snap => {
    const room = snap.val();
    if (!room) { handleRoomDissolved(); return; }
    if (room.status === 'starting') return; // game starting, ignore
    renderRoomScreen(room);
  });
  lobby.roomUnsub = () => ref.off('value', unsub);

  // Listen for game start signal
  const gameRef = db.ref(`games/${roomId}/status`);
  const gameUnsub = gameRef.on('value', snap => {
    if (snap.val() === 'playing') {
      gameRef.off('value', gameUnsub);
      if (lobby.roomUnsub) { lobby.roomUnsub(); lobby.roomUnsub=null; }
      db.ref(`games/${roomId}`).once('value').then(snap => {
        const data = snap.val(); if (!data) return;
        const allPlayers = Object.values(data.players).sort((a,b)=>a.joinedAt-b.joinedAt);
        gs.playerIndex = allPlayers.findIndex(p => p.id === lobby.playerId);
        gs.playerId = lobby.playerId;
        gs.roomId = roomId;
        startGame(roomId, data.towers, data.startTime, data);
        // If host, run AI
        if (lobby.isHost && data.ais && data.ais.length>0) startAI(data);
      });
    }
  });
}

function renderRoomScreen(room) {
  const isHost = room.hostPlayerId === lobby.playerId;
  const players = Object.values(room.players||{}).sort((a,b)=>a.joinedAt-b.joinedAt);
  const ais = room.ais || [];
  const total = players.length + ais.length;

  document.getElementById('roomScreenTitle').textContent = room.name || room.id;

  // Player list
  const pList = document.getElementById('roomPlayerList');
  pList.innerHTML = players.map((p,i) => `
    <div class="room-player ${p.id===lobby.playerId?'room-player-me':''}">
      <span class="room-player-color" style="background:${PLAYER_COLORS[i]}"></span>
      <span class="room-player-name">${escHtml(p.name||p.id)}</span>
      <span class="room-player-troop">${TROOPS[p.troop||'warrior']?.icon||''} ${TROOPS[p.troop||'warrior']?.label||''}</span>
      ${room.hostPlayerId===p.id ? '<span class="room-host-badge">房主</span>' : ''}
    </div>
  `).join('') + ais.map((ai,i) => `
    <div class="room-player room-player-ai">
      <span class="room-player-color" style="background:${PLAYER_COLORS[players.length+i]}"></span>
      <span class="room-player-name">${escHtml(ai.name)}</span>
      <span class="room-player-troop">${TROOPS[ai.troop||'warrior']?.icon||''} AI</span>
      ${isHost ? `<button class="btn-xs btn-danger" onclick="removeAI(${i})">✕</button>` : ''}
    </div>
  `).join('');

  // Host controls
  document.getElementById('hostControls').classList.toggle('hidden', !isHost);
  const addAiBtn = document.getElementById('addAiBtn');
  addAiBtn.disabled = total >= MAX_PLAYERS;

  // Start button: need at least 2 total
  const startBtn = document.getElementById('startGameBtn');
  startBtn.disabled = total < 2;
  startBtn.textContent = `▶ 開始遊戲 (${total}人)`;

  // Timer
  const elapsed = Date.now() - (room.createdAt||Date.now());
  const remaining = Math.max(0, ROOM_TIMEOUT_MS - elapsed);
  const mins = Math.floor(remaining/60000);
  const secs = Math.floor((remaining%60000)/1000);
  document.getElementById('roomTimer').textContent =
    `房間將在 ${mins}:${secs.toString().padStart(2,'0')} 後自動解散`;
}

function handleRoomDissolved() {
  clearTimeout(lobby.roomTimeoutHandle);
  alert('房間已解散');
  leaveRoom();
}

// ============================================================
//  HOST ACTIONS
// ============================================================
async function addAI() {
  const room = (await db.ref(`rooms/${lobby.roomId}`).once('value')).val();
  if (!room) return;
  const total = Object.keys(room.players||{}).length + (room.ais||[]).length;
  if (total >= MAX_PLAYERS) return;
  const ais = room.ais || [];
  const aiIndex = ais.length;
  const troop = TROOP_KEYS[Math.floor(Math.random()*TROOP_KEYS.length)];
  ais.push({ name: AI_NAMES[aiIndex] || `AI-${aiIndex+1}`, troop, isAI: true });
  await db.ref(`rooms/${lobby.roomId}/ais`).set(ais);
}

async function removeAI(index) {
  const room = (await db.ref(`rooms/${lobby.roomId}`).once('value')).val();
  if (!room) return;
  const ais = (room.ais||[]).filter((_,i)=>i!==index);
  await db.ref(`rooms/${lobby.roomId}/ais`).set(ais);
}

async function dissolveRoom() {
  if (!lobby.isHost || !lobby.roomId) return;
  clearTimeout(lobby.roomTimeoutHandle);
  await db.ref(`rooms/${lobby.roomId}`).remove();
}

async function startGameFromRoom() {
  if (!lobby.isHost || !lobby.roomId) return;
  const snap = await db.ref(`rooms/${lobby.roomId}`).once('value');
  const room = snap.val(); if (!room) return;

  const humanPlayers = Object.values(room.players||{}).sort((a,b)=>a.joinedAt-b.joinedAt);
  const aiPlayers    = (room.ais||[]).map((ai,i) => ({
    id: 'ai_'+i, name: ai.name, troop: ai.troop||'warrior',
    joinedAt: Date.now()+i+1, isAI: true,
  }));
  const allPlayers = [...humanPlayers, ...aiPlayers];

  const startTime = Date.now();
  const towers = generateTowers(allPlayers.length, allPlayers);
  const gameData = {
    status: 'playing', startTime,
    playerCount: allPlayers.length,
    players: allPlayers.reduce((acc,p,i) => {
      acc[p.id] = { id:p.id, name:p.name||p.id, index:i, joinedAt:p.joinedAt,
                    troop:p.troop||'warrior', isAI:p.isAI||false };
      return acc;
    }, {}),
    towers,
    ais: aiPlayers.map(p=>p.id),
  };

  await db.ref(`games/${lobby.roomId}`).set(gameData);
  // Remove room from lobby list (game started)
  await db.ref(`rooms/${lobby.roomId}`).remove();
  clearTimeout(lobby.roomTimeoutHandle);
}

// ============================================================
//  LEAVE ROOM
// ============================================================
async function leaveRoom() {
  clearTimeout(lobby.roomTimeoutHandle);
  if (lobby.roomUnsub) { lobby.roomUnsub(); lobby.roomUnsub=null; }

  if (lobby.roomId && lobby.playerId) {
    if (lobby.isHost) {
      await db.ref(`rooms/${lobby.roomId}`).remove();
    } else {
      await db.ref(`rooms/${lobby.roomId}/players/${lobby.playerId}`).remove();
    }
  }

  lobby = freshLobby();
  lobby.playerId = 'p_' + Math.random().toString(36).substr(2,9);
  lobby.playerName = '玩家' + lobby.playerId.slice(-4).toUpperCase();

  showLobbyScreen('lobbyListScreen');
  subscribeRoomList();
}

// ============================================================
//  AI ENGINE (runs on host client only)
// ============================================================
function startAI(gameData) {
  const aiIds = new Set(gameData.ais||[]);
  if (aiIds.size===0) return;

  lobby.aiInterval = setInterval(async () => {
    if (gs.phase !== 'playing') { clearInterval(lobby.aiInterval); return; }

    for (const aiId of aiIds) {
      const aiPlayer = Object.values(gs.towers).length ? null : null;
      // Find AI's player index from game data
      const aiInfo = gameData.players[aiId]; if (!aiInfo) continue;
      const aiIndex = aiInfo.index;

      // Get AI's towers
      const myTowers = Object.values(gs.towers).filter(t => t.owner===aiIndex&&t.soldiers>2);
      if (myTowers.length===0) continue;

      // Pick strongest source tower
      const src = myTowers.reduce((a,b) => a.soldiers>b.soldiers?a:b);
      if (src.soldiers < 4) continue;

      // Pick target: prefer weakest enemy/neutral tower
      const targets = Object.values(gs.towers)
        .filter(t => t.owner!==aiIndex)
        .sort((a,b) => a.soldiers-b.soldiers);
      if (targets.length===0) continue;

      // Bias toward neutral first, then weakest enemy
      const neutralTargets = targets.filter(t=>t.owner<0);
      const target = neutralTargets.length>0 ? neutralTargets[0] : targets[0];

      // Send half soldiers
      const count = Math.max(1, Math.floor(src.soldiers*0.5));
      const newSold = Math.max(0, src.soldiers-count);
      const troop = src.troop||'warrior';
      const speed = BASE_MOVE_SPEED*TROOPS[troop].speed;
      const dist = Math.hypot(target.x-src.x, target.y-src.y);
      const travelTime = (dist/speed)*1000;
      const sentAt = Date.now();
      const sgId = 'sg_'+sentAt+'_ai'+Math.random().toString(36).substr(2,5);

      const sg = {
        id:sgId, fromTowerId:src.id, toTowerId:target.id,
        count, ownerIndex:aiIndex,
        fromX:src.x, fromY:src.y, toX:target.x, toY:target.y,
        sentAt, travelTime, troop, progress:0,
      };

      // Optimistic local update
      if (gs.towers[src.id]) gs.towers[src.id].soldiers = newSold;

      const roomId = gs.roomId;
      try {
        await db.ref(`games/${roomId}/towers/${src.id}/soldiers`).set(newSold);
        await db.ref(`games/${roomId}/movingSoldiers/${sgId}`).set(sg);
        gs.soldiers.push({...sg});
        // AI arrival (host handles)
        setTimeout(()=>handleArrival(sg), travelTime);
      } catch(e){}
    }
  }, AI_INTERVAL_MS);
}

// ============================================================
//  TROOP SELECT (lobby-aware version)
// ============================================================
function openTroopSelectFromLobby() {
  gs.selectedTroop = gs.selectedTroop || 'warrior';
  showLobbyScreen('troopSelectScreen');
  renderTroopCards();
  // After confirming troop, go back to lobby
  document.getElementById('troopConfirmBtn').onclick = async () => {
    // Update troop in room if already in one
    if (lobby.roomId && lobby.playerId) {
      try { await db.ref(`rooms/${lobby.roomId}/players/${lobby.playerId}/troop`).set(gs.selectedTroop); }catch(e){}
    }
    showLobbyScreen('lobbyRoomScreen');
  };
  document.getElementById('troopBackBtn').onclick = () => showLobbyScreen('lobbyRoomScreen');
}

// ============================================================
//  RETURN TO LOBBY after game
// ============================================================
function returnToLobby() {
  clearInterval(lobby.aiInterval);
  clearInterval(growthInterval);
  clearInterval(archerInterval);
  cancelAnimationFrame(animId);
  dbListeners.forEach(fn=>fn()); dbListeners=[];
  gs = freshState();
  lobby.roomId = null;
  lobby.isHost = false;
  showLobbyScreen('lobbyListScreen');
  subscribeRoomList();
}
