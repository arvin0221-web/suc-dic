// ============================================================
// Tower Wars — v5
// NEW: Troop types, mid-path combat, archer tick, troop selection
// FIX: Defect locked for first 30s, enemy soldier animations
// ============================================================

// ===== CONSTANTS =====
const SOLDIER_GROWTH_INTERVAL = 600;
const SOLDIER_GROWTH_AMOUNT   = 1;
const BASE_MOVE_SPEED         = 150;  // map-px/s
const DRAG_RATIO              = 0.5;
const TOWER_RADIUS            = 30;
const MAP_W = 900, MAP_H = 600;
const MAP_PADDING = 90;
const MIN_NEUTRAL = 6, MAX_NEUTRAL = 12;
const DEFECT_LOCK_SECS = 30;
const ARCHER_TICK_MS   = 5000;
const ARCHER_DMG       = 0.1;

// ===== TROOP TYPES =====
// speed multiplier, pathPower (mid-fight), defencePower, label, icon, color tint
const TROOPS = {
  cavalry:  { speed:3.0,  pathPow:1.0, defPow:1.0, label:'騎兵', icon:'🐴', tint:'#ffe066' },
  warrior:  { speed:1.0,  pathPow:1.5, defPow:1.0, label:'戰士', icon:'⚔️',  tint:'#ff8c42' },
  shielder: { speed:1.0,  pathPow:1.0, defPow:1.5, label:'盾兵', icon:'🛡️',  tint:'#4fc3f7' },
  heavy:    { speed:0.25, pathPow:2.0, defPow:1.0, label:'重甲', icon:'🪖',  tint:'#b0bec5' },
  archer:   { speed:1.0,  pathPow:1.0, defPow:1.0, label:'弓手', icon:'🏹',  tint:'#a5d6a7' },
};
const TROOP_KEYS = Object.keys(TROOPS);
const NEUTRAL_TROOPS = TROOP_KEYS; // neutral towers pick randomly

const PLAYER_COLORS = ['#ff4757','#2f86ff','#2ed573','#ffa502'];
const PLAYER_NAMES  = ['紅','藍','綠','橙'];
const PLAYER_EMOJIS = ['🔴','🔵','🟢','🟠'];
const NEUTRAL_COLOR = '#8899aa';

// ===== STATE =====
let gs = freshState();
function freshState() {
  return {
    phase: 'menu',               // menu | troopSelect | matchmaking | playing | gameover
    selectedTroop: 'warrior',    // chosen before match
    roomId: null, playerId: null,
    playerIndex: null, playerCount: 2,
    gameStartAt: 0,
    towers: {}, soldiers: [],
    combatEvents: new Set(),     // ids of mid-path combats already processed
    archerTimers: [],
    dragFrom: null, dragPos: null,
    skillMode: null,
    particles: [], shockwaves: [], fireSweep: null, defectFlash: null,
    screenShake: 0, winner: null,
    skills: { napalm:{ used:false }, defect:{ used:false } },
  };
}

let canvas, ctx, animId, growthInterval, archerInterval;
let dbListeners = [], lastTimestamp = 0;

// ===== CANVAS =====
function initCanvas() {
  canvas = document.getElementById('gameCanvas');
  ctx    = canvas.getContext('2d');
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);
}
function resizeCanvas() {
  const c = document.getElementById('gameContainer');
  canvas.width = c.clientWidth; canvas.height = c.clientHeight;
}

// ===== SCREENS =====
function showScreen(id) {
  ['menuScreen','troopSelectScreen','matchmakingScreen','gameScreen','gameoverScreen']
    .forEach(s => document.getElementById(s).classList.add('hidden'));
  document.getElementById(id).classList.remove('hidden');
}

// ===== COORDS =====
function mapToCanvas(mx,my){ return { x:mx*canvas.width/MAP_W, y:my*canvas.height/MAP_H }; }
function canvasToMap(cx,cy){ return { x:cx*MAP_W/canvas.width, y:cy*MAP_H/canvas.height }; }

// ===== TROOP SELECT =====
function openTroopSelect() {
  // Snapshot player count before switching screen (the select is on menuScreen)
  gs._pendingPlayerCount = parseInt(document.getElementById('playerCountSelect').value);
  showScreen('troopSelectScreen');
  renderTroopCards();
}
function renderTroopCards() {
  const grid = document.getElementById('troopGrid');
  grid.innerHTML = '';
  for (const [key, t] of Object.entries(TROOPS)) {
    const btn = document.createElement('button');
    btn.className = 'troop-card' + (gs.selectedTroop===key?' selected':'');
    btn.innerHTML = `
      <div class="troop-icon">${t.icon}</div>
      <div class="troop-name">${t.label}</div>
      <div class="troop-stats">${troopDesc(key)}</div>`;
    btn.onclick = () => {
      gs.selectedTroop = key;
      document.querySelectorAll('.troop-card').forEach(c=>c.classList.remove('selected'));
      btn.classList.add('selected');
    };
    grid.appendChild(btn);
  }
}
function troopDesc(key) {
  const t = TROOPS[key];
  const lines = [];
  if (t.speed !== 1)  lines.push(`移速 ×${t.speed}`);
  if (key==='warrior')  lines.push('路途戰力 ×1.5');
  if (key==='shielder') lines.push('防禦戰力 ×1.5');
  if (key==='heavy')    lines.push('路途戰力 ×2');
  if (key==='archer')   lines.push('每5秒遠程 0.1傷');
  return lines.join(' · ') || '標準兵種';
}
function confirmTroopAndMatch() {
  showScreen('matchmakingScreen');
  startMatchmaking();
}

// ===== MATCHMAKING =====
async function startMatchmaking() {
  // Use count saved when user left the menu screen (select is now hidden)
  const count = gs._pendingPlayerCount || parseInt(document.getElementById('playerCountSelect').value) || 2;
  gs.playerCount = count;
  gs.playerId = 'p_' + Math.random().toString(36).substr(2,9);
  document.getElementById('matchStatus').textContent = '搜尋中...';
  document.getElementById('matchPlayerCount').textContent = `等待 ${count} 人遊戲`;

  const snap = await db.ref('waiting').once('value');
  const waiting = snap.val() || {};
  let targetRoom = null;
  for (const [rid, room] of Object.entries(waiting)) {
    if (room.playerCount===count && Object.keys(room.players||{}).length<count) {
      targetRoom=rid; break;
    }
  }
  if (!targetRoom)
    targetRoom = 'room_'+Date.now()+'_'+Math.random().toString(36).substr(2,5);

  gs.roomId = targetRoom;
  const roomRef = db.ref(`waiting/${targetRoom}`);
  await roomRef.child('players/'+gs.playerId).set({
    id:gs.playerId, joinedAt:Date.now(), troop:gs.selectedTroop
  });
  await roomRef.update({ playerCount:count });
  db.ref(`waiting/${targetRoom}/players/${gs.playerId}`).onDisconnect().remove();

  const statusRef = db.ref(`games/${targetRoom}/status`);
  const statusUnsub = statusRef.on('value', snap => {
    if (snap.val()==='playing') {
      statusRef.off('value',statusUnsub);
      db.ref(`games/${targetRoom}`).once('value').then(snap => {
        const data = snap.val();
        const sorted = Object.values(data.players).sort((a,b)=>a.joinedAt-b.joinedAt);
        gs.playerIndex = sorted.findIndex(p=>p.id===gs.playerId);
        startGame(targetRoom, data.towers, data.startTime);
      });
    }
  });
  dbListeners.push(()=>statusRef.off('value',statusUnsub));

  const waitUnsub = roomRef.on('value', async snap => {
    const room = snap.val(); if (!room) return;
    const players = Object.values(room.players||{});
    const cur=players.length, need=room.playerCount;
    document.getElementById('matchStatus').textContent=`已找到 ${cur} / ${need} 位玩家`;
    if (cur>=need) {
      roomRef.off('value',waitUnsub);
      const sorted=players.sort((a,b)=>a.joinedAt-b.joinedAt);
      if (sorted[0].id===gs.playerId) await initAsHost(targetRoom,sorted);
    }
  });
}

