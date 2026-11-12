const http = require("http");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    }).on("error", reject);
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class CDPClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.id = 1;
    this.pending = new Map();
  }

  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = reject;
    });

    this.ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) {
          reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        } else {
          resolve(msg.result);
        }
      }
    };
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = this.id++;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expression) {
    const res = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (res.exceptionDetails) {
      throw new Error(`Eval exception: ${res.exceptionDetails.text || JSON.stringify(res.exceptionDetails)}`);
    }
    return res.result?.value;
  }

  close() {
    if (this.ws) {
      this.ws.close();
    }
  }
}

async function captureScreenshots() {
  console.log("=== Capturing Adversarial Audit Browser Screenshots ===");
  const edgePath = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
  const userDataDir = path.join(process.env.TEMP || "C:\\temp", "plinthly_adv_audit_" + Date.now());

  const browserProc = spawn(edgePath, [
    "--headless=new",
    "--remote-debugging-port=9222",
    `--user-data-dir=${userDataDir}`,
    "--window-size=1400,1200",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
  ], { stdio: "ignore" });

  try {
    let connected = false;
    let versionInfo = null;
    for (let i = 0; i < 20; i++) {
      await delay(500);
      try {
        versionInfo = await getJson("http://127.0.0.1:9222/json/version");
        connected = true;
        break;
      } catch {}
    }

    if (!connected || !versionInfo) {
      throw new Error("Failed to connect to browser CDP port 9222.");
    }

    const targets = await getJson("http://127.0.0.1:9222/json/list");
    const pageTarget = targets.find((t) => t.type === "page") || targets[0];
    const cdp = new CDPClient(pageTarget.webSocketDebuggerUrl);
    await cdp.connect();

    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");

    // Screenshot 1: Clean Form Initial State (Empty defaults, safe manual entry)
    console.log("[1/3] Loading home page clean initial form state...");
    await cdp.send("Page.navigate", { url: "http://127.0.0.1:3000" });
    await delay(2000);

    const shot1 = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
    const shot1Path = path.join(process.cwd(), "docs", "evidence", "screenshots", "01_empty_safe_form_state.png");
    fs.writeFileSync(shot1Path, Buffer.from(shot1.data, "base64"));
    console.log(`Saved: ${shot1Path}`);

    // Screenshot 2: Target Purchase Loaded with Blocked Approval State
    console.log("[2/3] Loading target purchase and attempting blocked approval...");
    await cdp.send("Page.navigate", { url: "http://127.0.0.1:3000/?purchaseId=pur_1794149129429_osas38ir" });
    await delay(2500);

    // Click Evaluate Strategies
    await cdp.eval(`
      (() => {
        const btns = Array.from(document.querySelectorAll('button'));
        const btn = btns.find(b => b.textContent.includes('Evaluate Multi-Item Plan') || b.textContent.includes('Re-Evaluate Strategies'));
        if (btn) btn.click();
      })()
    `);
    await delay(1500);

    // Attempt to click "Approve Strategy" on first strategy
    const approvalAttemptResult = await cdp.eval(`
      (() => {
        const btns = Array.from(document.querySelectorAll('button'));
        const approveBtn = btns.find(b => b.textContent.includes('Approve Strategy') || b.textContent.includes('Approve and Lock'));
        if (approveBtn) {
          approveBtn.click();
          return "clicked";
        }
        return "not_found";
      })()
    `);
    console.log("Approve button attempt:", approvalAttemptResult);
    await delay(1500);

    const shot2 = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
    const shot2Path = path.join(process.cwd(), "docs", "evidence", "screenshots", "02_blocked_approval_unquoted_shipping.png");
    fs.writeFileSync(shot2Path, Buffer.from(shot2.data, "base64"));
    console.log(`Saved: ${shot2Path}`);

    // Screenshot 3: Synthetic Demo Fixture Active State
    console.log("[3/3] Loading synthetic demo fixture...");
    await cdp.eval(`
      (() => {
        const btns = Array.from(document.querySelectorAll('button'));
        const fixBtn = btns.find(b => b.textContent.includes('Load Demo Fixture'));
        if (fixBtn) fixBtn.click();
      })()
    `);
    await delay(2000);

    const shot3 = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
    const shot3Path = path.join(process.cwd(), "docs", "evidence", "screenshots", "03_synthetic_demo_fixture_banner.png");
    fs.writeFileSync(shot3Path, Buffer.from(shot3.data, "base64"));
    console.log(`Saved: ${shot3Path}`);

    cdp.close();
  } finally {
    browserProc.kill();
  }
}

captureScreenshots().catch(console.error);

