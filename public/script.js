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

  // ==== gifts (как у тебя) ====
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
    }catch{ GIFTS = []; }
    renderPlayers(); updateTopPayout();
  }
  loadGifts(); setInterval(loadGifts, 300_000);

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
  function pickGiftRelax(amountTon){
    if (!GIFTS.length || !amountTon) return { gift:null, affordable:false, missing:0 };
    const a = Number(amountTon) || 0;
    const le = pickGiftLE(a);
    if (le) return { gift: le, affordable:true, missing:0 };
    const higher = GIFTS.find(g => (Number(g.priceTon)||0) > a) || null;
    if (!higher) return { gift:null, affordable:false, missing:0 };
    const missing = Math.max(0, (Number(higher.priceTon)||0) - a);
    return { gift: higher, affordable:false, missing };
  }

  // ==== TonConnect (как было) ====
  let tonConnectUI;
  const DEPOSIT_WALLET = 'UQDEx5xByv2a4JE95W2EmJKfDe1ZWA0Azs16GTiUlhlESfed';
  const getConnectedAddress = () => tonConnectUI?.wallet?.account?.address || null;
  const updateWalletInfo = () => {
    const addr = getConnectedAddress();
    if (addr) { walletInfo?.classList?.remove('hidden'); walletInfo.textContent = `Кошелёк: ${addr}`; }
    else { walletInfo?.classList?.add('hidden'); walletInfo.textContent=''; }
  };
  (async function initTonConnect(){
    if (!window.TON_CONNECT_UI) return;
    tonConnectUI = new TON_CONNECT_UI.TonConnectUI({
      manifestUrl: `${location.origin}/tonconnect-manifest.json`,
      buttonRootId: 'ton-connect'
    });
    tonConnectUI.onStatusChange(updateWalletInfo);
    updateWalletInfo();
  })();

  disconnectBtn?.addEventListener('click', async () => { try{ await tonConnectUI?.disconnect(); }catch{} updateWalletInfo(); });
  depositBtn?.addEventListener('click', async () => {
    try{
      if (!getConnectedAddress()) { await tonConnectUI?.openModal(); if (!getConnectedAddress()) return; }
      const amtStr = prompt('Сколько TON пополнить?');
      const amt = Number((amtStr||'').replace(',','.')); if (!amt || amt<=0) return;
      const nano = BigInt(Math.round(amt * 1e9)).toString();
      await tonConnectUI.sendTransaction({ validUntil: Math.floor(Date.now()/1000)+300, messages:[{address:DEPOSIT_WALLET, amount:nano}]});
      alert('✅ Транзакция отправлена. Зачисление после подтверждения сети.');
    }catch{ alert('Операция отменена / ошибка.'); }
  });
  withdrawBtn?.addEventListener('click', async () => {
    const amtStr = prompt('Сумма вывода (TON):');
    const amt = Number((amtStr||'').replace(',','.')); if (!amt || amt<=0) return;
    try{
      const body = { userId: state.userId, amount: amt };
      const addr = getConnectedAddress(); if (addr) body.address = addr;
      const r = await fetch('/withdraw',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}).then(r=>r.json());
      if (!r.ok) return alert(r.error || 'Ошибка'); alert('✅ Заявка создана.');
    }catch{ alert('Ошибка сети'); }
  });

  // ==== Telegram профиль: применение + надёжная отправка ====
  function readTgUser() {
    const tg = window.Telegram?.WebApp;
    try { tg?.ready?.(); tg?.expand?.(); } catch {}
    let u = tg?.initDataUnsafe?.user || null;
    if (!u && (qs.get('name') || qs.get('photo'))) {
      u = { first_name: qs.get('name') || 'User', last_name: '', username: qs.get('username') || null, photo_url: qs.get('photo') || null };
    }
    return u;
  }
  function applyTgProfile(){
    const u = readTgUser();
    let displayName = 'User'; let photo = null;
    if (u){
      const composed = [u.first_name, u.last_name].filter(Boolean).join(' ');
      displayName = composed || (u.username ? `@${u.username}` : 'User');
      if (u.photo_url) photo = u.photo_url;
    }
    if (photo) profileAva.src = photo; else profileAva.removeAttribute('src');
    profileName.textContent = displayName;
    return { nick: displayName, avatar: photo || null };
  }
  document.addEventListener('DOMContentLoaded', applyTgProfile);

  // ==== WebSocket ====
  const wsUrl = location.origin.replace(/^http/, 'ws') + `/?userId=${encodeURIComponent(state.userId)}`;
  const ws = new WebSocket(wsUrl);

  function sendProfileWithRetries() {
    const prof = applyTgProfile();
    const trySend = () => { try { if (ws.readyState === 1) ws.send(JSON.stringify({ type:'profile', profile: prof })); } catch {} };
    trySend();
    setTimeout(trySend, 400);
    setTimeout(trySend, 1500);
  }
  ws.addEventListener('open', sendProfileWithRetries);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) sendProfileWithRetries(); });

  ws.onmessage = (ev) => {
    let d; try{ d = JSON.parse(ev.data); } catch { return; }
    if (d.online != null) onlineVal.textContent = d.online;

    switch (d.type) {
      case 'init':
        setBalance(d.balance || 0);
        history3 = Array.isArray(d.history) ? d.history.slice(0,3) : [];
        renderHistory();
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
    renderPlayers();
  }
  function updateTopPayout(){
    const bet = state.myBet || 0;
    const k = state.displayedMult || 1;
    const cashout = bet * k * HOUSE;
    payoutTopEl.textContent = (bet > 0 && state.roundState === 'running' && cashout > 0) ? `≈ ${cashout.toFixed(2)} TON` : '';
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
      let amountTon = 0;
      if (p.cashed) amountTon = Number(p.payout)||0;
      else if (state.roundState === 'running' && p.amount) amountTon = (Number(p.amount)||0) * (state.displayedMult||1) * HOUSE;
      else if (p.amount) amountTon = Number(p.amount)||0;

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

  // ==== focusable input (усиленный фикс) ====
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

    const kick = () => { modalBetInput.focus(); modalBetInput.select(); };
    requestAnimationFrame(kick);
    setTimeout(kick, 50);
    setTimeout(kick, 120);
    modalBetInput.addEventListener('touchstart', kick, { once:true });
  }

  // ==== round lifecycle ====
  function onRoundStart(d){
    state.roundState='betting';
    state.myBet=0; state.myCashed=false;

    placingBet = false; cashoutLock = false;
    closeModal(betModal);
    ensureBetInputReady('');

    series = [{x:0,y:1}]; drawChart();
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
    setTimeout(()=>{ setMult(1.00); statusEl.textContent='ожидание…'; clearPlayers(); },900);
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
  function stopTicker(){ if (localTicker){ clearTimeout(localTicker); localTicker=null; } }

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

  // ВАЖНО: разрешаем открывать всегда (без ограничений)
  function openBetModal(){
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

    if (!amt || isNaN(amt) || amt < MIN_BET) { alert(`Минимальная ставка ${MIN_BET.toFixed(2)} TON`); ensureBetInputReady(raw); return; }
    if (state.balance < amt) { alert('Недостаточно TON'); ensureBetInputReady(raw); return; }
    if (state.roundState!=='betting'){ alert('Ставки ещё закрыты. Подтверди, когда начнётся новый раунд.'); ensureBetInputReady(raw); return; }

    placingBet = true;
    try {
      // вместе со ставкой ещё раз шлём профиль — на всякий случай
      const prof = applyTgProfile();
      ws.send(JSON.stringify({ type:'place_bet', amount: amt, profile: prof }));
      closeModal(betModal);
      betBtn.disabled = true;
      setTimeout(()=> placingBet=false, 400);
    } catch { placingBet = false; }
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
    ctx.fillStyle = '#0d131b'; ctx.fillRect(0,0,w,h);

    ctx.strokeStyle = '#182232'; ctx.lineWidth = 1;
    for (let i=1;i<=4;i++){
      const y = (h/5)*i;
      ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(w,y); ctx.stroke();
    }
    if (series.length < 2) return;

    const xs = series.map(p=>p.x), ys = series.map(p=>p.y);
    const xmin = Math.min(...xs), xmax = Math.max(...xs);
    const ymin = 1, ymax = Math.max(2, Math.max(...ys) * 1.1);

    const fx = (x)=> (x - xmin) / Math.max(1,(xmax - xmin)) * (w-24) + 12;
    const fy = (y)=> h - ( (y - ymin) / (ymax - ymin) ) * (h-24) - 12;

    ctx.strokeStyle = '#22e58a'; ctx.lineWidth = 3; ctx.beginPath();
    series.forEach((p,i)=>{ const X = fx(p.x), Y = fy(p.y); if (i===0) ctx.moveTo(X,Y); else ctx.lineTo(X,Y); });
    ctx.stroke();
  }
  window.addEventListener('resize', resizeCanvas);
  resizeCanvas();
  modalBetInput?.addEventListener('wheel', e => e.preventDefault(), { passive:false });
  window.addEventListener('error', (e)=> console.error('JS Error:', e.message));
})();