async function initAsHost(roomId, players) {
  const startTime = Date.now();
  const towers = generateTowers(players.length, players);
  const gameData = {
    status:'playing', startTime, playerCount:players.length,
    players: players.reduce((acc,p,i)=>{
      acc[p.id]={ id:p.id, index:i, joinedAt:p.joinedAt, troop:p.troop||'warrior' };
      return acc;
    },{}),
    towers,
  };
  await db.ref(`games/${roomId}`).set(gameData);
  await db.ref(`waiting/${roomId}`).remove();
}

function cancelMatchmaking() {
  if (gs.roomId) db.ref(`waiting/${gs.roomId}/players/${gs.playerId}`).remove();
  dbListeners.forEach(fn=>fn()); dbListeners=[];
  gs=freshState(); showScreen('menuScreen');
}

// ===== TOWER GENERATION =====
function generateTowers(playerCount, players) {
  const towers={}, positions=[];
  const MIN_DIST=120;
  const corners=[
    {x:MAP_PADDING+40,y:MAP_PADDING+40},
    {x:MAP_W-MAP_PADDING-40,y:MAP_H-MAP_PADDING-40},
    {x:MAP_W-MAP_PADDING-40,y:MAP_PADDING+40},
    {x:MAP_PADDING+40,y:MAP_H-MAP_PADDING-40},
  ];
  const sorted = players.slice().sort((a,b)=>a.joinedAt-b.joinedAt);
  for (let i=0;i<playerCount;i++) {
    const troop = sorted[i]?.troop || 'warrior';
    positions.push(corners[i]);
    towers[`tp${i}`]={ id:`tp${i}`, x:corners[i].x, y:corners[i].y, soldiers:15, owner:i, troop };
  }
  const neutralCount = MIN_NEUTRAL+Math.floor(Math.random()*(MAX_NEUTRAL-MIN_NEUTRAL+1));
  let placed=0,fails=0;
  while (placed<neutralCount && fails<20) {
    const x=MAP_PADDING+Math.random()*(MAP_W-MAP_PADDING*2);
    const y=MAP_PADDING+Math.random()*(MAP_H-MAP_PADDING*2);
    if (positions.every(p=>Math.hypot(p.x-x,p.y-y)>=MIN_DIST)) {
      positions.push({x,y});
      const troop = NEUTRAL_TROOPS[Math.floor(Math.random()*NEUTRAL_TROOPS.length)];
      towers[`tn${placed}`]={
        id:`tn${placed}`, x:Math.round(x), y:Math.round(y),
        soldiers:5+Math.floor(Math.random()*10), owner:-1, troop
      };
      placed++;
    } else fails++;
  }
  return towers;
}

// ===== START GAME =====
function startGame(roomId, towersData, startTime) {
  gs.phase='playing'; gs.roomId=roomId;
  gs.gameStartAt = startTime || Date.now();
  gs.towers=JSON.parse(JSON.stringify(towersData));
  gs.soldiers=[]; gs.particles=[]; gs.shockwaves=[];
  gs.fireSweep=null; gs.defectFlash=null;
  gs.combatEvents=new Set();
  showScreen('gameScreen'); resizeCanvas();
  document.getElementById('myColorDot').style.background=PLAYER_COLORS[gs.playerIndex];
  document.getElementById('myColorLabel').textContent=PLAYER_NAMES[gs.playerIndex]+'方';
  setupInput(); setupFirebase(roomId);
  startGrowth(roomId); startArcherTick(roomId);
  startRenderLoop(); updateSkillUI();
}

// ===== FIREBASE =====
function setupFirebase(roomId) {
  const towersRef = db.ref(`games/${roomId}/towers`);
  towersRef.on('value', snap=>{ const d=snap.val(); if(d) gs.towers=d; });
  dbListeners.push(()=>towersRef.off());

  const solRef = db.ref(`games/${roomId}/movingSoldiers`);
  solRef.on('child_added', snap=>{
    const sg=snap.val();
    if (!sg || gs.soldiers.find(s=>s.id===sg.id)) return;
    const elapsed=Date.now()-sg.sentAt;
    if (elapsed>=sg.travelTime) return;
    gs.soldiers.push({...sg, progress:Math.min(elapsed/sg.travelTime,0.99)});
  });
  solRef.on('child_removed', snap=>{
    const sg=snap.val();
    if (sg) gs.soldiers=gs.soldiers.filter(s=>s.id!==sg.id);
  });
  dbListeners.push(()=>solRef.off());

  // Mid-path combat events
  const combatRef = db.ref(`games/${roomId}/combatEvents`);
  combatRef.on('child_added', snap=>{
    const ev=snap.val(); if(!ev) return;
    handleCombatEvent(ev);
  });
  dbListeners.push(()=>combatRef.off());

  const skillRef = db.ref(`games/${roomId}/skillEvents`);
  skillRef.on('child_added', snap=>{
    const ev=snap.val(); if(!ev) return;
    if (ev.type==='napalm') handleNapalmEvent(ev);
    else if (ev.type==='defect') handleDefectEvent(ev);
  });
  dbListeners.push(()=>skillRef.off());

  const statusRef = db.ref(`games/${roomId}/status`);
  statusRef.on('value', snap=>{
    if (snap.val()==='gameover')
      db.ref(`games/${roomId}/winner`).once('value').then(w=>endGame(w.val()));
  });
  dbListeners.push(()=>statusRef.off());
}

// ===== GROWTH =====
function startGrowth(roomId) {
  growthInterval = setInterval(async ()=>{
    if (gs.phase!=='playing') return;
    const updates={};
    for (const [tid,t] of Object.entries(gs.towers)) {
      if (t.owner===gs.playerIndex)
        updates[`games/${roomId}/towers/${tid}/soldiers`]=(t.soldiers||0)+SOLDIER_GROWTH_AMOUNT;
    }
    if (Object.keys(updates).length) try{ await db.ref().update(updates); }catch(e){}
  }, SOLDIER_GROWTH_INTERVAL);
}

