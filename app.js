// Polymarket Real-Time Terminal Controller

let activeMarket = null;
let tokenMap = {}; // mapping tokenID -> { name, price }
let ws = null;
let reconnectTimeout = null;
let heartbeatInterval = null;
let speedDecayInterval = null;

// Dynamic BTC interval trackers
let lastExpiredTimestamp = 0;

// Binance and Chart Analytics
let btcWs = null;
let currentBtcPrice = 0;
let targetBtcPrice = 0;

// TradingView Lightweight Charts variables
let btcChart = null;
let btcSeries = null;
let btcVolumeSeries = null;
let vwapSeries = null;
let currentBtcCandle = null;
const btcHistoryData = []; // Store past candles for indicator calculations (RSI, ATR, VWAP)

// Paper Trading Engine States
let paperTradingEnabled = true;
let paperTradingWallet = 15.0; // Simulated USDC
let paperTradeAllocationUsdc = 10.0; // Position size allocation in USDC per trade
const MIN_TRADE_COST_USDC = 1.0; // Minimum notional per trade in USDC
let paperRealizedPnl = 0.0;
let paperActivePosition = null; // { outcome, entryPrice, qty, cost, timestamp }
const paperClosedTrades = [];
let paperTrailingReversalPct = 8.0; // Trailing Reversal threshold (in P&L %)
let paperStopLossPct = 10.0; // -10.0% Stop Loss threshold
let paperHardTpPct = 60.0; // +60.0% Hard Take Profit threshold
let paperHardTpEnabled = true; // Flag to toggle Hard Take Profit
let paperMinHoldSecs = 5; // Minimum hold time in seconds
let paperMinTpPct = 5.0; // Minimum Take Profit threshold to cover fees/slippage (in %)
let paperFeePct = 2.0; // Round-trip fee/slippage estimate (in % of position cost)
let paperLastExitTime = 0;
let paperLastExitOutcome = null;
let currentRecommendation = "NEUTRAL";
let lastSignalDecision = "NEUTRAL";
let signalDelayTimeout = null;
let lastBlockedLogType = "NONE";
// Web3 / Real Trading states are defined globally in trading.js
let hasClobCreds = false;
let clobConnectionPending = false;

// Sound effects states
let soundEnabled = true;
let audioCtx = null;

// Metrics
let sessionVolValue = 0;
let sessionTradesCount = 0;
let totalVolValue = 0;
const tradeTimestamps = [];

// DOM Elements
const commandInput = document.getElementById("command-input");
const searchBtn = document.getElementById("search-btn");
const searchResultsPanel = document.getElementById("search-results-panel");
const resultsListContainer = document.getElementById("results-list-container");
const closeResultsBtn = document.getElementById("close-results-btn");
const connectionStatus = document.getElementById("connection-status");
const feedStatus = document.getElementById("feed-status");
const consoleLogs = document.getElementById("console-logs");

// Init Date & Time
function updateClock() {
  const now = new Date();
  const day = String(now.getDate()).padStart(2, "0");
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const year = now.getFullYear();
  const hours = String(now.getHours()).padStart(2, "0");
  const minutes = String(now.getMinutes()).padStart(2, "0");
  const seconds = String(now.getSeconds()).padStart(2, "0");

  document.getElementById("current-date").textContent =
    `${day}/${month}/${year}`;
  document.getElementById("current-time").textContent =
    `${hours}:${minutes}:${seconds}`;

  // Auto-transition for BTC 5m intervals
  const nowSecs = Math.floor(now.getTime() / 1000);
  if (activeMarket && activeMarket.slug.startsWith("btc-updown-5m-")) {
    const marketEndDateSecs = Math.floor(
      new Date(activeMarket.endDate).getTime() / 1000,
    );

    // Update remaining time timer and its color
    const timeLeftSecs = Math.max(0, marketEndDateSecs - nowSecs);
    const m = String(Math.floor(timeLeftSecs / 60)).padStart(2, "0");
    const s = String(timeLeftSecs % 60).padStart(2, "0");

    const timeLeftEl = document.getElementById("btc-time-left");
    if (timeLeftEl) {
      timeLeftEl.textContent = `${m}:${s}`;
      if (timeLeftSecs <= 15) {
        // Flash red / dark-red every 500ms
        timeLeftEl.style.color =
          now.getMilliseconds() < 500 ? "var(--bb-red)" : "#4b0c11";
      } else if (timeLeftSecs <= 45) {
        timeLeftEl.style.color = "var(--bb-red)";
      } else if (timeLeftSecs <= 120) {
        timeLeftEl.style.color = "var(--bb-amber)";
      } else {
        timeLeftEl.style.color = "var(--bb-green)";
      }
    }

    // Transition exactly when expiration is breached
    if (nowSecs >= marketEndDateSecs) {
      // Settle active paper position if one exists at expiration
      if (paperTradingEnabled && paperActivePosition) {
        const finalBtc = currentBtcPrice;
        const target = targetBtcPrice;
        const win =
          (paperActivePosition.outcome === "YES" && finalBtc >= target) ||
          (paperActivePosition.outcome === "NO" && finalBtc < target);
        const settlePrice = win ? 1.0 : 0.0;
        closePaperPosition(settlePrice, "EXPIRATION");
      }

      logToConsole(
        `[SYS] BTC 5m interval expired. Transitioning to next block...`,
      );
      lastExpiredTimestamp = marketEndDateSecs;
      // Temporarily rename slug to prevent re-entry loops during loading latency
      activeMarket.slug = "btc-updown-5m-transitioning";
      loadDefaultBtcMarket();
    }
  } else {
    const timeLeftEl = document.getElementById("btc-time-left");
    if (timeLeftEl) {
      timeLeftEl.textContent = "--:--";
    }
  }

  if (paperTradingEnabled) {
    updatePaperTradingUI();
  }
}
setInterval(updateClock, 500);
updateClock();

// Terminal Console Logger
function logToConsole(message) {
  const timestamp = new Date().toTimeString().split(" ")[0];
  const logMsg = `\n[${timestamp}] ${message}`;
  consoleLogs.textContent += logMsg;
  consoleLogs.scrollTop = consoleLogs.scrollHeight;
}

// Play Retro beep for trade feeds (Dynamic Web Audio API)
function playTradeBeep(side, price) {
  if (!soundEnabled || !audioCtx || audioCtx.state === "suspended") return;

  try {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);

    // Buy is high pitched, sell is lower pitched
    osc.type = "sine";
    osc.frequency.setValueAtTime(
      side === "BUY" ? 950 : 520,
      audioCtx.currentTime,
    );

    // Volume shaping
    gain.gain.setValueAtTime(0.012, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(
      0.00001,
      audioCtx.currentTime + 0.07,
    );

    osc.start();
    osc.stop(audioCtx.currentTime + 0.07);
  } catch (e) {
    console.error("Web Audio fail:", e);
  }
}

// Sound toggle listener
const soundToggleBtn = document.getElementById("sound-toggle-btn");
soundToggleBtn.addEventListener("click", () => {
  soundEnabled = !soundEnabled;
  if (soundEnabled) {
    soundToggleBtn.textContent = "ON";
    soundToggleBtn.className = "toggle-btn on";
    // Force init AudioContext
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    audioCtx.resume().then(() => {
      logToConsole(`[SYS] Audio outputs enabled.`);
      playTradeBeep("BUY", 0.5);
    });
  } else {
    soundToggleBtn.textContent = "OFF";
    soundToggleBtn.className = "toggle-btn off";
    logToConsole(`[SYS] Audio outputs disabled.`);
  }
});

// Helper: Format to USD currency representation
function formatUSD(val) {
  const num = parseFloat(val);
  if (isNaN(num)) return "$0.00";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(num);
}

// Helper: Get Slug from input (handling full Polymarket event/market URLs)
function parseInputSlug(input) {
  input = input.trim();
  if (input.startsWith("http://") || input.startsWith("https://")) {
    try {
      const url = new URL(input);
      const pathParts = url.pathname.split("/").filter((p) => p);
      // Polymarket URLs are usually: /event/slug or /market/slug
      if (pathParts.length > 0) {
        return pathParts[pathParts.length - 1];
      }
    } catch (e) {
      logToConsole(`[ERR] Failed parsing URL. Treating as raw search.`);
    }
  }
  return input;
}

// Load Selected Market metadata and connect to live stream
function loadMarket(market) {
  activeMarket = market;

  // Parse arrays that come as stringified JSON from Gamma
  let clobTokenIds = [];
  let outcomes = [];
  let prices = [];

  try {
    clobTokenIds =
      typeof market.clobTokenIds === "string"
        ? JSON.parse(market.clobTokenIds)
        : market.clobTokenIds;
    outcomes =
      typeof market.outcomes === "string"
        ? JSON.parse(market.outcomes)
        : market.outcomes;
    prices =
      typeof market.outcomePrices === "string"
        ? JSON.parse(market.outcomePrices)
        : market.outcomePrices;
  } catch (e) {
    logToConsole(`[ERR] Error decoding outcomes token list: ${e.message}`);
    return;
  }

  if (!clobTokenIds || clobTokenIds.length === 0) {
    logToConsole(`[ERR] Selected market lacks active orderbook tokens.`);
    alert(
      "This market doesn't support orderbook trading (clobTokenIds is empty). Try another one!",
    );
    return;
  }

  logToConsole(`[SYS] Activating market: "${market.question}"`);

  // Set UI labels
  document.getElementById("active-ticker-label").textContent =
    `TICKER: ${market.slug}`;
  document.getElementById("market-question").textContent = market.question;
  document.getElementById("market-slug").textContent = market.slug;
  document.getElementById("market-condition-id").textContent =
    market.conditionId;

  // Set dates
  let endStr = "N/A";
  if (market.endDate) {
    const dateObj = new Date(market.endDate);
    endStr = dateObj.toLocaleDateString();
  }
  document.getElementById("market-end-date").textContent = endStr;

  // Set Volume metrics
  totalVolValue = parseFloat(market.volume) || 0;
  document.getElementById("market-volume").textContent =
    formatUSD(totalVolValue);
  document.getElementById("market-volume-24h").textContent = formatUSD(
    market.volume24hr || 0,
  );
  document.getElementById("market-liquidity").textContent = formatUSD(
    market.liquidity || 0,
  );

  // Reset monitored Session metrics
  sessionVolValue = 0;
  sessionTradesCount = 0;
  document.getElementById("session-volume").textContent = "$0.00";
  document.getElementById("session-trades-count").textContent =
    "0 TRADES MONITORED";

  // Reset trade speed
  tradeTimestamps.length = 0;
  document.getElementById("trade-speed-indicator").textContent =
    "0.0 TRADES/MIN";

  // Map tokens
  tokenMap = {};
  const outcomesContainer = document.getElementById("outcomes-container");
  outcomesContainer.innerHTML = "";

  clobTokenIds.forEach((tokenId, idx) => {
    const outcomeName = outcomes[idx] || `OUTCOME ${idx + 1}`;
    const initialPrice = parseFloat(prices[idx]) || 0;

    tokenMap[tokenId] = {
      name: outcomeName,
      price: initialPrice,
    };

    // Add outcome card
    const card = document.createElement("div");
    card.className = "outcome-card";
    card.setAttribute("data-token-id", tokenId);
    card.innerHTML = `
            <div class="outcome-name">${outcomeName}</div>
            <div class="outcome-price-wrapper">
                <div class="outcome-price">
                    $<span class="outcome-price-val">${initialPrice.toFixed(3)}</span>
                    <span class="outcome-price-cents">(${(initialPrice * 100).toFixed(1)}¢)</span>
                </div>
                <div class="outcome-direction"></div>
            </div>
        `;
    outcomesContainer.appendChild(card);
  });

  // Check if BTC 5m up/down market to fetch Target Price
  if (market.slug.startsWith("btc-updown-5m-")) {
    // Fallback: Parse target price from question text immediately
    if (market.question) {
      const match = market.question.match(/\$([0-9,.]+)/);
      if (match) {
        const parsedPrice = parseFloat(match[1].replace(/,/g, ""));
        if (!isNaN(parsedPrice) && parsedPrice > 0) {
          targetBtcPrice = parsedPrice;
          const btcTargetPriceEl = document.getElementById("btc-target-price");
          if (btcTargetPriceEl) {
            btcTargetPriceEl.textContent = formatUSD(targetBtcPrice);
          }
          logToConsole(
            `[SYS] Parsed target price from question: ${formatUSD(targetBtcPrice)}`,
          );
          drawBtcTargetPriceLine();
        }
      }
    }

    const parts = market.slug.split("-");
    const timestamp = parseInt(parts[parts.length - 1]);
    if (!isNaN(timestamp)) {
      fetchBtcTargetPrice(timestamp);
    }

    // Show BTC indicators
    document.getElementById("btc-indicators-bar").style.display = "flex";
    document.getElementById("chart-overlay-indicators").style.display = "flex";
  } else {
    // Hide BTC indicators
    document.getElementById("btc-indicators-bar").style.display = "none";
    document.getElementById("chart-overlay-indicators").style.display = "none";
    targetBtcPrice = 0;
    if (btcSeries && btcTargetPriceLine) {
      btcSeries.removePriceLine(btcTargetPriceLine);
      btcTargetPriceLine = null;
    }
  }

  // Refresh indicator recommendation signals
  if (typeof recalculateIndicators === "function") {
    recalculateIndicators();
  }

  // Establish WebSocket Connection for trades ledger
  connectWebSocket(clobTokenIds, market.id);
}

