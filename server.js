require("dotenv").config();

const OpenAI = require("openai");
const express = require("express");
const cors = require("cors");
const session = require("express-session");
const admin = require("firebase-admin");

const serviceAccount = require("./serviceAccountKey.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use(
  session({
    secret: process.env.SESSION_SECRET || "shieldcall-demo-secret",
    resave: false,
    saveUninitialized: false,
  })
);

function requireLogin(req, res, next) {
  if (req.session && req.session.loggedIn) return next();
  return res.redirect("/login");
}

async function addNumber(type, number) {
  if (!number) return;
  await db.collection(type).doc(number).set({
    number,
    updatedAt: new Date().toISOString(),
  });
}

async function removeNumber(type, number) {
  if (!number) return;
  await db.collection(type).doc(number).delete();
}

async function checkNumberReputation(from) {
  const badDoc = await db.collection("badNumbers").doc(from).get();

  if (badDoc.exists) {
    return {
      risk: 100,
      label: "Known Scam Number",
      summary: "Numero löytyy huijausnumeroiden listalta.",
      action: "Block",
      nextStep: "🛑 Älä soita takaisin. Numero on tunnettu huijausnumero.",
      personaResponse:
        "Hei. Tämä numero käyttää automaattista huijaustorjuntaa. Keskustelu tallennetaan.",
    };
  }

  const trustedDoc = await db.collection("trustedNumbers").doc(from).get();

  if (trustedDoc.exists) {
    return {
      risk: 5,
      label: "Trusted Caller",
      summary: "Numero löytyy luotettujen soittajien listalta.",
      action: "Pass Through",
      nextStep: "✅ Puhelu voidaan päästää läpi tai soittaa takaisin.",
      personaResponse: "",
    };
  }

  return null;
}

async function analyzeCallWithGPT(transcript) {
  try {
    const response = await openai.responses.create({
      model: "gpt-4o-mini",
      input: `
Analysoi tämä puhelu ShieldCallia varten.

Palauta VAIN validi JSON:
{
  "risk": 0,
  "label": "Likely Safe",
  "summary": "lyhyt suomenkielinen yhteenveto",
  "action": "Pass Through",
  "nextStep": "mitä käyttäjän kannattaa tehdä seuraavaksi",
  "personaResponse": ""
}

Puhelun teksti:
"${transcript}"
      `,
    });

    return JSON.parse(response.output_text);
  } catch (error) {
    console.error("GPT error:", error.message);

    const text = transcript.toLowerCase();

    let risk = 20;
    let label = "Likely Safe";
    let action = "Pass Through";
    let summary = "Puhelu vaikuttaa normaalilta.";
    let nextStep = "✅ Soita takaisin tarvittaessa.";
    let personaResponse = "";

    const redFlags = [
      "pankkitunnus",
      "salasana",
      "korttitiedot",
      "tili lukitaan",
      "crypto",
      "sijoitus",
      "viranomainen",
      "poliisi",
    ];

    let hits = 0;

    redFlags.forEach((flag) => {
      if (text.includes(flag)) hits++;
    });

    risk += hits * 15;
    if (risk > 100) risk = 100;

    if (
      text.includes("sähkösopimus") ||
      text.includes("tarjoan") ||
      text.includes("myynti") ||
      text.includes("tarjous")
    ) {
      risk = 55;
      label = "Suspicious";
      action = "Whisper Only";
      summary = "Mahdollinen myyntipuhelu.";
      nextStep =
        "⚠️ Ei kiireellinen. Tarkista myöhemmin ennen takaisinsoittoa.";
    }

    if (
      text.includes("verkkopankki") ||
      text.includes("pankkitunnus") ||
      text.includes("salasana") ||
      text.includes("korttitiedot") ||
      text.includes("pankista") ||
      text.includes("tilillä") ||
      text.includes("epänormaalia toimintaa") ||
      text.includes("epäilyttävää toimintaa") ||
      text.includes("tili lukitaan")
    ) {
      risk = 92;
      label = "Scam Risk";
      action = "Block";
      summary =
        "Mahdollinen pankkihuijaus. ShieldCall voi ottaa keskustelun haltuun.";
      nextStep =
        "🛑 Älä soita takaisin. Tarkista asia suoraan pankin virallisesta numerosta.";
      personaResponse =
        "Hei. Tämä numero käyttää automaattista huijaustorjuntaa. Keskustelu tallennetaan.";
    }

    return { risk, label, summary, action, nextStep, personaResponse };
  }
}