// ===== ARCHER TICK =====
// Each player handles damage from their own archers only
function startArcherTick(roomId) {
  archerInterval = setInterval(async ()=>{
    if (gs.phase!=='playing') return;
    for (const sg of gs.soldiers) {
      if (sg.ownerIndex!==gs.playerIndex) continue;
      if (gs.towers[sg.fromTowerId]?.troop!=='archer' && sg.troop!=='archer') continue;
      // Find nearest enemy tower
      let nearest=null, nearestD=Infinity;
      for (const t of Object.values(gs.towers)) {
        if (t.owner===gs.playerIndex || t.owner<0) continue;
        const d=Math.hypot(t.x-sg.fromX+(sg.toX-sg.fromX)*sg.progress,
                           t.y-sg.fromY+(sg.toY-sg.fromY)*sg.progress);
        if (d<nearestD){ nearest=t; nearestD=d; }
      }
      if (!nearest) continue;
      try {
        await db.ref(`games/${roomId}/towers/${nearest.id}`).transaction(tower=>{
          if (!tower) return tower;
          tower.soldiers=Math.max(0,(tower.soldiers||0)-ARCHER_DMG);
          return tower;
        });
        // Arrow particle
        const from=mapToCanvas(
          sg.fromX+(sg.toX-sg.fromX)*sg.progress,
          sg.fromY+(sg.toY-sg.fromY)*sg.progress);
        const to=mapToCanvas(nearest.x,nearest.y);
        spawnArrowParticle(from.x,from.y,to.x,to.y,PLAYER_COLORS[gs.playerIndex]);
      } catch(e){}
    }
  }, ARCHER_TICK_MS);
}

// ===== INPUT =====
function setupInput() {
  canvas.addEventListener('mousedown',  onDown, {passive:false});
  canvas.addEventListener('mousemove',  onMove, {passive:false});
  canvas.addEventListener('mouseup',    onUp,   {passive:false});
  canvas.addEventListener('touchstart', onDown, {passive:false});
  canvas.addEventListener('touchmove',  onMove, {passive:false});
  canvas.addEventListener('touchend',   onUp,   {passive:false});
  canvas.addEventListener('mouseleave', onCancel);
}
function getPos(e) {
  const rect=canvas.getBoundingClientRect();
  const src=e.changedTouches?e.changedTouches[0]:(e.touches?e.touches[0]:e);
  return { x:(src.clientX-rect.left)*(canvas.width/rect.width),
           y:(src.clientY-rect.top)*(canvas.height/rect.height) };
}
function towerNear(cx,cy,mapR) {
  const mp=canvasToMap(cx,cy);
  let best=null,bestD=Infinity;
  for (const t of Object.values(gs.towers)) {
    const d=Math.hypot(t.x-mp.x,t.y-mp.y);
    if (d<mapR&&d<bestD){best=t;bestD=d;}
  }
  return best;
}
function onDown(e) {
  e.preventDefault();
  if (gs.phase!=='playing') return;
  const pos=getPos(e);
  const mapR=(TOWER_RADIUS*2.5)*MAP_W/canvas.width;
  if (gs.skillMode==='napalm'){activateNapalm();return;}
  if (gs.skillMode==='defect'){
    const t=towerNear(pos.x,pos.y,mapR);
    if (t&&t.owner>=0&&t.owner!==gs.playerIndex) activateDefect(t);
    else{gs.skillMode=null;updateSkillUI();}
    return;
  }
  const tower=towerNear(pos.x,pos.y,mapR);
  if (tower&&tower.owner===gs.playerIndex&&tower.soldiers>1){
    gs.dragFrom=tower; gs.dragPos=pos;
  }
}
function onMove(e){e.preventDefault();if(gs.dragFrom)gs.dragPos=getPos(e);}
function onUp(e) {
  e.preventDefault(); if(!gs.dragFrom)return;
  const pos=getPos(e);
  const mapR=(TOWER_RADIUS*3.2)*MAP_W/canvas.width;
  const t=towerNear(pos.x,pos.y,mapR);
  if (t&&t.id!==gs.dragFrom.id) sendSoldiers(gs.dragFrom,t);
  gs.dragFrom=null; gs.dragPos=null;
}
function onCancel(){gs.dragFrom=null;gs.dragPos=null;}

// ===== SEND SOLDIERS =====
async function sendSoldiers(from, to) {
  const live=gs.towers[from.id];
  if (!live||live.soldiers<2) return;
  const count=Math.max(1,Math.floor(live.soldiers*DRAG_RATIO));
  const newSold=Math.max(0,live.soldiers-count);
  if (gs.towers[from.id]) gs.towers[from.id].soldiers=newSold;
  const roomId=gs.roomId;
  try{ await db.ref(`games/${roomId}/towers/${from.id}/soldiers`).set(newSold); }catch(e){return;}

  const troop=live.troop||'warrior';
  const troopData=TROOPS[troop];
  const speed=BASE_MOVE_SPEED*troopData.speed;
  const dist=Math.hypot(to.x-from.x,to.y-from.y);
  const travelTime=(dist/speed)*1000;
  const sentAt=Date.now();
  const sgId='sg_'+sentAt+'_'+Math.random().toString(36).substr(2,5);
  const sg={
    id:sgId, fromTowerId:from.id, toTowerId:to.id,
    count, ownerIndex:gs.playerIndex,
    fromX:from.x, fromY:from.y, toX:to.x, toY:to.y,
    sentAt, travelTime, troop, progress:0,
  };
  gs.soldiers.push({...sg});
  const fc=mapToCanvas(from.x,from.y);
  spawnLaunchParticles(fc.x,fc.y,PLAYER_COLORS[gs.playerIndex]);
  try{ await db.ref(`games/${roomId}/movingSoldiers/${sgId}`).set(sg); }catch(e){}
  setTimeout(()=>handleArrival(sg), travelTime);
}

// ===== ARRIVAL =====
async function handleArrival(sg) {
  if (gs.phase!=='playing') return;
  const roomId=gs.roomId;
  const destTower=gs.towers[sg.toTowerId];
  const isFriendly=destTower&&destTower.owner===sg.ownerIndex;
  const isDefending=destTower&&destTower.owner!==sg.ownerIndex&&destTower.owner>=0;

  // Compute effective attack power (shielder bonus for defender)
  const attackPow=sg.count;
  let defenceBonus=1;
  if (isDefending) {
    const defTroop=destTower.troop||'warrior';
    defenceBonus=TROOPS[defTroop].defPow;
  }

  try {
    await db.ref(`games/${roomId}/towers/${sg.toTowerId}`).transaction(tower=>{
      if (!tower) return tower;
      if (tower.owner===sg.ownerIndex) {
        tower.soldiers=(tower.soldiers||0)+sg.count;
      } else {
        const defSoldiers=(tower.soldiers||0)*defenceBonus;
        const rem=defSoldiers-attackPow;
        if (rem<=0) {
          tower.soldiers=Math.ceil(Math.abs(rem)/defenceBonus);
          tower.owner=sg.ownerIndex;
          tower.troop=sg.troop; // conquering army brings their troop type
        } else {
          tower.soldiers=Math.ceil(rem/defenceBonus);
        }
      }
      return tower;
    });
  } catch(e){}

  const cp=mapToCanvas(sg.toX,sg.toY);
  spawnImpactParticles(cp.x,cp.y,PLAYER_COLORS[sg.ownerIndex]);
  gs.screenShake=5;
  gs.soldiers=gs.soldiers.filter(s=>s.id!==sg.id);
  try{ await db.ref(`games/${roomId}/movingSoldiers/${sg.id}`).remove(); }catch(e){}
  await checkWin();
}

