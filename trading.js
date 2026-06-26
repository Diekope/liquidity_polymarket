// Polymarket Web3 Connection & Real Trading Controller
// This file handles MetaMask interaction, network checks, ERC-20 balance retrieval, proxy resolution, and EIP-712 order signing.

// Web3 & Polymarket Real Trading States (Globals shared with app.js)
let connectedWalletAddress = null;
let polymarketProxyAddress = "";
let realPortfolioUsdc = null;
let realTradeAllocationUsdc = null;
let walletConnectionPending = false;
let realTradingEnabled = false;
let realActivePosition = null; // { outcome, entryPrice, qty, cost, timestamp }
let realOrderPending = false;
let realLastAttemptDecision = "NEUTRAL";
let realLastAttemptTime = 0;
let realAttemptStatusText = "IDLE";
let realAttemptStatusClass = "idle";
let realLastExitTime = 0;
let realLastExitOutcome = null;

const POLYGON_CHAIN_ID = "0x89";
const POLYGON_USDC_CONTRACT = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359"; // Native USDC (Polymarket primary since 2024)
const POLYGON_USDCE_CONTRACT = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"; // Bridged USDC.e (legacy fallback)
const POLYGON_PUSD_CONTRACT = "0xc011a7e12a19f7b1f670d46f03b03f3342e82dfb"; // Polymarket USD (pUSD, standard since 2026)
const REAL_PORTFOLIO_ALLOCATION_PCT = 0.1;
const REAL_SIGNAL_RETRY_MS = 250;
const REAL_MAX_ENTRY_PRICE = 0.85;

// Helper to encode balanceOf(address) ERC-20 payload
function encodeErc20BalanceOf(address) {
  return `0x70a08231${address.toLowerCase().replace("0x", "").padStart(64, "0")}`;
}

// Helper to calculate position trade size (10% of portfolio, minimum 1 USDC)
function calculateRealAllocation(balance) {
  if (!Number.isFinite(balance) || balance <= 0) return 0;
  if (balance < MIN_TRADE_COST_USDC) return balance;
  return Math.min(
    balance,
    Math.max(MIN_TRADE_COST_USDC, balance * REAL_PORTFOLIO_ALLOCATION_PCT),
  );
}

// Switch network in MetaMask to Polygon Mainnet (ChainID 137)
async function ensurePolygonNetwork() {
  const chainId = await window.ethereum.request({ method: "eth_chainId" });
  if (chainId && chainId.toLowerCase() === POLYGON_CHAIN_ID.toLowerCase()) {
    return true;
  }

  try {
    logToConsole(
      `[SYS] Switching wallet network to Polygon for USDC balance read...`,
    );
    setRealAttemptStatus("SWITCHING POLYGON", "attempting");
    await window.ethereum.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: POLYGON_CHAIN_ID }],
    });
    return true;
  } catch (switchError) {
    if (switchError && switchError.code === 4902) {
      await window.ethereum.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: POLYGON_CHAIN_ID,
            chainName: "Polygon Mainnet",
            nativeCurrency: {
              name: "POL",
              symbol: "POL",
              decimals: 18,
            },
            rpcUrls: ["https://polygon-rpc.com"],
            blockExplorerUrls: ["https://polygonscan.com"],
          },
        ],
      });
      return true;
    }

    logToConsole(
      `[ERR] Polygon network switch rejected or failed: ${switchError.message || switchError}`,
    );
    setRealAttemptStatus("BLOCKED: NOT POLYGON", "blocked");
    return false;
  }
}

