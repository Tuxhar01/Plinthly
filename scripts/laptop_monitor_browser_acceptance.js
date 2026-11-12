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
    this.consoleLogs = [];
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
      } else if (msg.method === "Runtime.consoleAPICalled") {
        const text = msg.params.args.map((a) => a.value ?? a.description ?? "").join(" ");
        this.consoleLogs.push({ type: msg.params.type, text });
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

async function runAcceptanceCheck() {
  console.log("=== Target Laptop + Monitor Browser UI Acceptance Check ===");
  const edgePath = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
  const userDataDir = path.join(process.env.TEMP || "C:\\temp", "plinthly_browser_target_" + Date.now());

  console.log("[1/6] Launching headless Edge browser...");
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
      throw new Error("Failed to connect to browser CDP port 9222 after 10s.");
    }
    console.log(`[2/6] Connected to browser: ${versionInfo.Browser}`);

    const targets = await getJson("http://127.0.0.1:9222/json/list");
    const pageTarget = targets.find((t) => t.type === "page") || targets[0];
    const cdp = new CDPClient(pageTarget.webSocketDebuggerUrl);
    await cdp.connect();

    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");

    const targetPurchaseId = "pur_1794149129429_osas38ir";
    const targetUrl = `http://127.0.0.1:3000/?purchaseId=${targetPurchaseId}`;
    console.log(`[3/6] Navigating to ${targetUrl}...`);
    await cdp.send("Page.navigate", { url: targetUrl });

    // Wait for purchase to load
    let loaded = false;
    for (let i = 0; i < 30; i++) {
      await delay(500);
      const text = await cdp.eval("document.body.innerText");
      if (text && text.includes(targetPurchaseId) && text.includes("Multi-Item Procurement Studio")) {
        console.log(`Purchase loaded successfully after ${(i + 1) * 500}ms!`);
        loaded = true;
        break;
      }
    }

    if (!loaded) {
      throw new Error("Failed to load purchase in UI within 15 seconds.");
    }

    // Inspect initial line items rendered in Studio
    console.log("\n[4/6] Inspecting line items rendered in Multi-Item Procurement Studio...");
    const lineItemDetails = await cdp.eval(`
      (() => {
        const text = document.body.innerText;
        return {
          hasLaptop: text.includes("laptop for software development"),
          hasMonitor: text.includes("monitor"),
          hasRequirementsConfirmed: text.includes("REQUIREMENTS_CONFIRMED"),
          hasBudget1500: text.includes("$1,500.00") || text.includes("$1500"),
          hasZip98101: text.includes("98101"),
          hasSyntheticFixtureBanner: text.includes("Synthetic Demo Fixture Active")
        };
      })()
    `);
    console.log("Line Items in UI:", JSON.stringify(lineItemDetails, null, 2));

    // Click "Evaluate Multi-Item Plan" button
    console.log("\n[5/6] Clicking 'Evaluate Multi-Item Plan' / 'Re-Evaluate Strategies'...");
    await cdp.eval(`
      (() => {
        const btns = Array.from(document.querySelectorAll('button'));
        const btn = btns.find(b =>
          b.textContent.includes('Evaluate Multi-Item Plan') ||
          b.textContent.includes('Re-Evaluate Strategies')
        );
        if (!btn) throw new Error('Evaluation button not found in UI');
        btn.click();
      })()
    `);

    // Wait for strategies to evaluate and render
    let evaluated = false;
    for (let i = 0; i < 30; i++) {
      await delay(500);
      const res = await cdp.eval(`
        (() => {
          const text = document.body.innerText;
          return {
            hasStrategies: text.includes("Lowest Landed Cost") || text.includes("Verified Direct Retailer"),
            hasCarts: text.includes("Retailer Cart") || text.includes("buy.trychannel3.com")
          };
        })()
      `);
      if (res && res.hasStrategies) {
        console.log(`Strategies evaluated and rendered after ${(i + 1) * 500}ms!`);
        evaluated = true;
        break;
      }
    }

    // Gather strategy details from UI
    const studioRenderData = await cdp.eval(`
      (() => {
        const text = document.body.innerText;
        return {
          hasAuthoritative: text.includes("Verified Direct Retailer"),
          hasLowestCost: text.includes("Lowest Landed Cost"),
          hasConsolidated: text.includes("Consolidated"),
          hasThinkPad: text.includes("ThinkPad") || text.includes("Lenovo"),
          hasMsi: text.includes("MSI") || text.includes("MP225V"),
          hasNewegg: text.includes("newegg.com"),
          hasCdw: text.includes("cdw.com"),
          hasSyntheticFixture: text.includes("Synthetic Demo Fixture Active"),
          unquotedShippingNotice: text.includes("Shipping charges") && text.includes("unquoted"),
          salesTaxNotice: text.includes("Sales tax for destination")
        };
      })()
    `);
    console.log("Studio Render Analysis:", JSON.stringify(studioRenderData, null, 2));

    // Capture Full Page Screenshot
    console.log("\n[6/6] Capturing high-resolution browser screenshot...");
    const screenshot = await cdp.send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: true,
    });

    const outPath = path.join(process.cwd(), "docs", "evidence", "screenshots", "laptop-monitor-acceptance-evidence.png");
    fs.writeFileSync(outPath, Buffer.from(screenshot.data, "base64"));
    console.log(`Screenshot saved successfully: ${outPath} (${Math.round(screenshot.data.length * 0.75 / 1024)} KB)`);

    cdp.close();
  } finally {
    browserProc.kill();
  }
}

runAcceptanceCheck().catch((err) => {
  console.error("Browser Acceptance Check Failed:", err);
  process.exit(1);
});

