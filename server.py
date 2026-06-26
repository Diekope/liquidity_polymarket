import http.server
import socketserver
import sys
import urllib.request
import urllib.error
import json
import base64
import hmac
import hashlib
import time
import os

PORT = 8000
CREDS_FILE = "clob_creds.json"

def load_creds():
    if os.path.exists(CREDS_FILE):
        try:
            with open(CREDS_FILE, "r") as f:
                return json.load(f)
        except Exception:
            return {}
    return {}

def save_creds(creds):
    try:
        with open(CREDS_FILE, "w") as f:
            json.dump(creds, f)
    except Exception as e:
        print(f"Failed to save credentials: {e}", file=sys.stderr)


class ProxyHandler(http.server.SimpleHTTPRequestHandler):
    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self):
        if self.path.startswith("/api/proxy"):
            # Extract target query (e.g. address=0x...)
            parts = self.path.split("?")
            query = parts[1] if len(parts) > 1 else ""
            if not query.startswith("address=0x"):
                self.send_error(400, "Invalid query")
                return
            target_url = f"https://polymarket.com/api/profile/userData?{query}"
            try:
                req = urllib.request.Request(
                    target_url, headers={"User-Agent": "Mozilla/5.0"}
                )
                with urllib.request.urlopen(req, timeout=10) as response:
                    data = response.read()
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Access-Control-Allow-Origin", "*")
                    self.end_headers()
                    self.wfile.write(data)
            except Exception as e:
                self.send_response(500)
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(str(e).encode())
        elif self.path.startswith("/api/clob/status"):
            # Check status of credentials for a given address
            parts = self.path.split("?")
            query = parts[1] if len(parts) > 1 else ""
            address = ""
            for param in query.split("&"):
                if param.startswith("address="):
                    address = param.split("=")[1].lower()
            
            creds = load_creds()
            has_creds = address in creds
            
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps({"has_creds": has_creds}).encode())
        else:
            # Serve static files normally
            super().do_GET()

    def do_POST(self):
        if self.path == "/api/clob/auth":
            content_length = int(self.headers['Content-Length'])
            post_data = self.rfile.read(content_length)
            try:
                body = json.loads(post_data.decode('utf-8'))
                address = body.get('address').lower()
                signature = body.get('signature')
                timestamp = str(body.get('timestamp'))
                nonce = str(body.get('nonce', '0'))
                
                # Setup L1 headers for Polymarket API Key management
                headers = {
                    "Content-Type": "application/json",
                    "POLY_ADDRESS": address,
                    "POLY_SIGNATURE": signature,
                    "POLY_TIMESTAMP": timestamp,
                    "POLY_NONCE": nonce
                }
                
                # 1. Try to derive API Key first
                derive_url = "https://clob.polymarket.com/auth/derive-api-key"
                req = urllib.request.Request(derive_url, method="GET", headers=headers)
                
                creds_data = None
                try:
                    with urllib.request.urlopen(req, timeout=10) as resp:
                        res_json = json.loads(resp.read().decode('utf-8'))
                        if res_json and "apiKey" in res_json:
                            creds_data = res_json
                except urllib.error.HTTPError as he:
                    print(f"Derive API Key HTTP error: {he.code}", file=sys.stderr)
                except Exception as ex:
                    print(f"Derive API Key general error: {ex}", file=sys.stderr)
                
                # 2. If derivation failed, create new API Key
                if not creds_data:
                    create_url = "https://clob.polymarket.com/auth/api-key"
                    req = urllib.request.Request(create_url, data=b"{}", method="POST", headers=headers)
                    try:
                        with urllib.request.urlopen(req, timeout=10) as resp:
                            res_json = json.loads(resp.read().decode('utf-8'))
                            if res_json and "apiKey" in res_json:
                                creds_data = res_json
                    except urllib.error.HTTPError as he:
                        err_body = he.read().decode('utf-8')
                        self.send_response(he.code)
                        self.send_header("Content-Type", "application/json")
                        self.send_header("Access-Control-Allow-Origin", "*")
                        self.end_headers()
                        self.wfile.write(err_body.encode())
                        return
                
                if creds_data:
                    all_creds = load_creds()
                    all_creds[address] = {
                        "apiKey": creds_data["apiKey"],
                        "secret": creds_data["secret"],
                        "passphrase": creds_data["passphrase"]
                    }
                    save_creds(all_creds)
                    
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Access-Control-Allow-Origin", "*")
                    self.end_headers()
                    self.wfile.write(json.dumps({"success": True, "creds": creds_data}).encode())
                else:
                    self.send_response(500)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Access-Control-Allow-Origin", "*")
                    self.end_headers()
                    self.wfile.write(json.dumps({"error": "Failed to derive or create CLOB API Key."}).encode())
            except Exception as e:
                self.send_response(500)
                self.send_header("Content-Type", "application/json")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(json.dumps({"error": str(e)}).encode())
                
        elif self.path == "/api/clob/order":
            content_length = int(self.headers['Content-Length'])
            post_data = self.rfile.read(content_length)
            try:
                body = json.loads(post_data.decode('utf-8'))
                owner = body.get('owner').lower()
                
                all_creds = load_creds()
                if owner not in all_creds:
                    self.send_response(401)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Access-Control-Allow-Origin", "*")
                    self.end_headers()
                    self.wfile.write(json.dumps({"error": "CLOB credentials not found. Please activate real trading first."}).encode())
                    return
                
                creds_info = all_creds[owner]
                api_key = creds_info["apiKey"]
                secret = creds_info["secret"]
                passphrase = creds_info["passphrase"]
                
                order_payload = json.dumps(body, separators=(',', ':'))
                timestamp = str(int(time.time()))
                method = "POST"
                path = "/order"
                
                base64_secret = base64.urlsafe_b64decode(secret)
                message = timestamp + method + path + order_payload
                signature = hmac.new(
                    base64_secret,
                    message.encode('utf-8'),
                    hashlib.sha256
                ).digest()
                sig_str = base64.urlsafe_b64encode(signature).decode('utf-8')
                
                headers = {
                    "Content-Type": "application/json",
                    "POLY_ADDRESS": owner,
                    "POLY_SIGNATURE": sig_str,
                    "POLY_TIMESTAMP": timestamp,
                    "POLY_API_KEY": api_key,
                    "POLY_PASSPHRASE": passphrase
                }
                
                clob_url = "https://clob.polymarket.com/order"
                req = urllib.request.Request(clob_url, data=order_payload.encode('utf-8'), method="POST", headers=headers)
                try:
                    with urllib.request.urlopen(req, timeout=10) as resp:
                        res_json = json.loads(resp.read().decode('utf-8'))
                        self.send_response(200)
                        self.send_header("Content-Type", "application/json")
                        self.send_header("Access-Control-Allow-Origin", "*")
                        self.end_headers()
                        self.wfile.write(json.dumps(res_json).encode())
                except urllib.error.HTTPError as he:
                    err_body = he.read().decode('utf-8')
                    print(f"CLOB Order submission failed with HTTP {he.code}: {err_body}", file=sys.stderr)
                    self.send_response(he.code)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Access-Control-Allow-Origin", "*")
                    self.end_headers()
                    self.wfile.write(err_body.encode())
            except Exception as e:
                self.send_response(500)
                self.send_header("Content-Type", "application/json")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(json.dumps({"error": str(e)}).encode())
        else:
            self.send_response(404)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(b"Not Found")


socketserver.TCPServer.allow_reuse_address = True
try:
    with socketserver.TCPServer(("", PORT), ProxyHandler) as httpd:
        print(f"Server started on port {PORT}")
        sys.stdout.flush()
        httpd.serve_forever()
except Exception as e:
    print(f"Error starting server: {e}", file=sys.stderr)
    sys.exit(1)