async function addCall(call) {
  await db.collection("calls").doc(call.id).set(call, { merge: true });
}

async function updateCall(callSid, updates) {
  const ref = db.collection("calls").doc(callSid);
  const doc = await ref.get();

  if (!doc.exists) return false;

  await ref.set(
    {
      ...updates,
      updatedAt: new Date().toISOString(),
    },
    { merge: true }
  );

  return true;
}

async function getCalls() {
  const snap = await db
    .collection("calls")
    .orderBy("createdAt", "desc")
    .limit(100)
    .get();

  return snap.docs.map((doc) => doc.data());
}

app.get("/", (req, res) => {
  if (req.session && req.session.loggedIn) return res.redirect("/dashboard");
  res.redirect("/login");
});

app.get("/login", (req, res) => {
  res.send(`
<html>
  <head>
    <title>ShieldCall Login</title>
  </head>
  <body style="margin:0; background:#0f172a; font-family:Arial, sans-serif;">
    <div style="max-width:420px; margin:90px auto; background:white; padding:32px; border-radius:24px;">
      <h1>ShieldCall</h1>
      <p>Kirjaudu admin-näkymään</p>

      <form method="POST" action="/login">
        <label>Salasana</label><br>
        <input type="password" name="password" style="width:100%; padding:12px; margin:10px 0 18px; border-radius:10px; border:1px solid #ccc;" autofocus>

        <button style="width:100%; padding:13px; border:none; border-radius:999px; background:#38bdf8; color:#082f49; font-weight:bold;">
          Kirjaudu
        </button>
      </form>
    </div>
  </body>
</html>
  `);
});

app.post("/login", (req, res) => {
  const password = req.body.password;
  const adminPassword = process.env.ADMIN_PASSWORD || "admin";

  if (password === adminPassword) {
    req.session.loggedIn = true;
    return res.redirect("/dashboard");
  }

  res.send(`
<html>
  <body style="font-family:Arial; padding:40px;">
    <h2>Väärä salasana</h2>
    <p><a href="/login">Yritä uudelleen</a></p>
  </body>
</html>
  `);
});

app.post("/logout", (req, res) => {
  req.session.destroy(() => {
    res.redirect("/login");
  });
});

/*
  Twilio tarvitsee nämä avoimiksi:
  /voice
  /gather
*/

app.post("/voice", async (req, res) => {
  const from = req.body.From || "Tuntematon numero";
  const callSid = req.body.CallSid || Date.now().toString();

  await addCall({
    id: callSid,
    from,
    status: "Puhelu aloitettu",
    transcript: "",
    risk: 0,
    label: "Waiting",
    summary: "",
    action: "Waiting",
    nextStep: "Odotetaan puheen analyysiä.",
    personaResponse: "",
    createdAt: new Date().toISOString(),
  });

  res.type("text/xml");
  res.send(`
<Response>
  <Say language="fi-FI" voice="alice">
    Hei. Tämä on Mikko Keenisen puhelinavustaja.
    Kerro lyhyesti kuka soittaa ja missä asiassa.
  </Say>

  <Gather input="speech"
          language="fi-FI"
          speechTimeout="auto"
          speechModel="phone_call"
          action="/gather"
          method="POST">
    <Say language="fi-FI" voice="alice">
      Voit puhua nyt.
    </Say>
  </Gather>

  <Say language="fi-FI" voice="alice">
    En kuullut vastausta. Kiitos soitosta.
  </Say>
  <Hangup/>
</Response>
  `);
});