// WebSocket Connection Management
function connectWebSocket(clobTokenIds, marketId) {
  if (ws) {
    ws.close();
  }
  clearTimeout(reconnectTimeout);
  clearInterval(heartbeatInterval);

  // Reset Trades Table Body
  const tbody = document.getElementById("trades-tbody");
  tbody.innerHTML =
    '<tr id="no-trades-row"><td colspan="6" class="no-data-msg">CONNECTING TO SECURE CLOB DATA FEED...</td></tr>';

  logToConsole(`[SYS] Initializing CLOB websocket stream...`);

  ws = new WebSocket("wss://ws-subscriptions-clob.polymarket.com/ws/market");

  ws.onopen = () => {
    logToConsole(`[SYS] Feed connected. Sending subscription message...`);
    const subPayload = {
      type: "market",
      assets_ids: clobTokenIds,
      custom_feature_enabled: true,
    };
    ws.send(JSON.stringify(subPayload));

    // Update statuses
    connectionStatus.textContent = "WS: CONNECTED";
    connectionStatus.className = "status-indicator online";
    feedStatus.textContent = "ACTIVE";
    feedStatus.className = "feed-status active";

    tbody.innerHTML =
      '<tr id="no-trades-row"><td colspan="6" class="no-data-msg">WAITING FOR LIVE DATA FEED TRANSACTION INGESTION...</td></tr>';

    // Setup PING heartbeat frames every 10 seconds
    heartbeatInterval = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send("PING");
      }
    }, 10000);
  };

  ws.onmessage = (event) => {
    if (event.data === "PONG") {
      return; // heartbeat loop
    }

    try {
      const data = JSON.parse(event.data);
      if (data.event_type === "last_trade_price") {
        processTradeEvent(data);
      }
    } catch (e) {
      // ignore non-json notifications
    }
  };

  ws.onerror = (err) => {
    logToConsole(`[ERR] Websocket connection error.`);
  };

  ws.onclose = () => {
    logToConsole(`[SYS] WebSocket feed closed.`);
    connectionStatus.textContent = "WS: DISCONNECTED";
    connectionStatus.className = "status-indicator offline";
    feedStatus.textContent = "SUSPENDED";
    feedStatus.className = "feed-status inactive";

    clearInterval(heartbeatInterval);

    // Attempt reconnection if active market remains loaded
    if (activeMarket && activeMarket.id === marketId) {
      logToConsole(`[SYS] Attempting automatic reconnection in 3 seconds...`);
      reconnectTimeout = setTimeout(() => {
        connectWebSocket(clobTokenIds, marketId);
      }, 3000);
    }
  };
}

// Process Trade Frame Ingestion
function processTradeEvent(trade) {
  const tokenObj = tokenMap[trade.asset_id];
  if (!tokenObj) return; // ignore events not related to active outcomes

  const outcomeName = tokenObj.name;
  const oldPrice = parseFloat(tokenObj.price);
  const newPrice = parseFloat(trade.price);
  const size = parseFloat(trade.size);
  const totalCost = newPrice * size;

  // Update live metrics values
  sessionVolValue += totalCost;
  sessionTradesCount++;
  totalVolValue += totalCost;

  // Update UI numbers
  document.getElementById("session-volume").textContent =
    formatUSD(sessionVolValue);
  document.getElementById("session-trades-count").textContent =
    `${sessionTradesCount} TRADES MONITORED`;
  document.getElementById("market-volume").textContent =
    formatUSD(totalVolValue);

  // Update active prices in registry (only for non-BTC 5m markets, since BTC 5m markets are priced in real-time by the BTC tick pricing model)
  const isBtcUpDown =
    activeMarket &&
    activeMarket.slug &&
    activeMarket.slug.startsWith("btc-updown-5m-");
  if (!isBtcUpDown) {
    tokenObj.price = newPrice;
    updateOutcomePriceCard(trade.asset_id, newPrice, oldPrice);
  }

  // Parse time
  let timeStr = "--:--:--";
  if (trade.timestamp) {
    const d = new Date(parseInt(trade.timestamp));
    timeStr = d.toTimeString().split(" ")[0];
  } else {
    timeStr = new Date().toTimeString().split(" ")[0];
  }

  // Log row
  appendTradeRow({
    timestamp: timeStr,
    outcome: outcomeName,
    side: trade.side,
    price: newPrice,
    size: size,
    total: totalCost,
  });

  // Run trade metrics calculations
  tradeTimestamps.push(Date.now());
  updateTradeSpeedDisplay();

  // Synthesize beep
  playTradeBeep(trade.side, newPrice);

  // Update paper trading UI on live price changes
  if (paperTradingEnabled && paperActivePosition) {
    updatePaperTradingUI();
  }
  if (realTradingEnabled || realActivePosition) {
    updateRealTradingUI();
  }
}

// Update card UI values and flicker indicators
function updateOutcomePriceCard(tokenId, newPrice, oldPrice) {
  const card = document.querySelector(
    `.outcome-card[data-token-id="${tokenId}"]`,
  );
  if (!card) return;

  const priceValEl = card.querySelector(".outcome-price-val");
  if (priceValEl) {
    priceValEl.textContent = newPrice.toFixed(3);
  }

  const centsEl = card.querySelector(".outcome-price-cents");
  if (centsEl) {
    centsEl.textContent = `(${(newPrice * 100).toFixed(1)}¢)`;
  }

  const directionEl = card.querySelector(".outcome-direction");
  if (directionEl && !isNaN(oldPrice) && newPrice !== oldPrice) {
    const isUp = newPrice > oldPrice;

    if (isUp) {
      card.classList.remove("card-flash-down");
      void card.offsetWidth; // Reflow to reset CSS transition cues
      card.classList.add("card-flash-up");
    } else {
      card.classList.remove("card-flash-up");
      void card.offsetWidth;
      card.classList.add("card-flash-down");
    }

    if (activeMarket && activeMarket.slug.startsWith("btc-updown-5m-")) {
      if (typeof recalculateIndicators === "function") {
        recalculateIndicators();
      }
    } else {
      directionEl.textContent = isUp ? "▲" : "▼";
      directionEl.className = isUp
        ? "outcome-direction up"
        : "outcome-direction down";
    }
  }
}

// Render row inside layout
function appendTradeRow(trade) {
  const tbody = document.getElementById("trades-tbody");
  const noTradesRow = document.getElementById("no-trades-row");
  if (noTradesRow) {
    noTradesRow.remove();
  }

  const tr = document.createElement("tr");
  tr.className =
    trade.side === "BUY" ? "buy-row flash-buy" : "sell-row flash-sell";
  tr.innerHTML = `
        <td>${trade.timestamp}</td>
        <td class="text-white" style="font-weight: 600;">${trade.outcome}</td>
        <td>${trade.side}</td>
        <td class="${trade.side === "BUY" ? "text-green" : "text-red"}">$${trade.price.toFixed(3)}</td>
        <td>${trade.size.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })}</td>
        <td class="text-white" style="font-weight: 600;">$${trade.total.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
    `;

  tbody.insertBefore(tr, tbody.firstChild);

  // limit DOM layout buffer to 15 items
  if (tbody.children.length > 15) {
    tbody.removeChild(tbody.lastChild);
  }
}

// Compute frequency metrics (Trades per minute)
function updateTradeSpeedDisplay() {
  const now = Date.now();
  // remove frames older than 60s
  while (tradeTimestamps.length > 0 && tradeTimestamps[0] < now - 60000) {
    tradeTimestamps.shift();
  }
  const speed = tradeTimestamps.length;
  document.getElementById("trade-speed-indicator").textContent =
    `${speed.toFixed(1)} TRADES/MIN`;
}

// Decay trade speed over time if inactive
clearInterval(speedDecayInterval);
speedDecayInterval = setInterval(updateTradeSpeedDisplay, 2500);

// Search Query Processing
async function executeSearch(query) {
  if (!query) return;

  const slug = parseInputSlug(query);
  logToConsole(`[SYS] Initiating search lookup for slug/term: "${slug}"`);

  // Show spinner status in input bar
  commandInput.disabled = true;
  searchBtn.disabled = true;
  commandInput.placeholder =
    "LOOKING UP TICKER DETAILS FROM POLYMARKET... PLEASE WAIT";

  try {
    // Fallback approach:
    // 1. Try direct slug lookup
    let directUrl = `https://gamma-api.polymarket.com/markets/slug/${slug}`;
    let response = await fetch(directUrl);

    if (response.status === 200) {
      const market = await response.json();
      if (market && market.id && market.clobTokenIds) {
        logToConsole(`[SYS] Direct match found for slug: "${slug}"`);
        loadMarket(market);
        searchResultsPanel.classList.add("hidden");
        resetCommandBar();
        return;
      }
    }

    // 2. If direct lookup fails, execute search endpoint query
    logToConsole(
      `[SYS] Direct slug check returned negative. Running search query...`,
    );
    let searchUrl = `https://gamma-api.polymarket.com/public-search?q=${encodeURIComponent(slug)}`;
    let searchResponse = await fetch(searchUrl);
    if (searchResponse.ok) {
      const data = await searchResponse.json();
      if (data && data.events && data.events.length > 0) {
        renderSearchResults(data.events);
        return;
      }
    }

    logToConsole(`[ERR] Zero market results found matching query "${slug}".`);
    alert(
      `No markets found on Polymarket matching: "${slug}". Ensure it is an active ticker slug.`,
    );
  } catch (err) {
    logToConsole(`[ERR] Network error occurred during search: ${err.message}`);
    alert(`Network error fetching from Polymarket: ${err.message}`);
  } finally {
    resetCommandBar();
  }
}

function resetCommandBar() {
  commandInput.disabled = false;
  searchBtn.disabled = false;
  commandInput.placeholder =
    "ENTER SLUG, KEYWORD, OR POLYMARKET URL (e.g. trump-out-as-president-by-june-30) AND PRESS ENTER";
  commandInput.value = "";
}

// Render list of matching markets in overlay
function renderSearchResults(events) {
  resultsListContainer.innerHTML = "";
  let matchesCount = 0;

  events.forEach((evt) => {
    if (!evt.markets) return;

    evt.markets.forEach((m) => {
      matchesCount++;

      // Format volume
      const vol = parseFloat(m.volume) || 0;
      const volStr =
        vol > 1000000
          ? `$${(vol / 1000000).toFixed(2)}M`
          : vol > 1000
            ? `$${(vol / 1000).toFixed(1)}k`
            : `$${vol.toFixed(0)}`;

      let endStr = "N/A";
      if (m.endDate) {
        endStr = new Date(m.endDate).toLocaleDateString();
      }

      // Determine active tags
      const isActive = m.active && !m.closed;
      const statusLabel = isActive ? "ACTIVE" : "CLOSED";
      const statusClass = isActive ? "text-green" : "text-muted";

      const resultItem = document.createElement("div");
      resultItem.className = "result-item";
      resultItem.innerHTML = `
                <div class="result-details">
                    <div class="result-question">${m.question}</div>
                    <div class="result-meta">
                        Event: <span class="text-white">${evt.title}</span> | Status: <span class="${statusClass}">${statusLabel}</span>
                    </div>
                </div>
                <div class="result-right">
                    <span class="result-vol">${volStr} Vol</span>
                    <span class="result-date">Ends: ${endStr}</span>
                </div>
            `;

      resultItem.addEventListener("click", () => {
        loadMarket(m);
        searchResultsPanel.classList.add("hidden");
      });

      resultsListContainer.appendChild(resultItem);
    });
  });

  if (matchesCount > 0) {
    logToConsole(
      `[SYS] Search returned ${matchesCount} potential outcome listings.`,
    );
    searchResultsPanel.classList.remove("hidden");
  } else {
    logToConsole(`[ERR] Zero matching markets under returned search events.`);
    alert("Search found events, but no tradable outcome markets. Try again!");
  }
}

// Input and Event Bindings
commandInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    executeSearch(commandInput.value);
  }
});

searchBtn.addEventListener("click", () => {
  executeSearch(commandInput.value);
});

closeResultsBtn.addEventListener("click", () => {
  searchResultsPanel.classList.add("hidden");
});