// ===== MID-PATH COMBAT =====
// Called every frame to detect collisions between opposite-direction squads
let lastCombatCheck=0;
function checkMidPathCombat() {
  const now=Date.now();
  if (now-lastCombatCheck < 200) return; // throttle
  lastCombatCheck=now;

  const soldiers=gs.soldiers;
  for (let i=0;i<soldiers.length;i++) {
    for (let j=i+1;j<soldiers.length;j++) {
      const a=soldiers[i], b=soldiers[j];
      if (a.ownerIndex===b.ownerIndex) continue;
      // Opposite path: a goes A→B, b goes B→A
      if (!(a.fromTowerId===b.toTowerId && a.toTowerId===b.fromTowerId)) continue;
      // Check if they have crossed (positions overlap on path)
      if (a.progress+b.progress < 1.0) continue; // haven't met yet
      // Already handled?
      const combatKey = [a.id,b.id].sort().join('|');
      if (gs.combatEvents.has(combatKey)) continue;
      gs.combatEvents.add(combatKey);
      // Only the owner of 'a' (lower ownerIndex) writes the combat event to avoid duplication
      if (gs.playerIndex===Math.min(a.ownerIndex,b.ownerIndex)) {
        writeCombatEvent(a, b, combatKey);
      }
    }
  }
}

async function writeCombatEvent(a, b, combatKey) {
  const evId='cb_'+Date.now()+'_'+Math.random().toString(36).substr(2,5);
  const ev={
    id:evId, key:combatKey,
    sgA:{ id:a.id, count:a.count, ownerIndex:a.ownerIndex, troop:a.troop||'warrior',
          x:a.fromX+(a.toX-a.fromX)*a.progress, y:a.fromY+(a.toY-a.fromY)*a.progress },
    sgB:{ id:b.id, count:b.count, ownerIndex:b.ownerIndex, troop:b.troop||'warrior',
          x:b.fromX+(b.toX-b.fromX)*b.progress, y:b.fromY+(b.toY-b.fromY)*b.progress },
    at:Date.now(),
  };
  try{ await db.ref(`games/${gs.roomId}/combatEvents/${evId}`).set(ev); }catch(e){}
}

function handleCombatEvent(ev) {
  const {sgA,sgB}=ev;
  const troopA=TROOPS[sgA.troop||'warrior'];
  const troopB=TROOPS[sgB.troop||'warrior'];
  const powA=sgA.count*troopA.pathPow;
  const powB=sgB.count*troopB.pathPow;

  // Visual clash
  const mx=(sgA.x+sgB.x)/2, my=(sgA.y+sgB.y)/2;
  const {x:cx,y:cy}=mapToCanvas(mx,my);
  spawnClashParticles(cx,cy,PLAYER_COLORS[sgA.ownerIndex],PLAYER_COLORS[sgB.ownerIndex]);
  gs.screenShake=Math.max(gs.screenShake,4);

  // Remove both soldiers from local animation immediately
  gs.soldiers=gs.soldiers.filter(s=>s.id!==sgA.id&&s.id!==sgB.id);

  // Survivor (only the caster writes to Firebase to avoid race)
  if (gs.playerIndex===Math.min(sgA.ownerIndex,sgB.ownerIndex)) {
    resolveCombatOnFirebase(ev, powA, powB, sgA, sgB);
  }
}

async function resolveCombatOnFirebase(ev, powA, powB, sgA, sgB) {
  const roomId=gs.roomId;
  // Remove both from movingSoldiers
  const updates={};
  updates[`games/${roomId}/movingSoldiers/${sgA.id}`]=null;
  updates[`games/${roomId}/movingSoldiers/${sgB.id}`]=null;

  if (Math.abs(powA-powB)<0.5) {
    // Mutual annihilation
  } else if (powA>powB) {
    const surviving=Math.round(sgA.count-(powB/TROOPS[sgA.troop||'warrior'].pathPow));
    if (surviving>0) {
      const newSg={ ...sgA, id:'sg_'+Date.now()+'_'+Math.random().toString(36).substr(2,5),
        count:surviving, sentAt:Date.now(),
        fromX:sgA.x, fromY:sgA.y, progress:0,
        travelTime:Math.hypot(sgA.toX-sgA.x,sgA.toY-sgA.y)/BASE_MOVE_SPEED/TROOPS[sgA.troop||'warrior'].speed*1000,
      };
      updates[`games/${roomId}/movingSoldiers/${newSg.id}`]=newSg;
      gs.soldiers.push({...newSg});
      setTimeout(()=>handleArrival(newSg),newSg.travelTime);
    }
  } else {
    const surviving=Math.round(sgB.count-(powA/TROOPS[sgB.troop||'warrior'].pathPow));
    if (surviving>0) {
      const newSg={ ...sgB, id:'sg_'+Date.now()+'_'+Math.random().toString(36).substr(2,5),
        count:surviving, sentAt:Date.now(),
        fromX:sgB.x, fromY:sgB.y, progress:0,
        travelTime:Math.hypot(sgB.toX-sgB.x,sgB.toY-sgB.y)/BASE_MOVE_SPEED/TROOPS[sgB.troop||'warrior'].speed*1000,
      };
      updates[`games/${roomId}/movingSoldiers/${newSg.id}`]=newSg;
      gs.soldiers.push({...newSg});
      setTimeout(()=>handleArrival(newSg),newSg.travelTime);
    }
  }
  try{ await db.ref().update(updates); }catch(e){}
}

// ===== WIN CHECK =====
async function checkWin() {
  try {
    const snap=await db.ref(`games/${gs.roomId}/towers`).once('value');
    const towers=snap.val(); if (!towers) return;
    const owners=new Set(Object.values(towers).filter(t=>t.owner>=0).map(t=>t.owner));
    if (owners.size===1) {
      const winner=[...owners][0];
      await db.ref(`games/${gs.roomId}`).update({status:'gameover',winner});
    }
  } catch(e){}
}

function endGame(winnerIdx) {
  gs.phase='gameover';
  clearInterval(growthInterval); clearInterval(archerInterval);
  cancelAnimationFrame(animId);
  dbListeners.forEach(fn=>fn()); dbListeners=[];
  const isWin=winnerIdx===gs.playerIndex;
  const titleEl=document.getElementById('gameoverTitle');
  titleEl.textContent=isWin?'🏆 勝利！':'💀 失敗';
  titleEl.style.color=isWin?'#f1c40f':'#e74c3c';
  document.getElementById('winnerText').textContent=
    `${PLAYER_EMOJIS[winnerIdx]} ${PLAYER_NAMES[winnerIdx]}方 獲勝！`;
  showScreen('gameoverScreen');
}

function returnToMenu() {
  clearInterval(growthInterval); clearInterval(archerInterval);
  cancelAnimationFrame(animId);
  dbListeners.forEach(fn=>fn()); dbListeners=[];
  gs=freshState(); showScreen('menuScreen');
}

// ============================================================
//  SKILLS
// ============================================================
function defectLockRemaining() {
  if (!gs.gameStartAt) return DEFECT_LOCK_SECS*1000;
  return Math.max(0, DEFECT_LOCK_SECS*1000-(Date.now()-gs.gameStartAt));
}

