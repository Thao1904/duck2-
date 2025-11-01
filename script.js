// ========================= TUNEABLES =========================
const TUNE = {
  tickBaseMs : 100,
  MOM: { baseStep: 50, turnPerTick: 60, nearDistance: 40 }
};
// =============================================================
const OPTIONS = { IS_DEBUG_MODE: true };

// ===== DOM =====
const playfield    = document.getElementById('playfield');
const videoElement = document.querySelector('.input_video');
const debugCanvas  = document.querySelector('.output_canvas');
const ctx          = debugCanvas.getContext('2d');
const cursorEl     = document.getElementById('hand-cursor');
const motherEl     = document.getElementById('mother');
const centerMsg    = document.getElementById('center-msg');
const nohandBanner = document.getElementById('nohand-banner');

// --- UI MIRROR FLIP (DISPLAY-ONLY)
videoElement.style.transform = 'scaleX(-1)';
debugCanvas.style.transform  = 'scaleX(-1)';
debugCanvas.style.transformOrigin = 'center';

// ===== Helpers =====
function PF(){
  const r = playfield.getBoundingClientRect();
  return { left:r.left, top:r.top, right:r.right, bottom:r.bottom };
}
function clampPF(p){
  const pf=PF();
  return { x:Math.min(Math.max(p.x,pf.left),pf.right), y:Math.min(Math.max(p.y,pf.top),pf.bottom) };
}
function side(p){
  const pf=PF(), e=.6;
  if(Math.abs(p.x-pf.left)<e) return 'left';
  if(Math.abs(p.x-pf.right)<e) return 'right';
  if(Math.abs(p.y-pf.top)<e) return 'top';
  if(Math.abs(p.y-pf.bottom)<e) return 'bottom';
  return null;
}
const r2d=r=>Math.round(r*(180/Math.PI));
const d2r=d=>d/(180/Math.PI);
const nn=(x,n)=>x===0?0:(x-1)+Math.abs(((x-1)%n)-n);
const dist=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);
const off=({x,y,distance,angle})=>({ x:x+(distance*Math.cos(d2r(angle-90))), y:y+(distance*Math.sin(d2r(angle-90))) });
const setXY=({el,x,y})=>{ el.style.transform=`translate(${x}px,${y}px)`; el.style.zIndex=Math.round(y); };
const angTo=(o,t)=>{ const a=r2d(Math.atan2(o.y-t.y,o.x-t.x))-90; return nn(a<0?a+360:a,1); };
const dir=a=>({360:'up',45:'up right',90:'right',135:'down right',180:'down',225:'down left',270:'left',315:'up left'})[nn(a,45)];
const diff=(a,b)=>{ const d1=Math.abs(a-b), d2=360-d1; return d1>d2?d2:d1; };

// ===== Landmarks helpers =====
const parts = { thumb:{tip:4}, index:{middle:6, tip:8}, wrist:0 };
// (video mirrored visually → flip x numerically)
const curNorm = (lm) => { const p=lm[parts.index.middle]; return { x:(-p.x+1), y:p.y }; };

// motion tracking per hand label
const prevCentroid = { left:null, right:null };
function centroid(lm){ const pts=[lm[parts.wrist], lm[parts.index.middle], lm[parts.index.tip], lm[parts.thumb.tip]]; const sx=pts.reduce((a,p)=>a+p.x,0), sy=pts.reduce((a,p)=>a+p.y,0); return { x:sx/pts.length, y:sy/pts.length }; }
function motionMag(a,b){ if(!a||!b) return 0; const dx=a.x-b.x, dy=a.y-b.y; return Math.hypot(dx,dy); }