// Dynamic BTC updown default market logic
const fallbackDefaultMarket = {
  id: "2364223",
  question: "Will the Salvator Mundi be publicly exhibited by December 31?",
  conditionId:
    "0xc1a4d849c111db38b26f43a7f8399866b65be7e15c07341e2a72860dd654f91f",
  slug: "will-the-salvator-mundi-be-publicly-exhibited-by-december-31",
  endDate: "2026-12-31T00:00:00Z",
  volume: "245.696992",
  volume24hr: "4.50877",
  liquidity: "156.6923",
  clobTokenIds:
    '["6482365015474175966883576909979562601253407370662079271183192917571184552615", "16392540448669304113952228137955108916849684603263830158190223249603940824402"]',
  outcomes: '["Yes", "No"]',
  outcomePrices: '["0.31", "0.69"]',
};

async function loadDefaultBtcMarket() {
  const nowSecs = Math.floor(Date.now() / 1000);
  const intervalSecs = 300;

  let targetTimestamp = 0;
  if (lastExpiredTimestamp > 0) {
    // Safe transition: target the block starting exactly when the previous expired ends
    targetTimestamp = lastExpiredTimestamp;
  } else {
    // Startup mode: target the currently active trading block (floor rounding)
    targetTimestamp = Math.floor(nowSecs / intervalSecs) * intervalSecs;
  }

  const slug = `btc-updown-5m-${targetTimestamp}`;
  logToConsole(`[SYS] Dynamically loading BTC 5m interval: "${slug}"`);

  try {
    let directUrl = `https://gamma-api.polymarket.com/markets/slug/${slug}`;
    let response = await fetch(directUrl);
    if (response.status === 200) {
      const market = await response.json();
      if (market && market.id && market.clobTokenIds) {
        // Safeguard: Check if this market has already resolved in real-world time
        const marketEndDateSecs = Math.floor(
          new Date(market.endDate).getTime() / 1000,
        );
        if (nowSecs >= marketEndDateSecs) {
          logToConsole(
            `[SYS] Market "${slug}" is already expired. Transitioning to next interval...`,
          );
          lastExpiredTimestamp = marketEndDateSecs;
          setTimeout(loadDefaultBtcMarket, 500);
          return;
        }

        // Clear expired trackers on success and load
        lastExpiredTimestamp = 0;
        loadMarket(market);
        return;
      }
    }
  } catch (e) {
    logToConsole(`[ERR] Failed to load dynamic BTC 5m market: ${e.message}`);
  }

  // Retrying or loading fallbacks
  if (!activeMarket || activeMarket.slug === "btc-updown-5m-transitioning") {
    logToConsole(`[SYS] Dynamic BTC fetch failed. Retrying in 5 seconds...`);
    setTimeout(loadDefaultBtcMarket, 5000);
  }
}

let btcTargetPriceLine = null;

// Binance WebSocket connection for live BTC price trade ticks
function connectBinanceWebSocket() {
  if (btcWs) {
    btcWs.close();
  }
  btcWs = new WebSocket("wss://stream.binance.com:9443/ws/btcusdt@trade");

  btcWs.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.e === "trade") {
        const price = parseFloat(data.p);
        const quantity = parseFloat(data.q);
        const timestamp = parseInt(data.T);
        updateLiveBtcPrice(price, quantity, timestamp);
      }
    } catch (e) {
      console.error("Error parsing Binance WS message:", e);
    }
  };

  btcWs.onclose = () => {
    setTimeout(connectBinanceWebSocket, 3000);
  };
}

// Draw target price line in TradingView chart helper
function drawBtcTargetPriceLine() {
  if (btcSeries && targetBtcPrice > 0) {
    if (btcTargetPriceLine) {
      btcSeries.removePriceLine(btcTargetPriceLine);
    }
    btcTargetPriceLine = btcSeries.createPriceLine({
      price: targetBtcPrice,
      color: "#f59e0b",
      lineWidth: 2,
      lineStyle: LightweightCharts.LineStyle.Dashed,
      axisLabelVisible: true,
      title: "TARGET",
    });
  }
}

// Fetch Target Price from Binance Kline API with retry mechanism
async function fetchBtcTargetPrice(startTimestampSecs, retries = 5) {
  try {
    const startTimestampMs = startTimestampSecs * 1000;
    const url = `https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=5m&startTime=${startTimestampMs}&limit=1`;
    const response = await fetch(url);
    if (response.ok) {
      const klines = await response.json();
      if (klines && klines.length > 0) {
        targetBtcPrice = parseFloat(klines[0][1]); // Index 1 is Open price
        document.getElementById("btc-target-price").textContent =
          formatUSD(targetBtcPrice);
        logToConsole(
          `[SYS] Fetched BTC Target Price for interval: ${formatUSD(targetBtcPrice)}`,
        );

        drawBtcTargetPriceLine();

        updateLiveBtcPrice(currentBtcPrice, 0, Date.now()); // refresh diff and display
        return;
      }
    }
  } catch (e) {
    logToConsole(`[ERR] Failed to fetch BTC target price: ${e.message}`);
  }

  if (retries > 0) {
    logToConsole(
      `[SYS] BTC target price not available yet. Retrying in 1.5s... (${retries} attempts left)`,
    );
    setTimeout(
      () => fetchBtcTargetPrice(startTimestampSecs, retries - 1),
      1500,
    );
    return;
  }

  // Only set to 0 if we don't have a parsed target price fallback
  if (!targetBtcPrice || targetBtcPrice <= 0) {
    targetBtcPrice = 0;
    if (btcSeries && btcTargetPriceLine) {
      btcSeries.removePriceLine(btcTargetPriceLine);
      btcTargetPriceLine = null;
    }
  } else {
    logToConsole(
      `[SYS] Keep parsed fallback target price: ${formatUSD(targetBtcPrice)}`,
    );
    drawBtcTargetPriceLine();
  }
}

// Fetch last 300 1-second candles from Binance to pre-populate chart
async function fetchBtcPriceHistory() {
  try {
    const url = `https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1s&limit=300`;
    const response = await fetch(url);
    if (response.ok) {
      const klines = await response.json();
      if (klines && klines.length > 0) {
        const candleData = klines.map((k) => ({
          time: Math.floor(k[0] / 1000), // convert ms to seconds
          open: parseFloat(k[1]),
          high: parseFloat(k[2]),
          low: parseFloat(k[3]),
          close: parseFloat(k[4]),
          volume: parseFloat(k[5]),
        }));

        btcHistoryData.length = 0;
        btcHistoryData.push(...candleData);

        if (btcSeries) {
          btcSeries.setData(candleData);
        }

        if (btcVolumeSeries) {
          const volumeData = candleData.map((c) => ({
            time: c.time,
            value: c.volume || 0,
            color: c.close >= c.open ? "#26a69a" : "#ef5350",
          }));
          btcVolumeSeries.setData(volumeData);
        }

        // Calculate and plot historical VWAP
        let cumPV = 0;
        let cumV = 0;
        const vwapData = candleData.map((c) => {
          const typicalPrice = (c.open + c.high + c.low + c.close) / 4;
          const vol = c.volume || 0;
          cumPV += typicalPrice * vol;
          cumV += vol;
          return {
            time: c.time,
            value: cumV > 0 ? cumPV / cumV : c.close,
          };
        });
        if (vwapSeries) {
          vwapSeries.setData(vwapData);
        }

        // Initialize current BTC candle to the last loaded historical candle
        const lastK = candleData[candleData.length - 1];
        currentBtcCandle = {
          time: lastK.time,
          open: lastK.open,
          high: lastK.high,
          low: lastK.low,
          close: lastK.close,
          volume: lastK.volume || 0,
        };

        logToConsole(
          `[SYS] Pre-populated BTC chart with ${candleData.length} historical 1s candles.`,
        );

        recalculateIndicators();
        return;
      }
    }
  } catch (e) {
    logToConsole(`[ERR] Failed to fetch BTC price history: ${e.message}`);
  }
}