function selectSkill(skillKey) {
  if (gs.phase!=='playing') return;
  if (gs.skills[skillKey].used) return;
  if (skillKey==='defect'&&defectLockRemaining()>0) return;
  if (gs.skillMode===skillKey){gs.skillMode=null;updateSkillUI();return;}
  gs.skillMode=skillKey;
  if (skillKey==='napalm'){activateNapalm();return;}
  updateSkillUI();
}

async function activateNapalm() {
  if (gs.skills.napalm.used){gs.skillMode=null;updateSkillUI();return;}
  gs.skills.napalm.used=true; gs.skillMode=null; updateSkillUI();
  const evId='ev_'+Date.now()+'_'+Math.random().toString(36).substr(2,5);
  try{ await db.ref(`games/${gs.roomId}/skillEvents/${evId}`).set({
    id:evId,type:'napalm',by:gs.playerIndex,at:Date.now(),
  }); }catch(e){}
}

function handleNapalmEvent(ev) {
  const caster=ev.by;
  const toDestroy=gs.soldiers.filter(s=>s.ownerIndex!==caster);
  for (const sg of toDestroy) {
    const prog=Math.max(0,Math.min((Date.now()-sg.sentAt)/sg.travelTime,1));
    const fx=sg.fromX+(sg.toX-sg.fromX)*prog, fy=sg.fromY+(sg.toY-sg.fromY)*prog;
    const cp=mapToCanvas(fx,fy);
    spawnNapalmExplosion(cp.x,cp.y);
  }
  if (toDestroy.length>0) {
    gs.fireSweep={startAt:Date.now(),duration:1400};
    gs.screenShake=18;
    for (let i=0;i<80;i++) {
      const cx=Math.random()*canvas.width, cy=-20+Math.random()*canvas.height*0.6;
      setTimeout(()=>spawnEmberCluster(cx,cy),Math.random()*800);
    }
  }
  gs.soldiers=gs.soldiers.filter(s=>s.ownerIndex===caster);
  if (ev.by===gs.playerIndex) {
    db.ref(`games/${gs.roomId}/movingSoldiers`).once('value').then(snap=>{
      const all=snap.val()||{}, updates={};
      for (const [sid,sg] of Object.entries(all))
        if (sg.ownerIndex!==caster) updates[sid]=null;
      if (Object.keys(updates).length)
        db.ref(`games/${gs.roomId}/movingSoldiers`).update(updates);
    });
  }
}

async function activateDefect(tower) {
  if (gs.skills.defect.used||defectLockRemaining()>0){gs.skillMode=null;updateSkillUI();return;}
  gs.skills.defect.used=true; gs.skillMode=null; updateSkillUI();
  const evId='ev_'+Date.now()+'_'+Math.random().toString(36).substr(2,5);
  try{ await db.ref(`games/${gs.roomId}/skillEvents/${evId}`).set({
    id:evId,type:'defect',by:gs.playerIndex,towerId:tower.id,at:Date.now(),
  }); }catch(e){}
}

function handleDefectEvent(ev) {
  const tower=gs.towers[ev.towerId]; if (!tower) return;
  const newOwner=ev.by;
  const cp=mapToCanvas(tower.x,tower.y);
  for (let i=0;i<4;i++) {
    setTimeout(()=>{
      gs.shockwaves.push({x:cp.x,y:cp.y,r:0,maxR:220+i*40,life:1,
        color:PLAYER_COLORS[newOwner],width:4-i*0.6});
    },i*90);
  }
  spawnDefectSpiral(cp.x,cp.y,PLAYER_COLORS[newOwner]);
  gs.defectFlash={startAt:Date.now(),duration:600,color:PLAYER_COLORS[newOwner],x:cp.x,y:cp.y};
  gs.screenShake=14;
  if (ev.by===gs.playerIndex)
    db.ref(`games/${gs.roomId}/towers/${ev.towerId}/owner`).set(newOwner);
  if (gs.towers[ev.towerId]) gs.towers[ev.towerId].owner=newOwner;
}

function updateSkillUI() {
  const now=Date.now();
  const nb=document.getElementById('skillNapalmBtn');
  const used_n=gs.skills.napalm.used;
  nb.disabled=used_n||gs.phase!=='playing';
  nb.classList.toggle('skill-active',gs.skillMode==='napalm');
  nb.classList.toggle('skill-used',used_n);
  document.getElementById('skillNapalmCd').textContent=used_n?'已使用':'就緒';

  const db2=document.getElementById('skillDefectBtn');
  const used_d=gs.skills.defect.used;
  const lock=defectLockRemaining();
  db2.disabled=used_d||lock>0||gs.phase!=='playing';
  db2.classList.toggle('skill-active',gs.skillMode==='defect');
  db2.classList.toggle('skill-used',used_d);
  document.getElementById('skillDefectCd').textContent=
    used_d?'已使用':lock>0?`${Math.ceil(lock/1000)}s`:'就緒';
}

// ============================================================
//  RENDER LOOP
// ============================================================
function startRenderLoop() {
  lastTimestamp=performance.now();
  function loop(ts) {
    const dt=Math.min((ts-lastTimestamp)/1000,0.1);
    lastTimestamp=ts;
    update(dt); draw();
    animId=requestAnimationFrame(loop);
  }
  animId=requestAnimationFrame(loop);
}

function update(dt) {
  const now=Date.now();
  for (const sg of gs.soldiers)
    sg.progress=Math.max(0,Math.min((now-sg.sentAt)/sg.travelTime,1));

  checkMidPathCombat();

  for (const p of gs.particles) {
    p.x+=p.vx*dt; p.y+=p.vy*dt;
    p.vy+=(p.gravity??150)*dt;
    p.vx*=(p.drag??0.99);
    p.life-=dt;
    p.alpha=Math.max(0,p.life/p.maxLife);
    p.r=p.maxR*(p.type==='ember'?1:p.alpha);
  }
  gs.particles=gs.particles.filter(p=>p.life>0);

  for (const sw of gs.shockwaves) { sw.r+=dt*380; sw.life=Math.max(0,1-sw.r/sw.maxR); }
  gs.shockwaves=gs.shockwaves.filter(sw=>sw.life>0);

  // Arrow particles (straight line, fast)
  for (const ap of (gs.arrowParticles||[])) { ap.t+=dt*2.5; ap.alpha=Math.max(0,1-ap.t); }
  if (gs.arrowParticles) gs.arrowParticles=gs.arrowParticles.filter(ap=>ap.alpha>0);

  if (gs.screenShake>0) gs.screenShake=Math.max(0,gs.screenShake-dt*55);
  updateHUD();
  // Skill UI update every ~500ms to avoid DOM spam
  if (!gs._lastSkillUIUpdate||now-gs._lastSkillUIUpdate>300) {
    updateSkillUI(); gs._lastSkillUIUpdate=now;
  }
}

function updateHUD() {
  let myT=0,myS=0;
  for (const t of Object.values(gs.towers)) {
    if (t.owner===gs.playerIndex){myT++;myS+=t.soldiers||0;}
  }
  document.getElementById('myTowerCount').textContent=myT;
  document.getElementById('mySoldierCount').textContent=Math.floor(myS);
}