app.post("/gather", async (req, res) => {
  const from = req.body.From || "Tuntematon numero";
  const callSid = req.body.CallSid || Date.now().toString();
  const speechResult = req.body.SpeechResult || "Ei transkriptiota.";

  const reputation = await checkNumberReputation(from);
  const analysis = reputation || (await analyzeCallWithGPT(speechResult));

  const updated = await updateCall(callSid, {
    status: "AI hoiti",
    transcript: speechResult,
    risk: analysis.risk,
    label: analysis.label,
    summary: analysis.summary,
    action: analysis.action,
    nextStep: analysis.nextStep,
    personaResponse: analysis.personaResponse,
  });

  if (!updated) {
    await addCall({
      id: callSid,
      from,
      status: "AI hoiti",
      transcript: speechResult,
      risk: analysis.risk,
      label: analysis.label,
      summary: analysis.summary,
      action: analysis.action,
      nextStep: analysis.nextStep,
      personaResponse: analysis.personaResponse,
      createdAt: new Date().toISOString(),
    });
  }

  let replyText = "Kiitos. Välitän viestin eteenpäin.";

  if (analysis.action === "Block") {
    replyText =
      "Tämä numero käyttää automaattista huijaus- ja väärinkäytössuojausta. Puhelua ei yhdistetä eteenpäin. Jos asiasi on oikea, ota yhteyttä virallista kanavaa pitkin.";
  }

  if (analysis.action === "Whisper Only") {
    replyText =
      "Kiitos soitosta. Otan viestisi talteen ja välitän sen tarkistettavaksi. Mikko palaa asiaan tarvittaessa.";
  }

  if (analysis.action === "Pass Through") {
    replyText =
      "Kiitos soitosta. Välitän viestin Mikolle. Hän palaa asiaan mahdollisuuksien mukaan.";
  }

  if (
    analysis.label === "Suspicious" &&
    analysis.summary &&
    analysis.summary.toLowerCase().includes("myynti")
  ) {
    replyText =
      "Kiitos soitosta. Emme ota vastaan puhelinmyyntiä tätä kautta. Voitte lähettää asian sähköpostitse.";
  }

  if (analysis.label === "Scam Risk" || analysis.risk >= 85) {
    replyText =
      "Tämä puhelu on merkitty korkean riskin puheluksi. Puhelua ei yhdistetä eteenpäin.";
  }

  res.type("text/xml");
  res.send(`
<Response>
  <Say language="fi-FI" voice="alice">
    ${replyText}
  </Say>
  <Hangup/>
</Response>
  `);
});

app.get("/calls", requireLogin, async (req, res) => {
  const calls = await getCalls();
  res.json(calls);
});

app.get("/api/calls", requireLogin, async (req, res) => {
  const calls = await getCalls();
  res.json(calls);
});

app.post("/clear", requireLogin, async (req, res) => {
  const snap = await db.collection("calls").get();

  const batch = db.batch();
  snap.docs.forEach((doc) => batch.delete(doc.ref));
  await batch.commit();

  res.redirect("/dashboard");
});

app.post("/trust-number", requireLogin, async (req, res) => {
  const number = req.body.number;

  await addNumber("trustedNumbers", number);
  await removeNumber("badNumbers", number);

  res.redirect("/dashboard");
});

app.post("/block-number", requireLogin, async (req, res) => {
  const number = req.body.number;

  await addNumber("badNumbers", number);
  await removeNumber("trustedNumbers", number);

  res.redirect("/dashboard");
});