// Indicator Calculation Helpers
function calculateRSI(candles, period = 14) {
  if (candles.length < period + 1) return 50;

  let gains = [];
  let losses = [];
  for (let i = 1; i < candles.length; i++) {
    const change = candles[i].close - candles[i - 1].close;
    gains.push(change > 0 ? change : 0);
    losses.push(change < 0 ? -change : 0);
  }

  let avgGain = gains.slice(0, period).reduce((a, b) => a + b, 0) / period;
  let avgLoss = losses.slice(0, period).reduce((a, b) => a + b, 0) / period;

  for (let i = period; i < gains.length; i++) {
    avgGain = (avgGain * (period - 1) + gains[i]) / period;
    avgLoss = (avgLoss * (period - 1) + losses[i]) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function calculateATR(candles, period = 14) {
  if (candles.length < period + 1) return 0;

  let trs = [];
  for (let i = 1; i < candles.length; i++) {
    const h_l = candles[i].high - candles[i].low;
    const h_pc = Math.abs(candles[i].high - candles[i - 1].close);
    const l_pc = Math.abs(candles[i].low - candles[i - 1].close);
    trs.push(Math.max(h_l, h_pc, l_pc));
  }

  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
  }
  return atr;
}

function calculateVWAP(candles) {
  let sumPV = 0;
  let sumV = 0;
  candles.forEach((c) => {
    const typicalPrice = (c.high + c.low + c.close) / 3;
    const vol = c.volume || 0;
    sumPV += typicalPrice * vol;
    sumV += vol;
  });
  return sumV > 0 ? sumPV / sumV : currentBtcPrice;
}

// High-precision Normal CDF approximation
function normalCDF(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.39894228 * Math.exp((-z * z) / 2);
  const p =
    d *
    t *
    (0.31938153 +
      t *
        (-0.356563782 +
          t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z > 0 ? 1 - p : p;
}

// Estimate the YES/NO token prices in real-time based on BTC price distance from target
function estimateRealtimeOutcomePrices() {
  if (
    !activeMarket ||
    !activeMarket.slug ||
    !activeMarket.slug.startsWith("btc-updown-5m-") ||
    targetBtcPrice <= 0 ||
    btcHistoryData.length < 15
  ) {
    return;
  }

  const now = new Date();
  const nowSecs = Math.floor(now.getTime() / 1000);
  const marketEndDateSecs = Math.floor(
    new Date(activeMarket.endDate).getTime() / 1000,
  );
  const timeLeftSecs = Math.max(1, marketEndDateSecs - nowSecs);

  const diff = currentBtcPrice - targetBtcPrice;
  const atr = calculateATR(btcHistoryData, 14) || 2.0;
  const stdDev = atr * Math.sqrt(timeLeftSecs);

  const z = diff / (stdDev > 0 ? stdDev : 1.0);
  let yesPrice = normalCDF(z);

  yesPrice = Math.max(0.01, Math.min(0.99, yesPrice));
  const noPrice = 1.0 - yesPrice;

  const tokenIds = Object.keys(tokenMap);
  tokenIds.forEach((tokenId, idx) => {
    const token = tokenMap[tokenId];
    const lowerName = token.name.toLowerCase();
    const oldPrice = token.price;
    let newPrice = oldPrice;

    const isYes = lowerName === "yes" || idx === 0;
    const isNo = lowerName === "no" || idx === 1;

    if (isYes) {
      newPrice = yesPrice;
    } else if (isNo) {
      newPrice = noPrice;
    }

    if (newPrice !== oldPrice) {
      token.price = newPrice;
      updateOutcomePriceCard(tokenId, newPrice, oldPrice);
    }
  });
}

function recalculateIndicators() {
  if (btcHistoryData.length < 15) return;

  const rsi = calculateRSI(btcHistoryData, 14);
  const atr = calculateATR(btcHistoryData, 14);
  const vwap = calculateVWAP(btcHistoryData);

  // Update floating overlay texts
  document.getElementById("btc-rsi-val").textContent = rsi.toFixed(1);
  document.getElementById("btc-atr-val").textContent = formatUSD(atr);
  document.getElementById("btc-vwap-val").textContent = formatUSD(vwap);

  const rsiEl = document.getElementById("btc-rsi-val");
  if (rsi >= 70) {
    rsiEl.className = "text-red";
  } else if (rsi <= 30) {
    rsiEl.className = "text-green";
  } else {
    rsiEl.className = "text-white";
  }

  const signalEl = document.getElementById("btc-signal-val");
  let decision = "NEUTRAL";
  let decisionClass = "text-amber";

  const isBtcUpDown =
    activeMarket && activeMarket.slug.startsWith("btc-updown-5m-");

  if (isBtcUpDown) {
    const atrVal = atr || 2.0;
    const bullishSignals =
      (rsi > 53 ? 1 : 0) + (currentBtcPrice > vwap ? 1 : 0);
    const bearishSignals =
      (rsi < 47 ? 1 : 0) + (currentBtcPrice < vwap ? 1 : 0);

    let candidateDecision = "NEUTRAL";

    if (bullishSignals >= 2) {
      candidateDecision = "BUY YES (UP)";
    } else if (bearishSignals >= 2) {
      candidateDecision = "BUY NO (DOWN)";
    } else if (rsi > 58) {
      candidateDecision = "BUY YES (UP)";
    } else if (rsi < 42) {
      candidateDecision = "BUY NO (DOWN)";
    }

    // Trend filters to avoid false counter-trend signals
    let blockYes = false;
    let blockNo = false;

    // Calculate YES/NO probabilities based on normal CDF distance scaling
    let yesProbability = 0.5;
    let noProbability = 0.5;
    if (targetBtcPrice > 0 && activeMarket && activeMarket.endDate) {
      const now = Date.now();
      const marketEndDateSecs = Math.floor(
        new Date(activeMarket.endDate).getTime() / 1000,
      );
      const timeLeftSecs = Math.max(
        1,
        marketEndDateSecs - Math.floor(now / 1000),
      );
      const diff = currentBtcPrice - targetBtcPrice;
      const atrValCalculated = atr || 2.0;
      const stdDev = atrValCalculated * Math.sqrt(timeLeftSecs);
      const z = diff / (stdDev > 0 ? stdDev : 1.0);
      yesProbability = normalCDF(z);
      noProbability = 1.0 - yesProbability;
    }

    // Filter A: Distance from target price (adaptive strike boundary)
    if (targetBtcPrice > 0) {
      const targetDistance = currentBtcPrice - targetBtcPrice;
      const distanceThreshold = Math.min(50.0, Math.max(15.0, 6 * atrVal));

      if (targetDistance > distanceThreshold) {
        blockNo = true; // Price is significantly above target, block DOWN (NO) entries
      } else if (targetDistance < -distanceThreshold) {
        blockYes = true; // Price is significantly below target, block UP (YES) entries
      }
    }

    // Filter B: Medium-term trend (last 30 seconds close price comparison)
    const lookback = Math.min(30, btcHistoryData.length);
    if (lookback >= 10) {
      const oldPrice = btcHistoryData[btcHistoryData.length - lookback].close;
      const priceChange = currentBtcPrice - oldPrice;
      const trendThreshold = 5 * atrVal;

      if (priceChange > trendThreshold) {
        blockNo = true; // Price rose significantly, block DOWN (NO) entries
      } else if (priceChange < -trendThreshold) {
        blockYes = true; // Price fell significantly, block UP (YES) entries
      }
    }

    // Filter C: Macro-term trend (last 120 seconds close price comparison)
    const macroLookback = Math.min(120, btcHistoryData.length);
    if (macroLookback >= 30) {
      const oldPriceMacro =
        btcHistoryData[btcHistoryData.length - macroLookback].close;
      const priceChangeMacro = currentBtcPrice - oldPriceMacro;
      const macroThreshold = Math.max(25.0, 10 * atrVal); // at least $25.00 movement

      if (priceChangeMacro > macroThreshold) {
        blockNo = true; // Price rose significantly over macro window, block DOWN (NO)
      } else if (priceChangeMacro < -macroThreshold) {
        blockYes = true; // Price fell significantly over macro window, block UP (YES)
      }
    }

    // Filter D: Probability/Pricing safety block (win expectancy threshold)
    if (yesProbability > 0.75) {
      blockNo = true; // YES is highly likely, block NO (DOWN) entries
    } else if (noProbability > 0.75) {
      blockYes = true; // NO is highly likely, block YES (UP) entries
    }

    // Apply filters to candidate decision with verbose logging
    let blockReason = "";
    if (candidateDecision === "BUY YES (UP)") {
      if (blockYes) {
        decision = "NEUTRAL";
        decisionClass = "text-amber";

        // Determine block reason for logging
        if (
          targetBtcPrice > 0 &&
          currentBtcPrice - targetBtcPrice <
            -Math.min(50.0, Math.max(15.0, 6 * atrVal))
        ) {
          blockReason = `Price is too far below target ($${(currentBtcPrice - targetBtcPrice).toFixed(2)})`;
        } else if (noProbability > 0.75) {
          blockReason = `NO probability is too high (${(noProbability * 100).toFixed(1)}%)`;
        } else {
          blockReason = `downtrend momentum`;
        }

        if (lastBlockedLogType !== "UP_BLOCKED_" + blockReason) {
          logToConsole(`[SIGNAL] UP entry blocked: ${blockReason}.`);
          lastBlockedLogType = "UP_BLOCKED_" + blockReason;
        }
      } else {
        decision = "BUY YES (UP)";
        decisionClass = "text-green";
        lastBlockedLogType = "NONE";
      }
    } else if (candidateDecision === "BUY NO (DOWN)") {
      if (blockNo) {
        decision = "NEUTRAL";
        decisionClass = "text-amber";

        // Determine block reason for logging
        if (
          targetBtcPrice > 0 &&
          currentBtcPrice - targetBtcPrice >
            Math.min(50.0, Math.max(15.0, 6 * atrVal))
        ) {
          blockReason = `Price is too far above target (+$${(currentBtcPrice - targetBtcPrice).toFixed(2)})`;
        } else if (yesProbability > 0.75) {
          blockReason = `YES probability is too high (${(yesProbability * 100).toFixed(1)}%)`;
        } else {
          blockReason = `uptrend momentum`;
        }

        if (lastBlockedLogType !== "DOWN_BLOCKED_" + blockReason) {
          logToConsole(`[SIGNAL] DOWN entry blocked: ${blockReason}.`);
          lastBlockedLogType = "DOWN_BLOCKED_" + blockReason;
        }
      } else {
        decision = "BUY NO (DOWN)";
        decisionClass = "text-red";
        lastBlockedLogType = "NONE";
      }
    } else {
      decision = "NEUTRAL";
      decisionClass = "text-amber";
      lastBlockedLogType = "NONE";
    }

    signalEl.textContent = decision;
    signalEl.className = decisionClass;
    currentRecommendation = decision;

    const signalBarEl = document.getElementById("btc-signal-bar");
    const headerBadgeEl = document.getElementById("header-signal-badge");

    if (signalBarEl) {
      signalBarEl.textContent = decision;
      signalBarEl.className = decisionClass;
    }

    if (headerBadgeEl) {
      headerBadgeEl.style.display = "inline-block";
      headerBadgeEl.textContent = decision;
      headerBadgeEl.classList.remove("neutral", "buy-yes", "buy-no");
      if (decision.includes("YES")) {
        headerBadgeEl.classList.add("buy-yes");
      } else if (decision.includes("NO")) {
        headerBadgeEl.classList.add("buy-no");
      } else {
        headerBadgeEl.classList.add("neutral");
      }
    }
  } else {
    signalEl.textContent = "N/A (NOT BTC MARKET)";
    signalEl.className = "text-muted";
    currentRecommendation = "NEUTRAL";

    const signalBarEl = document.getElementById("btc-signal-bar");
    const headerBadgeEl = document.getElementById("header-signal-badge");
    if (signalBarEl) {
      signalBarEl.textContent = "N/A";
      signalBarEl.className = "text-muted";
    }
    if (headerBadgeEl) {
      headerBadgeEl.style.display = "none";
    }
  }

  // Update YES/NO outcome cards borders and display BUY indicator text
  const cards = document.querySelectorAll(".outcome-card");
  cards.forEach((card) => {
    const nameEl = card.querySelector(".outcome-name");
    if (!nameEl) return;
    const name = nameEl.textContent.trim().toLowerCase();

    const directionEl = card.querySelector(".outcome-direction");
    if (!directionEl) return;

    // Reset custom styles first
    card.style.borderColor = "var(--bb-border)";
    card.style.boxShadow = "none";

    if (isBtcUpDown) {
      const isYes = name === "yes";
      const isNo = name === "no";

      const isBullish = decision.includes("BUY YES");
      const isBearish = decision.includes("BUY NO");

      if (isBullish) {
        if (isYes) {
          directionEl.textContent = "BUY ▲";
          directionEl.className = "outcome-direction up";
          card.style.borderColor = "var(--bb-green)";
          card.style.boxShadow = "0 0 8px rgba(16, 185, 129, 0.2)";
        } else {
          directionEl.textContent = "—";
          directionEl.className = "outcome-direction";
        }
      } else if (isBearish) {
        if (isNo) {
          directionEl.textContent = "BUY ▲";
          directionEl.className = "outcome-direction up";
          card.style.borderColor = "var(--bb-green)";
          card.style.boxShadow = "0 0 8px rgba(16, 185, 129, 0.2)";
        } else {
          directionEl.textContent = "—";
          directionEl.className = "outcome-direction";
        }
      } else {
        directionEl.textContent = "—";
        directionEl.className = "outcome-direction";
      }
    }
  });

  // Trigger automated trading logic with a 1-second delay to filter out transient signal noise
  if (paperTradingEnabled || realTradingEnabled) {
    if (decision !== lastSignalDecision) {
      clearTimeout(signalDelayTimeout);
      lastSignalDecision = decision;

      if (decision !== "NEUTRAL") {
        logToConsole(
          `[SYS] Signal detected: ${decision}. Verifying signal stability for 1s...`,
        );
      }

      // Queue trade execution 1 second later
      signalDelayTimeout = setTimeout(() => {
        if (paperTradingEnabled) {
          checkAndExecutePaperTrades(decision);
          updatePaperTradingUI();
        }
        if (realTradingEnabled) {
          maybeExecuteRealSignal(decision, true);
          updateRealTradingUI();
        }
      }, 1000);
    } else {
      // Signal hasn't changed. If we have a position, update P&L UI directly
      if (paperTradingEnabled) {
        updatePaperTradingUI();
      }
      if (realTradingEnabled) {
        maybeExecuteRealSignal(decision);
        updateRealTradingUI();
      }
    }
  }
}

// Paper Trading Helper Functions
function getTokenPriceByName(name) {
  const lowerName = name.toLowerCase();

  // 1. Try exact case-insensitive name matching
  for (const tokenId in tokenMap) {
    if (tokenMap[tokenId].name.toLowerCase() === lowerName) {
      return parseFloat(tokenMap[tokenId].price);
    }
  }

  // 2. Robust fallback based on token order (index 0 is YES, index 1 is NO)
  const tokenIds = Object.keys(tokenMap);
  if (lowerName === "yes" && tokenIds.length > 0) {
    return parseFloat(tokenMap[tokenIds[0]].price);
  } else if (lowerName === "no" && tokenIds.length > 1) {
    return parseFloat(tokenMap[tokenIds[1]].price);
  }

  return null;
}

function getCurrentPrice(outcomeName) {
  const price = getTokenPriceByName(outcomeName);
  return price !== null ? price : 0.5; // fallback
}

function closePaperPosition(exitPrice, reason = "TREND CHANGE") {
  if (!paperActivePosition) return;

  const pos = paperActivePosition;
  const rawRevenue = pos.qty * exitPrice;
  const feeAmount = pos.cost * (paperFeePct / 100);
  const revenue = rawRevenue - feeAmount;
  const pnl = revenue - pos.cost;

  paperTradingWallet += revenue;
  paperRealizedPnl += pnl;

  // Save cooldown details
  paperLastExitTime = Date.now();
  paperLastExitOutcome = pos.outcome;

  // Add to history
  const trade = {
    time: new Date().toTimeString().split(" ")[0],
    asset: pos.outcome,
    entryPrice: pos.entryPrice,
    exitPrice: exitPrice,
    pnl: pnl,
    reason: reason,
  };

  paperClosedTrades.unshift(trade);
  if (paperClosedTrades.length > 30) {
    paperClosedTrades.pop();
  }

  logToConsole(
    `[TRADE] Closed ${pos.outcome} at $${exitPrice.toFixed(3)} | PnL: $${pnl.toFixed(2)} USDC (${reason})`,
  );

  paperActivePosition = null;
  updatePaperTradingUI();
}

function checkAndExecutePaperTrades(decision) {
  if (!navigator.onLine) {
    logToConsole(`[ERR] Trade execution blocked: System is offline.`);
    return;
  }
  if (!paperTradingEnabled) return;
  if (!activeMarket) {
    logToConsole(`[SYS] Trade blocked: No active market loaded.`);
    return;
  }

  // Block automated trend flip exits if active position is hold-locked
  const holdTimeSecs = paperActivePosition
    ? (Date.now() - paperActivePosition.timestamp) / 1000
    : 999;
  if (holdTimeSecs < paperMinHoldSecs) {
    return;
  }

  const isBullish = decision.includes("BUY YES");
  const isBearish = decision.includes("BUY NO");

  if (!isBullish && !isBearish) {
    return; // Neutral decision, no action needed
  }

  logToConsole(
    `[SYS] checkAndExecutePaperTrades processing signal: ${decision}`,
  );

  // Check remaining time before expiration (avoid trading in the last 1 minute / 60 seconds)
  const now = Date.now();
  if (activeMarket.endDate) {
    const marketEndDateSecs = Math.floor(
      new Date(activeMarket.endDate).getTime() / 1000,
    );
    const timeLeftSecs = marketEndDateSecs - Math.floor(now / 1000);

    if (timeLeftSecs <= 60) {
      logToConsole(
        `[SYS] Skipping entry: only ${Math.max(0, timeLeftSecs)}s remaining (1m expiration lock active).`,
      );
      return;
    }
  }

  const isYesCooldown =
    paperLastExitOutcome === "YES" && now - paperLastExitTime < 10000;
  const isNoCooldown =
    paperLastExitOutcome === "NO" && now - paperLastExitTime < 10000;

  if (isBullish) {
    // If we hold NO, close it first
    if (paperActivePosition && paperActivePosition.outcome === "NO") {
      logToConsole(
        `[SYS] Signal flipped to Bullish. Closing opposite NO position.`,
      );
      closePaperPosition(getCurrentPrice("NO"), "TREND CHANGE");
    }

    // If we have an active position, we cannot buy YES (only one position at a time)
    if (paperActivePosition) {
      logToConsole(
        `[SYS] Skipping entry: already holding active position (${paperActivePosition.outcome}).`,
      );
      return;
    }

    if (isYesCooldown) {
      const cooldownLeft = Math.ceil(
        (10000 - (now - paperLastExitTime)) / 1000,
      );
      logToConsole(
        `[SYS] Skipping YES entry: system in cooldown for ${cooldownLeft}s.`,
      );
      return;
    }

    const price = getCurrentPrice("YES");
    if (price >= 0.85) {
      logToConsole(
        `[SYS] Skipping YES entry: price is too high ($${price.toFixed(3)} >= $0.85).`,
      );
      return;
    }

    if (price <= 0) {
      logToConsole(
        `[SYS] Skipping YES entry: invalid price ($${price.toFixed(3)}).`,
      );
      return;
    }

    const allocation = Math.min(paperTradeAllocationUsdc, paperTradingWallet);
    if (allocation < MIN_TRADE_COST_USDC) {
      logToConsole(
        `[SYS] Skipping YES entry: minimum trade size is $${MIN_TRADE_COST_USDC.toFixed(2)} USDC (Available: $${allocation.toFixed(2)} USDC).`,
      );
      return;
    }

    const qty = Math.floor(allocation / price);
    const cost = qty * price;
    if (qty <= 0) {
      logToConsole(
        `[SYS] Skipping YES entry: wallet balance too low to purchase 1 contract ($${price.toFixed(3)} USDC needed, Wallet: $${paperTradingWallet.toFixed(2)} USDC).`,
      );
      return;
    }
    if (cost < MIN_TRADE_COST_USDC) {
      logToConsole(
        `[SYS] Skipping YES entry: order value $${cost.toFixed(2)} is below the $${MIN_TRADE_COST_USDC.toFixed(2)} minimum.`,
      );
      return;
    }

    paperTradingWallet -= cost;
    paperActivePosition = {
      outcome: "YES",
      entryPrice: price,
      highestPnlPct: 0.0, // Initialize peak P&L percent
      qty: qty,
      cost: cost,
      timestamp: Date.now(),
    };
    logToConsole(
      `[TRADE] Bought YES (${qty} contracts) at $${price.toFixed(3)} USDC (Cost: $${cost.toFixed(2)} USDC)`,
    );
    updatePaperTradingUI();
  } else if (isBearish) {
    // If we hold YES, close it first
    if (paperActivePosition && paperActivePosition.outcome === "YES") {
      logToConsole(
        `[SYS] Signal flipped to Bearish. Closing opposite YES position.`,
      );
      closePaperPosition(getCurrentPrice("YES"), "TREND CHANGE");
    }

    // If we have an active position, we cannot buy NO
    if (paperActivePosition) {
      logToConsole(
        `[SYS] Skipping entry: already holding active position (${paperActivePosition.outcome}).`,
      );
      return;
    }

    if (isNoCooldown) {
      const cooldownLeft = Math.ceil(
        (10000 - (now - paperLastExitTime)) / 1000,
      );
      logToConsole(
        `[SYS] Skipping NO entry: system in cooldown for ${cooldownLeft}s.`,
      );
      return;
    }

    const price = getCurrentPrice("NO");
    if (price >= 0.85) {
      logToConsole(
        `[SYS] Skipping NO entry: price is too high ($${price.toFixed(3)} >= $0.85).`,
      );
      return;
    }

    if (price <= 0) {
      logToConsole(
        `[SYS] Skipping NO entry: invalid price ($${price.toFixed(3)}).`,
      );
      return;
    }

    const allocation = Math.min(paperTradeAllocationUsdc, paperTradingWallet);
    if (allocation < MIN_TRADE_COST_USDC) {
      logToConsole(
        `[SYS] Skipping NO entry: minimum trade size is $${MIN_TRADE_COST_USDC.toFixed(2)} USDC (Available: $${allocation.toFixed(2)} USDC).`,
      );
      return;
    }

    const qty = Math.floor(allocation / price);
    const cost = qty * price;
    if (qty <= 0) {
      logToConsole(
        `[SYS] Skipping NO entry: wallet balance too low to purchase 1 contract ($${price.toFixed(3)} USDC needed, Wallet: $${paperTradingWallet.toFixed(2)} USDC).`,
      );
      return;
    }
    if (cost < MIN_TRADE_COST_USDC) {
      logToConsole(
        `[SYS] Skipping NO entry: order value $${cost.toFixed(2)} is below the $${MIN_TRADE_COST_USDC.toFixed(2)} minimum.`,
      );
      return;
    }

    paperTradingWallet -= cost;
    paperActivePosition = {
      outcome: "NO",
      entryPrice: price,
      highestPnlPct: 0.0, // Initialize peak P&L percent
      qty: qty,
      cost: cost,
      timestamp: Date.now(),
    };
    logToConsole(
      `[TRADE] Bought NO (${qty} contracts) at $${price.toFixed(3)} USDC (Cost: $${cost.toFixed(2)} USDC)`,
    );
    updatePaperTradingUI();
  }
}

function updatePaperTradingUI() {
  if (!paperActivePosition) {
    // Render empty active position UI
    const activePosEl = document.getElementById("paper-active-position");
    const activePnlEl = document.getElementById("paper-active-pnl");
    if (activePosEl && activePnlEl) {
      const now = Date.now();
      const cooldownSecs = Math.max(
        0,
        Math.ceil((10000 - (now - paperLastExitTime)) / 1000),
      );

      if (cooldownSecs > 0) {
        activePosEl.innerHTML = `<span class="text-amber" style="font-weight:600;">COOLDOWN: ${cooldownSecs}s (${paperLastExitOutcome} CLOSED)</span>`;
      } else {
        activePosEl.innerHTML = `<span class="text-muted">WAITING FOR ENTRY SIGNAL...</span>`;
      }
      activePnlEl.textContent = "--";
      activePnlEl.className = "text-white";
    }

    // Render closed trades history table
    renderClosedTradesTable();
    return;
  }

  // Check Take Profit and Stop Loss limits dynamically
  const livePrice = getCurrentPrice(paperActivePosition.outcome);
  const pos = paperActivePosition;
  const pnlPctRaw = ((livePrice - pos.entryPrice) / pos.entryPrice) * 100;
  const pnlPct = pnlPctRaw - paperFeePct; // Net P&L percentage (fees/slippage subtracted)

  // Update trailing highest P&L percentage reached since entry
  if (pnlPct > pos.highestPnlPct) {
    pos.highestPnlPct = pnlPct;
  }

  // Calculate trailing Take Profit target (in P&L %) and its implied token price
  const trailingTpTargetPct = pos.highestPnlPct - paperTrailingReversalPct;
  const tpPrice = pos.entryPrice * (1 + trailingTpTargetPct / 100);

  // Check if we are still in the right trend direction
  const isInRightDirection =
    (pos.outcome === "YES" && currentRecommendation.includes("BUY YES")) ||
    (pos.outcome === "NO" && currentRecommendation.includes("BUY NO"));

  // Check minimum hold duration (except for interval expiration transition)
  const holdTimeSecs = (Date.now() - pos.timestamp) / 1000;
  const isHoldLocked = holdTimeSecs < paperMinHoldSecs;

  // Exit triggers (strictly blocked if inside minimum hold period)
  const isHardTpHit =
    !isHoldLocked && paperHardTpEnabled && pnlPct >= paperHardTpPct;
  const isTrailingTpHit =
    !isHoldLocked &&
    pos.highestPnlPct > 0 &&
    pnlPct <= trailingTpTargetPct &&
    pnlPct >= paperMinTpPct;
  const isStopLossHit =
    !isHoldLocked && pnlPct <= -paperStopLossPct && !isInRightDirection;

  if (isHardTpHit) {
    closePaperPosition(livePrice, `HARD TP (+${pnlPct.toFixed(1)}%)`);
    return;
  } else if (isTrailingTpHit) {
    closePaperPosition(
      livePrice,
      `DYNAMIC TP (+${pnlPct.toFixed(1)}% | Peak: +${pos.highestPnlPct.toFixed(1)}%)`,
    );
    return;
  } else if (isStopLossHit) {
    closePaperPosition(livePrice, `SL (-${paperStopLossPct.toFixed(1)}%)`);
    return;
  }

  // 1. Update realized P&L and net wallet value
  const currentPosValue = pos.qty * livePrice;
  const feeAmount = pos.cost * (paperFeePct / 100);
  const totalAssets = paperTradingWallet + currentPosValue - feeAmount;
  const pnl = currentPosValue - pos.cost - feeAmount;
  const sign = pnl >= 0 ? "+" : "";
  const pnlClass = pnl >= 0 ? "text-green" : "text-red";

  const pnlSummaryEl = document.getElementById("paper-pnl-summary");
  if (pnlSummaryEl) {
    pnlSummaryEl.textContent = `USDC: $${totalAssets.toFixed(2)} (Realized: $${paperRealizedPnl.toFixed(2)})`;
  }

  // 2. Update active position details with TP/SL targets
  const activePosEl = document.getElementById("paper-active-position");
  const activePnlEl = document.getElementById("paper-active-pnl");

  if (activePosEl && activePnlEl) {
    const slPrice = pos.entryPrice * (1 - paperStopLossPct / 100);

    // Display SL status based on direction consensus and hold lock
    let slLabel = "";
    if (isHoldLocked) {
      slLabel = `SL target: <span class="text-muted" style="text-decoration: line-through;">$${slPrice.toFixed(3)} (-${paperStopLossPct}%)</span> <span style="font-size:9px; color:var(--bb-amber); font-weight:bold;">[HOLD LOCK ACTIVE]</span>`;
    } else if (isInRightDirection) {
      slLabel = `SL target: <span style="color: var(--bb-amber); font-weight:600; text-decoration: line-through;">$${slPrice.toFixed(3)} (-${paperStopLossPct}%)</span> <span style="font-size:9px; color:var(--bb-green); font-weight:bold; letter-spacing:0.5px;">[HOLDING DIRECTION]</span>`;
    } else {
      slLabel = `SL target: <span class="text-red" style="font-weight:600;">$${slPrice.toFixed(3)} (-${paperStopLossPct}%)</span>`;
    }

    // Display Hard TP status based on enabled flag
    const hardTpLabel = paperHardTpEnabled
      ? `TP (Hard): <span class="text-green" style="font-weight:600;">+${paperHardTpPct}%</span>`
      : `TP (Hard): <span class="text-muted" style="font-weight:600; text-decoration: line-through;">DISABLED</span>`;

    // Formulate Hold Lock display
    const holdLabel = isHoldLocked
      ? `Hold lock: <span style="color: var(--bb-amber); font-weight:600; font-family: var(--font-mono);">LOCKED (${Math.ceil(paperMinHoldSecs - holdTimeSecs)}s)</span>`
      : `Hold lock: <span style="color: var(--bb-green); font-weight:600;">RELEASED (OPEN)</span>`;

    activePosEl.innerHTML = `
            <div>
                Outcome: <span style="font-weight:bold; color:var(--bb-amber);">${pos.outcome}</span> |
                Cost: <span style="font-weight:bold; color:var(--bb-cyan);">$${pos.cost.toFixed(2)}</span>
            </div>
            <div style="margin-top: 2px;">
                Entry: <span style="font-weight:bold;">$${pos.entryPrice.toFixed(3)}</span> |
                Live: <span style="font-weight:bold;">$${livePrice.toFixed(3)}</span>
            </div>
            <div style="font-size: 10px; color: var(--text-muted); margin-top: 4px; border-top: 1px dashed #212936; padding-top: 3px;">
                ${hardTpLabel} |
                TP (Trailing): <span class="text-green" style="font-weight:600;">$${tpPrice.toFixed(3)} (+${trailingTpTargetPct.toFixed(1)}% | Peak: +${pos.highestPnlPct.toFixed(1)}%) (Min TP: +${paperMinTpPct.toFixed(1)}%)</span>
            </div>
            <div style="font-size: 10px; color: var(--text-muted); margin-top: 2px;">
                ${slLabel}
            </div>
            <div style="font-size: 10px; color: var(--text-muted); margin-top: 3px; border-top: 1px dotted #212936; padding-top: 2px;">
                ${holdLabel}
            </div>
        `;

    activePnlEl.textContent = `${sign}$${pnl.toFixed(2)} (${sign}${pnlPct.toFixed(1)}%)`;
    activePnlEl.className = pnlClass;
  }

  // 3. Render closed trades history table
  renderClosedTradesTable();
}

function renderClosedTradesTable() {
  const tbody = document.getElementById("paper-history-tbody");
  if (tbody) {
    if (paperClosedTrades.length === 0) {
      tbody.innerHTML = `
                <tr>
                    <td colspan="6" class="no-data-msg" style="padding: 12px; font-size: 11px;">NO CLOSED POSITIONS</td>
                </tr>
            `;
    } else {
      tbody.innerHTML = paperClosedTrades
        .map((t) => {
          const sign = t.pnl >= 0 ? "+" : "";
          const pnlClass = t.pnl >= 0 ? "text-green" : "text-red";
          const reasonClass = t.reason.includes("TP")
            ? "text-green"
            : t.reason.includes("SL")
              ? "text-red"
              : "text-muted";
          return `
                    <tr style="border-bottom: 1px solid #111;">
                        <td style="padding: 4px 6px; color: var(--text-muted);">${t.time}</td>
                        <td style="padding: 4px 6px; font-weight: 600; color: var(--bb-white);">${t.asset}</td>
                        <td style="padding: 4px 6px; text-align: right;">$${t.entryPrice.toFixed(3)}</td>
                        <td style="padding: 4px 6px; text-align: right;">$${t.exitPrice.toFixed(3)}</td>
                        <td style="padding: 4px 6px; text-align: right;" class="${pnlClass}">${sign}$${t.pnl.toFixed(2)}</td>
                        <td style="padding: 4px 6px; font-size: 10px;" class="${reasonClass}">${t.reason}</td>
                    </tr>
                `;
        })
        .join("");
    }
  }
}

// Real Trading Helper Functions
function formatWalletAddress(address) {
  if (!address) return "NOT CONNECTED";
  return `${address.substring(0, 6)}...${address.substring(address.length - 4)}`;
}

function formatContractQty(qty) {
  const num = Number(qty);
  if (!Number.isFinite(num)) return "0";
  return num.toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 4,
  });
}

// ERC-20 balance, allocation, and order calculation helpers are moved to trading.js

function updateRealTradingUI() {
  // Sync real-trading-toggle checkbox
  const toggle = document.getElementById("real-trading-toggle");
  if (toggle) {
    toggle.checked = realTradingEnabled;
  }

  // Sync auto real trading toggle label status
  const toggleLabel = document.getElementById("real-trading-toggle-label");
  if (toggleLabel) {
    if (realTradingEnabled) {
      toggleLabel.textContent = "ACTIVE";
      toggleLabel.className = "text-green";
    } else {
      toggleLabel.textContent = "INACTIVE";
      toggleLabel.className = "text-red";
    }
  }

  // Sync real-trading-summary
  const summary = document.getElementById("real-trading-summary");
  if (summary) {
    if (realTradingEnabled) {
      summary.textContent = "ACTIVE";
      summary.className = "text-green";
    } else if (connectedWalletAddress) {
      summary.textContent = "STANDBY";
      summary.className = "text-cyan";
    } else {
      summary.textContent = "STANDBY";
      summary.className = "text-muted";
    }
  }

  // Sync wallet EOA status display
  const walletStatus = document.getElementById("real-wallet-status");
  if (walletStatus) {
    if (connectedWalletAddress) {
      walletStatus.textContent = formatWalletAddress(connectedWalletAddress);
      walletStatus.className = "text-green";
    } else {
      walletStatus.textContent = "NOT CONNECTED";
      walletStatus.className = "text-muted";
    }
  }

  // Show or hide the proxy input row based on wallet connection status
  const proxyInput = document.getElementById("real-proxy-input");
  if (proxyInput) {
    const proxyRow = proxyInput.closest(".control-row");
    if (proxyRow) {
      proxyRow.style.display = connectedWalletAddress ? "flex" : "none";
    }
  }

  // Show or hide the CLOB Auth row and update status
  const clobAuthRow = document.getElementById("real-clob-auth-row");
  if (clobAuthRow) {
    clobAuthRow.style.display = connectedWalletAddress ? "flex" : "none";
  }
  const clobStatus = document.getElementById("real-clob-status");
  const clobBtn = document.getElementById("real-clob-activate-btn");
  if (clobStatus) {
    if (hasClobCreds) {
      clobStatus.textContent = "CONNECTED (API READY)";
      clobStatus.className = "text-green";
      if (clobBtn) clobBtn.style.display = "none";
    } else {
      clobStatus.textContent = clobConnectionPending ? "CONNECTING..." : "NOT ACTIVATED";
      clobStatus.className = "text-muted";
      if (clobBtn) {
        clobBtn.style.display = "inline-block";
        clobBtn.disabled = clobConnectionPending;
        clobBtn.textContent = clobConnectionPending ? "SIGNING..." : "ACTIVATE";
      }
    }
  }

  // Sync balance display
  const balanceStatus = document.getElementById("real-balance-status");
  if (balanceStatus) {
    if (connectedWalletAddress) {
      if (realPortfolioUsdc !== null) {
        balanceStatus.textContent = `USDC: $${realPortfolioUsdc.toFixed(2)}`;
        balanceStatus.className = "text-white";
      } else {
        balanceStatus.textContent = "USDC: LOADING...";
        balanceStatus.className = "text-muted";
      }
    } else {
      balanceStatus.textContent = "USDC: --";
      balanceStatus.className = "text-muted";
    }
  }

  // Sync trade order size/allocation label
  const orderSizeLabel = document.getElementById("real-order-size-label");
  if (orderSizeLabel) {
    if (connectedWalletAddress && realPortfolioUsdc !== null && realPortfolioUsdc > 0) {
      const allocation = realTradeAllocationUsdc || calculateRealAllocation(realPortfolioUsdc);
      orderSizeLabel.textContent = `10% PORTFOLIO (~ $${allocation.toFixed(2)} USDC)`;
    } else {
      orderSizeLabel.textContent = "10% PORTFOLIO, MINIMUM 1 USDC";
    }
  }

  // Sync active positions display
  const activePositionEl = document.getElementById("real-active-position");
  if (activePositionEl) {
    if (realActivePosition) {
      const livePrice = getCurrentPrice(realActivePosition.outcome);
      const pnl = realActivePosition.qty * livePrice - realActivePosition.cost;
      const pnlPct = ((livePrice - realActivePosition.entryPrice) / realActivePosition.entryPrice) * 100;
      const sign = pnl >= 0 ? "+" : "";
      const pnlClass = pnl >= 0 ? "text-green" : "text-red";
      
      activePositionEl.innerHTML = `
        <span style="font-weight:bold; color:var(--bb-amber);">${realActivePosition.outcome}</span> |
        Qty: <span style="font-weight:bold;">${formatContractQty(realActivePosition.qty)}</span> |
        Cost: <span style="font-weight:bold; color:var(--bb-cyan);">$${realActivePosition.cost.toFixed(2)}</span> |
        Entry: <span>$${realActivePosition.entryPrice.toFixed(3)}</span> |
        Live: <span>$${livePrice.toFixed(3)}</span> |
        P&L: <span class="${pnlClass}">${sign}$${pnl.toFixed(2)} (${sign}${pnlPct.toFixed(1)}%)</span>
      `;
    } else {
      const now = Date.now();
      const cooldownSecs = Math.max(0, Math.ceil((10000 - (now - realLastExitTime)) / 1000));
      if (cooldownSecs > 0) {
        activePositionEl.innerHTML = `<span class="text-amber" style="font-weight:600;">COOLDOWN: ${cooldownSecs}s (${realLastExitOutcome} CLOSED)</span>`;
      } else {
        activePositionEl.innerHTML = `<span class="text-muted">NONE</span>`;
      }
    }
  }

  // Sync last attempt / execution status display
  const attemptStatusEl = document.getElementById("real-attempt-status");
  if (attemptStatusEl) {
    attemptStatusEl.textContent = realAttemptStatusText;
    attemptStatusEl.className = `real-attempt-status ${realAttemptStatusClass}`;
  }

  // Sync manual action button enabled/disabled states
  const buyYesBtn = document.getElementById("real-force-buy-yes-btn");
  const buyNoBtn = document.getElementById("real-force-buy-no-btn");
  const sellAllBtn = document.getElementById("real-sell-all-btn");

  if (buyYesBtn) {
    buyYesBtn.disabled = !connectedWalletAddress || realOrderPending;
  }
  if (buyNoBtn) {
    buyNoBtn.disabled = !connectedWalletAddress || realOrderPending;
  }
  if (sellAllBtn) {
    sellAllBtn.disabled = !connectedWalletAddress || !realActivePosition || realOrderPending;
  }
}

function setTradingTab(mode) {
  const paperTab = document.getElementById("paper-trading-tab");
  const realTab = document.getElementById("real-trading-tab");
  const paperPane = document.getElementById("paper-trading-pane");
  const realPane = document.getElementById("real-trading-pane");
  const isReal = mode === "real";

  if (paperTab) paperTab.classList.toggle("active", !isReal);
  if (realTab) realTab.classList.toggle("active", isReal);
  if (paperPane) paperPane.classList.toggle("active", !isReal);
  if (realPane) realPane.classList.toggle("active", isReal);
}

function isActionableTradingSignal(decision) {
  return (
    decision && (decision.includes("BUY YES") || decision.includes("BUY NO"))
  );
}

function getOutcomeFromDecision(decision) {
  if (!decision) return null;
  if (decision.includes("BUY YES")) return "YES";
  if (decision.includes("BUY NO")) return "NO";
  return null;
}

function setRealAttemptStatus(text, statusClass = "idle") {
  realAttemptStatusText = text;
  realAttemptStatusClass = statusClass;

  const attemptStatusEl = document.getElementById("real-attempt-status");
  if (attemptStatusEl) {
    attemptStatusEl.textContent = text;
    attemptStatusEl.className = `real-attempt-status ${statusClass}`;
  }
}

function handleBtcLiveTrade(timestampMs, price, volume) {
  if (!btcSeries) return;
  const candleTime = Math.floor(timestampMs / 1000); // 1-second window

  // Safety check: ignore out-of-order timestamps to prevent TV chart crashes
  if (currentBtcCandle && candleTime < currentBtcCandle.time) {
    return;
  }

  if (!currentBtcCandle || candleTime > currentBtcCandle.time) {
    if (currentBtcCandle) {
      btcHistoryData.push({ ...currentBtcCandle });
      if (btcHistoryData.length > 300) {
        btcHistoryData.shift();
      }
      recalculateIndicators();
    }

    // Start a new 1-second candle
    currentBtcCandle = {
      time: candleTime,
      open: price,
      high: price,
      low: price,
      close: price,
      volume: volume || 0,
    };
  } else if (candleTime === currentBtcCandle.time) {
    // Update current 1-second candle
    currentBtcCandle.high = Math.max(currentBtcCandle.high, price);
    currentBtcCandle.low = Math.min(currentBtcCandle.low, price);
    currentBtcCandle.close = price;
    currentBtcCandle.volume += volume || 0;
  }

  btcSeries.update(currentBtcCandle);
  if (btcVolumeSeries) {
    btcVolumeSeries.update({
      time: currentBtcCandle.time,
      value: currentBtcCandle.volume,
      color:
        currentBtcCandle.close >= currentBtcCandle.open ? "#26a69a" : "#ef5350",
    });
  }

  // Update live VWAP plotted line on chart
  const currentVwap = calculateVWAP(btcHistoryData.concat(currentBtcCandle));
  if (vwapSeries) {
    vwapSeries.update({
      time: currentBtcCandle.time,
      value: currentVwap,
    });
  }
}

// Update Live BTC Price indicator and chart buffer
function updateLiveBtcPrice(price, volume, timestampMs) {
  if (!price || isNaN(price)) return;
  currentBtcPrice = price;
  document.getElementById("live-btc-price").textContent = formatUSD(price);

  // Aggregate trade tick into TV 1s candle chart
  if (timestampMs !== undefined) {
    handleBtcLiveTrade(timestampMs, price, volume);
  }

  // Estimate YES/NO prices in real-time based on new BTC price tick
  estimateRealtimeOutcomePrices();

  if (targetBtcPrice > 0) {
    const diff = price - targetBtcPrice;
    const diffPct = (diff / targetBtcPrice) * 100;
    const sign = diff >= 0 ? "+" : "";
    const diffEl = document.getElementById("btc-price-diff");
    diffEl.textContent = `${sign}${formatUSD(diff)} (${sign}${diffPct.toFixed(2)}%)`;
    diffEl.className = diff >= 0 ? "text-green" : "text-red";

    const statusEl = document.getElementById("btc-interval-status");
    statusEl.textContent = diff >= 0 ? "UP (YES WINS)" : "DOWN (NO WINS)";
    statusEl.className = diff >= 0 ? "text-green" : "text-red";
  } else {
    document.getElementById("btc-price-diff").textContent = "--";
    document.getElementById("btc-price-diff").className = "text-white";
    document.getElementById("btc-interval-status").textContent = "N/A";
    document.getElementById("btc-interval-status").className = "text-white";
  }

  // Refresh paper trading dashboard in real-time at tick frequency
  if (paperTradingEnabled) {
    updatePaperTradingUI();
  }
  if (realTradingEnabled || realActivePosition) {
    updateRealTradingUI();
  }
}

// Initialize TradingView Lightweight Charts
function initTradingViewCharts() {
  const btcContainer = document.getElementById("btc-tradingview-chart");
  if (!btcContainer) {
    logToConsole(`[ERR] BTC chart container not found.`);
    return;
  }
  if (typeof LightweightCharts === "undefined") {
    btcContainer.innerHTML =
      '<div class="no-data-msg" style="padding: 12px;">BTC CHART UNAVAILABLE: LIGHTWEIGHT CHARTS LIBRARY DID NOT LOAD</div>';
    logToConsole(
      `[ERR] BTC chart unavailable: LightweightCharts library did not load.`,
    );
    return;
  }

  btcContainer.innerHTML = "";

  // Create Binance BTC Chart
  btcChart = LightweightCharts.createChart(btcContainer, {
    autoSize: true,
    layout: {
      background: { type: "solid", color: "#121824" },
      textColor: "#d1d5db",
      fontFamily: "JetBrains Mono, IBM Plex Mono, monospace",
    },
    grid: {
      vertLines: { color: "#212936" },
      horzLines: { color: "#212936" },
    },
    crosshair: {
      mode: LightweightCharts.CrosshairMode.Normal,
    },
    timeScale: {
      timeVisible: true,
      secondsVisible: true,
      borderColor: "#212936",
    },
    rightPriceScale: {
      borderColor: "#212936",
      scaleMargins: {
        top: 0.1,
        bottom: 0.25, // make room for volume overlay
      },
    },
  });

  btcSeries = btcChart.addCandlestickSeries({
    upColor: "#0ea5e9", // Sky blue for BTC
    downColor: "#ef4444", // Red
    borderVisible: false,
    wickUpColor: "#0ea5e9",
    wickDownColor: "#ef4444",
  });

  btcVolumeSeries = btcChart.addHistogramSeries({
    color: "#26a69a",
    priceFormat: {
      type: "volume",
    },
    priceScaleId: "", // overlay
  });

  btcVolumeSeries.priceScale().applyOptions({
    scaleMargins: {
      top: 0.8,
      bottom: 0,
    },
  });

  vwapSeries = btcChart.addLineSeries({
    color: "#a855f7", // Purple/Violet line for VWAP
    lineWidth: 1.5,
    lineStyle: LightweightCharts.LineStyle.Solid,
    title: "VWAP",
  });
}

// Start default load on page load
window.addEventListener("DOMContentLoaded", () => {
  logToConsole(`[SYS] Initializing Polymarket Bloomberg Terminal interface...`);

  // Bind Web3 connection button before network/CDN-dependent startup work.
  const connectBtn = document.getElementById("web3-connect-btn");
  if (connectBtn) {
    connectBtn.addEventListener("click", connectWeb3Wallet);
  }

  const paperTradingTab = document.getElementById("paper-trading-tab");
  const realTradingTab = document.getElementById("real-trading-tab");
  if (paperTradingTab) {
    paperTradingTab.addEventListener("click", () => setTradingTab("paper"));
  }
  if (realTradingTab) {
    realTradingTab.addEventListener("click", () => setTradingTab("real"));
  }

  initTradingViewCharts();
  connectBinanceWebSocket();
  fetchBtcPriceHistory();
  loadDefaultBtcMarket();

  // Bind Paper Trading controls
  const ptToggle = document.getElementById("paper-trading-toggle");
  const ptPanel = document.getElementById("paper-trading-panel");

  if (ptToggle && ptPanel) {
    ptToggle.addEventListener("change", () => {
      paperTradingEnabled = ptToggle.checked;
      logToConsole(
        `[SYS] Automated Paper Trading: ${paperTradingEnabled ? "ENABLED" : "DISABLED"}`,
      );

      // Toggle panel visibility based on active checkbox state
      ptPanel.style.display = paperTradingEnabled ? "flex" : "none";

      if (paperTradingEnabled) {
        updatePaperTradingUI();
      }
    });

    // Bind TP / SL / Hard TP inputs
    const tpInput = document.getElementById("paper-tp-input");
    const slInput = document.getElementById("paper-sl-input");
    const hardTpEnabledToggle = document.getElementById(
      "paper-hard-tp-enabled",
    );
    const hardTpInput = document.getElementById("paper-hard-tp-input");

    if (tpInput) {
      tpInput.addEventListener("input", () => {
        const val = parseFloat(tpInput.value);
        if (!isNaN(val) && val >= 0) {
          paperTrailingReversalPct = val;
          if (paperActivePosition) {
            updatePaperTradingUI();
          }
        }
      });
    }

    if (slInput) {
      slInput.addEventListener("input", () => {
        const val = parseFloat(slInput.value);
        if (!isNaN(val) && val >= 0) {
          paperStopLossPct = val;
          if (paperActivePosition) {
            updatePaperTradingUI();
          }
        }
      });
    }

    if (hardTpEnabledToggle) {
      hardTpEnabledToggle.addEventListener("change", () => {
        paperHardTpEnabled = hardTpEnabledToggle.checked;
        if (paperActivePosition) {
          updatePaperTradingUI();
        }
      });
    }

    if (hardTpInput) {
      hardTpInput.addEventListener("input", () => {
        const val = parseFloat(hardTpInput.value);
        if (!isNaN(val) && val >= 0) {
          paperHardTpPct = val;
          if (paperActivePosition) {
            updatePaperTradingUI();
          }
        }
      });
    }

    // Bind Minimum Hold duration input
    const minHoldInput = document.getElementById("paper-min-hold-input");
    if (minHoldInput) {
      minHoldInput.addEventListener("input", () => {
        const val = parseInt(minHoldInput.value);
        if (!isNaN(val) && val >= 0) {
          paperMinHoldSecs = val;
          if (paperActivePosition) {
            updatePaperTradingUI();
          }
        }
      });
    }

    // Bind Minimum Take Profit input
    const minTpInput = document.getElementById("paper-min-tp-input");
    if (minTpInput) {
      minTpInput.addEventListener("input", () => {
        const val = parseFloat(minTpInput.value);
        if (!isNaN(val) && val >= 0) {
          paperMinTpPct = val;
          if (paperActivePosition) {
            updatePaperTradingUI();
          }
        }
      });
    }

    // Bind Estimated Fees input
    const feeInput = document.getElementById("paper-fee-input");
    if (feeInput) {
      feeInput.addEventListener("input", () => {
        const val = parseFloat(feeInput.value);
        if (!isNaN(val) && val >= 0) {
          paperFeePct = val;
          if (paperActivePosition) {
            updatePaperTradingUI();
          }
        }
      });
    }

    // Sync initial panel display and status
    ptPanel.style.display = paperTradingEnabled ? "flex" : "none";
    if (paperTradingEnabled) {
      updatePaperTradingUI();
    }

    // Auto-resume audio context on first click to bypass browser autoplay blocks
    document.addEventListener(
      "click",
      () => {
        if (soundEnabled && !audioCtx) {
          audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        }
        if (audioCtx && audioCtx.state === "suspended") {
          audioCtx.resume();
        }
      },
      { once: true },
    );

    // Bind manual forcing action buttons
    const forceYesBtn = document.getElementById("force-buy-yes-btn");
    const forceNoBtn = document.getElementById("force-buy-no-btn");
    const forceExitBtn = document.getElementById("force-exit-btn");

    if (forceYesBtn) {
      forceYesBtn.addEventListener("click", () => executeManualTrade("YES"));
    }
    if (forceNoBtn) {
      forceNoBtn.addEventListener("click", () => executeManualTrade("NO"));
    }
    if (forceExitBtn) {
      forceExitBtn.addEventListener("click", executeManualExit);
    }

    const realTradingToggle = document.getElementById("real-trading-toggle");
    const realBuyYesBtn = document.getElementById("real-force-buy-yes-btn");
    const realBuyNoBtn = document.getElementById("real-force-buy-no-btn");
    const realSellAllBtn = document.getElementById("real-sell-all-btn");

    if (realTradingToggle) {
      realTradingToggle.addEventListener("change", () => {
        setRealTradingEnabled(realTradingToggle.checked);
      });
    }
    if (realBuyYesBtn) {
      realBuyYesBtn.addEventListener("click", () =>
        executeRealTrade("YES", "BUY", null, "MANUAL"),
      );
    }
    if (realBuyNoBtn) {
      realBuyNoBtn.addEventListener("click", () =>
        executeRealTrade("NO", "BUY", null, "MANUAL"),
      );
    }
    if (realSellAllBtn) {
      realSellAllBtn.addEventListener("click", () =>
        closeRealPosition("MANUAL SELL ALL"),
      );
    }

    const realClobActivateBtn = document.getElementById("real-clob-activate-btn");
    if (realClobActivateBtn) {
      realClobActivateBtn.addEventListener("click", activateClobAuth);
    }

    const proxyInput = document.getElementById("real-proxy-input");
    if (proxyInput) {
      proxyInput.value = polymarketProxyAddress;

      proxyInput.addEventListener("input", () => {
        const rawAddr = proxyInput.value.trim();
        if (rawAddr === "" || /^0x[a-fA-F0-9]{40}$/.test(rawAddr)) {
          proxyInput.style.borderColor = "var(--bb-border)";
          polymarketProxyAddress = rawAddr;
          logToConsole(
            `[SYS] Polymarket Proxy Address configured: ${polymarketProxyAddress || "DEFAULT (Connected Wallet EOA)"}`,
          );

          refreshRealPortfolioBalance();
          updateRealTradingUI();
        } else {
          proxyInput.style.borderColor = "var(--bb-red)";
        }
      });

      proxyInput.addEventListener("blur", () => {
        const rawAddr = proxyInput.value.trim();
        if (rawAddr === "" || /^0x[a-fA-F0-9]{40}$/.test(rawAddr)) {
          proxyInput.style.borderColor = "var(--bb-border)";
        }
      });
    }

    updateRealTradingUI();

    // Periodic balance refresh every 60 seconds when real trading enabled
    if (!window._realBalanceRefreshInterval) {
      window._realBalanceRefreshInterval = setInterval(() => {
        if (
          connectedWalletAddress &&
          (realTradingEnabled || realActivePosition)
        ) {
          refreshRealPortfolioBalance();
        }
      }, 60000);
    }

    // Monitor browser tab visibility to warn user about browser-side event loop throttling
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        logToConsole(
          `[WARNING] Terminal tab is in background! Browser throttling may lag indicators/exits. Keep this window active in the foreground.`,
        );
      } else {
        logToConsole(
          `[SYS] Terminal tab returned to foreground. Execution un-throttled.`,
        );
      }
    });

    // Listen for wallet account changes
    if (typeof window.ethereum !== "undefined") {
      window.ethereum.on("accountsChanged", (accounts) => {
        if (accounts && accounts.length > 0) {
          connectedWalletAddress = accounts[0];
          logToConsole(
            `[SYS] Wallet account changed: ${connectedWalletAddress}`,
          );
          const truncated =
            connectedWalletAddress.substring(0, 6) +
            "..." +
            connectedWalletAddress.substring(connectedWalletAddress.length - 4);
          const btn = document.getElementById("web3-connect-btn");
          if (btn) {
            btn.textContent = truncated;
            btn.style.color = "var(--bb-green)";
            btn.style.borderColor = "var(--bb-green-dim)";
          }
          resolvePolymarketProxy(connectedWalletAddress).then(() => {
            refreshRealPortfolioBalance();
            checkClobAuthStatus();
          });
          updateRealTradingUI();
        } else {
          connectedWalletAddress = null;
          polymarketProxyAddress = "";
          realPortfolioUsdc = null;
          realTradeAllocationUsdc = null;
          const btn = document.getElementById("web3-connect-btn");
          if (btn) {
            btn.textContent = "CONNECT WALLET";
            btn.style.color = "var(--bb-cyan)";
            btn.style.borderColor = "var(--bb-cyan)";
          }
          logToConsole(`[SYS] Wallet disconnected.`);
          if (realTradingEnabled) setRealTradingEnabled(false);
          updateRealTradingUI();
        }
      });

      window.ethereum.on("chainChanged", () => {
        logToConsole(`[SYS] Wallet network changed. Refreshing balance...`);
        realPortfolioUsdc = null;
        realTradeAllocationUsdc = null;
        if (connectedWalletAddress) {
          refreshRealPortfolioBalance();
          checkClobAuthStatus();
        }
        updateRealTradingUI();
      });
    }
  }
});