// ============================================================
//  DRAW
// ============================================================
function draw() {
  ctx.save();
  if (gs.screenShake>0) ctx.translate((Math.random()-.5)*gs.screenShake*2,(Math.random()-.5)*gs.screenShake*2);
  drawBackground();
  drawFireSweepUnderlay();
  drawConnections();
  drawShockwaves();
  drawTowers();
  drawSoldiers();
  drawArrows();
  drawDragLine();
  drawSkillOverlay();
  drawParticles();
  drawDefectFlash();
  ctx.restore();
}

function drawBackground() {
  ctx.fillStyle='#070b14';
  ctx.fillRect(0,0,canvas.width,canvas.height);
  ctx.save(); ctx.strokeStyle='rgba(100,150,255,0.04)'; ctx.lineWidth=1;
  for (let x=0;x<canvas.width;x+=55){ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,canvas.height);ctx.stroke();}
  for (let y=0;y<canvas.height;y+=55){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(canvas.width,y);ctx.stroke();}
  ctx.restore();
}

function drawFireSweepUnderlay() {
  if (!gs.fireSweep) return;
  const t=Math.min((Date.now()-gs.fireSweep.startAt)/gs.fireSweep.duration,1);
  if (t>=1){gs.fireSweep=null;return;}
  const intensity=t<0.15?t/0.15:1-(t-0.15)/0.85;
  ctx.save();
  const grd=ctx.createRadialGradient(canvas.width/2,canvas.height/2,0,canvas.width/2,canvas.height/2,Math.max(canvas.width,canvas.height));
  grd.addColorStop(0,`rgba(255,180,30,${intensity*0.35})`);
  grd.addColorStop(0.5,`rgba(255,70,20,${intensity*0.25})`);
  grd.addColorStop(1,`rgba(200,30,10,${intensity*0.1})`);
  ctx.fillStyle=grd; ctx.fillRect(0,0,canvas.width,canvas.height);
  ctx.restore();
}

function drawConnections() {
  const towerArr=Object.values(gs.towers);
  ctx.save(); ctx.lineWidth=0.5;
  for (let i=0;i<towerArr.length;i++) for (let j=i+1;j<towerArr.length;j++) {
    const a=towerArr[i],b=towerArr[j];
    if (a.owner>=0&&a.owner===b.owner) {
      const pa=mapToCanvas(a.x,a.y),pb=mapToCanvas(b.x,b.y);
      ctx.strokeStyle=PLAYER_COLORS[a.owner]+'22';
      ctx.beginPath();ctx.moveTo(pa.x,pa.y);ctx.lineTo(pb.x,pb.y);ctx.stroke();
    }
  }
  ctx.restore();
}

function drawShockwaves() {
  for (const sw of gs.shockwaves) {
    ctx.save(); ctx.globalAlpha=sw.life*0.8; ctx.strokeStyle=sw.color;
    ctx.lineWidth=sw.width*sw.life; ctx.shadowBlur=20; ctx.shadowColor=sw.color;
    ctx.beginPath();ctx.arc(sw.x,sw.y,sw.r,0,Math.PI*2);ctx.stroke();
    ctx.restore();
  }
}

function drawTowers() {
  const now=Date.now()/1000;
  const isDefectMode=gs.skillMode==='defect';
  for (const tower of Object.values(gs.towers)) {
    const {x:tx,y:ty}=mapToCanvas(tower.x,tower.y);
    const r=TOWER_RADIUS;
    const col=tower.owner>=0?PLAYER_COLORS[tower.owner]:NEUTRAL_COLOR;
    const isMe=tower.owner===gs.playerIndex;
    const isEnemyOwned=tower.owner>=0&&tower.owner!==gs.playerIndex;

    // Glow
    if (tower.owner>=0) {
      const pulse=0.5+0.5*Math.sin(now*1.8+tower.x*0.01);
      const grd=ctx.createRadialGradient(tx,ty,r*0.3,tx,ty,r*(2.6+pulse*0.5));
      grd.addColorStop(0,col+'44');grd.addColorStop(1,'transparent');
      ctx.fillStyle=grd;ctx.beginPath();ctx.arc(tx,ty,r*3.2,0,Math.PI*2);ctx.fill();
    }

    // Defect target rings
    if (isDefectMode&&isEnemyOwned&&defectLockRemaining()===0) {
      for (let ri=0;ri<3;ri++) {
        const phase=((now*3+ri*0.4)%1);
        ctx.save();ctx.strokeStyle='#a78bfa';ctx.lineWidth=2.5-ri;
        ctx.globalAlpha=(1-phase)*0.7;ctx.shadowBlur=15;ctx.shadowColor='#a78bfa';
        ctx.beginPath();ctx.arc(tx,ty,r+8+phase*30,0,Math.PI*2);ctx.stroke();ctx.restore();
      }
    }

    // Shadow
    ctx.save();ctx.translate(tx,ty+4);ctx.globalAlpha=0.2;
    hexPath(ctx,0,0,r);ctx.fillStyle='#000';ctx.fill();ctx.restore();

    // Body
    ctx.save();ctx.translate(tx,ty);if(isMe)ctx.rotate(now*0.3);
    hexPath(ctx,0,0,r);
    const fg=ctx.createRadialGradient(0,-r*0.3,1,0,0,r);
    if (tower.owner>=0){fg.addColorStop(0,col+'ee');fg.addColorStop(1,col+'66');}
    else{fg.addColorStop(0,'#334455ee');fg.addColorStop(1,'#22334488');}
    ctx.fillStyle=fg;ctx.fill();
    ctx.strokeStyle=col;ctx.lineWidth=isMe?3:1.5;
    if(isMe){ctx.shadowBlur=14;ctx.shadowColor=col;}
    ctx.stroke();ctx.shadowBlur=0;ctx.restore();

    // Drag ring
    if (gs.dragFrom&&gs.dragFrom.id===tower.id) {
      ctx.save();ctx.translate(tx,ty);ctx.strokeStyle=col;ctx.lineWidth=2.5;
      ctx.globalAlpha=0.5+0.5*Math.sin(now*8);
      ctx.beginPath();ctx.arc(0,0,r+10,0,Math.PI*2);ctx.stroke();ctx.restore();
    }

    // Soldier count (inside hex)
    ctx.save();
    ctx.fillStyle='#fff';
    ctx.font=`bold 14px 'Courier New',monospace`;
    ctx.textAlign='center';ctx.textBaseline='middle';
    ctx.shadowBlur=5;ctx.shadowColor='#000';
    ctx.fillText(Math.floor(tower.soldiers),tx,ty+2);
    ctx.shadowBlur=0;ctx.restore();

    // Troop icon — drawn above the hex, big and clear
    const troop=TROOPS[tower.troop]||TROOPS.warrior;
    ctx.save();
    ctx.font=`18px sans-serif`;
    ctx.textAlign='center';ctx.textBaseline='bottom';
    ctx.shadowBlur=6;ctx.shadowColor='rgba(0,0,0,0.9)';
    ctx.fillText(troop.icon, tx, ty - r + 2);
    ctx.shadowBlur=0;ctx.restore();

    // Troop label text below icon
    ctx.save();
    ctx.fillStyle= tower.owner>=0 ? PLAYER_COLORS[tower.owner] : '#aabbcc';
    ctx.font=`bold 9px 'Share Tech Mono',monospace`;
    ctx.textAlign='center';ctx.textBaseline='top';
    ctx.shadowBlur=4;ctx.shadowColor='rgba(0,0,0,0.9)';
    ctx.fillText(troop.label, tx, ty - r + 4);
    ctx.shadowBlur=0;ctx.restore();
  }
}

