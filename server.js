require("dotenv").config();

const express = require("express");
const app = express();

const PORT = process.env.PORT || 3000;
const FORWARD_TO_NUMBER = process.env.FORWARD_TO_NUMBER;

const calls = [];

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

function addCall(data) {
  calls.unshift({
    id: Date.now().toString(),
    time: new Date().toLocaleString("fi-FI"),
    ...data,
  });

  if (calls.length > 50) calls.pop();
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

          return `
            <div style="background:${color}; border-radius:18px; padding:18px; margin-bottom:14px; border:1px solid #e5e7eb;">
              <h2 style="margin:0 0 8px;">${status}</h2>
              <p><b>Aika:</b> ${call.time}</p>
              <p><b>Soittaja:</b> ${call.from || "Tuntematon"}</p>
              <p><b>Puheen sisältö:</b> ${call.speech || "Ei transkriptiota"}</p>
              <p><b>Toiminto:</b> ${call.action}</p>
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
      <p style="color:#cbd5e1; font-size:18px; margin:0;">Puhelinassistentti ja yhdistämisen seuranta</p>
      <p style="color:#cbd5e1; margin-top:10px;">Yhdistäminen: <b>${FORWARD_TO_NUMBER ? "päällä" : "ei asetettu"}</b></p>
    </div>

    <div style="display:grid; grid-template-columns:repeat(3, 1fr); gap:16px; margin-bottom:24px;">
      <div style="background:white; border-radius:18px; padding:20px;"><h3>Puhelut</h3><div style="font-size:34px; font-weight:bold;">${calls.length}</div></div>
      <div style="background:white; border-radius:18px; padding:20px;"><h3>Yhdistetyt</h3><div style="font-size:34px; font-weight:bold; color:#16a34a;">${calls.filter(c => c.forwarded).length}</div></div>
      <div style="background:white; border-radius:18px; padding:20px;"><h3>Estetyt</h3><div style="font-size:34px; font-weight:bold; color:#dc2626;">${calls.filter(c => !c.safe).length}</div></div>
    </div>

    <div style="margin-bottom:18px;">
      <a href="/dashboard" style="background:#38bdf8; color:#082f49; padding:12px 18px; border-radius:999px; text-decoration:none; font-weight:bold;">Päivitä</a>
      <a href="/api/calls" style="color:white; margin-left:12px;">JSON</a>
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

app.post("/voice", (req, res) => {
  const from = req.body.From || "Tuntematon";

  addCall({
    from,
    speech: "Puhelu aloitettu, odotetaan vastausta.",
    safe: true,
    forwarded: false,
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
  const from = req.body.From || "Tuntematon";
  const speech = req.body.SpeechResult || "";
  const lowerSpeech = speech.toLowerCase();

  let safe = true;

  if (
    lowerSpeech.includes("sähkösopimus") ||
    lowerSpeech.includes("tarjoan") ||
    lowerSpeech.includes("myynti")
  ) {
    safe = false;
  }

  if (
    lowerSpeech.includes("pankki") ||
    lowerSpeech.includes("tunnus") ||
    lowerSpeech.includes("salasana")
  ) {
    safe = false;
  }

  res.type("text/xml");

  if (safe && FORWARD_TO_NUMBER) {
    addCall({
      from,
      speech,
      safe: true,
      forwarded: true,
      action: "Puhelu yhdistettiin omaan numeroon",
    });

    return res.send(`
<Response>
  <Say language="fi-FI" voice="alice">Yhdistän puhelun.</Say>
  <Dial>${FORWARD_TO_NUMBER}</Dial>
</Response>
    `);
  }

  addCall({
    from,
    speech,
    safe: false,
    forwarded: false,
    action: "Puhelua ei yhdistetty",
  });

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