// Query ERC-20 USDC balance via connected window.ethereum or fallback to direct public RPCs
async function fetchErc20BalanceRpc(contractAddress, walletAddress) {
  const data = encodeErc20BalanceOf(walletAddress);
  logToConsole(`[SYS] Querying balance: contract=${contractAddress}, wallet=${walletAddress}`);

  // 1. Try window.ethereum first if MetaMask is connected and on Polygon network
  if (
    typeof window.ethereum !== "undefined" &&
    typeof window.ethereum.request === "function"
  ) {
    try {
      const chainId = await window.ethereum.request({ method: "eth_chainId" });
      logToConsole(`[SYS] window.ethereum chainId: ${chainId}`);
      if (chainId && chainId.toLowerCase() === POLYGON_CHAIN_ID.toLowerCase()) {
        logToConsole(`[SYS] Querying via window.ethereum...`);
        const result = await window.ethereum.request({
          method: "eth_call",
          params: [{ to: contractAddress, data }, "latest"],
        });
        logToConsole(`[SYS] window.ethereum eth_call result: ${result}`);
        if (result && result !== "0x") {
          return BigInt(result);
        }
        return 0n;
      } else {
        logToConsole(`[SYS] window.ethereum is not on Polygon network (expected: ${POLYGON_CHAIN_ID}, got: ${chainId})`);
      }
    } catch (e) {
      logToConsole(`[SYS] window.ethereum query failed: ${e.message || e}. Falling back to public RPCs.`);
    }
  } else {
    logToConsole(`[SYS] window.ethereum not available. Using public RPCs.`);
  }

  // 2. Fallback: Query public Polygon RPC endpoints (using polygon.publicnode.com first to prevent CORS block)
  const POLYGON_RPC_URLS = [
    "https://polygon.publicnode.com",
    "https://rpc.ankr.com/polygon",
    "https://polygon-rpc.com",
  ];
  for (const rpc of POLYGON_RPC_URLS) {
    try {
      logToConsole(`[SYS] Querying public RPC: ${rpc}...`);
      const res = await fetch(rpc, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_call",
          params: [{ to: contractAddress, data }, "latest"],
        }),
      });
      if (!res.ok) {
        logToConsole(`[SYS] RPC ${rpc} returned status: ${res.status}`);
        continue;
      }
      const json = await res.json();
      logToConsole(`[SYS] RPC ${rpc} result: ${JSON.stringify(json)}`);
      if (json.result && json.result !== "0x") {
        return BigInt(json.result);
      }
      if (json.error) {
        logToConsole(`[SYS] RPC ${rpc} error field: ${JSON.stringify(json.error)}`);
      }
      return 0n;
    } catch (e) {
      logToConsole(`[SYS] RPC ${rpc} failed: ${e.message || e}`);
    }
  }
  throw new Error("All Polygon RPC endpoints failed");
}

// Safe wrapper to prevent balance queries for invalid/custom contracts from throwing and blocking the entire query chain
async function fetchErc20BalanceRpcSafe(contractAddress, walletAddress) {
  try {
    return await fetchErc20BalanceRpc(contractAddress, walletAddress);
  } catch (e) {
    logToConsole(`[SYS] Balance query failed/reverted for contract ${contractAddress}: ${e.message || e}`);
    return 0n;
  }
}

