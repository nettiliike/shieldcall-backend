require("dotenv").config();

const express = require("express");
const app = express();

const PORT = process.env.PORT || 3000;
const FORWARD_TO_NUMBER = process.env.FORWARD_TO_NUMBER;

const calls = [];
const trustedNumbers = new Set();
const blockedNumbers = new Set();

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

function normalizeNumber(number) {
  return String(number || "Tuntematon").trim().replace(/\s+/g, "");
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function addCall(data) {
  calls.unshift({
    id: Date.now().toString(),
    time: new Date().toLocaleString("fi-FI"),
    ...data,
  });

  if (calls.length > 50) calls.pop();
}

function analyzeSpeech(speech, from) {
  const lower = String(speech || "").toLowerCase();
  const normalizedFrom = normalizeNumber(from);

  if (blockedNumbers.has(normalizedFrom)) {
    return {
      safe: false,
      forwarded: false,
      risk: 100,
      label: "Estetty numero",
      summary: "Numero on estettyjen listalla.",
      action: "Puhelua ei yhdistetty",
    };
  }

  if (trustedNumbers.has(normalizedFrom)) {
    return {
      safe: true,
      forwarded: true,
      risk: 5,
      label: "Luotettu soittaja",
      summary: "Numero on luotettujen listalla.",
      action: "Puhelu yhdistettiin omaan numeroon",
    };
  }

  let risk = 15;
  let label = "Todennäköisesti turvallinen";
  let summary = "Puhelu vaikuttaa tavalliselta yhteydenotolta.";
  let safe = true;

  const salesWords = ["sähkösopimus", "tarjoan", "myynti", "tarjous", "liittymä", "puhelinmyynti"];
  const scamWords = ["pankki", "pankkitunnus", "tunnus", "salasana", "korttitiedot", "tili", "lukitaan", "crypto", "sijoitus"];

  const salesHit = salesWords.some((word) => lower.includes(word));
  const scamHit = scamWords.some((word) => lower.includes(word));

  if (salesHit) {
    risk = 60;
    label = "Mahdollinen myyntipuhelu";
    summary = "Puhelu vaikuttaa myynti- tai tarjoukselta.";
    safe = false;
  }

  if (scamHit) {
    risk = 92;
    label = "Korkea huijausriski";
    summary = "Puhelussa mainitaan pankki-, tunnus-, salasana- tai rahariskiin liittyviä asioita.";
    safe = false;
  }

  if (lower.includes("yhteistyö") || lower.includes("asiakas") || lower.includes("tilaus") || lower.includes("varaus")) {
    if (!salesHit && !scamHit) {
      risk = 10;
      label = "Turvallinen yhteydenotto";
      summary = "Puhelu vaikuttaa oikealta asiakas- tai yhteistyöasialta.";
      safe = true;
    }
  }

  return {
    safe,
    forwarded: safe && Boolean(FORWARD_TO_NUMBER),
    risk,
    label,
    summary,
    action: safe && FORWARD_TO_NUMBER ? "Puhelu yhdistettiin omaan numeroon" : "Puhelua ei yhdistetty",
  };
}

function renderNumberList(title, set, removePath, emptyText) {
  const numbers = Array.from(set);
  if (!numbers.length) {
    return `<div style="background:white; border-radius:18px; padding:20px;"><h3>${title}</h3><p style="color:#64748b;">${emptyText}</p></div>`;
  }

  const rows = numbers.map((number) => `
    <div style="display:flex; justify-content:space-between; align-items:center; gap:10px; border-top:1px solid #e5e7eb; padding:10px 0;">
      <span>${escapeHtml(number)}</span>
      <form method="POST" action="${removePath}" style="margin:0;">
        <input type="hidden" name="number" value="${escapeHtml(number)}">
        <button style="padding:7px 12px; border:none; border-radius:999px; background:#64748b; color:white; font-weight:bold;">Poista</button>
      </form>
    </div>
  `).join("");

  return `<div style="background:white; border-radius:18px; padding:20px;"><h3>${title}</h3>${rows}</div>`;
}

app.get("/", (req, res) => {
  res.redirect("/dashboard");
});

app.get("/dashboard", (req, res) => {
  const rows = calls.length
    ? calls
        .map((call) => {
          const color = call.safe ? "#dcfce7" : "#fee2e2";
          const status = call.forwarded ? "Yhdistetty" : call.safe ? "Turvallinen" : "Estetty / ei yhdistetty";
          const badge = call.risk >= 85 ? "#dc2626" : call.risk >= 50 ? "#f59e0b" : "#16a34a";

          return `
            <div style="background:${color}; border-radius:18px; padding:18px; margin-bottom:14px; border:1px solid #e5e7eb;">
              <div style="display:flex; justify-content:space-between; align-items:center; gap:12px;">
                <h2 style="margin:0 0 8px;">${status}</h2>
                <span style="background:${badge}; color:white; padding:8px 14px; border-radius:999px; font-weight:bold;">Riski ${call.risk || 0}/100</span>
              </div>
              <p><b>Luokitus:</b> ${escapeHtml(call.label)}</p>
              <p><b>Aika:</b> ${escapeHtml(call.time)}</p>
              <p><b>Soittaja:</b> ${escapeHtml(call.from || "Tuntematon")}</p>
              <p><b>Puheen sisältö:</b> ${escapeHtml(call.speech || "Ei transkriptiota")}</p>
              <p><b>AI-yhteenveto:</b> ${escapeHtml(call.summary || "")}</p>
              <p><b>Toiminto:</b> ${escapeHtml(call.action)}</p>
              <div style="display:flex; gap:8px; flex-wrap:wrap; margin-top:14px;">
                <form method="POST" action="/trust-number" style="margin:0;">
                  <input type="hidden" name="number" value="${escapeHtml(call.from)}">
                  <button style="padding:10px 14px; border:none; border-radius:999px; background:#16a34a; color:white; font-weight:bold;">Merkitse luotetuksi</button>
                </form>
                <form method="POST" action="/block-number" style="margin:0;">
                  <input type="hidden" name="number" value="${escapeHtml(call.from)}">
                  <button style="padding:10px 14px; border:none; border-radius:999px; background:#dc2626; color:white; font-weight:bold;">Blokkaa jatkossa</button>
                </form>
              </div>
            </div>
          `;
        })
        .join("")
    : `<div style="background:white; border-radius:18px; padding:22px;">Ei puheluita vielä.</div>`;

  res.send(`
<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>ShieldCall Dashboard</title>
</head>
<body style="margin:0; background:#0f172a; font-family:Arial, sans-serif;">
  <div style="max-width:1000px; margin:0 auto; padding:36px 22px;">
    <div style="color:white; margin-bottom:24px;">
      <h1 style="font-size:42px; margin:0 0 8px;">ShieldCall Dashboard</h1>
      <p style="color:#cbd5e1; font-size:18px; margin:0;">Puhelinassistentti, riskipisteytys ja yhdistämisen seuranta</p>
      <p style="color:#cbd5e1; margin-top:10px;">Yhdistäminen: <b>${FORWARD_TO_NUMBER ? "päällä" : "ei asetettu"}</b></p>
    </div>

    <div style="display:grid; grid-template-columns:repeat(4, 1fr); gap:16px; margin-bottom:24px;">
      <div style="background:white; border-radius:18px; padding:20px;"><h3>Puhelut</h3><div style="font-size:34px; font-weight:bold;">${calls.length}</div></div>
      <div style="background:white; border-radius:18px; padding:20px;"><h3>Yhdistetyt</h3><div style="font-size:34px; font-weight:bold; color:#16a34a;">${calls.filter(c => c.forwarded).length}</div></div>
      <div style="background:white; border-radius:18px; padding:20px;"><h3>Estetyt</h3><div style="font-size:34px; font-weight:bold; color:#dc2626;">${calls.filter(c => !c.safe).length}</div></div>
      <div style="background:white; border-radius:18px; padding:20px;"><h3>Keski-riski</h3><div style="font-size:34px; font-weight:bold;">${calls.length ? Math.round(calls.reduce((s,c)=>s+(c.risk||0),0)/calls.length) : 0}</div></div>
    </div>

    <div style="margin-bottom:18px;">
      <a href="/dashboard" style="background:#38bdf8; color:#082f49; padding:12px 18px; border-radius:999px; text-decoration:none; font-weight:bold;">Päivitä</a>
      <a href="/api/calls" style="color:white; margin-left:12px;">JSON</a>
    </div>

    <div style="display:grid; grid-template-columns:1fr 1fr; gap:16px; margin-bottom:24px;">
      ${renderNumberList("Luotetut numerot", trustedNumbers, "/remove-trusted-number", "Ei vielä luotettuja numeroita.")}
      ${renderNumberList("Estetyt numerot", blockedNumbers, "/remove-blocked-number", "Ei vielä estettyjä numeroita.")}
    </div>

    ${rows}
  </div>
</body>
</html>
  `);
});

app.get("/api/calls", (req, res) => {
  res.json(calls);
});

app.post("/trust-number", (req, res) => {
  const number = normalizeNumber(req.body.number);
  if (number && number !== "Tuntematon") {
    trustedNumbers.add(number);
    blockedNumbers.delete(number);
  }
  res.redirect("/dashboard");
});

app.post("/block-number", (req, res) => {
  const number = normalizeNumber(req.body.number);
  if (number && number !== "Tuntematon") {
    blockedNumbers.add(number);
    trustedNumbers.delete(number);
  }
  res.redirect("/dashboard");
});

app.post("/remove-trusted-number", (req, res) => {
  trustedNumbers.delete(normalizeNumber(req.body.number));
  res.redirect("/dashboard");
});

app.post("/remove-blocked-number", (req, res) => {
  blockedNumbers.delete(normalizeNumber(req.body.number));
  res.redirect("/dashboard");
});

app.post("/voice", (req, res) => {
  const from = normalizeNumber(req.body.From || "Tuntematon");

  if (blockedNumbers.has(from)) {
    const analysis = analyzeSpeech("", from);
    addCall({ from, speech: "Numero estettiin ennen keskustelua.", ...analysis });
    res.type("text/xml");
    return res.send(`
<Response>
  <Say language="fi-FI" voice="alice">Tämä numero käyttää automaattista puhelunsuodatusta. Puhelua ei yhdistetä.</Say>
  <Hangup/>
</Response>
    `);
  }

  if (trustedNumbers.has(from) && FORWARD_TO_NUMBER) {
    const analysis = analyzeSpeech("", from);
    addCall({ from, speech: "Luotettu numero yhdistettiin suoraan.", ...analysis });
    res.type("text/xml");
    return res.send(`
<Response>
  <Say language="fi-FI" voice="alice">Yhdistän puhelun.</Say>
  <Dial>${FORWARD_TO_NUMBER}</Dial>
</Response>
    `);
  }

  addCall({
    from,
    speech: "Puhelu aloitettu, odotetaan vastausta.",
    safe: true,
    forwarded: false,
    risk: 0,
    label: "Odottaa vastausta",
    summary: "AI kysyy soittajalta asian.",
    action: "AI kysyy asian",
  });

  res.type("text/xml");
  res.send(`
<Response>
  <Say language="fi-FI" voice="alice">Hei, tämä on puhelinavustaja. Kerro lyhyesti asiasi.</Say>
  <Gather input="speech" language="fi-FI" speechTimeout="auto" action="/gather" method="POST">
    <Say language="fi-FI" voice="alice">Puhu nyt.</Say>
  </Gather>
  <Say language="fi-FI" voice="alice">En kuullut vastausta. Kiitos soitosta.</Say>
  <Hangup/>
</Response>
  `);
});

app.post("/gather", (req, res) => {
  const from = normalizeNumber(req.body.From || "Tuntematon");
  const speech = req.body.SpeechResult || "";
  const analysis = analyzeSpeech(speech, from);

  res.type("text/xml");

  if (analysis.safe && FORWARD_TO_NUMBER) {
    addCall({ from, speech, ...analysis, forwarded: true });
    return res.send(`
<Response>
  <Say language="fi-FI" voice="alice">Yhdistän puhelun.</Say>
  <Dial>${FORWARD_TO_NUMBER}</Dial>
</Response>
    `);
  }

  addCall({ from, speech, ...analysis, forwarded: false });

  return res.send(`
<Response>
  <Say language="fi-FI" voice="alice">Kiitos. Välitän viestin eteenpäin.</Say>
  <Hangup/>
</Response>
  `);
});

app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
