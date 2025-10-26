// ========================= TUNEABLES =========================
// Tăng/giảm các giá trị dưới đây để chỉnh SPEED & SENSITIVITY của vịt mẹ
const TUNE = {
  tickBaseMs    : 100,   // (TỐC ĐỘ) nhịp update cơ bản. Giảm số này -> cập nhật nhanh hơn
  MOM: {
    baseStep     : 50,   // (TỐC ĐỘ) số pixel vịt mẹ đi mỗi nhịp (trước khi nhân SPEED slider)
    turnPerTick  : 60,   // (ĐỘ NHẠY HƯỚNG) tối đa độ quay (độ) mỗi nhịp; lớn hơn -> quay theo cursor nhanh/“gắt” hơn
    nearDistance : 40,   // (ĐỘ NHẠY TIẾP CẬN) khoảng cách (px) coi như đã tới cursor; giảm -> bám sát hơn, dễ rung hơn
  }
};
// =============================================================

// ===== Options =====
const OPTIONS = { IS_DEBUG_MODE: true, PREFERRED_HAND: 'right' };

// ===== DOM =====
const playfield   = document.getElementById('playfield');
const lefty       = document.getElementById('hand_choice');
const speedRange  = document.getElementById('speed_range');
const speedValue  = document.getElementById('speed_value');
const videoElement= document.querySelector('.input_video');
const debugCanvas = document.querySelector('.output_canvas');
const ctx         = debugCanvas.getContext('2d');
const cursorEl    = document.getElementById('hand-cursor');
const motherEl    = document.getElementById('mother');

// Ensure the <video> itself is fullscreen + cover (if you show it)
(function styleVideoAsCover(){
  Object.assign(videoElement.style, {
    position: 'fixed',
    top: '0',
    left: '0',
    width: '100vw',
    height: '100vh',
    objectFit: 'cover',
    zIndex: '-1' // behind everything; change if you want to see the raw video
  });
})();

lefty.addEventListener('change', () => {
  OPTIONS.PREFERRED_HAND = lefty.checked ? 'left' : 'right';
});

// ===== Boundary helpers =====
function PF(){
  const r = playfield.getBoundingClientRect();
  return { left:r.left, top:r.top, right:r.right, bottom:r.bottom, width:r.width, height:r.height };
}
function clampPF(p){
  const pf = PF();
  return {
    x: Math.min(Math.max(p.x, pf.left ), pf.right ),
    y: Math.min(Math.max(p.y, pf.top  ), pf.bottom)
  };
}
function side(p){
  const pf = PF(), e = .6;
  if (Math.abs(p.x - pf.left  ) < e) return 'left';
  if (Math.abs(p.x - pf.right ) < e) return 'right';
  if (Math.abs(p.y - pf.top   ) < e) return 'top';
  if (Math.abs(p.y - pf.bottom) < e) return 'bottom';
  return null;
}

// ===== Math =====
const r2d   = r => Math.round(r * (180/Math.PI));
const d2r   = d => d / (180/Math.PI);
const nn    = (x,n) => x===0 ? 0 : (x-1) + Math.abs(((x-1)%n) - n);
const dist  = (a,b) => Math.hypot(a.x-b.x, a.y-b.y);
const off   = ({x,y,distance,angle}) => ({ x: x + (distance*Math.cos(d2r(angle-90))), y: y + (distance*Math.sin(d2r(angle-90))) });
const setXY = ({el,x,y}) => { el.style.transform = `translate(${x}px,${y}px)`; el.style.zIndex = Math.round(y); };
const angTo = (o,t) => { const a = r2d(Math.atan2(o.y-t.y,o.x-t.x)) - 90; return nn(a<0 ? a+360 : a, 1); };
const dir   = a => ({360:'up',45:'up right',90:'right',135:'down right',180:'down',225:'down left',270:'left',315:'up left'})[nn(a,45)];
const diff  = (a,b) => { const d1 = Math.abs(a-b), d2 = 360 - d1; return d1 > d2 ? d2 : d1; };