// Web3 Crypto Account Connection Handler
async function connectWeb3Wallet() {
  const connectBtn = document.getElementById("web3-connect-btn");

  // If wallet is already connected, copy address to clipboard on click
  if (connectedWalletAddress) {
    const addressToCopy = polymarketProxyAddress
      ? polymarketProxyAddress
      : connectedWalletAddress;
    try {
      await navigator.clipboard.writeText(addressToCopy);
      logToConsole(
        `[SYS] Wallet address copied to clipboard: ${addressToCopy}`,
      );

      if (connectBtn) {
        const originalText = connectBtn.textContent;
        connectBtn.textContent = "COPIED!";
        connectBtn.style.color = "var(--bb-cyan)";
        connectBtn.style.borderColor = "var(--bb-cyan)";

        setTimeout(() => {
          // Restore truncated address display
          const displayAddress = connectedWalletAddress;
          const truncated =
            displayAddress.substring(0, 6) +
            "..." +
            displayAddress.substring(displayAddress.length - 4);
          connectBtn.textContent = truncated;
          connectBtn.style.color = "var(--bb-green)";
          connectBtn.style.borderColor = "var(--bb-green-dim)";
        }, 1000);
      }
    } catch (err) {
      logToConsole(`[ERR] Failed to copy wallet address: ${err}`);
    }
    return;
  }

  if (walletConnectionPending) {
    logToConsole(
      `[SYS] Wallet connection already pending. Check your wallet extension window.`,
    );
    return;
  }
  if (!navigator.onLine) {
    logToConsole(`[ERR] Wallet connection blocked: System is offline.`);
    return;
  }
  if (typeof window.ethereum === "undefined") {
    logToConsole(`[SYS] Web3 wallet connection failed: MetaMask not detected.`);
    alert(
      "MetaMask (or a compatible Web3 wallet) was not detected. Please install the MetaMask extension to trade with a real account.",
    );
    return;
  }

  try {
    walletConnectionPending = true;
    if (connectBtn) {
      connectBtn.disabled = true;
      connectBtn.textContent = "CONNECTING...";
      connectBtn.style.opacity = "0.75";
    }
    logToConsole(`[SYS] Requesting wallet account connection...`);
    const accounts = await window.ethereum.request({
      method: "eth_requestAccounts",
    });

    if (accounts && accounts.length > 0) {
      connectedWalletAddress = accounts[0];
      logToConsole(`[SYS] Web3 wallet connected: ${connectedWalletAddress}`);

      // Auto-resolve Polymarket Proxy address
      await resolvePolymarketProxy(connectedWalletAddress);

      // Switch to Polygon network in MetaMask
      await ensurePolygonNetwork();

      // Truncate address for display: 0x1234...abcd
      const truncated =
        connectedWalletAddress.substring(0, 6) +
        "..." +
        connectedWalletAddress.substring(connectedWalletAddress.length - 4);
      if (connectBtn) {
        connectBtn.textContent = truncated;
        connectBtn.style.color = "var(--bb-green)";
        connectBtn.style.borderColor = "var(--bb-green-dim)";
      }
      await refreshRealPortfolioBalance();
      await checkClobAuthStatus();
      updateRealTradingUI();
    } else {
      logToConsole(`[SYS] Wallet connection returned no accounts.`);
    }
  } catch (e) {
    if (e.code === -32002) {
      logToConsole(
        `[ERR] Wallet connection already requested. Open your wallet extension and approve or reject the pending request.`,
      );
    } else if (e.code === 4001) {
      logToConsole(`[SYS] Wallet connection rejected by user.`);
    } else {
      logToConsole(`[ERR] Web3 wallet request failed: ${e.message || e}`);
    }
  } finally {
    walletConnectionPending = false;
    if (connectBtn && !connectedWalletAddress) {
      connectBtn.disabled = false;
      connectBtn.textContent = "CONNECT WALLET";
      connectBtn.style.opacity = "1";
    } else if (connectBtn) {
      connectBtn.disabled = false;
      connectBtn.style.opacity = "1";
    }
    updateRealTradingUI();
  }
}