function hexPath(ctx,cx,cy,r) {
  ctx.beginPath();
  for(let i=0;i<6;i++){
    const a=(Math.PI/3)*i-Math.PI/6;
    i===0?ctx.moveTo(cx+r*Math.cos(a),cy+r*Math.sin(a)):ctx.lineTo(cx+r*Math.cos(a),cy+r*Math.sin(a));
  }
  ctx.closePath();
}

function drawSoldiers() {
  const now=Date.now()/1000;
  for (const sg of gs.soldiers) {
    const fx=sg.fromX+(sg.toX-sg.fromX)*sg.progress;
    const fy=sg.fromY+(sg.toY-sg.fromY)*sg.progress;
    const {x,y}=mapToCanvas(fx,fy);
    const col=PLAYER_COLORS[sg.ownerIndex];
    const troop=TROOPS[sg.troop||'warrior'];

    // Trail
    for(let i=1;i<=6;i++){
      const tp=Math.max(0,sg.progress-i*0.035);
      const {x:trx,y:try_}=mapToCanvas(sg.fromX+(sg.toX-sg.fromX)*tp,sg.fromY+(sg.toY-sg.fromY)*tp);
      ctx.save();ctx.globalAlpha=(1-i/7)*0.28;
      ctx.beginPath();ctx.arc(trx,try_,5-i*0.5,0,Math.PI*2);
      ctx.fillStyle=col;ctx.fill();ctx.restore();
    }

    // Path line
    const fc=mapToCanvas(sg.fromX,sg.fromY),tc=mapToCanvas(sg.toX,sg.toY);
    ctx.save();ctx.strokeStyle=col+'22';ctx.lineWidth=1;ctx.setLineDash([4,6]);
    ctx.beginPath();ctx.moveTo(fc.x,fc.y);ctx.lineTo(tc.x,tc.y);ctx.stroke();
    ctx.setLineDash([]);ctx.restore();

    // Blob — size varies by troop
    const blobR = sg.troop==='heavy'?15:sg.troop==='cavalry'?10:12;
    ctx.save();
    ctx.shadowBlur=16;ctx.shadowColor=col;
    const pulse=0.9+0.1*Math.sin(now*10+sg.sentAt*0.001);
    ctx.beginPath();ctx.arc(x,y,blobR*pulse,0,Math.PI*2);
    ctx.fillStyle=col;ctx.fill();ctx.shadowBlur=0;
    ctx.strokeStyle='#ffffffbb';ctx.lineWidth=1.5;ctx.stroke();ctx.restore();

    // Count label
    ctx.save();
    ctx.fillStyle='#fff';ctx.font=`bold 9px monospace`;
    ctx.textAlign='center';ctx.textBaseline='middle';
    ctx.shadowBlur=3;ctx.shadowColor='#000';
    ctx.fillText(sg.count,x,y+1);
    ctx.shadowBlur=0;ctx.restore();

    // Troop icon floating above blob
    ctx.save();
    ctx.font=`14px sans-serif`;
    ctx.textAlign='center';ctx.textBaseline='bottom';
    ctx.shadowBlur=4;ctx.shadowColor='rgba(0,0,0,0.9)';
    ctx.fillText(troop.icon, x, y - blobR + 2);
    ctx.shadowBlur=0;ctx.restore();
  }
}

function drawArrows() {
  if (!gs.arrowParticles) return;
  for (const ap of gs.arrowParticles) {
    const px=ap.x0+(ap.x1-ap.x0)*ap.t;
    const py=ap.y0+(ap.y1-ap.y0)*ap.t;
    ctx.save();ctx.globalAlpha=ap.alpha*0.9;
    ctx.fillStyle=ap.color;ctx.shadowBlur=6;ctx.shadowColor=ap.color;
    ctx.beginPath();ctx.arc(px,py,3,0,Math.PI*2);ctx.fill();
    ctx.restore();
  }
}

function drawDragLine() {
  if (!gs.dragFrom||!gs.dragPos) return;
  const from=mapToCanvas(gs.dragFrom.x,gs.dragFrom.y);
  const to=gs.dragPos;
  const col=PLAYER_COLORS[gs.playerIndex];
  const now=Date.now()/1000;
  ctx.save();ctx.strokeStyle=col+'cc';ctx.lineWidth=2.5;
  ctx.setLineDash([8,5]);ctx.lineDashOffset=-(now*30)%13;
  ctx.beginPath();ctx.moveTo(from.x,from.y);ctx.lineTo(to.x,to.y);ctx.stroke();
  ctx.setLineDash([]);
  const angle=Math.atan2(to.y-from.y,to.x-from.x);
  ctx.fillStyle=col;ctx.shadowBlur=8;ctx.shadowColor=col;
  ctx.beginPath();
  ctx.moveTo(to.x,to.y);
  ctx.lineTo(to.x-16*Math.cos(angle-0.4),to.y-16*Math.sin(angle-0.4));
  ctx.lineTo(to.x-16*Math.cos(angle+0.4),to.y-16*Math.sin(angle+0.4));
  ctx.closePath();ctx.fill();ctx.shadowBlur=0;
  const live=gs.towers[gs.dragFrom.id];
  if (live) {
    const cnt=Math.max(1,Math.floor(live.soldiers*DRAG_RATIO));
    const troop=TROOPS[live.troop||'warrior'];
    ctx.fillStyle='#fff';ctx.font='bold 12px monospace';
    ctx.textAlign='center';ctx.textBaseline='middle';
    ctx.fillText(`派遣 ${cnt} ${troop.icon}`,(from.x+to.x)/2,(from.y+to.y)/2-16);
  }
  ctx.restore();
}

function drawSkillOverlay() {
  if (!gs.skillMode) return;
  const now=Date.now()/1000;
  const alpha=0.6+0.3*Math.sin(now*4);
  ctx.save();ctx.globalAlpha=alpha;
  ctx.fillStyle=gs.skillMode==='napalm'?'#ff6348':'#a78bfa';
  ctx.font='bold 15px Share Tech Mono,monospace';
  ctx.textAlign='center';ctx.textBaseline='top';
  ctx.shadowBlur=10;ctx.shadowColor=ctx.fillStyle;
  ctx.fillText(gs.skillMode==='napalm'?'🔥 燃燒彈已就緒，點擊發動':'🌀 策反：點擊敵方塔',canvas.width/2,10);
  ctx.restore();
}