// ===== Hand helpers =====
const parts    = { thumb:{tip:4}, index:{middle:6, tip:8} };
const handLbl  = h => h?.multiHandLandmarks?.[0] ? (h.multiHandedness[0].label === 'Left' ? 'right' : 'left') : null;
const isPrimary= h => handLbl(h) === OPTIONS.PREFERRED_HAND;
const curNorm  = h => { const {x,y} = h.multiHandLandmarks[0][parts.index.middle]; return { x:(-x+1), y }; };

// ===== Map 0..1 hand coords to playfield pixels (not window) =====
function toPlayfieldXY(px01, py01) {
  const r = PF();
  return {
    x: r.left + px01 * r.width,
    y: r.top  + py01 * r.height
  };
}

// ===== Fullscreen, pixel-perfect canvas sizing (DPR-aware) =====
function resizeDebugCanvas() {
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const w = Math.round(window.innerWidth  * dpr);
  const h = Math.round(window.innerHeight * dpr);

  if (debugCanvas.width !== w || debugCanvas.height !== h) {
    debugCanvas.width  = w;
    debugCanvas.height = h;
    Object.assign(debugCanvas.style, {
      position: 'fixed',
      top: '0',
      left: '0',
      width: '100vw',
      height: '100vh'
    });
    ctx.setTransform(1,0,0,1,0,0);
  }
}
window.addEventListener('resize', resizeDebugCanvas);
window.addEventListener('orientationchange', resizeDebugCanvas);
resizeDebugCanvas();

// ===== Pinch detection =====
function pinched(h){
  if (!isPrimary(h)) return false;
  const f=h.multiHandLandmarks[0][parts.index.tip], t=h.multiHandLandmarks[0][parts.thumb.tip];
  const dx=Math.abs(f.x-t.x), dy=Math.abs(f.y-t.y), dz=Math.abs(f.z-t.z);
  return (dx<0.08 && dy<0.08 && dz<0.11);
}

// ===== Draw camera with "object-fit: cover" (fullscreen, no distortion) =====
function drawDbg(h){
  resizeDebugCanvas(); // ensure buffer matches viewport & DPR

  const cw = debugCanvas.width;
  const ch = debugCanvas.height;

  // Use intrinsic size if provided; fallback to 1280x720
  const srcW = h.image?.width  || 1280;
  const srcH = h.image?.height || 720;

  ctx.save();
  ctx.clearRect(0,0,cw,ch);

  // COVER scaling: fill screen, preserve aspect ratio, crop overflow
  const scale = Math.max(cw / srcW, ch / srcH);
  const dw = srcW * scale;
  const dh = srcH * scale;
  const dx = (cw - dw) / 2;
  const dy = (ch - dh) / 2;

  // draw the frame
  ctx.drawImage(h.image, 0, 0, srcW, srcH, dx, dy, dw, dh);

  // draw landmarks in the same scaled space
  if (h.multiHandLandmarks){
    ctx.translate(dx, dy);
    ctx.scale(scale, scale);
    for (const lm of h.multiHandLandmarks){
      drawConnectors(ctx, lm, HAND_CONNECTIONS, { color:'#0ff', lineWidth: 5 / scale });
      drawLandmarks (ctx, lm,                    { color:'#f0f', lineWidth: 2 / scale });
    }
  }
  ctx.restore();
}

// ===== State =====
const data = {
  timer:null,
  desire:{x:0, y:0},
  cursor:{x:0, y:0},
  mother:{ x:0, y:0, angle:180, direction:'down', offset:{x:26, y:18.2}, el:motherEl }, // sprite center (+30%)
  ducklingTargets:[],
  ducklings:[]
};

// ===== Speed (slider) =====
let SPEED = parseFloat(speedRange.value);
function restartLoop(){
  clearInterval(data.timer);
  // (TỐC ĐỘ) tick interval chịu ảnh hưởng bởi SPEED
  const interval = Math.max(80, TUNE.tickBaseMs / SPEED);   // << TUNE tickBaseMs ở trên
  data.timer = setInterval(tick, interval);
}
speedRange.addEventListener('input', () => {
  SPEED = parseFloat(speedRange.value);
  speedValue.textContent = SPEED.toFixed(1);
  restartLoop();
});
speedValue.textContent = SPEED.toFixed(1);