async function checkClobAuthStatus() {
  if (!connectedWalletAddress) {
    hasClobCreds = false;
    updateRealTradingUI();
    return;
  }

  try {
    const url = `/api/clob/status?address=${connectedWalletAddress.toLowerCase()}`;
    const response = await fetch(url);
    if (response.ok) {
      const data = await response.json();
      hasClobCreds = !!data.has_creds;
    } else {
      hasClobCreds = false;
    }
  } catch (e) {
    console.error("Failed to check CLOB auth status:", e);
    hasClobCreds = false;
  }
  updateRealTradingUI();
}

async function activateClobAuth() {
  if (!connectedWalletAddress) {
    logToConsole(`[SYS] CLOB activation skipped: connect wallet first.`);
    alert("Connect your Web3 wallet first!");
    return;
  }

  if (clobConnectionPending) return;

  try {
    clobConnectionPending = true;
    const activateBtn = document.getElementById("real-clob-activate-btn");
    if (activateBtn) {
      activateBtn.disabled = true;
      activateBtn.textContent = "SIGNING...";
    }

    logToConsole(`[SYS] Initiating CLOB API Key derivation signature...`);
    
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const msgParams = {
      domain: {
        name: "ClobAuthDomain",
        version: "1",
        chainId: 137
      },
      message: {
        address: connectedWalletAddress.toLowerCase(),
        timestamp: timestamp,
        nonce: 0,
        message: "This message attests that I control the given wallet"
      },
      primaryType: "ClobAuth",
      types: {
        EIP712Domain: [
          { name: "name", type: "string" },
          { name: "version", type: "string" },
          { name: "chainId", type: "uint256" }
        ],
        ClobAuth: [
          { name: "address", type: "address" },
          { name: "timestamp", type: "string" },
          { name: "nonce", type: "uint256" },
          { name: "message", type: "string" }
        ]
      }
    };

    const signature = await window.ethereum.request({
      method: "eth_signTypedData_v4",
      params: [connectedWalletAddress, JSON.stringify(msgParams)]
    });

    logToConsole(`[SYS] CLOB Auth signed. Sending to proxy gateway for credentials derivation...`);

    const response = await fetch("/api/clob/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        address: connectedWalletAddress.toLowerCase(),
        signature: signature,
        timestamp: timestamp,
        nonce: 0
      })
    });

    if (response.ok) {
      const resData = await response.json();
      logToConsole(`[SYS] CLOB API Activation Success! Status: ${resData.creds ? 'Ready' : 'Unknown'}`);
      hasClobCreds = true;
    } else {
      const errText = await response.text();
      logToConsole(`[ERR] CLOB API Activation Failed: ${errText}`);
      hasClobCreds = false;
      alert("Failed to activate Polymarket CLOB trading. Check terminal console.");
    }
  } catch (err) {
    logToConsole(`[ERR] CLOB signature rejected or failed: ${err.message || err}`);
  } finally {
    clobConnectionPending = false;
    updateRealTradingUI();
  }
}