// ===== Debug draw =====
function drawDbgConditional(res, chosenIdx, policy){
  if(!OPTIONS.IS_DEBUG_MODE) return;
  debugCanvas.style.display='block';
  ctx.save();
  ctx.clearRect(0,0,debugCanvas.width,debugCanvas.height);
  ctx.drawImage(res.image,0,0,debugCanvas.width,debugCanvas.height);

  const lms = res.multiHandLandmarks || [];
  for(let i=0;i<lms.length;i++){
    drawConnectors(ctx, lms[i], HAND_CONNECTIONS, { color:(i===chosenIdx?'#0ff':'#0ff3'), lineWidth:(i===chosenIdx?5:3) });
    drawLandmarks (ctx, lms[i], { color:(i===chosenIdx?'#f0f':'#f0f3'), lineWidth:(i===chosenIdx?2:1) });
  }

  // optional bbox
  const drawBBox = (lm) => {
    let minX=+1e9, minY=+1e9, maxX=-1e9, maxY=-1e9;
    for(const p of lm){ minX=Math.min(minX,p.x); maxX=Math.max(maxX,p.x); minY=Math.min(minY,p.y); maxY=Math.max(maxY,p.y); }
    const x=minX*debugCanvas.width, y=minY*debugCanvas.height, ww=(maxX-minX)*debugCanvas.width, hh=(maxY-minY)*debugCanvas.height;
    ctx.strokeStyle='#ffea00'; ctx.lineWidth=4; ctx.strokeRect(x,y,ww,hh);
  };

  if(policy.mode==='single'){
    if(policy.showSingleBBox && res.multiHandLandmarks?.[policy.singleIndex]) drawBBox(res.multiHandLandmarks[policy.singleIndex]);
  } else if(policy.mode==='dual'){
    if(res.multiHandLandmarks?.[0]) drawBBox(res.multiHandLandmarks[0]);
    if(res.multiHandLandmarks?.[1]) drawBBox(res.multiHandLandmarks[1]);
  }
  ctx.restore();
}

// ===== Game state =====
const data = {
  timer:null,
  desire:{x:0, y:0},
  cursor:{x:0, y:0},
  mother:{ x:0, y:0, angle:180, direction:'down', offset:{x:26, y:18.2}, el:motherEl },
  ducklingTargets:[],
  ducklings:[]
};
const SPEED = 1;

// ===== Movement =====
function stepBound(ent, target, step){
  const o = { x: ent.x + ent.offset.x, y: ent.y + ent.offset.y };
  const a = angTo(o, target);
  let next = off({ x:ent.x, y:ent.y, distance:step, angle:a });
  const pf = PF();
  const cx = Math.min(Math.max(next.x + ent.offset.x, pf.left ), pf.right ) - ent.offset.x;
  const cy = Math.min(Math.max(next.y + ent.offset.y, pf.top  ), pf.bottom) - ent.offset.y;
  const collided = (cx!==next.x) || (cy!==next.y);

  if(!collided){ ent.x=cx; ent.y=cy; return a; }

  const cC = clampPF({ x:next.x+ent.offset.x, y:next.y+ent.offset.y });
  const s  = side(cC);
  const v  = { x:target.x-o.x, y:target.y-o.y };
  const sg = v => v===0?0:(v>0?1:-1);
  switch(s){
    case 'left': case 'right':
      ent.x=(s==='left'?pf.left-ent.offset.x:pf.right-ent.offset.x);
      ent.y=Math.min(Math.max(ent.y+sg(v.y)*step, pf.top-ent.offset.y), pf.bottom-ent.offset.y);
      break;
    case 'top': case 'bottom':
      ent.y=(s==='top'?pf.top-ent.offset.y:pf.bottom-ent.offset.y);
      ent.x=Math.min(Math.max(ent.x+sg(v.x)*step, pf.left-ent.offset.x), pf.right-ent.offset.x);
      break;
    default:
      ent.x=cC.x-ent.offset.x; ent.y=cC.y-ent.offset.y;
  }
  const no = { x: ent.x + ent.offset.x, y: ent.y + ent.offset.y };
  return angTo(o, no);
}

