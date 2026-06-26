# Liquidity Polymarket 📊

A clean, high-fidelity dashboard and proxy server for managing liquidity, checking balances, and executing trades on the **Polymarket Central Limit Order Book (CLOB)**.

This tool provides a Web3 frontend interface coupled with a local Python proxy server to securely handle Polymarket CLOB authentication (API key derivation/signing) and bypass CORS restrictions.

---

## ✨ Features

- **🔍 Market Discovery**: Instantly lookup Polymarket questions using slugs, keywords, or direct Polymarket URLs.
- **💰 Balance Checker**: Real-time balance queries for Polymarket-relevant tokens on Polygon (Native USDC, Legacy USDC.e, and standard pUSD).
- **🛡️ Secure Key Management**: Derives CLOB API keys securely via MetaMask/EIP-712 signatures. Credentials are kept locally in `clob_creds.json` on the server and are never exposed directly to the browser.
- **⚡ Proxy Server**: Bypasses CORS limitations for the Polymarket profile and CLOB order APIs.
- **💻 Interactive Log Terminal**: Integrated console log viewer within the dashboard for real-time status updates and order execution tracking.

---

## 📁 File Structure

- **`index.html`**: The structure of the dark-themed user interface dashboard.
- **`styles.css`**: Styling containing custom variables, layouts, and animations.
- **`app.js`**: Main frontend controller managing UI state, search parsing, and logging.
- **`trading.js`**: Web3 provider layer for EIP-712 signature generation, ERC-20 balance checks, and fallback public RPC queries.
- **`server.py`**: Python HTTP server serving the static files and proxying requests for `/api/proxy` (CORS bypass) and `/api/clob/*` (API key derivation and order placement).
- **`.gitignore`**: Configured to protect sensitive local credentials (`clob_creds.json`).

---

## 🚀 Getting Started

### Prerequisites

- **Python 3.x** installed on your machine.
- A Web3 browser wallet extension (like **MetaMask**) connected to the **Polygon network**.

### Running the Project

1. **Clone the repository** (if not already done):
   ```bash
   git clone https://github.com/Diekope/liquidity_polymarket.git
   cd liquidity_polymarket
   ```

2. **Start the local server**:
   ```bash
   python server.py
   ```
   The server will start on port `8000` (e.g., `http://localhost:8000`).

3. **Open the Dashboard**:
   Go to your web browser and navigate to:
   ```
   http://localhost:8000
   ```

4. **Connect Wallet & Trade**:
   - Input your Gnosis Safe or wallet address.
   - Use the interface to derive your Polymarket CLOB API Key.
   - Explore markets and manage your orders.

---

## 🔒 Security Notice

- **`clob_creds.json`**: This file is generated dynamically when you authenticate your wallet and contains your derived API Key, Secret, and Passphrase. **Do not share this file.** It has been automatically added to `.gitignore` to prevent committing it to GitHub.
- Private keys are never requested by the server; all signing happens client-side via your Web3 wallet.