// Automatically resolve Polymarket Gnosis Safe proxy wallet address from connected EOA
async function resolvePolymarketProxy(eoa) {
  if (!eoa) return;
  try {
    logToConsole(`[SYS] Resolving Polymarket Proxy wallet for EOA: ${eoa}...`);
    // Try data-api endpoint first
    const url = `https://data-api.polymarket.com/profile?address=${eoa.toLowerCase()}`;
    logToConsole(`[SYS] Querying Polymarket profile API: ${url}`);
    const response = await fetch(url);
    if (response.ok) {
      const data = await response.json();
      logToConsole(`[SYS] Polymarket profile API response: ${JSON.stringify(data)}`);
      // data-api returns array or object depending on version
      const profile = Array.isArray(data) ? data[0] : data;
      const proxy =
        profile &&
        (profile.proxyWallet || profile.proxy_wallet || profile.proxyAddress);
      if (proxy) {
        polymarketProxyAddress = proxy.toLowerCase();
        logToConsole(
          `[SYS] Successfully resolved Polymarket Proxy: ${polymarketProxyAddress}`,
        );

        // Update input field value
        const proxyInput = document.getElementById("real-proxy-input");
        if (proxyInput) {
          proxyInput.value = polymarketProxyAddress;
        }
        return;
      } else {
        logToConsole(`[SYS] Profile loaded but no proxy address field found in data.`);
      }
    } else {
      logToConsole(`[SYS] Profile API returned status: ${response.status} ${response.statusText}`);
    }
    // Fallback: try local server CORS proxy endpoint to query Polymarket API securely
    const legacyUrl = `/api/proxy?address=${eoa.toLowerCase()}`;
    logToConsole(`[SYS] Querying legacy proxy server endpoint: ${legacyUrl}`);
    const legacyResponse = await fetch(legacyUrl);
    if (legacyResponse.ok) {
      const legacyData = await legacyResponse.json();
      logToConsole(`[SYS] Legacy proxy API response: ${JSON.stringify(legacyData)}`);
      if (legacyData && legacyData.proxyWallet) {
        polymarketProxyAddress = legacyData.proxyWallet.toLowerCase();
        logToConsole(
          `[SYS] Successfully resolved Polymarket Proxy (legacy): ${polymarketProxyAddress}`,
        );
        const proxyInput = document.getElementById("real-proxy-input");
        if (proxyInput) {
          proxyInput.value = polymarketProxyAddress;
        }
        return;
      } else {
        logToConsole(`[SYS] Legacy profile loaded but no proxyWallet field found.`);
      }
    } else {
      logToConsole(`[SYS] Legacy proxy API returned status: ${legacyResponse.status}`);
    }
    logToConsole(
      `[SYS] No proxy wallet found for EOA. Using EOA directly. You can set it manually in the Proxy field.`,
    );
    polymarketProxyAddress = "";
  } catch (err) {
    logToConsole(
      `[ERR] Failed to resolve Polymarket Proxy automatically: ${err.message || err}. You can set it manually.`,
    );
  }
}

