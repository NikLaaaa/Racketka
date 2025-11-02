(() => {
  // ==== helpers ====
  const $ = (s) => document.querySelector(s);
  const esc = (s) =>
    String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

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
  const navProfile = $('#navProfile');
  const tabCrash = $('#tabCrash');
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

  // ==== gifts ====
  let GIFTS = [];
  async function loadGifts(){
    try{
      const r = await fetch('/gifts', { cache:'no-store' });
      const js = await r.json();
      GIFTS = Array.isArray(js.items)
        ? js.items
            .map(x => ({ ...x, priceTon: Number(x.priceTon) || 0 }))
            .filter(x => x.img && x.priceTon > 0)
            .sort((a,b)=>a.priceTon-b.priceTon)
        : [];
    }catch(e){
      GIFTS = [];
    } finally {
      // после любой попытки — перерисуем
      renderPlayers();
      updateTopPayout();
    }
  }
  loadGifts();
  setInterval(loadGifts, 300_000);

  // жёсткий подбор (<= сумма)
  function pickGiftLE(amountTon){
    if (!GIFTS.length || !amountTon) return null;
    const a = Number(amountTon) || 0;
    let best = null;
    for (const g of GIFTS){
      const p = Number(g.priceTon) || 0;
      if (a + 1e-9 >= p) best = g; else break;
    }
    return best;
  }
  // мягкий подбор: если не нашли ≤, берём ближайший сверху и считаем «сколько не хватает»
  function pickGiftRelax(amountTon){
    if (!GIFTS.length || !amountTon) return { gift:null, affordable:false, missing:0 };
    const a = Number(amountTon) || 0;
    const le = pickGiftLE(a);
    if (le) return { gift: le, affordable:true, missing:0 };
    // самый дешёвый сверху
    const higher = GIFTS.find(g => (Number(g.priceTon)||0) > a) || null;
    if (!higher) return { gift:null, affordable:false, missing:0 };
    const missing = Math.max(0, (Number(higher.priceTon)||0) - a);
    return { gift: higher, affordable:false, missing };
  }

  // ==== TonConnect (optional) ====
  let tonConnectUI;
  const DEPOSIT_WALLET = 'UQDEx5xByv2a4JE95W2EmJKfDe1ZWA0Azs16GTiUlhlESfed';

  function getConnectedAddress(){
    return tonConnectUI?.wallet?.account?.address || null;
  }
  function updateWalletInfo(){
    const addr = getConnectedAddress();
    if (addr) {
      walletInfo?.classList?.remove('hidden');
      walletInfo.textContent = `Кошелёк: ${addr}`;
    } else {
      walletInfo?.classList?.add('hidden');
      walletInfo.textContent = '';
    }
  }
  async function initTonConnect(){
    if (!window.TON_CONNECT_UI) return;
    tonConnectUI = new TON_CONNECT_UI.TonConnectUI({
      manifestUrl: `${location.origin}/tonconnect-manifest.json`,
      buttonRootId: 'ton-connect'
    });
    tonConnectUI.onStatusChange(updateWalletInfo);
    updateWalletInfo();
  }
  initTonConnect();

  disconnectBtn?.addEventListener('click', async () => {
    try { await tonConnectUI?.disconnect(); } catch(_) {}
    updateWalletInfo();
  });

  depositBtn?.addEventListener('click', async () => {
    try {
      if (!getConnectedAddress()) {
        await tonConnectUI?.openModal();
        if (!getConnectedAddress()) return;
      }
      const amtStr = prompt('Сколько TON пополнить?');
      const amt = Number((amtStr||'').replace(',','.'));
      if (!amt || amt <= 0) return;
      const nano = BigInt(Math.round(amt * 1e9)).toString();
      await tonConnectUI.sendTransaction({
        validUntil: Math.floor(Date.now()/1000) + 300,
        messages: [{ address: DEPOSIT_WALLET, amount: nano }]
      });
      alert('✅ Транзакция отправлена. Зачисление будет после подтверждения сети.');
    } catch(e){
      alert('Операция отменена или произошла ошибка.');
    }
  });

  withdrawBtn?.addEventListener('click', async () => {
    const amtStr = prompt('Сумма вывода (TON):');
    const amt = Number((amtStr||'').replace(',','.'));
    if (!amt || amt<=0) return;
    try{
      const body = { userId: state.userId, amount: amt };
      const addr = getConnectedAddress();
      if (addr) body.address = addr;
      const r = await fetch('/withdraw', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify(body)
      }).then(r=>r.json());
      if (!r.ok) return alert(r.error || 'Ошибка');
      alert('✅ Заявка создана. Сумма будет перечислена на ваш кошелёк в ближайшее время.');
    }catch(_){ alert('Ошибка сети'); }
  });

  // ==== Telegram профиль ====
  function applyTgProfile(){
    try{
      const tg = window.Telegram?.WebApp;
      tg?.ready?.(); tg?.expand?.();

      const u = tg?.initDataUnsafe?.user;
      const nameQS = qs.get('name'); const photoQS = qs.get('photo');

      let displayName = 'User'; let photo = null;
      if (u) {
        const composed = [u.first_name, u.last_name].filter(Boolean).join(' ');
        displayName = composed || (u.username ? `@${u.username}` : 'User');
        if (u.photo_url) photo = u.photo_url;
      } else if (nameQS) { displayName = nameQS; if (photoQS) photo = photoQS; }

      if (photo) profileAva.src = photo; else profileAva.removeAttribute('src');
      profileName.textContent = displayName;

      const sendProfile = () => { try { ws.send(JSON.stringify({ type:'profile', profile:{ nick: displayName, avatar: photo } })); } catch(_){ } };
      if (ws.readyState === 1) sendProfile(); else ws.addEventListener('open', sendProfile, { once:true });
    } catch(_) {}
  }
  document.addEventListener('DOMContentLoaded', applyTgProfile);

  // ==== WebSocket ====
  const wsUrl = location.origin.replace(/^http/, 'ws') + `/?userId=${encodeURIComponent(state.userId)}`;
  const ws = new WebSocket(wsUrl);

  ws.onmessage = (ev) => {
    let d; try{ d = JSON.parse(ev.data); } catch { return; }
    if (d.online != null) onlineVal.textContent = d.online;

    switch (d.type) {
      case 'init':
        setBalance(d.balance || 0);
        history3 = Array.isArray(d.history) ? d.history.slice(0,3) : [];
        renderHistory();
        if (Array.isArray(d.players)) d.players.forEach(p => addOrUpdatePlayer(p.userId, p.nick, p.avatar));
        setMult(1.00);
        statusEl.textContent='ожидание…';
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
        placingBet = false;
        cashoutLock = false;
        alert(d.message || 'Ошибка');
        break;
    }
  };

  // ==== UI helpers ====
  function setBalance(v){
    state.balance = Number(v)||0;
    balanceNumEl.textContent = state.balance.toFixed(2);
    profileBalance.textContent = state.balance.toFixed(2);
  }

  function setMult(v){
    const m = Number(v)||1;
    state.displayedMult = m;
    multEl.textContent = m.toFixed(2);
    pushPoint(m);
    updateTopPayout();
    renderPlayers(); // пересчёт подарков в реальном времени
  }

  function updateTopPayout(){
    const bet = state.myBet || 0;
    const k = state.displayedMult || 1;
    const cashout = bet * k * HOUSE;

    if (bet > 0 && state.roundState === 'running' && cashout > 0) {
      payoutTopEl.textContent = `≈ ${cashout.toFixed(2)} TON`;
    } else {
      payoutTopEl.textContent = '';
    }
    cashoutBtn.classList.toggle('armed', bet > 0 && state.roundState === 'running');
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

  function addOrUpdatePlayer(id, nick, avatar){
    const p = players.get(id) || { id, amount:0, payout:0, cashed:false };
    p.nick = nick || p.nick || ('User '+String(id).slice(-4));
    p.avatar = (avatar !== undefined) ? avatar : (p.avatar || null);
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
      // расчёт текущей/итоговой суммы в TON
      let amountTon = 0;
      if (p.cashed) {
        amountTon = Number(p.payout)||0;
      } else if (state.roundState === 'running' && p.amount) {
        amountTon = (Number(p.amount)||0) * (state.displayedMult||1) * HOUSE;
      } else if (p.amount) {
        amountTon = Number(p.amount)||0;
      }

      // мягкий подбор подарка
      const { gift, affordable, missing } = pickGiftRelax(amountTon);

      let giftHTML = '';
      if (gift) {
        giftHTML = affordable
          ? `<div class="pgift"><img src="${gift.img}" alt="${esc(gift.name)}"><span>${esc(gift.name)} • ${amountTon.toFixed(2)} TON</span></div>`
          : `<div class="pgift"><img src="${gift.img}" alt="${esc(gift.name)}"><span>${esc(gift.name)} • не хватает ${missing.toFixed(2)} TON • ≈ ${amountTon.toFixed(2)} TON</span></div>`;
      } else if (amountTon > 0) {
        giftHTML = `<div class="pgift">≈ ${amountTon.toFixed(2)} TON</div>`;
      }

      const ava = p.avatar ? `<img class="pava" src="${esc(p.avatar)}" alt="">` : `<div class="pava pava--ph"></div>`;

      const row = document.createElement('div'); row.className='player';
      row.innerHTML = `
        <div class="pinfo">
          ${ava}
          <div class="pname">${esc(p.nick||'User')}</div>
        </div>
        <div class="pval ${p.cashed ? 'good' : ''}">
          <div>${p.cashed ? `+${(p.payout||0).toFixed(2)}` : (p.amount ? (p.amount||0).toFixed(2) : '')}</div>
          ${giftHTML}
        </div>`;
      playersList.appendChild(row);
    }
    roundTotal.textContent = total ? `${total.toFixed(2)} TON` : '';
  }

  // ==== focusable input (фикс бага) ====
  function ensureBetInputReady(initialValue = ''){
    if (!modalBetInput) return;
    modalBetInput.setAttribute('type','text');
    modalBetInput.setAttribute('inputmode','decimal');
    modalBetInput.setAttribute('autocomplete','off');
    modalBetInput.setAttribute('autocapitalize','off');
    modalBetInput.setAttribute('spellcheck','false');
    modalBetInput.removeAttribute('readonly');
    modalBetInput.disabled = false;
    modalBetInput.value = initialValue;

    requestAnimationFrame(() => {
      modalBetInput.focus();
      modalBetInput.select();
      setTimeout(() => {
        if (document.activeElement !== modalBetInput) {
          modalBetInput.focus();
          modalBetInput.select();
        }
      }, 50);
    });
  }

  // ==== round lifecycle ====
  function onRoundStart(d){
    state.roundState='betting';
    state.myBet=0; state.myCashed=false;

    placingBet = false; cashoutLock = false;
    closeModal(betModal);
    ensureBetInputReady('');

    series = [{x:0,y:1}];
    drawChart();

    setMult(1.00);
    statusEl.textContent='ставки…';
    betBtn.disabled=false;
    cashoutBtn.disabled=true;
    cashoutBtn.classList.remove('active','pulse','armed');
    payoutTopEl.textContent = '';
    clearPlayers();

    let sec = Math.max(0, Math.round((d.bettingEndsAt - Date.now())/1000));
    statusEl.textContent = `ставки: ${sec}s`;
    const iv = setInterval(()=>{
      if (state.roundState!=='betting'){ clearInterval(iv); return; }
      sec--;
      statusEl.textContent = sec<=0 ? 'готовность' : `ставки: ${sec}s`;
      if (sec<=0) clearInterval(iv);
    },1000);
  }

  function onRoundRunning(){
    state.roundState='running';
    statusEl.textContent='в полёте';
    startTicker();
    if (state.myBet>0){
      cashoutBtn.disabled=false;
      cashoutBtn.classList.add('active','pulse');
    }
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
    setTimeout(()=>{
      setMult(1.00);
      statusEl.textContent='ожидание…';
      clearPlayers();
    },900);
  }

  // ==== ticker ====
  function startTicker(){
    if (localTicker) return;
    function tick(){
      if (state.roundState!=='running'){ stopTicker(); return; }
      setMult(state.displayedMult + 0.01);
      const next = Math.max(18, Math.round(180 - (state.displayedMult - 1) * 35));
      localTicker = setTimeout(tick, next);
    }
    tick();
  }
  function stopTicker(){
    if (localTicker){ clearTimeout(localTicker); localTicker=null; }
  }

  // ==== modal ====
  function openModal(el){
    if (!el) return;
    if (!el.classList.contains('open')){
      el.classList.add('open');
      el.style.display='flex';
      document.body.classList.add('modal-open');
    }
    modalBox?.addEventListener('click', (e)=> e.stopPropagation());
    el.addEventListener('click', (e)=>{ if (e.target===el) closeModal(el); });

    ensureBetInputReady(modalBetInput.value || '');
  }
  function closeModal(el){
    if (!el) return;
    el.classList.remove('open');
    el.style.display='none';
    document.body.classList.remove('modal-open');
  }

  function openBetModal(){
    if (state.roundState!=='betting'){
      alert('Ставки пока закрыты. Подожди начала раунда.');
      return;
    }
    ensureBetInputReady(modalBetInput.value || '');
    openModal(betModal);
  }

  betBtn?.addEventListener('click', openBetModal);
  modalClose?.addEventListener('click', ()=> closeModal(betModal));
  modalBetInput?.addEventListener('keydown', (e)=>{ if (e.key==='Enter') modalConfirm.click(); });

  modalConfirm?.addEventListener('click', ()=>{
    if (placingBet) return;

    const raw = (modalBetInput.value||'').replace(',','.');
    const amt = Math.round((Number(raw) + Number.EPSILON) * 100) / 100;

    if (!amt || isNaN(amt) || amt < MIN_BET) {
      alert(`Минимальная ставка ${MIN_BET.toFixed(2)} TON`);
      ensureBetInputReady(raw);
      return;
    }
    if (state.balance < amt) {
      alert('Недостаточно TON');
      ensureBetInputReady(raw);
      return;
    }

    placingBet = true;
    try {
      ws.send(JSON.stringify({ type:'place_bet', amount: amt }));
      closeModal(betModal);
      betBtn.disabled = true;
      setTimeout(()=> placingBet=false, 400);
    } catch(_) {
      placingBet = false;
    }
  });

  cashoutBtn?.addEventListener('click', ()=>{
    if (cashoutLock) return;
    if (state.roundState!=='running') return alert('Рано');
    cashoutLock = true;
    ws.send(JSON.stringify({ type:'cashout' }));
    cashoutBtn.disabled = true;
    cashoutBtn.classList.remove('active','pulse');
  });

  // ==== tabs ====
  function setTab(name){
    const crash = name==='crash';
    tabCrash.classList.toggle('hidden', !crash);
    tabProfile.classList.toggle('hidden', crash);
    navCrash.classList.toggle('active', crash);
    navProfile.classList.toggle('active', !crash);
  }
  navCrash?.addEventListener('click', ()=> setTab('crash'));
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
    ctx.clearRect(0,0,w,h);
    ctx.fillStyle = '#0d131b';
    ctx.fillRect(0,0,w,h);

    ctx.strokeStyle = '#182232';
    ctx.lineWidth = 1;
    for (let i=1;i<=4;i++){
      const y = (h/5)*i;
      ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(w,y); ctx.stroke();
    }

    if (series.length < 2) return;

    const xs = series.map(p=>p.x);
    const ys = series.map(p=>p.y);
    const xmin = Math.min(...xs), xmax = Math.max(...xs);
    const ymin = 1, ymax = Math.max(2, Math.max(...ys) * 1.1);

    const fx = (x)=> (x - xmin) / Math.max(1,(xmax - xmin)) * (w-24) + 12;
    const fy = (y)=> h - ( (y - ymin) / (ymax - ymin) ) * (h-24) - 12;

    ctx.strokeStyle = '#22e58a';
    ctx.lineWidth = 3;
    ctx.beginPath();
    series.forEach((p,i)=>{
      const X = fx(p.x), Y = fy(p.y);
      if (i===0) ctx.moveTo(X,Y); else ctx.lineTo(X,Y);
    });
    ctx.stroke();
  }
  window.addEventListener('resize', resizeCanvas);
  resizeCanvas();

  // safety
  modalBetInput?.addEventListener('wheel', e => e.preventDefault(), { passive:false });
  window.addEventListener('error', (e)=> console.error('JS Error:', e.message));
})();
// ================== WHEEL (Roulette: 5 NFT, 2 No Loot, 1 Re-roll) ==================
(() => {
  const openBtn   = document.querySelector('#openWheelBtn');
  const modal     = document.querySelector('#wheelModal');
  const closeBtn  = document.querySelector('#wheelClose');
  const canvas    = document.querySelector('#wheelCanvas');
  const centerLbl = document.querySelector('#wheelCenter');
  const spinBtn   = document.querySelector('#wheelSpinBtn');
  const starsEl   = document.querySelector('#starsBalance');
  if (!canvas) return;

  const ctx = canvas.getContext('2d');

  const WSTATE = {
    stars: 250,   // демо-баланс ⭐ (подключи к бэку при желании)
    price: 50,    // стоимость спина
    sectors: [],  // {type:'gift'|'none'|'reroll', name, img, color}
    angle: 0,
    spinning: false,
    rerollOnce: false, // чтобы не зациклиться: один бесплатный ре-ролл за выпадение reroll
  };
  starsEl.textContent = WSTATE.stars;

  const COLORS = ['#ffd43b','#5b46ff','#24c2a6','#74f0ff','#ff7b7b','#202733','#111821','#6e42ff'];

  async function loadWheel(){
    // берём /gifts и берём первые 5 NFT
    let gifts = [];
    try{
      const r = await fetch('/gifts', { cache:'no-store' });
      const js = await r.json();
      gifts = (js.items||[])
        .filter(x => x.img && x.name)
        .sort((a,b)=>a.priceTon-b.priceTon)
        .slice(0,5)
        .map((g,i)=>({ type:'gift', name:g.name, img:g.img, color: COLORS[i%COLORS.length] }));
    }catch(e){ /* ignore */ }

    // если не пришло — заглушки
    if (gifts.length < 5){
      while (gifts.length < 5) {
        const i = gifts.length;
        gifts.push({ type:'gift', name:`Gift #${i+1}`, img:'', color: COLORS[i%COLORS.length] });
      }
    }

    // собираем 8 секторов: 5 gifts, 2 no-loot, 1 reroll
    const noLoot = { type:'none',   name:'No Loot', img:'', color:'#1c2433' };
    const reroll = { type:'reroll', name:'Re-roll', img:'', color:'#ffb703' };

    WSTATE.sectors = [
      gifts[0], noLoot,
      gifts[1], gifts[2],
      reroll,
      gifts[3], noLoot,
      gifts[4],
    ];
    renderWheel();
  }

  // utils
  function rad(d){ return d*Math.PI/180; }

  function renderWheel(){
    const { width:w, height:h } = canvas;
    const cx=w/2, cy=h/2, R = Math.min(cx,cy)-6;
    ctx.clearRect(0,0,w,h);

    const N = WSTATE.sectors.length;
    const step = Math.PI*2 / N;

    ctx.save();
    ctx.translate(cx,cy);
    ctx.rotate(WSTATE.angle);

    for (let i=0;i<N;i++){
      const a0 = i*step, a1=(i+1)*step;
      const sec = WSTATE.sectors[i];

      // сектор
      ctx.beginPath(); ctx.moveTo(0,0);
      ctx.arc(0,0,R, a0, a1, false);
      ctx.closePath();
      ctx.fillStyle = sec.color || COLORS[i%COLORS.length];
      ctx.fill();

      // бордер
      ctx.strokeStyle = '#0b1119';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(0,0,R, a1-0.002, a1+0.002);
      ctx.stroke();

      // контент
      const mid = (a0+a1)/2;
      const rIcon = R*0.68;
      const x = Math.cos(mid) * rIcon;
      const y = Math.sin(mid) * rIcon;

      ctx.save();
      ctx.translate(x,y);
      ctx.rotate(mid + Math.PI/2);

      if (sec.type === 'gift'){
        drawIcon(sec.img, -24, -24, 48, 48, 10);
      } else if (sec.type === 'none'){
        drawPill('No Loot');
      } else if (sec.type === 'reroll'){
        drawPill('Re-roll 🔄', true);
      }
      ctx.restore();
    }

    ctx.restore();
  }

  // округлённая картинка
  const cacheImgs = new Map();
  function drawIcon(src, x,y,w,h,r){
    if (!src) { drawPill('Gift'); return; }
    let img = cacheImgs.get(src);
    if (!img){
      img = new Image(); img.crossOrigin = "anonymous"; img.src = src;
      cacheImgs.set(src,img); img.onload = () => renderWheel();
    }
    if (!img.complete) { drawPill('…'); return; }

    ctx.save();
    const rr = Math.min(r,w/2,h/2);
    ctx.beginPath();
    ctx.moveTo(x+rr, y);
    ctx.arcTo(x+w, y,   x+w, y+h, rr);
    ctx.arcTo(x+w, y+h, x,   y+h, rr);
    ctx.arcTo(x,   y+h, x,   y,   rr);
    ctx.arcTo(x,   y,   x+w, y,   rr);
    ctx.closePath();
    ctx.clip();
    ctx.drawImage(img, x, y, w, h);
    ctx.restore();
  }

  function drawPill(text, accent=false){
    ctx.font = '700 14px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
    const padX=12, padY=8;
    const m = ctx.measureText(text);
    const w = m.width + padX*2, h = 30;
    ctx.fillStyle = accent ? '#2d7dff' : '#111a28';
    ctx.strokeStyle = accent ? '#8bb6ff' : '#25324a';
    ctx.lineWidth = 2;
    roundRect(-w/2,-h/2,w,h,12,true,true);
    ctx.fillStyle = '#dbe7ff';
    ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.fillText(text, 0, 1);
  }
  function roundRect(x,y,w,h,r,fill,stroke){
    const rr = Math.min(r,w/2,h/2);
    ctx.beginPath();
    ctx.moveTo(x+rr, y);
    ctx.arcTo(x+w, y,   x+w, y+h, rr);
    ctx.arcTo(x+w, y+h, x,   y+h, rr);
    ctx.arcTo(x,   y+h, x,   y,   rr);
    ctx.arcTo(x,   y,   x+w, y,   rr);
    ctx.closePath();
    if (fill) ctx.fill();
    if (stroke) ctx.stroke();
  }

  function open(){ modal.classList.add('open'); modal.style.display='flex'; document.body.classList.add('modal-open'); renderWheel(); }
  function close(){ modal.classList.remove('open'); modal.style.display='none'; document.body.classList.remove('modal-open'); }

  openBtn?.addEventListener('click', open);
  closeBtn?.addEventListener('click', close);
  modal?.addEventListener('click', (e)=>{ if (e.target===modal) close(); });

  // Анимация спина с ease-out и логикой исхода
  function spin(pay=true){
    if (WSTATE.spinning) return;
    if (pay && WSTATE.stars < WSTATE.price) { alert('Недостаточно ⭐'); return; }
    if (pay){ WSTATE.stars -= WSTATE.price; starsEl.textContent = WSTATE.stars; }

    WSTATE.spinning = true;
    centerLbl.textContent = 'Крутим…';

    const N = WSTATE.sectors.length;
    const step = (Math.PI*2)/N;

    const targetIndex = Math.floor(Math.random()*N);
    const targetAngle = (Math.PI/2) - (targetIndex*step + step/2); // указатель сверху

    const current = ((WSTATE.angle%(Math.PI*2))+Math.PI*2)%(Math.PI*2);
    const baseTurns = Math.PI*2 * (5 + Math.random()*2);
    let delta = baseTurns + (targetAngle - current);
    while (delta < Math.PI*2*3) delta += Math.PI*2;

    const duration = 2600 + Math.random()*600;
    const t0 = performance.now();

    requestAnimationFrame(function frame(t){
      const p = Math.min(1, (t - t0) / duration);
      const ease = 1 - Math.pow(1-p, 5);
      WSTATE.angle = current + delta * ease;
      renderWheel();
      if (p < 1) requestAnimationFrame(frame);
      else onSpinEnd(targetIndex);
    });
  }

  function onSpinEnd(idx){
    WSTATE.spinning = false;
    const sec = WSTATE.sectors[idx];

    if (sec.type === 'gift'){
      centerLbl.innerHTML = `<div style="display:flex;flex-direction:column;align-items:center;gap:6px">
        <img class="wheel-icon" src="${sec.img}" alt="">
        <b>${sec.name}</b>
      </div>`;
    } else if (sec.type === 'none'){
      centerLbl.textContent = 'Пусто 🙈';
    } else { // reroll
      centerLbl.textContent = 'Re-roll! 🔄';
      if (!WSTATE.rerollOnce){
        WSTATE.rerollOnce = true;    // один бесплатный реролл
        setTimeout(()=> spin(false), 600);
        return;
      } else {
        // если уже делали бесплатный реролл — больше не повторяем
        WSTATE.rerollOnce = false;
      }
    }
  }

  spinBtn?.addEventListener('click', ()=>{ if (!WSTATE.spinning) { WSTATE.rerollOnce=false; spin(true); } });

  // init
  loadWheel();
})();