function tick(){
  const c = clampPF(data.desire);
  data.cursor.x=c.x; data.cursor.y=c.y;

  const o = { x:data.mother.x+data.mother.offset.x, y:data.mother.y+data.mother.offset.y };
  const d = dist(o, data.cursor);

  const near = TUNE.MOM.nearDistance / SPEED;
  if(!d || d<near){ motherEl.classList.remove('waddle'); return; }

  const facing = off({ x:data.mother.x, y:data.mother.y, distance:100, angle:data.mother.angle });
  const need   = diff(angTo(o, facing), angTo(o, data.cursor));
  const STEP = TUNE.MOM.baseStep * SPEED;
  const TURN = TUNE.MOM.turnPerTick * SPEED;

  let used;
  if(need>TURN){
    const rad=d2r(TURN);
    const v={ x:data.cursor.x-o.x, y:data.cursor.y-o.y };
    const r={ x:v.x*Math.cos(rad)-v.y*Math.sin(rad), y:v.x*Math.sin(rad)+v.y*Math.cos(rad) };
    used=stepBound(data.mother,{ x:o.x+r.x, y:o.y+r.y },STEP);
  }else{
    used=stepBound(data.mother,data.cursor,STEP);
  }

  data.mother.angle=used;
  data.mother.direction=dir(used);
  setXY({ el:motherEl, x:data.mother.x, y:data.mother.y });
  motherEl.className=`duck waddle ${data.mother.direction}`;

  data.ducklingTargets.forEach((t,i)=>{
    const back=off({ x:data.mother.x, y:data.mother.y, distance:60+(80*i), angle:data.mother.angle+180 });
    const cc=clampPF({ x:back.x+data.mother.offset.x, y:back.y+data.mother.offset.y });
    t.x=cc.x; t.y=cc.y;
  });
}

function moveEnt(ent,x,y){ ent.x=x; ent.y=y; ent.el.style.transform=`translate(${x}px,${y}px)`; ent.el.style.zIndex=Math.round(y); }
setInterval(()=>{
  data.ducklings.forEach((d,i)=>{
    const t=data.ducklingTargets[i];
    const full=Math.hypot((d.x+d.offset.x)-t.x,(d.y+d.offset.y)-t.y);
    if(full<40){ d.el.classList.remove('waddle'); return; }
    const tmp={ x:d.x, y:d.y, offset:d.offset };
    const ang=stepBound(tmp,{ x:t.x, y:t.y },30);
    d.x=tmp.x; d.y=tmp.y; moveEnt(d,d.x,d.y);
    d.el.className=`duckling waddle ${dir(ang)}`;
  });
},300);

// FX + spawn
function quack(x,y){
  const el=document.createElement('div');
  el.className='fx-quack'; el.textContent='quack';
  el.style.left=`${x}px`; el.style.top=`${y}px`;
  document.body.appendChild(el);
  setTimeout(()=>el.remove(),650);
}
function plus(){
  const el=document.createElement('div');
  el.className='fx-plus'; el.textContent='+1 baby duck';
  document.body.appendChild(el);
  setTimeout(()=>el.remove(),950);
}
function spawnDuckling(){
  if (data.ducklings.length >= 50) { resetGame('too-many-babies'); return; }
  const pf=PF(); const x=pf.left+28, y=pf.top+28;
  const n=document.createElement('div'); n.className='duckling down';
  n.innerHTML=`<div class="neck-base"><div class="neck"><div class="head"></div></div></div>
               <div class="tail"></div><div class="body"></div>
               <div class="legs"><div class="leg"></div><div class="leg"></div></div>`;
  document.body.appendChild(n);
  const obj={ el:n, x, y, offset:{x:13, y:9.1} };
  moveEnt(obj,x,y);
  data.ducklings.push(obj);
  data.ducklingTargets.push({ x, y });
}
let last=false, count=0, timer=null; const WINDOW=4000;
function cycle(){
  count++; quack(data.desire.x,data.desire.y);
  if(count>=3){ count=0; clearTimeout(timer); timer=null; spawnDuckling(); plus(); }
  else if(!timer){ timer=setTimeout(()=>{ count=0; timer=null; }, WINDOW); }
}

// Reset
let lastSeen = Date.now();
let resetArmed = false;
function resetGame(reason='manual/clap'){
  const pf=PF(); const cx=(pf.left+pf.right)/2, cy=(pf.top+pf.bottom)/2;

  document.querySelectorAll('.duckling').forEach(n=>n.remove());
  data.ducklings.length=0;
  data.ducklingTargets.length=0;

  data.mother.x=cx-data.mother.offset.x;
  data.mother.y=cy-data.mother.offset.y;
  data.mother.angle=180; data.mother.direction='down';
  setXY({ el:motherEl, x:data.mother.x, y:data.mother.y });
  motherEl.className='duck down';

  data.desire.x=cx; data.desire.y=cy;
  data.cursor.x=cx; data.cursor.y=cy;
  count=0; clearTimeout(timer); timer=null;
  cursorEl.classList.remove('is-pinched');

 centerMsg.innerHTML = `<b>Restarted</b>`;
  centerMsg.style.display='block';
  setTimeout(()=>{ centerMsg.style.display='none'; }, 2000);

  lastSeen=Date.now();
  resetArmed=false;
  console.info('[RESET]', reason);
}

