const fs = require('fs');
const path = require('path');
const { GoogleGenAI } = require('@google/genai');

// Load .env.local
const envLocalPath = path.resolve(process.cwd(), '.env.local');
if (fs.existsSync(envLocalPath)) {
  const content = fs.readFileSync(envLocalPath, 'utf8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2].trim().replace(/^["']|["']$/g, '');
    }
  }
}

async function testPrompt() {
  const apiKey = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
  console.log('Testing model:', model);
  const ai = new GoogleGenAI({ apiKey });

  const prompt = "I need a good laptop for software development and a monitor for my setup. Deliver them as soon as possible.";

  const systemInstruction = `You are a procurement intent parser. Decompose the buyer's procurement request into a structured JSON response.
Return a valid JSON object matching this schema:
{
  "productKeywords": string,
  "budgetCents": number | null,
  "currency": string | null,
  "quantity": number | null,
  "lineItems": [
    {
      "id": string,
      "title": string,
      "quantity": number | null,
      "budgetCents": number | null,
      "currency": string | null,
      "requirements": [
        {
          "key": string,
          "expectedValue": string,
          "description": string
        }
      ]
    }
  ],
  "ambiguities": string[]
}`;

  const response = await ai.models.generateContent({
    model,
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    config: {
      systemInstruction: { parts: [{ text: systemInstruction }] },
      responseMimeType: 'application/json',
      temperature: 0.1,
    }
  });

  console.log('Raw Gemini Response:');
  console.log(response.text);
}

testPrompt().catch(console.error);

