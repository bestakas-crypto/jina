(() => {
  'use strict';

  const STORAGE_KEY = 'stock-portfolio';
  const FX_STORAGE_KEY = 'fx-rates';
  const FX_API_URL = 'https://api.frankfurter.dev/v1/latest';
  const FX_DISPLAY_CURRENCIES = ['KRW', 'USD', 'JPY'];
  const LEGACY_KEYS = { kospi: 'atr-grid:kospi', qqq: 'atr-grid:qqq' };
  const LEGACY_NAMES = { kospi: '코스피200', qqq: 'QQQ' };
  const MIGRATION_SKIP_FLAG = 'atr-grid-migration-skipped';
  const DRAWDOWN_THRESHOLDS = [5, 10, 15, 20, 25, 30];
  const PARTIAL_SELL_PRESETS = [10, 20, 30, 50];

  let portfolio = [];
  let fxRates = null; // { rates: { KRW: 1, USD: 1350.5, ... }, updatedAt, source, displayCurrency }
  let currentStockId = null;
  let showAllTx = false;
  let showDrawdownTable = false;
  let showTotalDetail = false;
  let txModalMode = null; // 'buy' | 'sell'
  let editingTxId = null;
  let confirmCallback = null;

  // ---------- ID / date helpers ----------
  function genId() {
    return 'id_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  }

  function todayStr() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function num(v) {
    const n = parseFloat(v);
    return isFinite(n) ? n : null;
  }

  // ---------- Storage ----------
  function loadPortfolio() {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      return [];
    }
  }

  function savePortfolio() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(portfolio));
  }

  function getStock(id) {
    return portfolio.find((s) => s.id === id) || null;
  }

  // ---------- FX rates (manual + best-effort auto fetch) ----------
  function defaultFxRates() {
    return { rates: { KRW: 1 }, updatedAt: null, source: null, displayCurrency: 'KRW' };
  }

  function loadFxRates() {
    const raw = localStorage.getItem(FX_STORAGE_KEY);
    if (!raw) return defaultFxRates();
    try {
      const parsed = JSON.parse(raw);
      const merged = Object.assign(defaultFxRates(), parsed);
      merged.rates = Object.assign({ KRW: 1 }, parsed.rates);
      return merged;
    } catch (e) {
      return defaultFxRates();
    }
  }

  function saveFxRates() {
    localStorage.setItem(FX_STORAGE_KEY, JSON.stringify(fxRates));
  }

  // amount in fromCurrency -> amount in toCurrency, or null if either rate is unknown.
  // fxRates.rates stores "KRW value of 1 unit of that currency".
  function convertAmount(amount, fromCurrency, toCurrency) {
    const from = fromCurrency || 'KRW';
    const to = toCurrency || 'KRW';
    if (from === to) return amount;
    const fromRate = fxRates.rates[from];
    const toRate = fxRates.rates[to];
    if (fromRate == null || toRate == null) return null;
    return (amount * fromRate) / toRate;
  }

  function currenciesInUse() {
    const set = new Set(FX_DISPLAY_CURRENCIES);
    portfolio.forEach((s) => { if (s.currency) set.add(s.currency); });
    set.delete('KRW');
    return Array.from(set);
  }

  // Best-effort automatic lookup via a free, no-key exchange rate API.
  // On any failure (offline, blocked, API down) this simply resolves to false
  // and whatever rates are already stored (manual or previously fetched) stay in effect.
  async function autoFetchFxRates() {
    const need = currenciesInUse();
    if (need.length === 0) return true;
    try {
      const url = `${FX_API_URL}?from=KRW&to=${encodeURIComponent(need.join(','))}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error('fx http error');
      const data = await res.json();
      let any = false;
      need.forEach((c) => {
        const perKrw = data.rates && data.rates[c];
        if (perKrw) { fxRates.rates[c] = 1 / perKrw; any = true; }
      });
      if (any) {
        fxRates.updatedAt = new Date().toISOString();
        fxRates.source = 'auto';
        saveFxRates();
      }
      return any;
    } catch (e) {
      return false;
    }
  }

  function createStock(name, currency) {
    return {
      id: genId(),
      name,
      currency: currency || 'KRW',
      transactions: [],
      buyMultiple: 1.0,
      sellMultiple: 1.5,
      stopMultiple: 2.0,
      postEntryHighPrice: null,
      autoUpdateHigh: true,
      trailingStopLine: null,
      lastPrice: null,
      lastAtr: null
    };
  }

  // ---------- Derived calculations ----------
  function sortByDate(transactions) {
    return [...transactions].sort((a, b) => {
      if (a.date !== b.date) return a.date < b.date ? -1 : 1;
      return 0;
    });
  }

  // Average price = weighted average of BUY transactions only.
  // Selling never changes average price, only reduces holding qty.
  function computeDerived(stock) {
    const sorted = sortByDate(stock.transactions);
    let runQty = 0;
    let runCost = 0;
    const enriched = [];

    sorted.forEach((t) => {
      if (t.type === 'buy') {
        runQty += t.qty;
        runCost += t.qty * t.price;
        enriched.push({ ...t, avgPriceAtExecution: runQty > 0 ? runCost / runQty : 0, realizedPnl: null });
      } else {
        const avgAtSale = runQty > 0 ? runCost / runQty : 0;
        const realizedPnl = (t.price - avgAtSale) * t.qty;
        enriched.push({ ...t, avgPriceAtExecution: avgAtSale, realizedPnl });
      }
    });

    const holdingQty = stock.transactions.reduce(
      (sum, t) => sum + (t.type === 'buy' ? t.qty : -t.qty), 0
    );
    const avgPrice = runQty > 0 ? runCost / runQty : 0;
    const costBasis = avgPrice * holdingQty;

    return { holdingQty, avgPrice, costBasis, enrichedTransactions: enriched };
  }

  function getBasePrice(stock, derived) {
    const sorted = sortByDate(stock.transactions);
    if (sorted.length === 0) return derived.avgPrice;
    return sorted[sorted.length - 1].price;
  }

  function computeNextBuyPrice(stock, derived, atr) {
    if (atr == null) return null;
    const basePrice = getBasePrice(stock, derived);
    return basePrice - atr * stock.buyMultiple;
  }

  function computeTakeProfitPrice(stock, derived, atr) {
    if (atr == null) return null;
    return derived.avgPrice + atr * stock.sellMultiple;
  }

  function computeTrailingStopCandidate(stock, atr) {
    if (stock.postEntryHighPrice == null || atr == null) return null;
    return stock.postEntryHighPrice - atr * stock.stopMultiple;
  }

  // Ratchet: trailing stop line only ever moves up, never down.
  function commitTrailingStopRatchet(stock, atr) {
    if (stock.postEntryHighPrice == null) {
      stock.trailingStopLine = null;
      return;
    }
    const candidate = computeTrailingStopCandidate(stock, atr);
    if (candidate == null) return;
    stock.trailingStopLine = stock.trailingStopLine == null
      ? candidate
      : Math.max(stock.trailingStopLine, candidate);
  }

  // Reset / re-anchor postEntryHighPrice + trailingStopLine when holdings integrity
  // may have been broken by a transaction edit/delete or a full exit.
  function reconcilePostHighAndStop(stock) {
    const derived = computeDerived(stock);
    if (derived.holdingQty <= 0) {
      stock.postEntryHighPrice = null;
      stock.trailingStopLine = null;
      return;
    }
    if (stock.postEntryHighPrice == null) {
      const sorted = sortByDate(stock.transactions);
      const firstBuy = sorted.find((t) => t.type === 'buy');
      stock.postEntryHighPrice = firstBuy ? firstBuy.price : null;
      stock.trailingStopLine = null;
    }
  }

  // ---------- Signal ----------
  function computeSignal(stock, currentPrice, nextBuyPrice, takeProfitPrice) {
    if (currentPrice == null) return null;
    const stopLine = stock.trailingStopLine;
    const hitStop = stopLine != null && currentPrice <= stopLine;
    const hitProfit = takeProfitPrice != null && currentPrice >= takeProfitPrice;
    const hitBuy = nextBuyPrice != null && currentPrice <= nextBuyPrice;

    if (hitStop && hitProfit) {
      return { level: 1, cls: 'signal-red', text: '🔴 매도 신호 도달 — 추적 손절선과 익절 조건이 동시에 충족되었습니다' };
    }
    if (hitStop) {
      return { level: 2, cls: 'signal-red', text: '🔴 방어 매도 기준 도달 — 매도를 고려하세요' };
    }
    if (hitProfit) {
      return { level: 3, cls: 'signal-orange', text: '🟠 익절 기준 도달 — 분할 매도를 고려하세요' };
    }
    if (hitBuy) {
      return { level: 4, cls: 'signal-green', text: '🟢 매수 기준 도달 — 추가 매수를 고려하세요' };
    }
    return { level: 5, cls: 'signal-yellow', text: '🟡 관망 구간' };
  }

  function signalEmoji(stock, currentPrice, nextBuyPrice, takeProfitPrice) {
    const s = computeSignal(stock, currentPrice, nextBuyPrice, takeProfitPrice);
    return s ? s.text.slice(0, 2) : '⚪';
  }

  // ---------- Drawdown ----------
  function computeDrawdownLevels(postEntryHighPrice) {
    if (postEntryHighPrice == null) return [];
    return DRAWDOWN_THRESHOLDS.map((pct) => ({
      pct,
      price: postEntryHighPrice * (1 - pct / 100)
    }));
  }

  function computeDrawdownBracketLabel(dropPct) {
    if (dropPct <= 0) return '고점권 (하락 없음)';
    for (const t of DRAWDOWN_THRESHOLDS) {
      if (dropPct <= t) return `-${t}% 이내`;
    }
    return '-30% 초과';
  }

  // ---------- Partial sell simulation ----------
  function computePartialSell(derived, currentPrice, pct) {
    const qty = derived.holdingQty * (pct / 100);
    const realizedPnl = currentPrice == null ? null : (currentPrice - derived.avgPrice) * qty;
    return { qty, realizedPnl };
  }

  // ---------- Formatting ----------
  function formatMoney(n, currency) {
    if (n == null || !isFinite(n)) return '-';
    const rounded = Math.round(n).toLocaleString('ko-KR');
    return (currency === 'KRW' || !currency) ? rounded + '원' : rounded + ' ' + currency;
  }

  function formatPrice(n) {
    if (n == null || !isFinite(n)) return '-';
    const rounded = Math.round(n * 100) / 100;
    return rounded.toLocaleString('ko-KR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function formatQty(n) {
    if (n == null || !isFinite(n)) return '-';
    const rounded = Math.round(n * 10000) / 10000;
    return rounded.toLocaleString('ko-KR', { maximumFractionDigits: 4 });
  }

  function formatPercent(n) {
    if (n == null || !isFinite(n)) return '-';
    const rounded = Math.round(n * 100) / 100;
    return (rounded >= 0 ? '+' : '') + rounded.toFixed(2) + '%';
  }

  function pnlClass(n) {
    if (n == null || !isFinite(n)) return '';
    return n >= 0 ? 'pnl-pos' : 'pnl-neg';
  }

  // ---------- DOM refs ----------
  const el = {};
  function cacheDom() {
    el.btnNavBack = document.getElementById('btn-nav-back');
    el.btnNavForward = document.getElementById('btn-nav-forward');
    el.btnNavRefresh = document.getElementById('btn-nav-refresh');
    el.headerTitle = document.getElementById('header-title');

    el.viewList = document.getElementById('view-list');
    el.btnAddStock = document.getElementById('btn-add-stock');
    el.btnToggleTotal = document.getElementById('btn-toggle-total');
    el.totalCostSum = document.getElementById('total-cost-sum');
    el.totalChevron = document.getElementById('total-chevron');
    el.totalSummaryDetail = document.getElementById('total-summary-detail');
    el.totalDetailRows = document.getElementById('total-detail-rows');
    el.totalMissingNote = document.getElementById('total-missing-note');
    el.currencySwitch = document.getElementById('currency-switch');
    el.fxStatus = document.getElementById('fx-status');
    el.fxRateRows = document.getElementById('fx-rate-rows');
    el.btnFxRefresh = document.getElementById('btn-fx-refresh');
    el.btnFxSave = document.getElementById('btn-fx-save');
    el.stockList = document.getElementById('stock-list');
    el.stockListEmpty = document.getElementById('stock-list-empty');

    el.viewDetail = document.getElementById('view-detail');
    el.dAvgPrice = document.getElementById('d-avg-price');
    el.dQty = document.getElementById('d-qty');
    el.dCostBasis = document.getElementById('d-cost-basis');
    el.dPnl = document.getElementById('d-pnl');

    el.signalBanner = document.getElementById('signal-banner');
    el.signalText = document.getElementById('signal-text');

    el.inputCurrentPrice = document.getElementById('input-current-price');
    el.inputAtr = document.getElementById('input-atr');
    el.inputPostHigh = document.getElementById('input-post-high');
    el.inputAutoUpdateHigh = document.getElementById('input-auto-update-high');

    el.dNextBuy = document.getElementById('d-next-buy');
    el.dTakeProfit = document.getElementById('d-take-profit');
    el.dTrailingStop = document.getElementById('d-trailing-stop');

    el.drawdownCurrentLine = document.getElementById('drawdown-current-line');
    el.btnToggleDrawdown = document.getElementById('btn-toggle-drawdown');
    el.drawdownTableWrap = document.getElementById('drawdown-table-wrap');
    el.drawdownBody = document.getElementById('drawdown-body');

    el.partialSellBody = document.getElementById('partial-sell-body');
    el.inputCustomPct = document.getElementById('input-custom-pct');
    el.customPctResult = document.getElementById('custom-pct-result');

    el.txBody = document.getElementById('tx-body');
    el.txEmpty = document.getElementById('tx-empty');
    el.btnToggleTxAll = document.getElementById('btn-toggle-tx-all');

    el.settingsDetails = document.getElementById('settings-details');
    el.settingsName = document.getElementById('settings-name');
    el.settingsCurrency = document.getElementById('settings-currency');
    el.settingsBuyMult = document.getElementById('settings-buy-mult');
    el.settingsSellMult = document.getElementById('settings-sell-mult');
    el.settingsStopMult = document.getElementById('settings-stop-mult');
    el.btnSaveSettings = document.getElementById('btn-save-settings');
    el.btnResetStock = document.getElementById('btn-reset-stock');
    el.btnDeleteStock = document.getElementById('btn-delete-stock');

    el.stickyActions = document.getElementById('sticky-actions');
    el.btnOpenBuy = document.getElementById('btn-open-buy');
    el.btnOpenSell = document.getElementById('btn-open-sell');

    el.modalTx = document.getElementById('modal-tx');
    el.modalTxTitle = document.getElementById('modal-tx-title');
    el.txDate = document.getElementById('tx-date');
    el.txPrice = document.getElementById('tx-price');
    el.txQty = document.getElementById('tx-qty');
    el.btnTxDelete = document.getElementById('btn-tx-delete');
    el.btnTxCancel = document.getElementById('btn-tx-cancel');
    el.btnTxSave = document.getElementById('btn-tx-save');

    el.modalAddStock = document.getElementById('modal-add-stock');
    el.addStockName = document.getElementById('add-stock-name');
    el.addStockCurrency = document.getElementById('add-stock-currency');
    el.btnAddStockCancel = document.getElementById('btn-add-stock-cancel');
    el.btnAddStockSave = document.getElementById('btn-add-stock-save');

    el.modalConfirm = document.getElementById('modal-confirm');
    el.confirmMessage = document.getElementById('confirm-message');
    el.confirmCancel = document.getElementById('confirm-cancel');
    el.confirmOk = document.getElementById('confirm-ok');

    el.modalMigration = document.getElementById('modal-migration');
    el.migrationSkip = document.getElementById('migration-skip');
    el.migrationOk = document.getElementById('migration-ok');

    el.toast = document.getElementById('toast');
  }

  // ---------- Toast ----------
  let toastTimer = null;
  function showToast(msg) {
    el.toast.textContent = msg;
    el.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.toast.hidden = true; }, 2400);
  }

  // ---------- Confirm modal ----------
  function askConfirm(message, onConfirm) {
    el.confirmMessage.textContent = message;
    confirmCallback = onConfirm;
    el.modalConfirm.hidden = false;
  }

  function closeConfirm() {
    el.modalConfirm.hidden = true;
    confirmCallback = null;
  }

  // ---------- Navigation ----------
  // renderListView/renderDetailView only update the DOM. navigateToList/navigateToDetail
  // additionally push a browser history entry so the header back/forward buttons
  // (and the device's own back gesture) work like real navigation.
  function renderListView() {
    currentStockId = null;
    el.viewList.hidden = false;
    el.viewDetail.hidden = true;
    el.stickyActions.hidden = true;
    el.headerTitle.textContent = '분할매매 트래커';
    renderList();
  }

  function renderDetailView(stockId) {
    const stock = getStock(stockId);
    if (!stock) { renderListView(); return; }
    currentStockId = stockId;
    showAllTx = false;
    showDrawdownTable = false;
    el.viewList.hidden = true;
    el.viewDetail.hidden = false;
    el.stickyActions.hidden = false;
    el.headerTitle.textContent = stock.name;

    el.inputCurrentPrice.value = stock.lastPrice != null ? stock.lastPrice : '';
    el.inputAtr.value = stock.lastAtr != null ? stock.lastAtr : '';
    el.inputPostHigh.value = stock.postEntryHighPrice != null ? stock.postEntryHighPrice : '';
    el.inputAutoUpdateHigh.checked = stock.autoUpdateHigh;
    el.settingsDetails.open = false;

    renderDetail();
  }

  function navigateToList() {
    history.pushState({ view: 'list' }, '', '#list');
    renderListView();
  }

  function navigateToDetail(stockId) {
    history.pushState({ view: 'detail', id: stockId }, '', '#detail/' + stockId);
    renderDetailView(stockId);
  }

  // ---------- Render: List ----------
  function renderList() {
    el.stockList.innerHTML = '';
    el.stockListEmpty.hidden = portfolio.length > 0;

    const detailRows = [];

    portfolio.forEach((stock) => {
      const derived = computeDerived(stock);
      detailRows.push({ name: stock.name, cost: derived.costBasis, currency: stock.currency });

      const hasPrice = stock.lastPrice != null;
      let nextBuy = null;
      let takeProfit = null;
      if (hasPrice) {
        nextBuy = computeNextBuyPrice(stock, derived, stock.lastAtr);
        takeProfit = computeTakeProfitPrice(stock, derived, stock.lastAtr);
      }

      const card = document.createElement('div');
      card.className = 'stock-card';
      card.dataset.id = stock.id;

      const top = document.createElement('div');
      top.className = 'stock-card-top';

      const signalSpan = document.createElement('span');
      signalSpan.className = 'stock-card-signal';
      signalSpan.textContent = hasPrice ? signalEmoji(stock, stock.lastPrice, nextBuy, takeProfit) : '⚪';
      top.appendChild(signalSpan);

      const nameSpan = document.createElement('span');
      nameSpan.className = 'stock-card-name';
      nameSpan.textContent = stock.name;
      top.appendChild(nameSpan);

      const returnSpan = document.createElement('span');
      returnSpan.className = 'stock-card-return mono';
      if (hasPrice && derived.avgPrice > 0) {
        const pct = (stock.lastPrice - derived.avgPrice) / derived.avgPrice * 100;
        returnSpan.textContent = formatPercent(pct);
        returnSpan.classList.add(pnlClass(pct));
      } else {
        returnSpan.textContent = '현재가 미입력';
        returnSpan.style.color = 'var(--text-faint)';
        returnSpan.style.fontSize = '12px';
      }
      top.appendChild(returnSpan);

      const menuBtn = document.createElement('button');
      menuBtn.type = 'button';
      menuBtn.className = 'stock-card-menu';
      menuBtn.dataset.id = stock.id;
      menuBtn.setAttribute('aria-label', '종목 삭제');
      menuBtn.textContent = '⋮';
      top.appendChild(menuBtn);

      card.appendChild(top);

      const grid = document.createElement('div');
      grid.className = 'stock-card-grid';
      grid.appendChild(cardItem('평균단가', formatPrice(derived.avgPrice)));
      grid.appendChild(cardItem('보유수량', formatQty(derived.holdingQty)));
      grid.appendChild(cardItem('매입금액', formatMoney(derived.costBasis, stock.currency)));
      card.appendChild(grid);

      el.stockList.appendChild(card);
    });

    const displayCurrency = fxRates.displayCurrency;
    let total = 0;
    let missingCount = 0;
    detailRows.forEach((r) => {
      const converted = convertAmount(r.cost, r.currency, displayCurrency);
      if (converted == null) { missingCount++; return; }
      total += converted;
    });
    el.totalCostSum.textContent = formatMoney(total, displayCurrency);

    el.totalMissingNote.hidden = missingCount === 0;
    if (missingCount > 0) {
      el.totalMissingNote.textContent = `환율 정보가 없는 ${missingCount}개 종목은 합계에서 제외되었습니다. 아래에서 환율을 입력해주세요.`;
    }

    document.querySelectorAll('.currency-pill').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.currency === displayCurrency);
    });

    el.totalSummaryDetail.hidden = !showTotalDetail;
    el.totalChevron.classList.toggle('open', showTotalDetail);
    if (showTotalDetail) {
      el.totalDetailRows.innerHTML = '';
      detailRows.forEach((r) => {
        const row = document.createElement('div');
        row.className = 'total-detail-row';
        const nameSpan = document.createElement('span');
        nameSpan.textContent = r.name;
        const costSpan = document.createElement('span');
        costSpan.className = 'mono';
        costSpan.textContent = formatMoney(r.cost, r.currency);
        row.appendChild(nameSpan);
        row.appendChild(costSpan);
        el.totalDetailRows.appendChild(row);
      });
      if (detailRows.length === 0) {
        el.totalDetailRows.textContent = '등록된 종목이 없습니다.';
      }
      renderFxSettings();
    }
  }

  function renderFxSettings() {
    if (fxRates.updatedAt) {
      const dt = new Date(fxRates.updatedAt);
      const stamp = `${dt.getMonth() + 1}/${dt.getDate()} ${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`;
      el.fxStatus.textContent = fxRates.source === 'auto'
        ? `${stamp} 자동 조회된 환율 사용 중 (필요하면 아래에서 직접 수정 가능)`
        : `${stamp} 수동 입력한 환율 사용 중`;
    } else {
      el.fxStatus.textContent = '환율 자동 조회에 실패했습니다. 아래에 직접 입력해주세요.';
    }

    el.fxRateRows.innerHTML = '';
    currenciesInUse().forEach((currency) => {
      const row = document.createElement('div');
      row.className = 'fx-rate-row';

      const label = document.createElement('span');
      label.textContent = `1 ${currency} =`;
      row.appendChild(label);

      const input = document.createElement('input');
      input.type = 'number';
      input.className = 'fx-rate-input';
      input.step = '0.01';
      input.min = '0';
      input.dataset.currency = currency;
      input.value = fxRates.rates[currency] != null ? Math.round(fxRates.rates[currency] * 100) / 100 : '';
      row.appendChild(input);

      const unit = document.createElement('span');
      unit.textContent = '원';
      row.appendChild(unit);

      el.fxRateRows.appendChild(row);
    });
  }

  function cardItem(label, value) {
    const wrap = document.createElement('div');
    wrap.className = 'stock-card-item';
    const l = document.createElement('span');
    l.className = 'stock-card-label';
    l.textContent = label;
    const v = document.createElement('span');
    v.className = 'stock-card-value mono';
    v.textContent = value;
    wrap.appendChild(l);
    wrap.appendChild(v);
    return wrap;
  }

  // ---------- Render: Detail ----------
  function renderDetail() {
    const stock = getStock(currentStockId);
    if (!stock) { renderListView(); return; }
    const derived = computeDerived(stock);

    el.dAvgPrice.textContent = formatPrice(derived.avgPrice);
    el.dQty.textContent = formatQty(derived.holdingQty);
    el.dCostBasis.textContent = formatMoney(derived.costBasis, stock.currency);

    const currentPrice = num(el.inputCurrentPrice.value);
    const atr = num(el.inputAtr.value);

    if (currentPrice != null && derived.holdingQty > 0) {
      const evalValue = currentPrice * derived.holdingQty;
      const pnl = evalValue - derived.costBasis;
      const pct = derived.avgPrice > 0 ? (currentPrice - derived.avgPrice) / derived.avgPrice * 100 : null;
      el.dPnl.textContent = `${formatMoney(pnl, stock.currency)} (${formatPercent(pct)})`;
      el.dPnl.className = 'summary-value mono ' + pnlClass(pnl);
    } else {
      el.dPnl.textContent = '현재가 미입력';
      el.dPnl.className = 'summary-value mono';
    }

    const nextBuy = computeNextBuyPrice(stock, derived, atr);
    const takeProfit = computeTakeProfitPrice(stock, derived, atr);
    el.dNextBuy.textContent = nextBuy != null ? formatPrice(nextBuy) : '-';
    el.dTakeProfit.textContent = takeProfit != null ? formatPrice(takeProfit) : '-';
    el.dTrailingStop.textContent = stock.trailingStopLine != null ? formatPrice(stock.trailingStopLine) : '-';

    const signal = computeSignal(stock, currentPrice, nextBuy, takeProfit);
    if (signal) {
      el.signalBanner.hidden = false;
      el.signalBanner.className = 'signal-banner ' + signal.cls;
      el.signalText.textContent = signal.text;
    } else {
      el.signalBanner.hidden = true;
    }

    renderDrawdown(stock, currentPrice);
    renderPartialSell(derived, currentPrice);
    renderTxHistory(stock, derived);
    renderSettingsFields(stock);

    el.btnOpenSell.disabled = derived.holdingQty <= 0;
  }

  function renderDrawdown(stock, currentPrice) {
    if (stock.postEntryHighPrice == null) {
      el.drawdownCurrentLine.textContent = '보유 후 최고가 정보가 없습니다.';
    } else if (currentPrice == null) {
      el.drawdownCurrentLine.textContent =
        `보유 후 최고가 ${formatPrice(stock.postEntryHighPrice)} — 현재가를 입력하면 하락 구간을 표시합니다.`;
    } else {
      const dropPct = (stock.postEntryHighPrice - currentPrice) / stock.postEntryHighPrice * 100;
      const label = computeDrawdownBracketLabel(dropPct);
      el.drawdownCurrentLine.textContent = `보유 후 최고가 대비 ${formatPercent(-dropPct)} (${label})`;
    }

    const levels = computeDrawdownLevels(stock.postEntryHighPrice);
    el.drawdownBody.innerHTML = '';
    levels.forEach((lvl) => {
      const tr = document.createElement('tr');
      const tdPct = document.createElement('td');
      tdPct.textContent = `-${lvl.pct}%`;
      const tdPrice = document.createElement('td');
      tdPrice.textContent = formatPrice(lvl.price);
      tr.appendChild(tdPct);
      tr.appendChild(tdPrice);
      el.drawdownBody.appendChild(tr);
    });

    el.btnToggleDrawdown.textContent = showDrawdownTable ? '하락 구간 접기 ▴' : '하락 구간 더보기 ▾';
    el.drawdownTableWrap.hidden = !showDrawdownTable;
  }

  function renderPartialSell(derived, currentPrice) {
    el.partialSellBody.innerHTML = '';
    PARTIAL_SELL_PRESETS.forEach((pct) => {
      const { qty, realizedPnl } = computePartialSell(derived, currentPrice, pct);
      const tr = document.createElement('tr');
      const tdPct = document.createElement('td');
      tdPct.textContent = `${pct}%`;
      const tdQty = document.createElement('td');
      tdQty.textContent = formatQty(qty);
      const tdPnl = document.createElement('td');
      if (realizedPnl == null) {
        tdPnl.textContent = '현재가 미입력';
      } else {
        tdPnl.textContent = (realizedPnl >= 0 ? '+' : '') + formatMoney(realizedPnl, null).replace('원', '') + '원';
        tdPnl.className = pnlClass(realizedPnl);
      }
      tr.appendChild(tdPct);
      tr.appendChild(tdQty);
      tr.appendChild(tdPnl);
      el.partialSellBody.appendChild(tr);
    });
    updateCustomPctResult(derived, currentPrice);
  }

  function updateCustomPctResult(derived, currentPrice) {
    const pct = num(el.inputCustomPct.value);
    if (pct == null || pct < 0 || pct > 100) {
      el.customPctResult.textContent = '';
      return;
    }
    const { qty, realizedPnl } = computePartialSell(derived, currentPrice, pct);
    if (realizedPnl == null) {
      el.customPctResult.textContent = `${pct}% 매도 시 수량 ${formatQty(qty)} — 현재가 미입력`;
    } else {
      el.customPctResult.innerHTML =
        `${pct}% 매도 시 수량 ${formatQty(qty)} · 실현손익 <span class="${pnlClass(realizedPnl)}">${(realizedPnl >= 0 ? '+' : '')}${formatMoney(realizedPnl)}</span>`;
    }
  }

  function renderTxHistory(stock, derived) {
    const sortedDesc = [...derived.enrichedTransactions].sort((a, b) => {
      if (a.date !== b.date) return a.date < b.date ? 1 : -1;
      return 0;
    });
    const list = showAllTx ? sortedDesc : sortedDesc.slice(0, 5);

    el.txBody.innerHTML = '';
    el.txEmpty.hidden = stock.transactions.length > 0;

    list.forEach((rec) => {
      const tr = document.createElement('tr');
      tr.dataset.txId = rec.id;
      tr.setAttribute('data-clickable', '1');

      const tdType = document.createElement('td');
      const span = document.createElement('span');
      span.className = rec.type === 'buy' ? 'badge-buy' : 'badge-sell';
      span.textContent = rec.type === 'buy' ? '매수' : '매도';
      tdType.appendChild(span);
      tr.appendChild(tdType);

      const tdDate = document.createElement('td');
      tdDate.textContent = rec.date;
      tr.appendChild(tdDate);

      const tdPrice = document.createElement('td');
      tdPrice.textContent = formatPrice(rec.price);
      tr.appendChild(tdPrice);

      const tdQty = document.createElement('td');
      tdQty.textContent = formatQty(rec.qty);
      tr.appendChild(tdQty);

      const tdPnl = document.createElement('td');
      if (rec.realizedPnl == null) {
        tdPnl.textContent = '-';
      } else {
        tdPnl.textContent = (rec.realizedPnl >= 0 ? '+' : '') + formatMoney(rec.realizedPnl, stock.currency);
        tdPnl.className = pnlClass(rec.realizedPnl);
      }
      tr.appendChild(tdPnl);

      const tdEdit = document.createElement('td');
      tdEdit.className = 'tx-edit-hint';
      tdEdit.textContent = '✎';
      tr.appendChild(tdEdit);

      el.txBody.appendChild(tr);
    });

    el.btnToggleTxAll.hidden = stock.transactions.length <= 5;
    el.btnToggleTxAll.textContent = showAllTx ? '최근 5건만 보기 ▴' : '전체 보기 ▾';
  }

  function renderSettingsFields(stock) {
    el.settingsName.value = stock.name;
    el.settingsCurrency.value = stock.currency;
    el.settingsBuyMult.value = stock.buyMultiple;
    el.settingsSellMult.value = stock.sellMultiple;
    el.settingsStopMult.value = stock.stopMultiple;
  }

  // ---------- Commit handlers (persist + ratchet) ----------
  function commitCurrentPrice() {
    const stock = getStock(currentStockId);
    if (!stock) return;
    const price = num(el.inputCurrentPrice.value);
    stock.lastPrice = price;

    if (price != null && stock.autoUpdateHigh &&
      (stock.postEntryHighPrice == null || price > stock.postEntryHighPrice)) {
      stock.postEntryHighPrice = price;
      el.inputPostHigh.value = price;
    }
    const atr = num(el.inputAtr.value);
    commitTrailingStopRatchet(stock, atr);
    savePortfolio();
    renderDetail();
  }

  function commitAtr() {
    const stock = getStock(currentStockId);
    if (!stock) return;
    const atr = num(el.inputAtr.value);
    stock.lastAtr = atr;
    commitTrailingStopRatchet(stock, atr);
    savePortfolio();
    renderDetail();
  }

  function commitPostHigh() {
    const stock = getStock(currentStockId);
    if (!stock) return;
    const val = num(el.inputPostHigh.value);
    stock.postEntryHighPrice = val;
    const atr = num(el.inputAtr.value);
    commitTrailingStopRatchet(stock, atr);
    savePortfolio();
    renderDetail();
  }

  // ---------- Transaction modal ----------
  function openTxModal(mode, existingTx) {
    txModalMode = mode;
    editingTxId = existingTx ? existingTx.id : null;
    const label = mode === 'buy' ? '매수' : '매도';
    el.modalTxTitle.textContent = existingTx ? `${label} 기록 수정` : `${label} 추가`;
    el.txDate.value = existingTx ? existingTx.date : todayStr();
    el.txPrice.value = existingTx ? existingTx.price : '';
    el.txQty.value = existingTx ? existingTx.qty : '';
    el.btnTxDelete.hidden = !existingTx;
    el.modalTx.hidden = false;
  }

  function closeTxModal() {
    el.modalTx.hidden = true;
    txModalMode = null;
    editingTxId = null;
  }

  function handleTxSave() {
    const stock = getStock(currentStockId);
    if (!stock) return;
    const price = num(el.txPrice.value);
    const qty = num(el.txQty.value);
    const date = el.txDate.value || todayStr();

    if (price == null || price <= 0) { showToast('단가를 올바르게 입력하세요.'); return; }
    if (qty == null || qty <= 0) { showToast('수량을 올바르게 입력하세요.'); return; }

    if (editingTxId) {
      const tx = stock.transactions.find((t) => t.id === editingTxId);
      if (tx) { tx.price = price; tx.qty = qty; tx.date = date; }
    } else {
      const wasZero = computeDerived(stock).holdingQty <= 0;
      const atrNow = num(el.inputAtr.value);
      stock.transactions.push({ id: genId(), type: txModalMode, price, qty, date, atrAtExecution: atrNow });
      if (txModalMode === 'buy' && wasZero) {
        stock.postEntryHighPrice = price;
        stock.trailingStopLine = null;
      }
    }

    reconcilePostHighAndStop(stock);
    savePortfolio();
    closeTxModal();
    el.inputPostHigh.value = stock.postEntryHighPrice != null ? stock.postEntryHighPrice : '';
    renderDetail();
    showToast('거래가 저장되었습니다.');
  }

  function handleTxDelete() {
    const stock = getStock(currentStockId);
    if (!stock || !editingTxId) return;
    askConfirm('이 거래 기록을 삭제할까요? 이 작업은 되돌릴 수 없습니다.', () => {
      stock.transactions = stock.transactions.filter((t) => t.id !== editingTxId);
      reconcilePostHighAndStop(stock);
      savePortfolio();
      closeTxModal();
      el.inputPostHigh.value = stock.postEntryHighPrice != null ? stock.postEntryHighPrice : '';
      renderDetail();
      showToast('거래 기록이 삭제되었습니다.');
    });
  }

  // ---------- Stock add / settings / reset / delete ----------
  function handleAddStockSave() {
    const name = el.addStockName.value.trim();
    if (!name) { showToast('종목명을 입력하세요.'); return; }
    const currency = el.addStockCurrency.value.trim() || 'KRW';
    const stock = createStock(name, currency);
    portfolio.push(stock);
    savePortfolio();
    el.modalAddStock.hidden = true;
    navigateToDetail(stock.id);
  }

  function handleSaveSettings() {
    const stock = getStock(currentStockId);
    if (!stock) return;
    const name = el.settingsName.value.trim();
    if (!name) { showToast('종목명을 입력하세요.'); return; }
    stock.name = name;
    stock.currency = el.settingsCurrency.value.trim() || 'KRW';
    const bm = num(el.settingsBuyMult.value);
    if (bm != null && bm >= 0) stock.buyMultiple = bm;
    const sm = num(el.settingsSellMult.value);
    if (sm != null && sm >= 0) stock.sellMultiple = sm;
    const stm = num(el.settingsStopMult.value);
    if (stm != null && stm >= 0) stock.stopMultiple = stm;

    savePortfolio();
    el.headerTitle.textContent = stock.name;
    renderDetail();
    showToast('설정이 저장되었습니다.');
  }

  function handleResetStock() {
    const stock = getStock(currentStockId);
    if (!stock) return;
    askConfirm(`'${stock.name}' 종목의 거래 이력을 전부 삭제하고 초기화합니다. 이 작업은 되돌릴 수 없습니다.`, () => {
      stock.transactions = [];
      stock.postEntryHighPrice = null;
      stock.trailingStopLine = null;
      stock.lastPrice = null;
      stock.lastAtr = null;
      savePortfolio();
      el.inputCurrentPrice.value = '';
      el.inputAtr.value = '';
      el.inputPostHigh.value = '';
      renderDetail();
      showToast('종목이 초기화되었습니다.');
    });
  }

  function handleDeleteStock() {
    const stock = getStock(currentStockId);
    if (!stock) return;
    askConfirm(`'${stock.name}' 종목을 삭제합니다. 이 작업은 되돌릴 수 없습니다.`, () => {
      portfolio = portfolio.filter((s) => s.id !== currentStockId);
      savePortfolio();
      history.back();
      showToast('종목이 삭제되었습니다.');
    });
  }

  // Quick delete from the list card's "⋮" menu — same effect as the settings
  // "종목 삭제" button, but reachable without opening the stock first.
  function handleQuickDeleteStock(stockId) {
    const stock = getStock(stockId);
    if (!stock) return;
    askConfirm(`'${stock.name}' 종목을 삭제합니다. 이 작업은 되돌릴 수 없습니다.`, () => {
      portfolio = portfolio.filter((s) => s.id !== stockId);
      savePortfolio();
      renderList();
      showToast('종목이 삭제되었습니다.');
    });
  }

  // ---------- Legacy migration ----------
  function checkLegacyMigration() {
    if (localStorage.getItem(MIGRATION_SKIP_FLAG)) return;
    if (portfolio.length > 0) return;
    const kospiRaw = localStorage.getItem(LEGACY_KEYS.kospi);
    const qqqRaw = localStorage.getItem(LEGACY_KEYS.qqq);
    if (!kospiRaw && !qqqRaw) return;
    el.modalMigration.hidden = false;
  }

  function performMigration() {
    ['kospi', 'qqq'].forEach((key) => {
      const raw = localStorage.getItem(LEGACY_KEYS[key]);
      if (!raw) return;
      let legacy;
      try { legacy = JSON.parse(raw); } catch (e) { return; }
      if (!legacy || !legacy.started) return;

      const stock = createStock(LEGACY_NAMES[key], 'KRW');
      const history = Array.isArray(legacy.history) ? legacy.history.slice().reverse() : [];
      history.forEach((rec) => {
        stock.transactions.push({
          id: genId(),
          type: rec.type,
          price: rec.price,
          qty: rec.qty,
          date: rec.date,
          atrAtExecution: rec.atr != null ? rec.atr : null
        });
      });

      const derived = computeDerived(stock);
      if (derived.holdingQty > 0) {
        const sorted = sortByDate(stock.transactions);
        const firstBuy = sorted.find((t) => t.type === 'buy');
        stock.postEntryHighPrice = firstBuy ? firstBuy.price : null;
      }
      stock.trailingStopLine = null;

      portfolio.push(stock);
    });

    savePortfolio();
    localStorage.setItem(MIGRATION_SKIP_FLAG, '1');
    el.modalMigration.hidden = true;
    showToast('기존 데이터를 새 구조로 변환했습니다.');
    renderList();
  }

  // ---------- Init ----------
  function bindEvents() {
    el.btnNavBack.addEventListener('click', () => history.back());
    el.btnNavForward.addEventListener('click', () => history.forward());
    el.btnNavRefresh.addEventListener('click', () => location.reload());

    el.btnAddStock.addEventListener('click', () => {
      el.addStockName.value = '';
      el.addStockCurrency.value = 'KRW';
      el.modalAddStock.hidden = false;
    });
    el.btnAddStockCancel.addEventListener('click', () => { el.modalAddStock.hidden = true; });
    el.btnAddStockSave.addEventListener('click', handleAddStockSave);

    el.btnToggleTotal.addEventListener('click', () => {
      showTotalDetail = !showTotalDetail;
      renderList();
    });

    el.currencySwitch.addEventListener('click', (e) => {
      const btn = e.target.closest('.currency-pill');
      if (!btn) return;
      fxRates.displayCurrency = btn.dataset.currency;
      saveFxRates();
      renderList();
    });

    el.btnFxRefresh.addEventListener('click', async () => {
      el.fxStatus.textContent = '환율을 조회하는 중...';
      const ok = await autoFetchFxRates();
      renderList();
      showToast(ok ? '환율을 새로 조회했습니다.' : '환율 자동 조회에 실패했습니다. 직접 입력해주세요.');
    });

    el.btnFxSave.addEventListener('click', () => {
      const inputs = el.fxRateRows.querySelectorAll('.fx-rate-input');
      inputs.forEach((input) => {
        const val = num(input.value);
        if (val != null && val > 0) fxRates.rates[input.dataset.currency] = val;
      });
      fxRates.updatedAt = new Date().toISOString();
      fxRates.source = 'manual';
      saveFxRates();
      renderList();
      showToast('환율이 저장되었습니다.');
    });

    el.stockList.addEventListener('click', (e) => {
      const menuBtn = e.target.closest('.stock-card-menu');
      if (menuBtn) {
        e.stopPropagation();
        handleQuickDeleteStock(menuBtn.dataset.id);
        return;
      }
      const card = e.target.closest('.stock-card');
      if (card) navigateToDetail(card.dataset.id);
    });

    el.inputCurrentPrice.addEventListener('input', renderDetail);
    el.inputCurrentPrice.addEventListener('change', commitCurrentPrice);
    el.inputAtr.addEventListener('input', renderDetail);
    el.inputAtr.addEventListener('change', commitAtr);
    el.inputPostHigh.addEventListener('change', commitPostHigh);
    el.inputAutoUpdateHigh.addEventListener('change', () => {
      const stock = getStock(currentStockId);
      if (!stock) return;
      stock.autoUpdateHigh = el.inputAutoUpdateHigh.checked;
      savePortfolio();
    });

    el.btnToggleDrawdown.addEventListener('click', () => {
      showDrawdownTable = !showDrawdownTable;
      renderDetail();
    });

    el.inputCustomPct.addEventListener('input', () => {
      const stock = getStock(currentStockId);
      if (!stock) return;
      const derived = computeDerived(stock);
      const currentPrice = num(el.inputCurrentPrice.value);
      updateCustomPctResult(derived, currentPrice);
    });

    el.btnToggleTxAll.addEventListener('click', () => {
      showAllTx = !showAllTx;
      renderDetail();
    });

    el.txBody.addEventListener('click', (e) => {
      const row = e.target.closest('tr[data-tx-id]');
      if (!row) return;
      const stock = getStock(currentStockId);
      if (!stock) return;
      const tx = stock.transactions.find((t) => t.id === row.dataset.txId);
      if (tx) openTxModal(tx.type, tx);
    });

    el.btnOpenBuy.addEventListener('click', () => openTxModal('buy'));
    el.btnOpenSell.addEventListener('click', () => {
      if (el.btnOpenSell.disabled) return;
      openTxModal('sell');
    });
    el.btnTxCancel.addEventListener('click', closeTxModal);
    el.btnTxSave.addEventListener('click', handleTxSave);
    el.btnTxDelete.addEventListener('click', handleTxDelete);

    el.btnSaveSettings.addEventListener('click', handleSaveSettings);
    el.btnResetStock.addEventListener('click', handleResetStock);
    el.btnDeleteStock.addEventListener('click', handleDeleteStock);

    el.confirmOk.addEventListener('click', () => {
      const cb = confirmCallback;
      closeConfirm();
      if (cb) cb();
    });
    el.confirmCancel.addEventListener('click', closeConfirm);
    el.modalConfirm.addEventListener('click', (e) => { if (e.target === el.modalConfirm) closeConfirm(); });
    el.modalTx.addEventListener('click', (e) => { if (e.target === el.modalTx) closeTxModal(); });
    el.modalAddStock.addEventListener('click', (e) => { if (e.target === el.modalAddStock) el.modalAddStock.hidden = true; });

    el.migrationOk.addEventListener('click', performMigration);
    el.migrationSkip.addEventListener('click', () => {
      localStorage.setItem(MIGRATION_SKIP_FLAG, '1');
      el.modalMigration.hidden = true;
    });
  }

  function init() {
    cacheDom();
    portfolio = loadPortfolio();
    fxRates = loadFxRates();
    bindEvents();

    window.addEventListener('popstate', (e) => {
      const state = e.state;
      if (state && state.view === 'detail') renderDetailView(state.id);
      else renderListView();
    });
    history.replaceState({ view: 'list' }, '', '#list');

    checkLegacyMigration();
    renderListView();

    // Best-effort background refresh; renderList() again once it settles (or fails silently).
    autoFetchFxRates().then(() => {
      if (!currentStockId) renderList();
    });

    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('service-worker.js').catch(() => {});
      });
      // When a newly deployed service worker takes over, reload once so the
      // page (and cached assets) reflect the latest version instead of a stale copy.
      let swRefreshed = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (swRefreshed) return;
        swRefreshed = true;
        location.reload();
      });
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
