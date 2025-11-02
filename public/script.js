(()=> {
  // ==== helpers ====
  const $ = s => document.querySelector(s);
  const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\'':'&#39;'}[c]));
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

  // ==== Telegram профиль (игра + профиль) ====
  const CURRENT_PROFILE = { nick: 'User', avatar: null };
  function applyTgProfile(){
    try{
      const tg = window.Telegram?.WebApp; tg?.ready?.(); tg?.expand?.();
      const u = tg?.initDataUnsafe?.user; const nameQS = qs.get('name'); const photoQS = qs.get('photo');
      let displayName = 'User'; let photo = null;
      if (u){
        const composed = [u.first_name,u.last_name].filter(Boolean).join(' ');
        displayName = composed || (u.username?`@${u.username}`:'User');
        if (u.photo_url) photo = u.photo_url;
      } else if (nameQS){
        displayName = nameQS; if (photoQS) photo = photoQS;
      }
      // Профиль
      if (photo) profileAva.src = photo; else profileAva.removeAttribute('src');
      profileName.textContent = displayName;

      CURRENT_PROFILE.nick = displayName; CURRENT_PROFILE.avatar = photo || null;

      const send = ()=>{ try{ ws.send(JSON.stringify({ type:'profile', profile:{ nick:displayName, avatar:photo } })); }catch{} };
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
        if (typeof d.stars === 'number') { WSTATE.stars = d.stars|0; starsEl.textContent = WSTATE.stars; }
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

      case 'profile_update':
        addOrUpdatePlayer(d.userId, d.nick, d.avatar);
        break;

      case 'error':
        placingBet = false; cashoutLock = false; alert(d.message || 'Ошибка'); break;
    }
  };

  // ==== UI helpers ====
  function setBalance(v){ state.balance = Number(v)||0; balanceNumEl.textContent = state.balance.toFixed(2); profileBalance.textContent = state.balance.toFixed(2); }

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

  function addOrUpdatePlayer(id, nick, avatar){
    const p = players.get(id) || { id, amount:0, payout:0, cashed:false };
    p.nick = nick || p.nick || ('User '+String(id).slice(-4));
    p.avatar = (avatar !== undefined) ? avatar : (p.avatar || null);
    players.set(id,