function drawParticles() {
  for (const p of gs.particles) {
    ctx.save();ctx.globalAlpha=p.alpha*0.92;
    if (p.type==='ember') {
      ctx.save();const angle=Math.atan2(p.vy,p.vx);
      ctx.translate(p.x,p.y);ctx.rotate(angle);
      const grad=ctx.createLinearGradient(-p.r*2,0,p.r*0.5,0);
      grad.addColorStop(0,'transparent');grad.addColorStop(1,p.color);
      ctx.fillStyle=grad;ctx.shadowBlur=8;ctx.shadowColor=p.color;
      ctx.fillRect(-p.r*2,-p.r*0.4,p.r*2.5,p.r*0.8);ctx.restore();
    } else {
      ctx.beginPath();ctx.arc(p.x,p.y,Math.max(0.5,p.r),0,Math.PI*2);
      ctx.fillStyle=p.color;ctx.shadowBlur=p.type==='fire'?14:6;ctx.shadowColor=p.color;ctx.fill();
    }
    ctx.restore();
  }
}

function drawDefectFlash() {
  if (!gs.defectFlash) return;
  const t=Math.min((Date.now()-gs.defectFlash.startAt)/gs.defectFlash.duration,1);
  if (t>=1){gs.defectFlash=null;return;}
  const intensity=t<0.1?t/0.1:1-(t-0.1)/0.9;
  ctx.save();
  const grd=ctx.createRadialGradient(gs.defectFlash.x,gs.defectFlash.y,0,gs.defectFlash.x,gs.defectFlash.y,Math.max(canvas.width,canvas.height)*1.2);
  const c=gs.defectFlash.color;
  grd.addColorStop(0,c+Math.round(intensity*0.55*255).toString(16).padStart(2,'0'));
  grd.addColorStop(0.4,c+Math.round(intensity*0.2*255).toString(16).padStart(2,'0'));
  grd.addColorStop(1,'transparent');
  ctx.fillStyle=grd;ctx.fillRect(0,0,canvas.width,canvas.height);ctx.restore();
}

// ============================================================
//  PARTICLES
// ============================================================
function spawnLaunchParticles(x,y,color) {
  for(let i=0;i<14;i++){
    const a=Math.random()*Math.PI*2,spd=50+Math.random()*120,life=0.3+Math.random()*0.4;
    gs.particles.push({x,y,vx:Math.cos(a)*spd,vy:Math.sin(a)*spd-40,color,maxLife:life,life,maxR:2+Math.random()*3,r:3,alpha:1,type:'normal',gravity:120,drag:0.99});
  }
}
function spawnImpactParticles(x,y,color) {
  for(let i=0;i<22;i++){
    const a=Math.random()*Math.PI*2,spd=80+Math.random()*160,life=0.35+Math.random()*0.45;
    gs.particles.push({x,y,vx:Math.cos(a)*spd,vy:Math.sin(a)*spd-60,color,maxLife:life,life,maxR:3+Math.random()*4,r:4,alpha:1,type:'normal',gravity:180,drag:0.99});
  }
}
function spawnClashParticles(x,y,colA,colB) {
  for(let i=0;i<30;i++){
    const a=Math.random()*Math.PI*2,spd=80+Math.random()*180,life=0.4+Math.random()*0.5;
    const col=i%2===0?colA:colB;
    gs.particles.push({x,y,vx:Math.cos(a)*spd,vy:Math.sin(a)*spd-80,color:col,maxLife:life,life,maxR:3+Math.random()*4,r:4,alpha:1,type:'normal',gravity:160,drag:0.98});
  }
  gs.shockwaves.push({x,y,r:0,maxR:80,life:1,color:'#ffffff',width:2});
}
function spawnArrowParticle(x0,y0,x1,y1,color) {
  if (!gs.arrowParticles) gs.arrowParticles=[];
  gs.arrowParticles.push({x0,y0,x1,y1,color,t:0,alpha:1});
}
function spawnNapalmExplosion(x,y) {
  const fireC=['#ff4757','#ff6348','#ff7f50','#ffa502','#ffdd59','#fff3cd'];
  for(let i=0;i<60;i++){
    const a=Math.random()*Math.PI*2,spd=100+Math.random()*280;
    const col=fireC[Math.floor(Math.random()*fireC.length)],life=0.5+Math.random()*0.8;
    gs.particles.push({x,y,vx:Math.cos(a)*spd,vy:Math.sin(a)*spd-100,color:col,maxLife:life,life,maxR:6+Math.random()*8,r:8,alpha:1,type:'fire',gravity:60,drag:0.97});
  }
  for(let i=0;i<20;i++){
    const col=['#555','#444','#333'][i%3],life=0.8+Math.random()*0.8;
    gs.particles.push({x:x+(Math.random()-.5)*30,y,vx:(Math.random()-.5)*40,vy:-60-Math.random()*80,color:col,maxLife:life,life,maxR:8+Math.random()*10,r:10,alpha:1,type:'fire',gravity:-5,drag:0.98});
  }
}
function spawnEmberCluster(x,y) {
  for(let i=0;i<8;i++){
    const life=0.6+Math.random()*0.7,a=Math.PI*0.5+Math.PI*(Math.random()-.5)*0.8;
    gs.particles.push({x:x+(Math.random()-.5)*60,y,vx:Math.cos(a)*100*(Math.random()-.5)*2,vy:Math.sin(a)*(50+Math.random()*120),color:['#ff4757','#ff6348','#ffa502','#ffdd59'][Math.floor(Math.random()*4)],maxLife:life,life,maxR:2+Math.random()*3,r:3,alpha:1,type:'ember',gravity:80,drag:0.99});
  }
}
function spawnDefectSpiral(x,y,color) {
  const count=80;
  for(let i=0;i<count;i++){
    const t=i/count,angle=t*Math.PI*8,spd=80+Math.random()*200;
    const outA=Math.atan2(Math.sin(angle)*(10+t*120),Math.cos(angle)*(10+t*120));
    const life=0.6+Math.random()*0.7,isWhite=i%5===0;
    gs.particles.push({x:x+Math.cos(angle)*20,y:y+Math.sin(angle)*20,vx:Math.cos(outA)*spd,vy:Math.sin(outA)*spd,color:isWhite?'#ffffff':color,maxLife:life,life,maxR:isWhite?3:4+Math.random()*3,r:4,alpha:1,type:'spiral',gravity:-20,drag:0.95});
  }
  for(let ring=0;ring<3;ring++){
    const rc=24+ring*12;
    for(let i=0;i<rc;i++){
      const a=(Math.PI*2/rc)*i,spd=120+ring*80,life=0.5+ring*0.15;
      gs.particles.push({x,y,vx:Math.cos(a)*spd,vy:Math.sin(a)*spd,color:ring===1?'#ffffff':color,maxLife:life,life,maxR:3+ring,r:3,alpha:1,type:'spiral',gravity:0,drag:0.93});
    }
  }
}

// ===== BOOT =====
window.addEventListener('load', ()=>{
  initCanvas();
  showScreen('menuScreen');
  document.getElementById('startMatchBtn').addEventListener('click', openTroopSelect);
  document.getElementById('troopConfirmBtn').addEventListener('click', confirmTroopAndMatch);
  document.getElementById('troopBackBtn').addEventListener('click', ()=>{gs=freshState();showScreen('menuScreen');});
  document.getElementById('cancelMatchBtn').addEventListener('click', cancelMatchmaking);
  document.getElementById('backToMenuBtn').addEventListener('click', returnToMenu);
  document.getElementById('skillNapalmBtn').addEventListener('click', ()=>selectSkill('napalm'));
  document.getElementById('skillDefectBtn').addEventListener('click', ()=>selectSkill('defect'));
});
