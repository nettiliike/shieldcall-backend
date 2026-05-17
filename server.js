const express = require("express");
const twilio = require("twilio");
const admin = require("firebase-admin");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Firebase
if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const db = admin.firestore();
const COLLECTION = "calls";

// Etusivu
app.get("/", (req, res) => {
  res.send("AI Puhelinvastaaja backend toimii ✅");
});

// Dashboard
app.get("/dashboard", (req, res) => {
  res.sendFile(__dirname + "/dashboard-ai-voicemail.html");
});

// Puheluiden haku dashboardille
app.get("/api/calls", async (req, res) => {
  try {
    const snapshot = await db
      .collection(COLLECTION)
      .orderBy("createdAt", "desc")
      .limit(50)
      .get();

    const calls = snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));

    res.json(calls);
  } catch (error) {
    console.error("Virhe puheluiden haussa:", error);
    res.status(500).json({ error: "Puheluiden haku epäonnistui" });
  }
});

// Oletusasetukset
const defaultAssistantSettings = {
  activeReply: "reply1",
  replies: {
    reply1: {
      name: "Palaveri",
      message:
        "Hei, olen juuri palaverissa. Kerro lyhyesti nimesi ja asiasi, niin välitän viestin eteenpäin.",
    },
    reply2: {
      name: "Reissussa",
      message:
        "Hei, olen tällä hetkellä reissussa enkä pääse vastaamaan. Kerro lyhyesti nimesi ja asiasi, niin palaan asiaan myöhemmin.",
    },
    reply3: {
      name: "Yleinen",
      message:
        "Hei, olet yhteydessä tekoälyavustajaan. Kerro lyhyesti nimesi ja asiasi.",
    },
  },
};

async function getAssistantSettings() {
  const doc = await db.collection("settings").doc("assistant").get();

  if (!doc.exists) {
    return defaultAssistantSettings;
  }

  const data = doc.data();

  return {
    ...defaultAssistantSettings,
    ...data,
    replies: {
      ...defaultAssistantSettings.replies,
      ...(data.replies || {}),
    },
  };
}

async function getActiveAssistantMessage() {
  const settings = await getAssistantSettings();
  const activeReply = settings.activeReply || "reply1";
  const reply = settings.replies?.[activeReply];

  return reply?.message || defaultAssistantSettings.replies.reply1.message;
}

// Asetusten haku dashboardille
app.get("/api/settings", async (req, res) => {
  try {
    const settings = await getAssistantSettings();
    res.json(settings);
  } catch (error) {
    console.error("Asetusten haku epäonnistui:", error);
    res.status(500).json({ error: "Asetusten haku epäonnistui" });
  }
});

// Asetusten tallennus dashboardilta
app.post("/api/settings", async (req, res) => {
  try {
    const { activeReply, replies } = req.body;

    await db.collection("settings").doc("assistant").set(
      {
        activeReply,
        replies,
        updatedAt: new Date(),
      },
      { merge: true }
    );

    res.json({ ok: true });
  } catch (error) {
    console.error("Asetusten tallennus epäonnistui:", error);
    res.status(500).json({ error: "Asetusten tallennus epäonnistui" });
  }
});

// Twilio soittaa tähän
app.post("/voice", async (req, res) => {
  try {
    const twiml = new twilio.twiml.VoiceResponse();
    const assistantMessage = await getActiveAssistantMessage();

    const gather = twiml.gather({
      input: "speech",
      action: "/process-speech",
      method: "POST",
      language: "fi-FI",
      speechTimeout: "auto",
      timeout: 6,
    });

    gather.say(
      {
        language: "fi-FI",
      },
      assistantMessage
    );

    twiml.say(
      {
        language: "fi-FI",
      },
      "En kuullut vastausta. Voit yrittää myöhemmin uudelleen. Hei hei."
    );

    res.type("text/xml");
    res.send(twiml.toString());
  } catch (error) {
    console.error("Virhe /voice reitissä:", error);

    const twiml = new twilio.twiml.VoiceResponse();
    twiml.say(
      {
        language: "fi-FI",
      },
      "Puhelinavustajassa tapahtui virhe. Yritä myöhemmin uudelleen."
    );

    res.type("text/xml");
    res.send(twiml.toString());
  }
});

// Puheen käsittely
app.post("/process-speech", async (req, res) => {
  try {
    const speechText = req.body.SpeechResult || "";
    const from = req.body.From || "Tuntematon";
    const callSid = req.body.CallSid || "";

    let ai = {
      category: "Epäselvä",
      priority: "keskitaso",
      summary: speechText || "Ei puhesisältöä",
      recommendedAction: "Tarkista puhelu",
      spamRisk: 20,
      riskReason: "Ei tarkempaa analyysiä",
    };

    if (process.env.OPENAI_API_KEY && speechText) {
      try {
        const response = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "gpt-4o-mini",
            messages: [
              {
                role: "system",
                content:
                  "Analysoi suomenkielinen puhelu. Vastaa vain JSON-muodossa kentillä: category, priority, summary, recommendedAction, spamRisk, riskReason. priority on matala, keskitaso tai korkea. spamRisk on numero 0-100.",
              },
              {
                role: "user",
                content: speechText,
              },
            ],
            temperature: 0.2,
          }),
        });

        const data = await response.json();
        const text = data.choices?.[0]?.message?.content || "";

        const cleaned = text
          .replace(/```json/g, "")
          .replace(/```/g, "")
          .trim();

        ai = {
          ...ai,
          ...JSON.parse(cleaned),
        };
      } catch (openAiError) {
        console.error("OpenAI-analyysi epäonnistui:", openAiError);
      }
    }

    await db.collection(COLLECTION).add({
      from,
      callerNumber: from,
      callSid,
      transcript: speechText,
      speechText,
      category: ai.category || "Epäselvä",
      priority: ai.priority || "keskitaso",
      summary: ai.summary || speechText || "Ei yhteenvetoa",
      recommendedAction: ai.recommendedAction || "Tarkista puhelu",
      spamRisk: Number(ai.spamRisk ?? 20),
      riskReason: ai.riskReason || "Ei riskiselitettä",
      status: "new",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    const twiml = new twilio.twiml.VoiceResponse();

    twiml.say(
      {
        language: "fi-FI",
      },
      "Kiitos. Välitän viestin eteenpäin. Hei hei."
    );

    res.type("text/xml");
    res.send(twiml.toString());
  } catch (error) {
    console.error("Virhe /process-speech reitissä:", error);

    const twiml = new twilio.twiml.VoiceResponse();

    twiml.say(
      {
        language: "fi-FI",
      },
      "Kiitos soitosta. Viestin käsittelyssä tapahtui virhe."
    );

    res.type("text/xml");
    res.send(twiml.toString());
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
