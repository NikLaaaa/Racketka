(()=> {
  // ==== helpers ====
  const $ = s => document.querySelector(s);
  const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const clamp2 = n => (Math.round((Number(n)||0)*100)/100);

  // ==== DOM ====
  const onlineVal = $('#onlineVal');
  const balanceNumEl = $('#balanceNum');
  const multEl = $('#multVal');
  const statusEl = $('#status');
  const payoutTopEl = $('#payoutTop');

  const playersList = $('#playersList');
  const roundTotal = $('#roundTotal');

  const betBtn = $('#betBtn');
  const cashoutBtn = $('#cashoutBtn');

  const navCrash = $('#navCrash');
  const navWheel = $('#navWheel');
  const navProfile = $('#navProfile');
  const tabCrash = $('#tabCrash');
  const tabWheel = $('#tabWheel');
  const tabProfile = $('#tabProfile');

  const profileAva = $('#profileAva');
  const profileName = $('#profileName');
  const profileBalance = $('#profileBalance');

  const depositBtn = $('#depositBtn');
  const withdrawBtn = $('#withdrawBtn');
  const disconnectBtn = $('#disconnectBtn');
  const walletInfo = $('#walletInfo');

  const betModal = $('#betModal');
  const modalBox = $('#betBox') || betModal?.firstElementChild;
  const modalBetInput = $('#modalBetInput');
  const modalConfirm = $('#modalConfirmBtn');
  const modalClose = $('#modalClose');

  const chartCanvas = $('#chartCanvas');
  const ctx = chartCanvas?.getContext?.('2d');

  // ==== constants ====
  const MIN_BET = 0.10;
  const HOUSE = 0.98;

  // ==== state ====
  const qs = new URLSearchParams(location.search);
  const tg = window.Telegram?.WebApp;
  const state = {
    userId: qs.get('userId') || ('guest' + (Math.random()*1e6|0)),
    balance: 0,
    roundState: 'idle',
    displayedMult: 1,
    myBet: 0,
    myCashed: false
  };

  const players = new Map();
  let placingBet = false;
  let cashoutLock = false;
  let localTicker = null;
  let history3 = [];
  let series = [];

  // ==== TonConnect (optional) ====
  let tonConnectUI;
  const DEPOSIT_WALLET = 'UQDEx5xByv2a4JE95W2EmJKfDe1ZWA0Azs16GTiUlhlESfed';

  function getConnectedAddress(){ return tonConnectUI?.wallet?.account?.address || null; }
  function updateWalletInfo(){
    const addr = getConnectedAddress();
    if (addr) { walletInfo?.classList?.remove('hidden'); walletInfo.textContent = `Кошелёк: ${addr}`; }
    else { walletInfo?.classList?.add('hidden'); walletInfo.textContent = ''; }
  }
  async function initTonConnect(){
    if (!window.TON_CONNECT_UI) return;
    tonConnectUI = new TON_CONNECT_UI.TonConnectUI({ manifestUrl:`${location.origin}/tonconnect-manifest.json`, buttonRootId:'ton-connect' });
    tonConnectUI.onStatusChange(updateWalletInfo); updateWalletInfo();
  }
  initTonConnect();

  disconnectBtn?.addEventListener('click', async () => { try{ await tonConnectUI?.disconnect(); }catch{} updateWalletInfo(); });
  depositBtn?.addEventListener('click', async () => {
    try{
      if (!getConnectedAddress()) { await tonConnectUI?.openModal(); if (!getConnectedAddress()) return; }
      const amtStr = prompt('Сколько TON пополнить?'); const amt = Number((amtStr||'').replace(',','.'));
      if (!amt || amt<=0) return;
      const nano = BigInt(Math.round(amt*1e9)).toString();
      await tonConnectUI.sendTransaction({ validUntil: Math.floor(Date.now()/1000)+300, messages:[{ address: DEPOSIT_WALLET, amount: nano }] });
      alert('✅ Транзакция отправлена. Зачисление будет после подтверждения сети.');
    }catch{ alert('Операция отменена или произошла ошибка.'); }
  });
  withdrawBtn?.addEventListener('click', async () => {
    const amtStr = prompt('Сумма вывода (TON):'); const amt = Number((amtStr||'').replace(',','.')); if (!amt || amt<=0) return;
    try{
      const body = { userId: state.userId, amount: amt }; const addr = getConnectedAddress(); if (addr) body.address = addr;
      const r = await fetch('/withdraw',{ method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)}).then(r=>r.json());
      if (!r.ok) return alert(r.error || 'Ошибка'); alert('✅ Заявка создана. Сумма будет перечислена на ваш кошелёк в ближайшее время.');
    }catch{ alert('Ошибка сети'); }
  });

  // ==== Telegram профиль ====
  let tgProfile = { name: '–', photo: null };
  function applyTgProfile(){
    try{
      tg?.ready?.(); tg?.expand?.();
      const u = tg?.initDataUnsafe?.user;
      const nameQS = qs.get('name'); const photoQS = qs.get('photo');

      if (u){
        const composed = [u.first_name,u.last_name].filter(Boolean).join(' ');
        tgProfile.name = composed || (u.username?`@${u.username}`:'–');
        if (u.photo_url) tgProfile.photo = u.photo_url;
      } else if (nameQS){
        tgProfile.name = nameQS; if (photoQS) tgProfile.photo = photoQS;
      }

      // применяем в UI
      if (tgProfile.photo) profileAva.src = tgProfile.photo; else profileAva.removeAttribute('src');
      profileName.textContent = tgProfile.name;

      // отправим профиль на сервер сразу при открытии сокета
      const send = ()=>{ try{ ws.send(JSON.stringify({ type:'profile', profile:{ nick:tgProfile.name, avatar:tgProfile.photo } })); }catch{} };
      if (ws.readyState===1) send(); else ws.addEventListener('open', send, {once:true});
    }catch{}
  }
  document.addEventListener('DOMContentLoaded', applyTgProfile);

  // ==== WebSocket ====
  const wsUrl = location.origin.replace(/^http/,'ws') + `/?userId=${encodeURIComponent(state.userId)}`;
  const ws = new WebSocket(wsUrl);

  ws.onmessage = (ev) => {
    let d; try{ d = JSON.parse(ev.data); } catch { return; }
    if (d.online != null) onlineVal.textContent = d.online;

    switch (d.type) {
      case 'init':
        setBalance(d.balance || 0);
        setStars(d.stars || 0);
        history3 = Array.isArray(d.history) ? d.history.slice(0,3) : [];
        renderHistory();
        setMult(1.00);
        statusEl.textContent='ожидание…';
        break;

      case 'profile_update':
        // если пришёл апдейт другого игрока — не создаём пустышки, только обновим если он уже ставил
        if (players.has(d.userId)) {
          const p = players.get(d.userId);
          p.nick = d.nick || p.nick;
          p.avatar = (d.avatar !== undefined) ? d.avatar : p.avatar;
          players.set(d.userId, p);
          renderPlayers();
        }
        break;

      case 'round_start': onRoundStart(d); break;
      case 'round_running': onRoundRunning(); break;
      case 'multiplier': setMult(d.multiplier); break;

      case 'round_end':
        onRoundEnd(d);
        if (Array.isArray(d.history)) { history3 = d.history.slice(0,3); renderHistory(); }
        break;

      case 'player_bet': onPlayerBet(d); break;
      case 'player_cashed': onPlayerCashed(d); break;

      case 'bet_confirm':
        placingBet = false;
        state.myBet = Number(d.amount)||0;
        setBalance(d.balance ?? state.balance);
        betBtn.disabled = true;
        cashoutBtn.disabled = false;
        cashoutBtn.classList.add('active','pulse','armed');
        updateTopPayout();
        break;

      case 'cashout_result':
        setBalance(d.balance ?? state.balance);
        state.myBet = 0; state.myCashed = true;
        cashoutBtn.disabled = true;
        cashoutBtn.classList.remove('active','pulse','armed');
        payoutTopEl.textContent = '';
        cashoutLock = false;
        break;

      case 'error':
        placingBet = false; cashoutLock = false; alert(d.message || 'Ошибка'); break;
    }
  };

  // ==== UI helpers ====
  function setBalance(v){ state.balance = Number(v)||0; balanceNumEl.textContent = state.balance.toFixed(2); profileBalance.textContent = state.balance.toFixed(2); }
  function setStars(v){ WSTATE.stars = Number(v)||0; starsEl.textContent = WSTATE.stars; }

  function setMult(v){
    const m = Number(v)||1;
    state.displayedMult = m;
    multEl.textContent = m.toFixed(2);
    pushPoint(m);
    updateTopPayout();
  }

  function updateTopPayout(){
    const bet = state.myBet||0, k = state.displayedMult||1;
    const cashout = bet*k*HOUSE;
    if (bet>0 && state.roundState==='running' && cashout>0) payoutTopEl.textContent = `≈ ${cashout.toFixed(2)} TON`;
    else payoutTopEl.textContent = '';
    cashoutBtn.classList.toggle('armed', bet>0 && state.roundState==='running');
  }

  function renderHistory(){
    const row = $('#crashRow'); row.innerHTML = '';
    history3.slice(0,3).forEach(x=>{
      const m = Number(x)||1;
      const el = document.createElement('div');
      el.className = 'crash-chip ' + (m>=2 ? 'good' : 'bad');
      el.textContent = m.toFixed(2) + 'x';
      row.appendChild(el);
    });
  }

  // НЕ создаём «левого User»: не добавляем игрока, если у него нет активности
  function addOrUpdatePlayer(id, nick, avatar){
    const has = players.get(id);
    const p = has || { id, amount:0, payout:0, cashed:false, nick:'', avatar:null };
    if (nick) p.nick = nick;
    if (avatar !== undefined) p.avatar = avatar;
    players.set(id, p);
    renderPlayers();
  }
  function onPlayerBet(d){
    addOrUpdatePlayer(d.userId, d.nick, d.avatar);
    const p = players.get(d.userId);
    p.amount = +(p.amount + Number(d.amount||0)).toFixed(2);
    renderPlayers();
  }
  function onPlayerCashed(d){
    const p = players.get(d.userId); if (!p) return;
    p.cashed = true; p.payout = Number(d.payout)||0;
    renderPlayers();
  }
  function clearPlayers(){ players.clear(); renderPlayers(); }
  function renderPlayers(){
    playersList.innerHTML = '';
    let total=0;
    for (const [,p] of players) total += p.amount||0;
    for (const [,p] of players){
      // пропустим игроков без активности, чтобы не мигал «User»
      if (!(p.amount>0 || p.cashed)) continue;
      const ava = p.avatar ? `<img class="pava" src="${esc(p.avatar)}" alt="">` : `<div class="pava pava--ph"></div>`;
      const name = esc(p.nick || 'Игрок');
      const row = document.createElement('div'); row.className='player';
      row.innerHTML = `
        <div class="pinfo">${ava}<div class="pname">${name}</div></div>
        <div class="pval ${p.cashed ? 'good' : ''}">
          ${p.cashed ? `+${(p.payout||0).toFixed(2)}` : (p.amount ? (p.amount||0).toFixed(2) : '')}
        </div>`;
      playersList.appendChild(row);
    }
    roundTotal.textContent = total ? `${total.toFixed(2)} TON` : '';
  }

  // ==== modal ====
  function openModal(el){
    if (!el) return;
    if (!el.classList.contains('open')){
      el.classList.add('open'); el.style.display='flex'; document.body.classList.add('modal-open');
    }
    modalBox?.addEventListener('click', e=>e.stopPropagation());
    el.addEventListener('click', e=>{ if (e.target===el) closeModal(el); });
    // гарантируем кликабельность на ПК/мобиле
    modalBetInput.style.pointerEvents = 'auto';
    modalBetInput.removeAttribute('disabled');
    ensureBetInputReady(modalBetInput.value || '');
  }
  function closeModal(el){ if (!el) return; el.classList.remove('open'); el.style.display='none'; document.body.classList.remove('modal-open'); }
  function ensureBetInputReady(initialValue=''){
    if (!modalBetInput) return;
    modalBetInput.setAttribute('type','text');
    modalBetInput.setAttribute('inputmode','decimal');
    modalBetInput.setAttribute('autocomplete','off');
    modalBetInput.setAttribute('autocapitalize','off');
    modalBetInput.setAttribute('spellcheck','false');
    modalBetInput.disabled = false;
    modalBetInput.value = initialValue;
    requestAnimationFrame(()=>{
      modalBetInput.focus(); modalBetInput.select();
      setTimeout(()=>{ if (document.activeElement!==modalBetInput){ modalBetInput.focus(); modalBetInput.select(); } }, 40);
    });
  }
  function openBetModal(){
    if (state.roundState!=='betting'){
      alert('Ставки пока закрыты. Подожди начала раунда.');
      // когда начнутся — откроем автоматически
      const once = (ev) => {
        if (ev?.type==='message') return; // заглушка
      };
      return;
    }
    ensureBetInputReady(modalBetInput.value||'');
    openModal(betModal);
  }
  betBtn?.addEventListener('click', openBetModal);
  modalClose?.addEventListener('click', ()=> closeModal(betModal));
  modalBetInput?.addEventListener('keydown', e=>{ if (e.key==='Enter') modalConfirm.click(); });

  modalConfirm?.addEventListener('click', ()=>{
    if (placingBet) return;
    const raw = (modalBetInput.value||'').replace(',','.');
    const amt = clamp2(raw);
    if (!amt || isNaN(amt) || amt < MIN_BET){ alert(`Минимальная ставка ${MIN_BET.toFixed(2)} TON`); ensureBetInputReady(raw); return; }
    if (state.balance < amt){ alert('Недостаточно TON'); ensureBetInputReady(raw); return; }
    placingBet = true;
    try{
      ws.send(JSON.stringify({
        type:'place_bet',
        amount: amt,
        profile: { nick: tgProfile.name, avatar: tgProfile.photo } // отправим профиль вместе со ставкой
      }));
      closeModal(betModal); betBtn.disabled = true;
      setTimeout(()=> placingBet=false, 300);
    }catch{ placingBet=false; }
  });

  cashoutBtn?.addEventListener('click', ()=>{
    if (cashoutLock) return;
    if (state.roundState!=='running') return alert('Рано');
    cashoutLock = true; ws.send(JSON.stringify({ type:'cashout' }));
    cashoutBtn.disabled = true; cashoutBtn.classList.remove('active','pulse');
  });

  // ==== tabs ====
  function setTab(name){
    const isCrash = name==='crash';
    const isWheel = name==='wheel';
    tabCrash.classList.toggle('hidden', !isCrash);
    tabWheel.classList.toggle('hidden', !isWheel);
    tabProfile.classList.toggle('hidden', isCrash || isWheel);
    navCrash.classList.toggle('active', isCrash);
    navWheel.classList.toggle('active', isWheel);
    navProfile.classList.toggle('active', !isCrash && !isWheel);
    if (isWheel) wheelRender();
  }
  navCrash?.addEventListener('click', ()=> setTab('crash'));
  navWheel?.addEventListener('click', ()=> setTab('wheel'));
  navProfile?.addEventListener('click', ()=> setTab('profile'));

  // ==== chart ====
  function resizeCanvas(){
    if (!chartCanvas) return;
    const rect = chartCanvas.parentElement.getBoundingClientRect();
    chartCanvas.width = Math.max(300, rect.width);
    chartCanvas.height = Math.max(180, rect.height);
    drawChart();
  }
  function pushPoint(mult){
    if (!ctx) return;
    const x = (series.length ? series[series.length-1].x + 1 : 0);
    series.push({ x, y: mult });
    if (series.length > 500) series.shift();
    drawChart();
  }
  function drawChart(){
    if (!ctx) return;
    const w = chartCanvas.width, h = chartCanvas.height;
    ctx.clearRect(0,0,w,h); ctx.fillStyle='#0d131b'; ctx.fillRect(0,0,w,h);
    ctx.strokeStyle='#182232'; ctx.lineWidth=1;
    for (let i=1;i<=4;i++){ const y=(h/5)*i; ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(w,y); ctx.stroke(); }
    if (series.length<2) return;
    const xs = series.map(p=>p.x), ys = series.map(p=>p.y);
    const xmin=Math.min(...xs), xmax=Math.max(...xs), ymin=1, ymax=Math.max(2, Math.max(...ys)*1.1);
    const fx = x=> (x - xmin) / Math.max(1,(xmax - xmin)) * (w-24) + 12;
    const fy = y=> h - ( (y - ymin) / (ymax - ymin) ) * (h-24) - 12;
    ctx.strokeStyle='#22e58a'; ctx.lineWidth=3; ctx.beginPath();
    series.forEach((p,i)=>{ const X=fx(p.x), Y=fy(p.y); if (i===0) ctx.moveTo(X,Y); else ctx.lineTo(X,Y); });
    ctx.stroke();
  }
  window.addEventListener('resize', resizeCanvas);
  resizeCanvas();
  modalBetInput?.addEventListener('wheel', e => e.preventDefault(), { passive:false });
  window.addEventListener('error', e=> console.error('JS Error:', e.message));

  // ================== WHEEL + STARS ==================
  const wheelCanvas = $('#wheelCanvas'); const wctx = wheelCanvas?.getContext('2d');
  const wheelCenter = $('#wheelCenter'); const wheelSpinBtn = $('#wheelSpinBtn'); const starsEl = $('#starsBalance');
  const WSTATE = { stars: 0, price: 50, sectors: [], angle: 0, spinning: false, rerollOnce:false };
  starsEl.textContent = WSTATE.stars;

  // — загрузка подарков
  async function wheelLoad(){
    let gifts=[];
    try{
      const r = await fetch('/gifts',{cache:'no-store'}); const js = await r.json();
      gifts = (js.items||[]).filter(x=>x.img&&x.name).sort((a,b)=>a.priceTon-b.priceTon).slice(0,5)
              .map((g,i)=>({ type:'gift', name:g.name, img:g.img, color: ['#ffd43b','#5b46ff','#24c2a6','#74f0ff','#ff7b7b'][i%5] }));
    }catch{}
    while (gifts.length<5) gifts.push({type:'gift',name:`Gift #${gifts.length+1}`,img:'',color:'#5b46ff'});

    const noLoot = { type:'none', name:'No Loot', img:'', color:'#1c2433' };
    const reroll = { type:'reroll', name:'Re-roll', img:'', color:'#ffb703' };
    WSTATE.sectors = [gifts[0], noLoot, gifts[1], gifts[2], reroll, gifts[3], noLoot, gifts[4]];
    wheelRender();
  }

  function wheelRender(){
    if (!wctx) return;
    const { width:w, height:h } = wheelCanvas; const cx=w/2, cy=h/2, R=Math.min(cx,cy)-6;
    wctx.clearRect(0,0,w,h);
    const N=WSTATE.sectors.length; const step=Math.PI*2/N;
    wctx.save(); wctx.translate(cx,cy); wctx.rotate(WSTATE.angle);
    for (let i=0;i<N;i++){
      const a0=i*step, a1=(i+1)*step, sec=WSTATE.sectors[i];
      // сектор
      wctx.beginPath(); wctx.moveTo(0,0); wctx.arc(0,0,R,a0,a1,false); wctx.closePath();
      wctx.fillStyle=sec.color||'#202733'; wctx.fill();
      // разделитель
      wctx.strokeStyle='#0b1119'; wctx.lineWidth=3; wctx.beginPath(); wctx.arc(0,0,R,a1-0.002,a1+0.002); wctx.stroke();
      // контент
      const mid=(a0+a1)/2, rIcon=R*0.68, x=Math.cos(mid)*rIcon, y=Math.sin(mid)*rIcon;
      wctx.save(); wctx.translate(x,y); wctx.rotate(mid+Math.PI/2);
      if (sec.type==='gift'){ drawIcon(sec.img, -24, -24, 48, 48, 10); }
      else if (sec.type==='none'){ drawPill('No Loot'); }
      else { drawPill('Re-roll 🔄', true); }
      wctx.restore();
    }
    wctx.restore();
  }
  const imgCache=new Map();
  function drawIcon(src,x,y,w,h,r){
    if (!src){ drawPill('Gift'); return; }
    let img = imgCache.get(src);
    if (!img){ img=new Image(); img.crossOrigin='anonymous'; img.src=src; imgCache.set(src,img); img.onload=()=>wheelRender(); }
    if (!img.complete){ drawPill('…'); return; }
    wctx.save(); const rr=Math.min(r,w/2,h/2);
    wctx.beginPath(); wctx.moveTo(x+rr,y);
    wctx.arcTo(x+w,y, x+w,y+h, rr); wctx.arcTo(x+w,y+h, x,y+h, rr);
    wctx.arcTo(x,y+h, x,y, rr); wctx.arcTo(x,y, x+w,y, rr); wctx.closePath(); wctx.clip();
    wctx.drawImage(img,x,y,w,h); wctx.restore();
  }
  function drawPill(text,accent=false){
    wctx.font='700 14px system-ui,-apple-system,Segoe UI,Roboto,sans-serif';
    const padX=12; const m=wctx.measureText(text); const w=m.width+padX*2, h=30;
    wctx.fillStyle = accent? '#2d7dff' : '#111a28'; wctx.strokeStyle = accent? '#8bb6ff' : '#25324a'; wctx.lineWidth=2;
    roundRect(-w/2,-h/2,w,h,12,true,true); wctx.fillStyle='#dbe7ff'; wctx.textAlign='center'; wctx.textBaseline='middle'; wctx.fillText(text,0,1);
  }
  function roundRect(x,y,w,h,r,fill,stroke){
    const rr=Math.min(r,w/2,h/2);
    wctx.beginPath();
    wctx.moveTo(x+rr,y); wctx.arcTo(x+w,y,x+w,y+h,rr); wctx.arcTo(x+w,y+h,x,y+h,rr);
    wctx.arcTo(x,y+h,x,y,rr); wctx.arcTo(x,y,x+w,y,rr); wctx.closePath();
    if (fill) wctx.fill(); if (stroke) wctx.stroke();
  }

  // ===== Stars purchase flow =====
  let lastPayload = null;
  let starsTimer = null;

  function startStarsWatcher(){
    if (starsTimer) clearInterval(starsTimer);
    starsTimer = setInterval(async ()=>{
      try{
        const r = await fetch('/stars/credit', {
          method:'POST',
          headers:{'content-type':'application/json'},
          body: JSON.stringify({ userId: state.userId, payload: lastPayload })
        }).then(r=>r.json());
        if (r && r.ok){
          setStars(r.stars||0);
          clearInterval(starsTimer); starsTimer=null;
          // после зачисления — сразу крутить
          WSTATE.rerollOnce=false;
          wheelSpin(false);
        }
      }catch{}
    }, 1500);
  }

  async function buyStarsAndSpin(){
    if (!tg){
      alert('Открой игру через Telegram (кнопка «Открыть игру»). Покупка Stars недоступна из браузера.');
      return;
    }
    try{
      // создаём инвойс
      const r = await fetch('/stars/create', {
        method:'POST',
        headers:{'content-type':'application/json'},
        body: JSON.stringify({ userId: state.userId, amount: WSTATE.price })
      }).then(r=>r.json());
      if (!r.ok) return alert(r.error || 'Ошибка оплаты');

      lastPayload = r.payload;
      // открываем в Telegram
      if (typeof tg.openTelegramLink === 'function') tg.openTelegramLink(r.link);
      else if (typeof tg.openInvoice === 'function') tg.openInvoice(r.link);
      else window.open(r.link, '_blank');

      wheelCenter.textContent='Ожидание оплаты…';
      startStarsWatcher();
    }catch(e){
      alert('Не удалось открыть оплату');
    }
  }

  function wheelSpin(pay=true){
    if (WSTATE.spinning) return;
    if (pay && WSTATE.stars < WSTATE.price){
      // не хватает — покупаем ⭐
      buyStarsAndSpin();
      return;
    }
    if (pay){
      WSTATE.stars -= WSTATE.price; starsEl.textContent = WSTATE.stars;
    }
    WSTATE.spinning = true; wheelCenter.textContent='Крутим…';

    const N=WSTATE.sectors.length, step=(Math.PI*2)/N;
    const targetIndex=Math.floor(Math.random()*N);
    const targetAngle = (Math.PI/2) - (targetIndex*step + step/2);

    const current = ((WSTATE.angle%(Math.PI*2))+Math.PI*2)%(Math.PI*2);
    const baseTurns = Math.PI*2 * (5 + Math.random()*2);
    let delta = baseTurns + (targetAngle - current);
    while (delta < Math.PI*2*3) delta += Math.PI*2;

    const duration = 2600 + Math.random()*600;
    const t0 = performance.now();
    requestAnimationFrame(function frame(t){
      const p = Math.min(1,(t-t0)/duration);
      const ease = 1 - Math.pow(1-p,5);
      WSTATE.angle = current + delta*ease;
      wheelRender();
      if (p<1) requestAnimationFrame(frame);
      else wheelOnEnd(targetIndex);
    });
  }
  function wheelOnEnd(idx){
    WSTATE.spinning=false;
    const sec=WSTATE.sectors[idx];
    if (sec.type==='gift'){
      wheelCenter.innerHTML = `<div style="display:flex;flex-direction:column;align-items:center;gap:6px">
        <img class="wheel-icon" src="${sec.img||''}" alt=""><b>${esc(sec.name)}</b></div>`;
    } else if (sec.type==='none'){
      wheelCenter.textContent='Пусто 🙈';
    } else {
      wheelCenter.textContent='Re-roll! 🔄';
      if (!WSTATE.rerollOnce){ WSTATE.rerollOnce=true; setTimeout(()=> wheelSpin(false), 600); return; }
      WSTATE.rerollOnce=false;
    }
  }

  const starsElWrap = $('.stars'); // только для инициализации текста
  const starsBalance = $('#starsBalance');

  const wheelSpinBtn = $('#wheelSpinBtn');
  wheelSpinBtn?.addEventListener('click', ()=>{
    if (!WSTATE.spinning){
      WSTATE.rerollOnce=false;
      wheelSpin(true);
    }
  });

  // загрузить подарки
  const starsElInit = $('#starsBalance');
  const starsElInitVal = Number(starsElInit?.textContent||0)||0;
  WSTATE.stars = starsElInitVal;
  starsEl.textContent = WSTATE.stars;
  wheelLoad();

  // ==== round lifecycle ====
  function onRoundStart(d){
    state.roundState='betting';
    state.myBet=0; state.myCashed=false;
    placingBet=false; cashoutLock=false;
    closeModal(betModal);
    ensureBetInputReady('');

    series = [{x:0,y:1}]; drawChart();
    setMult(1.00);
    statusEl.textContent='ставки…';
    betBtn.disabled=false;
    cashoutBtn.disabled=true;
    cashoutBtn.classList.remove('active','pulse','armed');
    payoutTopEl.textContent = '';

    // окно ставок — ровно по серверу
    let sec = Math.max(0, Math.round((Number(d.betDurationMs)||5000)/1000));
    statusEl.textContent = `ставки: ${sec}s`;
    const iv = setInterval(()=>{
      if (state.roundState!=='betting'){ clearInterval(iv); return; }
      sec--; statusEl.textContent = sec<=0 ? 'готовность' : `ставки: ${sec}s`;
      if (sec<=0) clearInterval(iv);
    },1000);
  }
  function onRoundRunning(){
    state.roundState='running';
    statusEl.textContent='в полёте';
    startTicker();
    if (state.myBet>0){ cashoutBtn.disabled=false; cashoutBtn.classList.add('active','pulse'); }
    updateTopPayout();
  }
  function onRoundEnd(d){
    state.roundState='finished';
    stopTicker();
    const final = Number(d.result||1);
    setMult(final);
    statusEl.textContent='КРАШ';
    cashoutBtn.classList.remove('armed');
    payoutTopEl.textContent = '';
    setTimeout(()=>{ setMult(1.00); statusEl.textContent='ожидание…'; clearPlayers(); },900);
  }

  // ==== ticker ====
  function startTicker(){
    if (localTicker) return;
    function tick(){ if (state.roundState!=='running'){ stopTicker(); return; }
      setMult(state.displayedMult + 0.01);
      const next = Math.max(18, Math.round(180 - (state.displayedMult - 1) * 35));
      localTicker = setTimeout(tick, next);
    }
    tick();
  }
  function stopTicker(){ if (localTicker){ clearTimeout(localTicker); localTicker=null; } }

  // ==== canvas ====
  function resizeFixForIOS(){
    // помогает заполнить dvh на iOS
    document.documentElement.style.setProperty('--vh', `${window.innerHeight * 0.01}px`);
  }
  window.addEventListener('resize', resizeFixForIOS);
  resizeFixForIOS();

})();