// Refresh USDC balances (both Native & legacy fallback)
async function refreshRealPortfolioBalance() {
  if (!connectedWalletAddress) {
    logToConsole(`[SYS] refreshRealPortfolioBalance: connectedWalletAddress is empty.`);
    realPortfolioUsdc = null;
    realTradeAllocationUsdc = null;
    updateRealTradingUI();
    return null;
  }

  try {
    const queryAddress = polymarketProxyAddress
      ? polymarketProxyAddress
      : connectedWalletAddress;
    logToConsole(
      `[SYS] Reading USDC balance for ${polymarketProxyAddress ? "proxy" : "EOA"}: ${queryAddress}...`,
    );

    // Query all contracts in parallel safely
    logToConsole(`[SYS] Launching parallel safe RPC calls for Native USDC, USDC.e, and pUSD...`);
    const [rawNative, rawUSDCe, rawPUSD] = await Promise.all([
      fetchErc20BalanceRpcSafe(POLYGON_USDC_CONTRACT, queryAddress),
      fetchErc20BalanceRpcSafe(POLYGON_USDCE_CONTRACT, queryAddress),
      fetchErc20BalanceRpcSafe(POLYGON_PUSD_CONTRACT, queryAddress),
    ]);

    logToConsole(`[SYS] Raw BigInt balance results: Native USDC = ${rawNative}, USDC.e = ${rawUSDCe}, pUSD = ${rawPUSD}`);

    const nativeUsdc = Number(rawNative) / 1e6;
    const usdcE = Number(rawUSDCe) / 1e6;
    const pUSD = Number(rawPUSD) / 1e6;

    realPortfolioUsdc = nativeUsdc + usdcE + pUSD;
    realTradeAllocationUsdc = calculateRealAllocation(realPortfolioUsdc);

    logToConsole(
      `[SYS] Balance: Native USDC = $${nativeUsdc.toFixed(2)}, USDC.e = $${usdcE.toFixed(2)}, pUSD = $${pUSD.toFixed(2)} → Total: $${realPortfolioUsdc.toFixed(2)}`,
    );

    if (realPortfolioUsdc <= 0) {
      logToConsole(`[SYS] Wallet USDC balance is $0.00 on Polygon.`);
      setRealAttemptStatus("BLOCKED: BALANCE 0", "blocked");
    }
    updateRealTradingUI();
    return realPortfolioUsdc;
  } catch (e) {
    logToConsole(`[ERR] Failed to read wallet USDC balance: ${e.message || e}`);
    realPortfolioUsdc = null;
    realTradeAllocationUsdc = null;
    updateRealTradingUI();
    return null;
  }
}

// Estimate order size based on USDC balance and current market price
async function calculateRealOrderSize(outcome) {
  const price = getCurrentPrice(outcome);
  if (price <= 0 || isNaN(price)) {
    logToConsole(`[SYS] Real trade blocked: invalid price for ${outcome}.`);
    setRealAttemptStatus("BLOCKED: BAD PRICE", "blocked");
    return null;
  }
  if (price >= REAL_MAX_ENTRY_PRICE) {
    logToConsole(
      `[SYS] Real trade blocked: ${outcome} price is too high ($${price.toFixed(3)} >= $${REAL_MAX_ENTRY_PRICE.toFixed(2)}).`,
    );
    setRealAttemptStatus(
      `BLOCKED: ${outcome} >= ${REAL_MAX_ENTRY_PRICE.toFixed(2)}`,
      "blocked",
    );
    return null;
  }

  // Reload/refresh balance first to ensure we have current funds
  const balance = await refreshRealPortfolioBalance();
  if (balance === null || balance <= 0) {
    logToConsole(`[SYS] Real trade blocked: USDC balance is zero or null.`);
    setRealAttemptStatus("BLOCKED: USDC 0", "blocked");
    return null;
  }

  const tradeCost = calculateRealAllocation(balance);
  if (tradeCost < MIN_TRADE_COST_USDC) {
    logToConsole(
      `[SYS] Real trade blocked: allocation $${tradeCost.toFixed(2)} is below minimum $${MIN_TRADE_COST_USDC.toFixed(2)}.`,
    );
    setRealAttemptStatus("BLOCKED: < $1 ALLOC", "blocked");
    return null;
  }

  let qty = Math.floor(tradeCost / price);
  if (qty * price < MIN_TRADE_COST_USDC) {
    qty = Math.ceil(MIN_TRADE_COST_USDC / price);
  }

  const cost = qty * price;
  if (cost > balance) {
    logToConsole(`[SYS] Real trade blocked: cost $${cost.toFixed(2)} exceeds wallet balance $${balance.toFixed(2)}.`);
    setRealAttemptStatus("BLOCKED: BALANCE", "blocked");
    return null;
  }

  if (qty <= 0) {
    logToConsole(`[SYS] Real trade blocked: calculated quantity is 0.`);
    setRealAttemptStatus("BLOCKED: QTY 0", "blocked");
    return null;
  }

  return {
    qty,
    price,
    cost,
    portfolioUsdc: balance,
  };
}