// ===== Boundary step (di chuyển trong biên) =====
function stepBound(ent, target, step){
  const o = { x: ent.x + ent.offset.x, y: ent.y + ent.offset.y };
  const a = angTo(o, target);
  let next = off({ x:ent.x, y:ent.y, distance:step, angle:a });

  const pf = PF();
  const cx = Math.min(Math.max(next.x + ent.offset.x, pf.left ), pf.right ) - ent.offset.x;
  const cy = Math.min(Math.max(next.y + ent.offset.y, pf.top  ), pf.bottom) - ent.offset.y;
  const collided = (cx !== next.x) || (cy !== next.y);

  if (!collided){ ent.x = cx; ent.y = cy; return a; }

  // Trượt dọc biên nếu chạm
  const cC = clampPF({ x:next.x + ent.offset.x, y:next.y + ent.offset.y });
  const s  = side(cC);
  const v  = { x:target.x - o.x, y:target.y - o.y };
  const sg = v => v===0 ? 0 : (v>0 ? 1 : -1);

  switch(s){
    case 'left':
    case 'right':
      ent.x = (s==='left' ? pf.left - ent.offset.x : pf.right - ent.offset.x);
      ent.y = Math.min(Math.max(ent.y + sg(v.y)*step, pf.top - ent.offset.y), pf.bottom - ent.offset.y);
      break;
    case 'top':
    case 'bottom':
      ent.y = (s==='top' ? pf.top - ent.offset.y : pf.bottom - ent.offset.y);
      ent.x = Math.min(Math.max(ent.x + sg(v.x)*step, pf.left - ent.offset.x), pf.right - ent.offset.x);
      break;
    default:
      ent.x = cC.x - ent.offset.x;
      ent.y = cC.y - ent.offset.y;
  }
  const no = { x: ent.x + ent.offset.x, y: ent.y + ent.offset.y };
  return angTo(o, no);
}

// ===== Mother tick =====
function tick(){
  const c = clampPF(data.desire);
  data.cursor.x = c.x; data.cursor.y = c.y;

  const o = { x:data.mother.x + data.mother.offset.x, y:data.mother.y + data.mother.offset.y };
  const d = dist(o, data.cursor);

  // (ĐỘ NHẠY TIẾP CẬN) nếu đã đủ gần thì dừng waddle
  const near = TUNE.MOM.nearDistance / SPEED;  // SPEED cao -> vẫn bám sát
  if (!d || d < near){ motherEl.classList.remove('waddle'); return; }

  const facing = off({ x:data.mother.x, y:data.mother.y, distance:100, angle:data.mother.angle });
  const need   = diff(angTo(o, facing), angTo(o, data.cursor));

  // (TỐC ĐỘ) bước đi + (ĐỘ NHẠY HƯỚNG) góc quay tối đa mỗi nhịp
  const STEP = TUNE.MOM.baseStep * SPEED;       // << TUNE baseStep ở trên
  const TURN = TUNE.MOM.turnPerTick * SPEED;    // << TUNE turnPerTick ở trên

  let used;
  if (need > TURN){
    // quay từng phần theo TURN để tránh giật
    const rad = d2r(TURN);
    const v   = { x: data.cursor.x - o.x, y: data.cursor.y - o.y };
    const r   = { x: v.x*Math.cos(rad) - v.y*Math.sin(rad), y: v.x*Math.sin(rad) + v.y*Math.cos(rad) };
    used = stepBound(data.mother, { x:o.x+r.x, y:o.y+r.y }, STEP);
  } else {
    used = stepBound(data.mother, data.cursor, STEP);
  }

  data.mother.angle     = used;
  data.mother.direction = dir(used);
  setXY({ el:motherEl, x:data.mother.x, y:data.mother.y });
  motherEl.className = `duck waddle ${data.mother.direction}`;

  // Cập nhật điểm bám cho vịt con
  data.ducklingTargets.forEach((t,i)=>{
    const back = off({ x:data.mother.x, y:data.mother.y, distance:60 + (80*i), angle:data.mother.angle + 180 });
    const cc = clampPF({ x:back.x + data.mother.offset.x, y:back.y + data.mother.offset.y });
    t.x = cc.x; t.y = cc.y;
  });
}

