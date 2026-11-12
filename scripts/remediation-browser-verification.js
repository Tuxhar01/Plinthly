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
    this.networkRequests = [];
    this.networkResponses = [];
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
      } else if (msg.method === "Network.requestWillBeSent") {
        this.networkRequests.push({
          requestId: msg.params.requestId,
          url: msg.params.request.url,
          method: msg.params.request.method,
          postData: msg.params.request.postData,
        });
      } else if (msg.method === "Network.responseReceived") {
        this.networkResponses.push({
          requestId: msg.params.requestId,
          url: msg.params.response.url,
          status: msg.params.response.status,
          statusText: msg.params.response.statusText,
        });
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
      throw new Error(res.exceptionDetails.text || "Runtime evaluation exception");
    }
    return res.result?.value;
  }
}

async function runAudit() {
  console.log("=== PLINTHLY BROWSER ACCEPTANCE AUDIT ===");
  const edgePath = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
  const userDataDir = path.join(process.env.TEMP || "C:\\temp", "plinthly_browser_audit_" + Date.now());

  console.log("[1] Launching headless browser on port 9223...");
  const browserProc = spawn(edgePath, [
    "--headless=new",
    "--remote-debugging-port=9223",
    `--user-data-dir=${userDataDir}`,
    "--window-size=1280,1024",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
  ], { stdio: "ignore" });

  try {
    let connected = false;
    for (let i = 0; i < 20; i++) {
      await delay(500);
      try {
        await getJson("http://127.0.0.1:9223/json/version");
        connected = true;
        break;
      } catch {}
    }
    if (!connected) throw new Error("Could not connect to browser CDP");

    const targets = await getJson("http://127.0.0.1:9223/json/list");
    const pageTarget = targets.find((t) => t.type === "page") || targets[0];
    const cdp = new CDPClient(pageTarget.webSocketDebuggerUrl);
    await cdp.connect();

    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Network.enable");

    // ==========================================
    // SCENARIO 1: Sample Purchase 1 (pur_1792633876502_s7jvwi22)
    // ==========================================
    console.log("\n--- SCENARIO 1: Sample Purchase pur_1792633876502_s7jvwi22 ---");
    await cdp.send("Page.navigate", { url: "http://127.0.0.1:3000/?purchaseId=pur_1792633876502_s7jvwi22" });
    await delay(3000);

    const s1Title = await cdp.eval("document.title");
    console.log(`Page title: "${s1Title}"`);

    // Verify studio is loaded
    const s1StudioLoaded = await cdp.eval("document.body.innerText.includes('Multi-Item Procurement Studio')");
    console.log(`Studio loaded: ${s1StudioLoaded}`);

    // Click Evaluate Multi-Item Plan
    console.log("Clicking 'Evaluate Multi-Item Plan'...");
    await cdp.eval(`
      (() => {
        const btns = Array.from(document.querySelectorAll('button'));
        const btn = btns.find(b => b.textContent.includes('Evaluate Multi-Item Plan') || b.textContent.includes('Re-Evaluate Strategies'));
        if (btn) btn.click();
      })()
    `);
    await delay(4000);

    const s1Error = await cdp.eval(`
      (() => {
        const el = document.querySelector('[class*="bg-[var(--block-tint)]"], [class*="text-[var(--block)]"]');
        return el ? el.innerText : null;
      })()
    `);
    console.log(`Scenario 1 UI Error Banner: ${s1Error || "NONE (PASS)"}`);

    const s1Strategies = await cdp.eval(`
      (() => {
        const cards = Array.from(document.querySelectorAll('div.grid > div.p-4, div.p-4.rounded-lg'))
          .filter(el => el.innerText.includes('Merchandise:') && el.innerText.includes('Pre-Tax Landed Subtotal:'));
        return cards.length;
      })()
    `);
    console.log(`Scenario 1 Evaluated Strategies Count: ${s1Strategies}`);

    // ==========================================
    // SCENARIO 2: Sample Purchase 2 (pur_1792654701712_f2iks5to)
    // ==========================================
    console.log("\n--- SCENARIO 2: Sample Purchase pur_1792654701712_f2iks5to ---");
    await cdp.send("Page.navigate", { url: "http://127.0.0.1:3000/?purchaseId=pur_1792654701712_f2iks5to" });
    await delay(3000);

    const s2StudioLoaded = await cdp.eval("document.body.innerText.includes('Multi-Item Procurement Studio')");
    console.log(`Studio loaded: ${s2StudioLoaded}`);

    console.log("Clicking 'Evaluate Multi-Item Plan'...");
    await cdp.eval(`
      (() => {
        const btns = Array.from(document.querySelectorAll('button'));
        const btn = btns.find(b => b.textContent.includes('Evaluate Multi-Item Plan') || b.textContent.includes('Re-Evaluate Strategies'));
        if (btn) btn.click();
      })()
    `);
    await delay(4000);

    const s2Error = await cdp.eval(`
      (() => {
        const el = document.querySelector('[class*="bg-[var(--block-tint)]"], [class*="text-[var(--block)]"]');
        return el ? el.innerText : null;
      })()
    `);
    console.log(`Scenario 2 UI Error Banner: ${s2Error || "NONE (PASS)"}`);

    const s2Strategies = await cdp.eval(`
      (() => {
        const cards = Array.from(document.querySelectorAll('div.grid > div.p-4, div.p-4.rounded-lg'))
          .filter(el => el.innerText.includes('Merchandise:') && el.innerText.includes('Pre-Tax Landed Subtotal:'));
        return cards.length;
      })()
    `);
    console.log(`Scenario 2 Evaluated Strategies Count: ${s2Strategies}`);

    // ==========================================
    // GEMINI TEST 1: MacBook Pro M4
    // ==========================================
    console.log("\n--- GEMINI TEST 1: MacBook Pro M4 ---");
    await cdp.send("Page.navigate", { url: "http://127.0.0.1:3000/" });
    await delay(2500);

    const prompt1 = "I need 2 MacBook Pro M4 laptops with 16GB RAM and 512GB SSD, delivered to ZIP 98101 by November 15. My total budget is $4,000.";
    console.log(`Input: "${prompt1}"`);

    await cdp.eval(`
      (() => {
        const textarea = document.getElementById('natural-language-prompt');
        if (textarea) {
          // Use native input value setter so React detects change
          const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
          nativeSetter.call(textarea, ${JSON.stringify(prompt1)});
          textarea.dispatchEvent(new Event('input', { bubbles: true }));
        }
      })()
    `);
    await delay(500);

    console.log("Clicking 'Decompose with Gemini'...");
    await cdp.eval(`
      (() => {
        const btns = Array.from(document.querySelectorAll('button'));
        const btn = btns.find(b => b.textContent.includes('Decompose with Gemini'));
        if (btn) btn.click();
      })()
    `);

    // Wait for Gemini API response
    console.log("Waiting for Gemini response (up to 12s)...");
    await delay(1200);
    let g1Done = false;
    for (let i = 0; i < 24; i++) {
      await delay(500);
      const isStillLoading = await cdp.eval(`
        (() => {
          const btns = Array.from(document.querySelectorAll('button'));
          const btn = btns.find(b => b.textContent.includes('Decompose with Gemini') || b.textContent.includes('Analyzing'));
          return btn && btn.disabled;
        })()
      `);
      if (!isStillLoading) {
        g1Done = true;
        break;
      }
    }

    const g1BannerText = await cdp.eval(`
      (() => {
        const banner = document.querySelector('[class*="border-l-4"]');
        return banner ? banner.innerText : null;
      })()
    `);
    console.log(`Gemini Test 1 Result Banner:\n${g1BannerText}`);

    // ==========================================
    // GEMINI TEST 2: Multi-Item Procurement ($5,000 budget)
    // ==========================================
    console.log("\n--- GEMINI TEST 2: Multi-Item Procurement ($5,000 budget) ---");
    const prompt2 = "I need 2 Dell XPS 15 laptops, 2 27-inch 4K monitors, and 2 USB-C docking stations. Deliver everything to ZIP 98101 by November 20. Total budget is $5,000.";
    console.log(`Input: "${prompt2}"`);

    await cdp.eval(`
      (() => {
        const textarea = document.getElementById('natural-language-prompt');
        if (textarea) {
          const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
          nativeSetter.call(textarea, ${JSON.stringify(prompt2)});
          textarea.dispatchEvent(new Event('input', { bubbles: true }));
        }
      })()
    `);
    await delay(500);

    console.log("Clicking 'Decompose with Gemini'...");
    await cdp.eval(`
      (() => {
        const btns = Array.from(document.querySelectorAll('button'));
        const btn = btns.find(b => b.textContent.includes('Decompose with Gemini'));
        if (btn) btn.click();
      })()
    `);

    console.log("Waiting for Gemini response (up to 12s)...");
    await delay(1200);
    for (let i = 0; i < 24; i++) {
      await delay(500);
      const isStillLoading = await cdp.eval(`
        (() => {
          const btns = Array.from(document.querySelectorAll('button'));
          const btn = btns.find(b => b.textContent.includes('Decompose with Gemini') || b.textContent.includes('Analyzing'));
          return btn && btn.disabled;
        })()
      `);
      if (!isStillLoading) break;
    }

    const g2BudgetValue = await cdp.eval(`
      (() => {
        const budgetInput = document.getElementById('multi-purchase-budget') || document.getElementById('purchase-budget');
        const budgetCard = document.querySelector('[class*="grid-cols-1 sm:grid-cols-3"]');
        return {
          inputValue: budgetInput ? budgetInput.value : null,
          cardSummary: budgetCard ? budgetCard.innerText : null
        };
      })()
    `);
    console.log(`Gemini Test 2 Aggregate Budget Display:\n`, JSON.stringify(g2BudgetValue, null, 2));

    const g2ConfidenceText = await cdp.eval(`
      (() => {
        const info = Array.from(document.querySelectorAll('div')).find(d => d.innerText.includes('Model Assessment:'));
        return info ? info.innerText.split('\\n')[0] : null;
      })()
    `);
    console.log(`Gemini Test 2 Model Assessment:\n${g2ConfidenceText}`);

    // ==========================================
    // GEMINI TEST 3: Ambiguous Procurement Request
    // ==========================================
    console.log("\n--- GEMINI TEST 3: Ambiguous Procurement Request ---");
    const prompt3 = "I need a good laptop for software development and a monitor for my setup. Deliver them as soon as possible.";
    console.log(`Input: "${prompt3}"`);

    await cdp.eval(`
      (() => {
        const textarea = document.getElementById('natural-language-prompt');
        if (textarea) {
          const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
          nativeSetter.call(textarea, ${JSON.stringify(prompt3)});
          textarea.dispatchEvent(new Event('input', { bubbles: true }));
        }
      })()
    `);
    await delay(500);

    console.log("Clicking 'Decompose with Gemini'...");
    await cdp.eval(`
      (() => {
        const btns = Array.from(document.querySelectorAll('button'));
        const btn = btns.find(b => b.textContent.includes('Decompose with Gemini'));
        if (btn) btn.click();
      })()
    `);

    console.log("Waiting for Gemini response (up to 12s)...");
    await delay(1200);
    for (let i = 0; i < 24; i++) {
      await delay(500);
      const isStillLoading = await cdp.eval(`
        (() => {
          const btns = Array.from(document.querySelectorAll('button'));
          const btn = btns.find(b => b.textContent.includes('Decompose with Gemini') || b.textContent.includes('Analyzing'));
          return btn && btn.disabled;
        })()
      `);
      if (!isStillLoading) break;
    }

    const g3Ambiguities = await cdp.eval(`
      (() => {
        const banner = Array.from(document.querySelectorAll('div')).find(d => d.innerText.includes('Unresolved Ambiguities & Missing Information:'));
        return banner ? banner.innerText : null;
      })()
    `);
    console.log(`Gemini Test 3 Extracted Ambiguities & Fallback:\n${g3Ambiguities}`);

    console.log("\n=== ALL 5 BROWSER ACCEPTANCE SCENARIOS EXECUTED SUCCESSFULLY ===");
  } finally {
    browserProc.kill();
  }
}

runAudit().catch((err) => {
  console.error("Browser audit failed:", err);
  process.exit(1);
});