// Evaluate signal and trigger trade execution
function maybeExecuteRealSignal(decision, force = false) {
  if (
    !realTradingEnabled ||
    realOrderPending ||
    !isActionableTradingSignal(decision)
  ) {
    return;
  }

  const desiredOutcome = getOutcomeFromDecision(decision);
  const currentPrice = desiredOutcome ? getCurrentPrice(desiredOutcome) : 0;
  if (currentPrice >= REAL_MAX_ENTRY_PRICE) {
    setRealAttemptStatus(
      `BLOCKED: ${desiredOutcome} >= ${REAL_MAX_ENTRY_PRICE.toFixed(2)}`,
      "blocked",
    );
    return;
  }

  const now = Date.now();
  const shouldRetry =
    force ||
    decision !== realLastAttemptDecision ||
    now - realLastAttemptTime >= REAL_SIGNAL_RETRY_MS;

  if (!shouldRetry) return;

  realLastAttemptDecision = decision;
  realLastAttemptTime = now;
  setRealAttemptStatus(`SIGNAL ${decision}`, "attempting");
  checkAndExecuteRealTrades(decision);
}

// Analyze signal and execute buy/sell/flip orders
function checkAndExecuteRealTrades(decision) {
  if (!realTradingEnabled || realOrderPending) return;
  if (!navigator.onLine) {
    logToConsole(`[ERR] Real trade execution blocked: System is offline.`);
    setRealAttemptStatus("BLOCKED: OFFLINE", "blocked");
    return;
  }
  if (!activeMarket) {
    logToConsole(`[SYS] Real trade blocked: No active market loaded.`);
    setRealAttemptStatus("BLOCKED: NO MARKET", "blocked");
    return;
  }
  if (!connectedWalletAddress) {
    logToConsole(`[SYS] Real trade blocked: Web3 wallet is not connected.`);
    setRealAttemptStatus("BLOCKED: NO WALLET", "blocked");
    setRealTradingEnabled(false);
    return;
  }

  const holdTimeSecs = realActivePosition
    ? (Date.now() - realActivePosition.timestamp) / 1000
    : 999;
  if (holdTimeSecs < paperMinHoldSecs) {
    return;
  }

  const isBullish = decision.includes("BUY YES");
  const isBearish = decision.includes("BUY NO");
  if (!isBullish && !isBearish) {
    logToConsole(
      `[SYS] Real trading idle: waiting for BUY YES / BUY NO signal (current: ${decision || "EMPTY"}).`,
    );
    setRealAttemptStatus("IDLE: NO SIGNAL", "idle");
    return;
  }

  if (activeMarket.endDate) {
    const timeLeftSecs =
      Math.floor(new Date(activeMarket.endDate).getTime() / 1000) -
      Math.floor(Date.now() / 1000);
    if (timeLeftSecs <= 60) {
      logToConsole(
        `[SYS] Real entry skipped: only ${Math.max(0, timeLeftSecs)}s remaining (1m expiration lock active).`,
      );
      setRealAttemptStatus("BLOCKED: EXPIRING", "blocked");
      return;
    }
  }

  const now = Date.now();
  const isYesCooldown =
    realLastExitOutcome === "YES" && now - realLastExitTime < 10000;
  const isNoCooldown =
    realLastExitOutcome === "NO" && now - realLastExitTime < 10000;

  if (isBullish && isYesCooldown) {
    const cooldownLeft = Math.ceil((10000 - (now - realLastExitTime)) / 1000);
    logToConsole(
      `[SYS] Skipping Real YES entry: system in cooldown for ${cooldownLeft}s.`,
    );
    setRealAttemptStatus(`COOLDOWN: ${cooldownLeft}s`, "blocked");
    return;
  }
  if (isBearish && isNoCooldown) {
    const cooldownLeft = Math.ceil((10000 - (now - realLastExitTime)) / 1000);
    logToConsole(
      `[SYS] Skipping Real NO entry: system in cooldown for ${cooldownLeft}s.`,
    );
    setRealAttemptStatus(`COOLDOWN: ${cooldownLeft}s`, "blocked");
    return;
  }

  const desiredOutcome = isBullish ? "YES" : "NO";
  const desiredPrice = getCurrentPrice(desiredOutcome);
  if (desiredPrice >= REAL_MAX_ENTRY_PRICE) {
    logToConsole(
      `[SYS] Real entry skipped: ${desiredOutcome} price is too high ($${desiredPrice.toFixed(3)} >= $${REAL_MAX_ENTRY_PRICE.toFixed(2)}).`,
    );
    setRealAttemptStatus(
      `BLOCKED: ${desiredOutcome} >= ${REAL_MAX_ENTRY_PRICE.toFixed(2)}`,
      "blocked",
    );
    return;
  }

  if (realActivePosition && realActivePosition.outcome === desiredOutcome) {
    logToConsole(
      `[SYS] Real trading holds ${desiredOutcome}; no duplicate buy needed.`,
    );
    setRealAttemptStatus(`HOLDING ${desiredOutcome}`, "success");
    return;
  }
  if (realActivePosition) {
    logToConsole(
      `[SYS] Real signal flipped. Selling active ${realActivePosition.outcome} before opening ${desiredOutcome}.`,
    );
    closeRealPosition("TREND CHANGE");
    return;
  }

  executeRealTrade(desiredOutcome, "BUY", null, "AUTO SIGNAL");
}

