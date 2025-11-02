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
  let localTicker = null;
  let history3 = [];
  let series = [];

  // ==== TonConnect (опционально) ====
  let tonConnectUI;
  const DEPOSIT_WALLET = 'UQDEx5xByv2a4JE95W2EmJKfDe1ZWA0Azs16GTiUlhlESfed'; // замени на свой UQ...

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

  // ==== Telegram профиль (имя + аватар) ====
  function applyTgProfile(){
    try{
      const tg = window.Telegram?.WebApp;
      tg?.ready?.();
      tg?.expand?.();

      const u = tg?.initDataUnsafe?.user;
      // если Telegram недоступен — поддержим ?name= & ?photo=
      const nameQS = qs.get('name');
      const photoQS = qs.get('photo');

      let displayName = 'User';
      let photo = null;

      if (u) {
        // именно отображаемое имя
        const composed = [u.first_name, u.last_name].filter(Boolean).join(' ');
        displayName = composed || (u.username ? `@${u.username}` : 'User');
        if (u.photo_url) photo = u.photo_url;
      } else if (nameQS) {
        displayName = nameQS;
        if (photoQS) photo = photoQS;
      }

      if (photo) {
        profileAva.src = photo;
      } else {
        profileAva.removeAttribute('src');
      }
      profileName.textContent = displayName;

      // Отправим на сервер, если WS уже открыт
      if (ws.readyState === 1) {
        ws.send(JSON.stringify({ type:'profile', profile:{ nick: displayName, avatar: photo } }));
      } else {
        ws.addEventListener('open', () => {
          try {
            ws.send(JSON.stringify({ type:'profile', profile:{ nick: displayName, avatar: photo } }));
          } catch(_) {}
        }, { once:true });
      }
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
        cashoutBtn.classList.add('active','pulse');
        break;

      case 'cashout_result':
        setBalance(d.balance ?? state.balance);
        state.myBet = 0; state.myCashed = true;
        cashoutBtn.disabled = true;
        cashoutBtn.classList.remove('active','pulse');
        break;

      case 'error':
        placingBet = false;
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
      const row = document.createElement('div'); row.className='player';
      row.innerHTML = `
        <div class="pname">${esc(p.nick||'User')}</div>
        <div class="pval ${p.cashed ? 'good' : ''}">
          ${p.cashed ? `+${(p.payout||0).toFixed(2)}` : (p.amount ? (p.amount||0).toFixed(2) : '')}
        </div>`;
      playersList.appendChild(row);
    }
    roundTotal.textContent = total ? `${total.toFixed(2)} TON` : '';
  }

  // ==== round lifecycle ====
  function onRoundStart(d){
    state.roundState='betting';
    state.myBet=0; state.myCashed=false;

    // СБРОС ВСЕГО, чтобы инпут всегда работал после раннего клика:
    placingBet = false;
    closeModal(betModal);
    modalBetInput.value = '';
    modalBetInput.disabled = false;

    // Убедимся, что у инпута тип/атрибуты правильные (некоторые бразуеры ломают через кэш):
    modalBetInput.setAttribute('type','text');
    modalBetInput.setAttribute('inputmode','decimal');
    modalBetInput.setAttribute('autocomplete','off');
    modalBetInput.setAttribute('autocapitalize','off');
    modalBetInput.setAttribute('spellcheck','false');

    // график
    series = [{x:0,y:1}];
    drawChart();

    setMult(1.00);
    statusEl.textContent='ставки…';
    betBtn.disabled=false;
    cashoutBtn.disabled=true;
    cashoutBtn.classList.remove('active','pulse');
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
  }

  function onRoundEnd(d){
    state.roundState='finished';
    stopTicker();
    const final = Number(d.result||1);
    setMult(final);
    statusEl.textContent='КРАШ';
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
    // защита от «пролёта» кликов
    modalBox?.addEventListener('click', (e)=> e.stopPropagation());
    el.addEventListener('click', (e)=>{ if (e.target===el) closeModal(el); });

    // всегда разблокируем поле и ставим фокус
    modalBetInput.disabled = false;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        modalBetInput.focus();
        modalBetInput.select();
        setTimeout(() => {
          if (document.activeElement !== modalBetInput) {
            modalBetInput.focus();
            modalBetInput.select();
          }
        }, 60);
      });
    });
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
    openModal(betModal);
  }

  betBtn?.addEventListener('click', openBetModal);
  modalClose?.addEventListener('click', ()=> closeModal(betModal));
  modalBetInput?.addEventListener('keydown', (e)=>{ if (e.key==='Enter') modalConfirm.click(); });

  modalConfirm?.addEventListener('click', ()=>{
    if (placingBet) return;
    const amt = Number((modalBetInput.value||'').replace(',','.'));
    if (!amt || amt<=0) { alert('Введите сумму'); return; }
    if (state.balance < amt) { alert('Недостаточно TON'); return; }

    placingBet = true;
    try {
      ws.send(JSON.stringify({ type:'place_bet', amount: amt }));
      closeModal(betModal);
    } finally {
      // быстро сбрасываем флаг, чтобы следующий раунд не «ломал» ввод
      setTimeout(()=> placingBet=false, 500);
    }
  });

  cashoutBtn?.addEventListener('click', ()=>{
    if (state.roundState!=='running') return alert('Рано');
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

  // ==== green line chart ====
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

  // safety: wheel на number-инпутах (если где-то остался) — блок
  modalBetInput?.addEventListener('wheel', e => e.preventDefault(), { passive:false });

  // лог ошибок
  window.addEventListener('error', (e)=> console.error('JS Error:', e.message));
})();