// Idle / capacity watchdog
setInterval(()=>{
  const idle = Date.now() - lastSeen;
  if (idle > 10000 && !resetArmed) { resetArmed = true; resetGame('no-hand 10s'); }
  if (data.ducklings.length >= 50) { resetGame('too-many-babies'); }
}, 300);

// Init
(function init(){
  const pf=PF();
  const cx=(pf.left+pf.right)/2, cy=(pf.top+pf.bottom)/2;
  data.desire.x=cx; data.desire.y=cy;
  data.mother.x=cx-26; data.mother.y=cy-18.2;
  setXY({ el:motherEl, x:data.mother.x, y:data.mother.y });

  const interval=Math.max(80, TUNE.tickBaseMs / 1);
  data.timer=setInterval(tick, interval);
})();

// ===== MediaPipe callback =====
let lastTwoHandDist = null;
const CLAP_NEAR  = 0.08;
const CLAP_SPEED = -0.02;
let clapLockUntil = 0;

function onResults(res){
  if(!res) return;
  const lms = res.multiHandLandmarks || [];
  const handsCount = lms.length;

  // Toggle "no hand" banner inside camera
  nohandBanner.style.display = (handsCount===0) ? 'block' : 'none';

  // Choose controlling hand by motion
  let chosenIdx = null, bestMotion = -1;
  if(handsCount>0){
    const handed = res.multiHandedness || [];
    for(let i=0;i<lms.length;i++){
      const label = (handed[i]?.label || 'Right').toLowerCase();
      const cNow = centroid(lms[i]);
      const cPrev = prevCentroid[label];
      const m = motionMag(cNow, cPrev);
      if(m>bestMotion){ bestMotion=m; chosenIdx=i; }
      prevCentroid[label]=cNow;
    }
  }

  // Debug draw
  let policy = { mode:'single', singleIndex:chosenIdx, showSingleBBox:false };
  if(handsCount>=2){ policy = { mode:'dual' }; }
  drawDbgConditional(res, chosenIdx, policy);

  
  // Update cursor from chosen hand
  if(chosenIdx!=null){
    lastSeen = Date.now(); resetArmed=false;
    const p = curNorm(lms[chosenIdx]);
    const vw = innerWidth, vh = innerHeight;
    data.desire.x = p.x * vw; data.desire.y = p.y * vh;
    cursorEl.style.transform = `translate(${data.desire.x}px, ${data.desire.y}px)`;

    // pinch detect
    const f=lms[chosenIdx][parts.index.tip], t=lms[chosenIdx][parts.thumb.tip];
    const dx=Math.abs(f.x-t.x), dy=Math.abs(f.y-t.y), dz=Math.abs(f.z-t.z);
    const pinched=(dx<0.08 && dy<0.08 && dz<0.11);
    cursorEl.classList.toggle('is-pinched', pinched);
    if(!window.__lastPinch && pinched){ /* pinch start */ }
    else if(window.__lastPinch && !pinched){ cycle(); } // release → quack
    window.__lastPinch = pinched;
  }
}

// ===== MediaPipe setup =====
const hands = new Hands({ locateFile:f=>`https://cdn.jsdelivr.net/npm/@mediapipe/hands/${f}` });
hands.setOptions({ maxNumHands:2, modelComplexity:1, minDetectionConfidence:0.5, minTrackingConfidence:0.5 });
hands.onResults(onResults);

const cam = new Camera(videoElement,{ onFrame:async()=>{ await hands.send({ image:videoElement }); }, width:1280, height:720 });
cam.start();

/* =========================
   NOTES
   - Single-line instruction at top center.
   - If no hand detected → yellow banner inside camera says:
     "Move your hand in front of the camera".
   - Boundary & camera canvas with golden border.
   - Rest of interaction logic preserved from baseline.
   ========================= */