// Connect, format and check balance before sending to signature
async function executeRealTrade(outcome, side, qty, reason = "MANUAL") {
  if (!connectedWalletAddress) {
    logToConsole(
      `[SYS] REAL TRADE BLOCKED: Please connect your Web3 wallet first.`,
    );
    setRealAttemptStatus("BLOCKED: NO WALLET", "blocked");
    alert(
      "Please connect your Web3 wallet using the 'CONNECT WALLET' button in the header before attempting real trades!",
    );
    return;
  }
  if (!activeMarket) {
    logToConsole(`[SYS] REAL TRADE BLOCKED: No active market loaded.`);
    setRealAttemptStatus("BLOCKED: NO MARKET", "blocked");
    return;
  }
  if (realOrderPending) {
    logToConsole(
      `[SYS] REAL TRADE BLOCKED: another wallet signature is pending.`,
    );
    setRealAttemptStatus("PENDING WALLET", "attempting");
    return;
  }
  if (side === "BUY" && realActivePosition) {
    if (realActivePosition.outcome === outcome) {
      logToConsole(
        `[SYS] REAL TRADE BLOCKED: already tracking an active ${outcome} position.`,
      );
      setRealAttemptStatus(`HOLDING ${outcome}`, "success");
      return;
    }
    logToConsole(
      `[SYS] Real manual flip requested. Selling active ${realActivePosition.outcome} before opening ${outcome}.`,
    );
    closeRealPosition("MANUAL FLIP");
    return;
  }
  if (
    side === "SELL" &&
    (!realActivePosition || realActivePosition.outcome !== outcome)
  ) {
    logToConsole(
      `[SYS] REAL EXIT BLOCKED: no tracked ${outcome} position to sell.`,
    );
    setRealAttemptStatus("BLOCKED: NO POSITION", "blocked");
    return;
  }

  let orderSize = null;
  if (side === "BUY") {
    orderSize = await calculateRealOrderSize(outcome);
    if (!orderSize) return;
    qty = orderSize.qty;
  } else if (realActivePosition) {
    qty = realActivePosition.qty;
    orderSize = {
      qty,
      price: getCurrentPrice(outcome),
      cost: qty * getCurrentPrice(outcome),
      portfolioUsdc: realPortfolioUsdc,
    };
  }

  realOrderPending = true;
  setRealAttemptStatus(`${side} ${outcome}: PREPARING`, "attempting");
  updateRealTradingUI();
  logToConsole(`[SYS] INITIATING REAL ${side} ORDER (${reason})...`);
  signRealPolymarketOrder(outcome, side, qty, reason, orderSize);
}

