require('dotenv').config();
const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

// ─── SALOON CONFIG ───────────────────────────────────────────────
const SALOON_NAME = "Aditya Saloon";

const SERVICES = [
  { id: "haircut", name: "Haircut", price: 60 },
  { id: "shave", name: "Shave", price: 40 },
  { id: "hair_dyeing", name: "Hair Dyeing", price: 40 },
];

const OPEN_HOUR = 8;
const CLOSE_HOUR = 20;
const BREAK_START = 14;
const BREAK_END = 15;
const SLOT_GAP = 35;

// ─── GENERATE TIME SLOTS ─────────────────────────────────────────
function generateSlots() {
  const slots = [];
  let totalMinutes = OPEN_HOUR * 60;
  while (true) {
    const hour = Math.floor(totalMinutes / 60);
    const minute = totalMinutes % 60;
    if (hour >= BREAK_START && hour < BREAK_END) {
      totalMinutes = BREAK_END * 60;
      continue;
    }
    if (totalMinutes + 30 > CLOSE_HOUR * 60) break;
    const h = hour % 12 === 0 ? 12 : hour % 12;
    const m = String(minute).padStart(2, "0");
    const ampm = hour < 12 ? "AM" : "PM";
    slots.push(`${h}:${m} ${ampm}`);
    totalMinutes += SLOT_GAP;
  }
  return slots;
}

const ALL_SLOTS = generateSlots();
const bookedSlots = {};

function getAvailableSlots(date) {
  const booked = bookedSlots[date] || [];
  return ALL_SLOTS.filter(s => !booked.includes(s));
}

function bookSlot(date, slot) {
  if (!bookedSlots[date]) bookedSlots[date] = [];
  bookedSlots[date].push(slot);
}

const sessions = {};

// ─── SEND WHATSAPP MESSAGE ───────────────────────────────────────
async function sendMsg(to, text) {
  try {
    await axios.post(
      `https://graph.facebook.com/v18.0/${process.env.PHONE_NUMBER_ID}/messages`,
      { messaging_product: 'whatsapp', to, type: 'text', text: { body: text } },
      { headers: { Authorization: `Bearer ${process.env.ACCESS_TOKEN}` } }
    );
  } catch (e) {
    console.error('Send error:', e.response?.data || e.message);
  }
}

// ─── GEMINI AI ───────────────────────────────────────────────────
async function askGemini(userMessage, session) {
  const serviceList = SERVICES.map(s => `${s.name} (Rs.${s.price})`).join(", ");
  const today = new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

  let availableSlotsText = "";
  if (session.date) {
    const slots = getAvailableSlots(session.date);
    availableSlotsText = slots.length > 0 ? slots.join(", ") : "Koi slot available nahi hai.";
  }

  const prompt = `Tu ${SALOON_NAME} ka WhatsApp booking assistant hai. Hinglish mein baat kar. Short aur friendly replies do.

SALOON:
- Services: ${serviceList}
- Timing: 8 AM - 8 PM (Monday to Sunday)
- Break: 2 PM - 3 PM (booking nahi hogi)
- Appointment: 30 minute each
- Aaj: ${today}

BOOKING STATE:
- Step: ${session.step}
- Service: ${session.service || "nahi"}
- Date: ${session.date || "nahi"}
- Slot: ${session.slot || "nahi"}
${session.date ? `- Available slots: ${availableSlotsText}` : ""}

RULES:
1. Sirf yeh 3 services: Haircut, Shave, Hair Dyeing. Koi aur service nahi milegi.
2. Break time (2-3 PM) mein booking nahi
3. Sirf booking related baat karo
4. Payment: PhonePe/UPI ID ${process.env.UPI_ID} pe Rs.20 advance
5. Payment ke baad UTR number maango

FLOW:
start -> service pucho
service_selected -> date pucho
date_selected -> slots dikhao, time pucho  
slot_selected -> payment details do
payment_pending -> UTR maango, confirm karo

Sirf JSON return karo, kuch aur nahi:
{"reply":"customer ko message","action":"none OR set_service OR set_date OR set_slot OR confirm_booking","value":""}

Customer: ${userMessage}`;

  try {
    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.5, maxOutputTokens: 400 }
      }
    );
    const text = response.data.candidates[0].content.parts[0].text;
    const clean = text.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  } catch (e) {
    console.error('Gemini error:', e.response?.data || e.message);
    return { reply: "Maafi, thodi dikkat hai. Dobara try karein.", action: "none", value: "" };
  }
}

// ─── HANDLE MESSAGE ───────────────────────────────────────────────
async function handleMessage(from, text) {
  if (!sessions[from]) {
    sessions[from] = { step: 'start', service: null, date: null, slot: null };
  }
  const session = sessions[from];
  const result = await askGemini(text, session);

  if (result.action === 'set_service' && result.value) {
    session.service = result.value;
    session.step = 'service_selected';
  }
  if (result.action === 'set_date' && result.value) {
    session.date = result.value;
    session.step = 'date_selected';
  }
  if (result.action === 'set_slot' && result.value) {
    const available = getAvailableSlots(session.date || '');
    if (available.includes(result.value)) {
      session.slot = result.value;
      session.step = 'slot_selected';
    }
  }
  if (result.action === 'confirm_booking') {
    if (session.date && session.slot) bookSlot(session.date, session.slot);
    session.step = 'done';
    await sendMsg(process.env.OWNER_PHONE,
      `Nai Booking!\nCustomer: ${from}\nService: ${session.service}\nDate: ${session.date}\nTime: ${session.slot}\nPayment verify karein.`
    );
    scheduleReminder(from, session.service, session.date, session.slot);
    setTimeout(() => {
      sessions[from] = { step: 'start', service: null, date: null, slot: null };
    }, 10 * 60 * 1000);
  }

  await sendMsg(from, result.reply);
}

// ─── REMINDER ─────────────────────────────────────────────────────
function scheduleReminder(to, service, date, timeStr) {
  try {
    if (!timeStr || !date) return;
    const [time, meridiem] = timeStr.split(' ');
    let [h, m] = time.split(':').map(Number);
    if (meridiem === 'PM' && h !== 12) h += 12;
    if (meridiem === 'AM' && h === 12) h = 0;
    const apptDate = new Date(date);
    apptDate.setHours(h, m - 10, 0, 0);
    const diff = apptDate - new Date();
    if (diff > 0) {
      setTimeout(async () => {
        await sendMsg(to, `Reminder! Aapki ${service} appointment sirf 10 minute mein hai! Jaldi aa jaayein. ${SALOON_NAME}`);
      }, diff);
    }
  } catch (e) {
    console.error('Reminder error:', e.message);
  }
}

// ─── WEBHOOK ──────────────────────────────────────────────────────
app.get('/webhook', (req, res) => {
  if (req.query['hub.verify_token'] === process.env.VERIFY_TOKEN) {
    res.send(req.query['hub.challenge']);
  } else res.sendStatus(403);
});

app.post('/webhook', (req, res) => {
  try {
    const entry = req.body?.entry?.[0]?.changes?.[0]?.value;
    const msg = entry?.messages?.[0];
    if (msg && msg.type === 'text') {
      console.log(`From ${msg.from}: ${msg.text.body}`);
      handleMessage(msg.from, msg.text.body);
    }
  } catch (e) {
    console.error('Webhook error:', e.message);
  }
  res.sendStatus(200);
});

app.listen(process.env.PORT || 3000, () => {
  console.log(`${SALOON_NAME} AI bot chal raha hai!`);
  console.log('Slots:', ALL_SLOTS.join(', '));
});