// Manual Forced Order Dispatcher (Paper vs Real mode)
function executeManualTrade(outcome) {
  if (!navigator.onLine) {
    logToConsole(`[ERR] Action blocked: System is offline.`);
    return;
  }
  if (!activeMarket) {
    logToConsole(`[SYS] Manual action blocked: No active market loaded.`);
    return;
  }

  if (paperTradingEnabled) {
    // Execute simulated paper trade instantly
    const price = getCurrentPrice(outcome);
    if (price <= 0 || isNaN(price)) {
      logToConsole(`[SYS] Manual entry blocked: invalid price for ${outcome}.`);
      return;
    }

    // If holding opposite, close it first
    const opposite = outcome === "YES" ? "NO" : "YES";
    if (paperActivePosition && paperActivePosition.outcome === opposite) {
      logToConsole(
        `[SYS] Manual entry: Flipped direction. Closing opposite ${opposite} position.`,
      );
      closePaperPosition(getCurrentPrice(opposite), "MANUAL FLIP");
    }

    // If already holding same, do nothing
    if (paperActivePosition && paperActivePosition.outcome === outcome) {
      logToConsole(`[SYS] Manual entry: Already holding ${outcome} position.`);
      return;
    }

    const qty = 100;
    const cost = qty * price;
    if (cost < MIN_TRADE_COST_USDC) {
      logToConsole(
        `[SYS] Manual entry blocked: order value $${cost.toFixed(2)} is below the $${MIN_TRADE_COST_USDC.toFixed(2)} minimum.`,
      );
      return;
    }
    if (paperTradingWallet < cost) {
      logToConsole(
        `[SYS] Manual entry: Insufficient funds (Cost: $${cost.toFixed(2)}, Balance: $${paperTradingWallet.toFixed(2)}).`,
      );
      return;
    }

    paperTradingWallet -= cost;
    paperActivePosition = {
      outcome: outcome,
      entryPrice: price,
      highestPnlPct: 0.0,
      qty: qty,
      cost: cost,
      timestamp: Date.now(),
    };
    logToConsole(
      `[TRADE] MANUAL FORCE: Bought ${outcome} (100 contracts) at $${price.toFixed(3)} USDC`,
    );
    updatePaperTradingUI();
  } else {
    executeRealTrade(outcome, "BUY", null, "MANUAL FORCE");
  }
}

// Manual Forced Position Exit Dispatcher
function executeManualExit() {
  if (!navigator.onLine) {
    logToConsole(`[ERR] Action blocked: System is offline.`);
    return;
  }
  if (paperTradingEnabled) {
    if (!paperActivePosition) {
      logToConsole(`[SYS] Manual exit: No active position to close.`);
      return;
    }
    const outcome = paperActivePosition.outcome;
    const price = getCurrentPrice(outcome);
    closePaperPosition(price, "MANUAL EXIT");
  } else {
    closeRealPosition("MANUAL EXIT");
  }
}