// Exit tracked real position
function closeRealPosition(reason = "SELL ALL") {
  if (!realActivePosition) {
    logToConsole(`[SYS] Real exit: No tracked real position to sell.`);
    updateRealTradingUI();
    return;
  }
  executeRealTrade(
    realActivePosition.outcome,
    "SELL",
    realActivePosition.qty,
    reason,
  );
}

// Formulate EIP-712 Order struct and request MetaMask signature
async function signRealPolymarketOrder(
  outcome,
  side,
  qty,
  reason = "MANUAL",
  orderSize = null,
) {
  if (typeof window.ethereum === "undefined") {
    logToConsole(`[ERR] MetaMask / Web3 provider not detected.`);
    realOrderPending = false;
    setRealAttemptStatus("ERROR: NO METAMASK", "error");
    updateRealTradingUI();
    return;
  }

  // Get tokenId from active market
  const tokenIds = Object.keys(tokenMap);
  let tokenId = "";
  if (outcome === "YES" && tokenIds.length > 0) {
    tokenId = tokenIds[0];
  } else if (outcome === "NO" && tokenIds.length > 1) {
    tokenId = tokenIds[1];
  } else {
    logToConsole(
      `[ERR] Real trade error: Token ID not found for outcome ${outcome}.`,
    );
    realOrderPending = false;
    setRealAttemptStatus("ERROR: NO TOKEN", "error");
    updateRealTradingUI();
    return;
  }

  const price =
    orderSize && orderSize.price ? orderSize.price : getCurrentPrice(outcome);
  const cost = orderSize && orderSize.cost ? orderSize.cost : qty * price;
  if (cost < MIN_TRADE_COST_USDC) {
    logToConsole(
      `[SYS] Real trade blocked: order value $${cost.toFixed(2)} is below the $${MIN_TRADE_COST_USDC.toFixed(2)} minimum.`,
    );
    realOrderPending = false;
    setRealAttemptStatus("BLOCKED: < $1 ORDER", "blocked");
    updateRealTradingUI();
    return;
  }

  logToConsole(
    `[SYS] Ordering ${formatContractQty(qty)} contracts of ${outcome} (Token: ${tokenId.substring(0, 10)}...) at estimated price of $${price.toFixed(3)} ($${cost.toFixed(2)} USDC)`,
  );

  try {
    const msgParams = {
      domain: {
        name: "Polymarket CTF Exchange",
        version: "1",
        chainId: 137, // Polygon mainnet
        verifyingContract: "0x4b70c20f3e17cf6d03cf1c3e390c5bca138cb56d",
      },
      message: {
        salt: Math.floor(Math.random() * 1000000000).toString(),
        maker: polymarketProxyAddress ? polymarketProxyAddress : connectedWalletAddress,
        signer: connectedWalletAddress,
        taker: "0x0000000000000000000000000000000000000000",
        tokenId: tokenId,
        makerAmount: Math.floor(qty * 10 ** 6).toString(),
        takerAmount: Math.floor(cost * 10 ** 6).toString(),
        expiration: (Math.floor(Date.now() / 1000) + 3600).toString(),
        nonce: "0",
        feeRateBps: "0",
        side: side === "BUY" ? 0 : 1, // 0 = BUY, 1 = SELL
      },
      primaryType: "Order",
      types: {
        EIP712Domain: [
          { name: "name", type: "string" },
          { name: "version", type: "string" },
          { name: "chainId", type: "uint256" },
          { name: "verifyingContract", type: "address" },
        ],
        Order: [
          { name: "salt", type: "uint256" },
          { name: "maker", type: "address" },
          { name: "signer", type: "address" },
          { name: "taker", type: "address" },
          { name: "tokenId", type: "uint256" },
          { name: "makerAmount", type: "uint256" },
          { name: "takerAmount", type: "uint256" },
          { name: "expiration", type: "uint256" },
          { name: "nonce", type: "uint256" },
          { name: "feeRateBps", type: "uint256" },
          { name: "side", type: "uint8" },
        ],
      },
    };

    const from = connectedWalletAddress;
    const params = [from, JSON.stringify(msgParams)];
    const method = "eth_signTypedData_v4";

    logToConsole(
      `[SYS] Sending signature request eth_signTypedData_v4 to wallet...`,
    );
    setRealAttemptStatus(`${side} ${outcome}: WALLET SIGN`, "attempting");

    const handleSignedOrder = async (signature) => {
      logToConsole(`[SYS] EIP-712 Order Signed Successfully!`);
      logToConsole(`[SYS] Signature: ${signature.substring(0, 30)}...`);
      logToConsole(
        `[SYS] Dispatching payload package to CLOB Endpoint via local proxy...`,
      );

      const orderPayload = {
        order: {
          salt: msgParams.message.salt,
          maker: msgParams.message.maker,
          signer: msgParams.message.signer,
          taker: msgParams.message.taker,
          tokenId: msgParams.message.tokenId,
          makerAmount: msgParams.message.makerAmount,
          takerAmount: msgParams.message.takerAmount,
          expiration: msgParams.message.expiration,
          nonce: parseInt(msgParams.message.nonce),
          feeRateBps: parseInt(msgParams.message.feeRateBps),
          side: msgParams.message.side,
          signature: signature
        },
        owner: connectedWalletAddress,
        orderType: "GTC"
      };

      try {
        const response = await fetch("/api/clob/order", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(orderPayload)
        });
        
        if (response.ok) {
          const resJson = await response.json();
          logToConsole(`[SYS] CLOB Order Response: ${JSON.stringify(resJson)}`);
          
          if (side === "BUY") {
            realActivePosition = {
              outcome: outcome,
              entryPrice: price,
              qty: qty,
              cost: cost,
              timestamp: Date.now(),
              highestPnlPct: 0.0,
            };
            logToConsole(
              `[TRADE] REAL ${reason}: Bought ${outcome} (${formatContractQty(qty)} contracts) at estimated $${price.toFixed(3)} for $${cost.toFixed(2)} USDC.`,
            );
            setRealAttemptStatus(`BUY ${outcome} CONFIRMED`, "success");
          } else {
            logToConsole(
              `[TRADE] REAL ${reason}: Sell order confirmed for ${outcome} (${formatContractQty(qty)} contracts) at estimated $${price.toFixed(3)}.`,
            );
            realLastExitTime = Date.now();
            realLastExitOutcome = outcome;
            realActivePosition = null;
            setRealAttemptStatus(`SELL ${outcome} CONFIRMED`, "success");
          }
        } else {
          const errText = await response.text();
          logToConsole(`[ERR] CLOB Order submission failed: ${errText}`);
          setRealAttemptStatus("ORDER FAILED", "error");
        }
      } catch (err) {
        logToConsole(`[ERR] Failed to submit CLOB order: ${err.message || err}`);
        setRealAttemptStatus("ORDER ERROR", "error");
      }
      
      realOrderPending = false;
      updateRealTradingUI();
    };

    if (typeof window.ethereum.request === "function") {
      const signature = await window.ethereum.request({ method, params });
      handleSignedOrder(signature);
    } else if (typeof window.ethereum.sendAsync === "function") {
      window.ethereum.sendAsync(
        { method, params, from },
        function (err, result) {
          if (err) {
            logToConsole(
              `[ERR] Signature request failed: ${err.message || err}`,
            );
            realOrderPending = false;
            setRealAttemptStatus("ERROR: SIGN REJECTED", "error");
            updateRealTradingUI();
            return;
          }
          if (result.error) {
            logToConsole(
              `[ERR] Wallet returned error: ${result.error.message}`,
            );
            realOrderPending = false;
            setRealAttemptStatus("ERROR: WALLET", "error");
            updateRealTradingUI();
            return;
          }
          handleSignedOrder(result.result);
        },
      );
    } else {
      throw new Error("Wallet provider does not support EIP-712 signing.");
    }
  } catch (e) {
    logToConsole(`[ERR] Order formulation failed: ${e.message}`);
    realOrderPending = false;
    setRealAttemptStatus("ERROR: ORDER FAILED", "error");
    updateRealTradingUI();
  }
}