app.get("/dashboard", requireLogin, async (req, res) => {
  res.send(`
<html>
  <head>
    <title>ShieldCall Live Dashboard</title>
  </head>

  <body style="margin:0; background:#0f172a; font-family:Arial, sans-serif;">
    <div style="max-width:1050px; margin:0 auto; padding:40px 24px;">
      <div style="display:flex; justify-content:space-between; align-items:center; color:white; margin-bottom:30px;">
        <div>
          <h1 style="font-size:42px; margin-bottom:8px;">ShieldCall LIVE</h1>
          <p style="font-size:18px; color:#cbd5e1; margin:0;">
            Realtime AI call screening dashboard.
          </p>
        </div>

        <form method="POST" action="/logout">
          <button style="padding:10px 16px; border:none; border-radius:999px; background:#334155; color:white; font-weight:bold;">
            Kirjaudu ulos
          </button>
        </form>
      </div>

      <div id="stats" style="display:grid; grid-template-columns:repeat(4, 1fr); gap:16px; margin-bottom:28px;"></div>

      <div style="margin-bottom:20px;">
        <a href="/simulate" style="background:#38bdf8; color:#082f49; padding:12px 18px; border-radius:999px; text-decoration:none; font-weight:bold;">
          Simuloi puhelu
        </a>

        <a href="/calls" style="margin-left:10px; color:white;">JSON</a>

        <form method="POST" action="/clear" style="display:inline;">
          <button style="margin-left:10px; padding:12px 18px; border-radius:999px; border:none; background:#ef4444; color:white; font-weight:bold;">
            Tyhjennä demo
          </button>
        </form>
      </div>

      <div id="calls"></div>
    </div>

    <script>
      async function loadCalls() {
        const response = await fetch("/api/calls");

        if (response.redirected) {
          window.location.href = response.url;
          return;
        }

        const calls = await response.json();

        const total = calls.length;
        const blocked = calls.filter(c => c.action === "Block").length;
        const warned = calls.filter(c => c.action === "Whisper Only").length;
        const passed = calls.filter(c => c.action === "Pass Through").length;

        document.getElementById("stats").innerHTML = \`
          <div style="background:white; border-radius:20px; padding:20px;">
            <h3>Total Calls</h3>
            <div style="font-size:34px; font-weight:bold;">\${total}</div>
          </div>
          <div style="background:white; border-radius:20px; padding:20px;">
            <h3>Blocked</h3>
            <div style="font-size:34px; font-weight:bold; color:#ef4444;">\${blocked}</div>
          </div>
          <div style="background:white; border-radius:20px; padding:20px;">
            <h3>Warnings</h3>
            <div style="font-size:34px; font-weight:bold; color:#f59e0b;">\${warned}</div>
          </div>
          <div style="background:white; border-radius:20px; padding:20px;">
            <h3>Passed</h3>
            <div style="font-size:34px; font-weight:bold; color:#22c55e;">\${passed}</div>
          </div>
        \`;

        if (!calls.length) {
          document.getElementById("calls").innerHTML =
            '<div style="background:white; padding:30px; border-radius:20px;">No calls yet.</div>';
          return;
        }

        document.getElementById("calls").innerHTML = calls.map(call => {
          let badgeColor = "#22c55e";
          let cardBg = "#f0fdf4";
          let decision = "✅ Safe to pass through";

          if (call.action === "Whisper Only") {
            badgeColor = "#f59e0b";
            cardBg = "#fffbeb";
            decision = "⚠️ Whisper warning recommended";
          }

          if (call.action === "Block") {
            badgeColor = "#ef4444";
            cardBg = "#fef2f2";
            decision = "🛑 Blocked by ShieldCall";
          }

          return \`
            <div style="background:\${cardBg}; border-radius:22px; padding:22px; margin:18px 0; box-shadow:0 10px 30px rgba(0,0,0,0.08); border:1px solid #e5e7eb;">
              <div style="display:flex; justify-content:space-between; align-items:center;">
                <h2 style="margin:0;">\${call.label || "Unknown"}</h2>
                <span style="background:\${badgeColor}; color:white; padding:8px 14px; border-radius:999px; font-weight:bold;">
                  Risk \${call.risk ?? 0}/100
                </span>
              </div>

              <h3 style="margin-top:14px;">\${decision}</h3>
              <p><b>Action:</b> \${call.action || ""}</p>
              <p><b>Next Step:</b> \${call.nextStep || ""}</p>
              <p><b>AI Persona:</b> \${call.personaResponse || "—"}</p>
              <p><b>Caller:</b> \${call.from || ""}</p>
              <p><b>Status:</b> \${call.status || ""}</p>
              <p><b>Transcript:</b> \${call.transcript || ""}</p>
              <p><b>AI Summary:</b> \${call.summary || ""}</p>

              <div style="margin-top:16px;">
                <form method="POST" action="/trust-number" style="display:inline;">
                  <input type="hidden" name="number" value="\${call.from}">
                  <button style="padding:10px 14px; border-radius:999px; border:none; background:#22c55e; color:white; font-weight:bold;">
                    Merkitse luotetuksi
                  </button>
                </form>

                <form method="POST" action="/block-number" style="display:inline;">
                  <input type="hidden" name="number" value="\${call.from}">
                  <button style="padding:10px 14px; border-radius:999px; border:none; background:#ef4444; color:white; font-weight:bold; margin-left:8px;">
                    Blokkaa jatkossa
                  </button>
                </form>
              </div>

              <small style="display:block; margin-top:14px;">\${call.createdAt || ""}</small>
            </div>
          \`;
        }).join("");
      }

      loadCalls();
      setInterval(loadCalls, 2000);
    </script>
  </body>
</html>
  `);
});

