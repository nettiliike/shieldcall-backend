require("dotenv").config();

const express = require("express");
const app = express();

const PORT = process.env.PORT || 3000;
const FORWARD_TO_NUMBER = process.env.FORWARD_TO_NUMBER;

app.use(express.urlencoded({ extended: true }));

app.post("/voice", (req, res) => {
  res.type("text/xml");
  res.send(`
<Response>
  <Say language="fi-FI" voice="alice">
  Hei, tämä on puhelinavustaja. Kerro lyhyesti asiasi.
</Say>
  <Gather input="speech" action="/gather" method="POST">
   <Say language="fi-FI" voice="alice">Puhu nyt.</Say>
  </Gather>
</Response>
  `);
});

app.post("/gather", (req, res) => {
  const speech = (req.body.SpeechResult || "").toLowerCase();

  let safe = true;

  if (
    speech.includes("sähkösopimus") ||
    speech.includes("tarjoan") ||
    speech.includes("myynti")
  ) {
    safe = false;
  }

  if (
    speech.includes("pankki") ||
    speech.includes("tunnus") ||
    speech.includes("salasana")
  ) {
    safe = false;
  }

  res.type("text/xml");

  if (safe && FORWARD_TO_NUMBER) {
    return res.send(`
<Response>
  <Say language="fi-FI" voice="alice">Yhdistän puhelun.</Say>
  <Dial>${FORWARD_TO_NUMBER}</Dial>
</Response>
    `);
  }

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