// Connect Web3 Wallet
async function connectWeb3Wallet() {
  const connectBtn = document.getElementById("web3-connect-btn");

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
        connectBtn.textContent = "COPIED!";
        connectBtn.style.color = "var(--bb-cyan)";
        connectBtn.style.borderColor = "var(--bb-cyan)";

        setTimeout(() => {
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

// Automatically resolve Polymarket Gnosis Safe proxy wallet address from connected EOA
// Automatically resolve Polymarket Gnosis Safe proxy wallet address from connected EOA
async function resolvePolymarketProxy(eoa) {
  if (!eoa) return;
  try {
    logToConsole(`[SYS] Resolving Polymarket Proxy wallet for EOA: ${eoa}...`);
    // Try data-api endpoint first (CORS allowed on this endpoint)
    const url = `https://data-api.polymarket.com/profile?address=${eoa.toLowerCase()}`;
    logToConsole(`[SYS] Querying Polymarket profile API: ${url}`);
    const response = await fetch(url);
    if (response.ok) {
      const data = await response.json();
      logToConsole(`[SYS] Polymarket profile API response: ${JSON.stringify(data)}`);
      const profile = Array.isArray(data) ? data[0] : data;
      const proxy =
        profile &&
        (profile.proxyWallet || profile.proxy_wallet || profile.proxyAddress);
      if (proxy) {
        polymarketProxyAddress = proxy.toLowerCase();
        logToConsole(
          `[SYS] Successfully resolved Polymarket Proxy: ${polymarketProxyAddress}`,
        );

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
          `[SYS] Successfully resolved Polymarket Proxy (legacy/proxy): ${polymarketProxyAddress}`,
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

// Enable/disable real trading mode
function setRealTradingEnabled(enabled) {
  if (enabled) {
    if (!navigator.onLine) {
      logToConsole(`[ERR] Real trading activation blocked: System is offline.`);
      realTradingEnabled = false;
      updateRealTradingUI();
      return;
    }
    if (!connectedWalletAddress) {
      logToConsole(
        `[SYS] Real trading activation blocked: connect your Web3 wallet first.`,
      );
      alert("Connect your Web3 wallet before activating real trading.");
      realTradingEnabled = false;
      updateRealTradingUI();
      return;
    }
    if (!activeMarket) {
      logToConsole(
        `[SYS] Real trading activation blocked: no active market loaded.`,
      );
      alert("Load a market before activating real trading.");
      realTradingEnabled = false;
      updateRealTradingUI();
      return;
    }

    realTradingEnabled = true;
    logToConsole(`[SYS] Automated Real Trading: ENABLED`);
    refreshRealPortfolioBalance();
    maybeExecuteRealSignal(currentRecommendation, true);
    updateRealTradingUI();
    return;
  }

  if (realTradingEnabled) {
    logToConsole(`[SYS] Automated Real Trading: DISABLED`);
  }
  realTradingEnabled = false;
  setRealAttemptStatus("IDLE", "idle");
  if (!paperTradingEnabled) {
    clearTimeout(signalDelayTimeout);
  }

  if (realActivePosition) {
    closeRealPosition("REAL TRADING DISABLED");
  }
}