app.get("/simulate", requireLogin, (req, res) => {
  res.send(`
<html>
  <head><title>ShieldCall Simulator</title></head>
  <body style="font-family: Arial; max-width: 700px; margin: 40px auto;">
    <h1>ShieldCall Simulator</h1>

    <form method="POST" action="/simulate">
      <label>Soittaja:</label><br>
      <input id="from" name="from" value="+358400000000" style="width:100%; padding:10px;"><br><br>

      <label>Puheen sisältö:</label><br>
      <textarea id="transcript" name="transcript" rows="6" style="width:100%; padding:10px;">Hei, tarjoan uutta sähkösopimusta.</textarea><br><br>

      <button style="padding:12px 20px;">Simuloi puhelu</button>
    </form>

    <h3>Demo-skenaariot</h3>
    <button onclick="demoSafe()">Safe Call</button>
    <button onclick="demoSales()">Sales Call</button>
    <button onclick="demoBankScam()">Bank Scam</button>
    <button onclick="demoKnownScam()">Known Scam Number</button>

    <p><a href="/dashboard">Avaa dashboard</a></p>

    <script>
      function demoSafe() {
        document.getElementById("from").value = "+358400000000";
        document.getElementById("transcript").value = "Hei, soitan sovitusta yhteistyöpalaverista ensi viikolle.";
      }

      function demoSales() {
        document.getElementById("from").value = "+358412345666";
        document.getElementById("transcript").value = "Hei, tarjoan uutta sähkösopimusta edullisempaan hintaan.";
      }

      function demoBankScam() {
        document.getElementById("from").value = "+358412345777";
        document.getElementById("transcript").value = "Hei pankista, tililläsi on epäilyttävää toimintaa. Anna pankkitunnukset tai tili lukitaan.";
      }

      function demoKnownScam() {
        document.getElementById("from").value = "+358401234567";
        document.getElementById("transcript").value = "Hei, tämä numero löytyy huijauslistalta.";
      }
    </script>
  </body>
</html>
  `);
});

app.post("/simulate", requireLogin, async (req, res) => {
  const from = req.body.from || "Simuloitu numero";
  const transcript = req.body.transcript || "Ei transkriptiota.";
  const callSid = "SIM-" + Date.now();

  const reputation = await checkNumberReputation(from);
  const analysis = reputation || (await analyzeCallWithGPT(transcript));

  await addCall({
    id: callSid,
    from,
    status: "Simuloitu puhelu",
    transcript,
    risk: analysis.risk,
    label: analysis.label,
    summary: analysis.summary,
    action: analysis.action,
    nextStep: analysis.nextStep,
    personaResponse: analysis.personaResponse,
    createdAt: new Date().toISOString(),
  });

  res.redirect("/dashboard");
});

app.listen(PORT, () => {
  console.log(`ShieldCall backend käynnissä portissa ${PORT}`);
});