// ===== Babies follow =====
function moveEnt(ent,x,y){ ent.x=x; ent.y=y; ent.el.style.transform=`translate(${x}px,${y}px)`; ent.el.style.zIndex=Math.round(y); }
setInterval(()=>{
  data.ducklings.forEach((d,i)=>{
    const t = data.ducklingTargets[i];
    const full = Math.hypot((d.x+d.offset.x)-t.x, (d.y+d.offset.y)-t.y);
    if (full < 40){ d.el.classList.remove('waddle'); return; }
    const tmp = { x:d.x, y:d.y, offset:d.offset };
    const ang = stepBound(tmp, { x:t.x, y:t.y }, 30);
    d.x = tmp.x; d.y = tmp.y;
    moveEnt(d, d.x, d.y);
    d.el.className = `duckling waddle ${dir(ang)}`;
  });
}, 300);

// ===== Effects, spawn baby, triple pinch (giữ nguyên) =====
function quack(x,y){ const el=document.createElement('div'); el.className='fx-quack'; el.textContent='quack'; el.style.left=`${x}px`; el.style.top=`${y}px`; document.body.appendChild(el); setTimeout(()=>el.remove(),650); }
function plus(){ const el=document.createElement('div'); el.className='fx-plus'; el.textContent='+1 baby duck'; document.body.appendChild(el); setTimeout(()=>el.remove(),950); }
function spawnDuckling(){
  const pf=PF(); const x=pf.left+28, y=pf.top+28;
  const n=document.createElement('div'); n.className='duckling down';
  n.innerHTML=`<div class="neck-base"><div class="neck"><div class="head"></div></div></div>
               <div class="tail"></div><div class="body"></div>
               <div class="legs"><div class="leg"></div><div class="leg"></div></div>`;
  document.body.appendChild(n);
  const obj={ el:n, x, y, offset:{x:13, y:9.1} };
  moveEnt(obj, x, y);
  data.ducklings.push(obj);
  data.ducklingTargets.push({ x, y });
}
let last=false, count=0, timer=null; const WINDOW=4000;
function cycle(){ count++; quack(data.desire.x, data.desire.y);
  if(count>=3){ count=0; clearTimeout(timer); timer=null; spawnDuckling(); plus(); }
  else if(!timer){ timer=setTimeout(()=>{ count=0; timer=null; }, WINDOW); } }

// ===== Init =====
(function init(){
  const pf = PF();
  const cx = (pf.left + pf.right)/2, cy = (pf.top + pf.bottom)/2;
  data.desire.x = cx; data.desire.y = cy;
  data.mother.x = cx - 26; data.mother.y = cy - 18.2; // offset để sprite nằm đúng tâm
  setXY({ el:motherEl, x:data.mother.x, y:data.mother.y });
  resizeDebugCanvas(); // ensure canvas buffer is in sync at start
  restartLoop(); // chạy theo TUNE.tickBaseMs & SPEED
})();

// ===== MediaPipe Hands =====
function onResults(h){
  if(!h) return;
  if(OPTIONS.IS_DEBUG_MODE){ debugCanvas.style.display='block'; drawDbg(h); }

  if(isPrimary(h)){
    const p = curNorm(h); // normalized 0..1
    // Map hand to playfield (game boundary), not window
    const pos = toPlayfieldXY(p.x, p.y);
    data.desire.x = pos.x; data.desire.y = pos.y;

    cursorEl.style.transform = `translate(${pos.x}px, ${pos.y}px)`;

    const now = pinched(h);
    cursorEl.classList.toggle('is-pinched', now);
    if(!last && now){ /* pinch start */ }
    else if(last && !now){ cycle(); } // pinch release
    last = now;
  }
}

const hands=new Hands({ locateFile:f=>`https://cdn.jsdelivr.net/npm/@mediapipe/hands/${f}` });
hands.setOptions({ maxNumHands:1, modelComplexity:1, minDetectionConfidence:0.5, minTrackingConfidence:0.5 });
hands.onResults(onResults);

// If you want to hint portrait-friendly capture, keep standard 1280x720 (landscape)
// MediaPipe will letterbox internally; we "cover" during draw to fill screen.
const cam=new Camera(videoElement,{
  onFrame: async () => { await hands.send({ image:videoElement }); },
  width: 1280,
  height: 720
});
cam.start();
