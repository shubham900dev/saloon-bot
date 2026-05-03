require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cron = require('node-cron');
const app = express();
app.use(express.json());

const SERVICES = ['1. Haircut', '2. Shave', '3. Haircut + Shave', '4. Facial', '5. Hair Color', '6. Beard Trim'];
const TIMES = ['1. 10:00 AM', '2. 11:00 AM', '3. 12:00 PM', '4. 2:00 PM', '5. 3:00 PM', '6. 4:00 PM', '7. 5:00 PM'];
const sessions = {};

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

async function handleMessage(from, text) {
  text = text.trim();
  if (!sessions[from]) sessions[from] = { step: 'start' };
  const s = sessions[from];

  if (s.step === 'start') {
    s.step = 'service';
    await sendMsg(from,
      'Namaste! Aditya Saloon mein aapka swagat hai! ✂\n\nKaunsi service chahiye?\n\n' +
      SERVICES.join('\n') +
      '\n\nNumber likho (jaise: 1)'
    );
  } else if (s.step === 'service') {
    const idx = parseInt(text) - 1;
    if (idx < 0 || idx >= SERVICES.length) {
      await sendMsg(from, 'Kripya sahi number likho (1 se 6 ke beech)');
      return;
    }
    s.service = SERVICES[idx].substring(3);
    s.step = 'time';
    await sendMsg(from,
      `${s.service} - Sahi hai!\n\nKaunsa time chahiye?\n\n` +
      TIMES.join('\n') +
      '\n\nNumber likho (jaise: 1)'
    );
  } else if (s.step === 'time') {
    const idx = parseInt(text) - 1;
    if (idx < 0 || idx >= TIMES.length) {
      await sendMsg(from, 'Kripya sahi number likho (1 se 7 ke beech)');
      return;
    }
    s.time = TIMES[idx].substring(3);
    s.step = 'payment';
    await sendMsg(from,
      `Booking Summary:\n` +
      `Service: ${s.service}\n` +
      `Time: ${s.time}\n\n` +
      `Booking confirm karne ke liye *₹20 advance* bhejein:\n` +
      `UPI ID: *${process.env.UPI_ID}*\n\n` +
      `Payment ke baad UTR/Transaction ID yahan bhejein.`
    );
  } else if (s.step === 'payment') {
    if (text.length < 6) {
      await sendMsg(from, 'Kripya sahi UTR/Transaction ID bhejein.');
      return;
    }
    s.utr = text;
    s.step = 'done';
    await sendMsg(from,
      `Booking Confirmed! \n\n` +
      `Service: ${s.service}\n` +
      `Time: ${s.time}\n` +
      `UTR: ${s.utr}\n\n` +
      `Samay par aa jaayein. Dhanyavaad! 🙏`
    );
    await sendMsg(process.env.OWNER_PHONE,
      `Nai Booking!\n` +
      `Customer: ${from}\n` +
      `Service: ${s.service}\n` +
      `Time: ${s.time}\n` +
      `UTR: ${s.utr}`
    );
    scheduleReminder(from, s.service, s.time);
  } else {
    sessions[from] = { step: 'start' };
    await handleMessage(from, text);
  }
}

function scheduleReminder(to, service, timeStr) {
  try {
    const [time, meridiem] = timeStr.split(' ');
    let [h, m] = time.split(':').map(Number);
    if (meridiem === 'PM' && h !== 12) h += 12;
    if (meridiem === 'AM' && h === 12) h = 0;
    let reminderH = h;
    let reminderM = m - 10;
    if (reminderM < 0) { reminderM += 60; reminderH -= 1; }
    const cronExpr = `${reminderM} ${reminderH} * * *`;
    const job = cron.schedule(cronExpr, async () => {
      await sendMsg(to, `Reminder! Aapki *${service}* appointment sirf 10 minute mein hai!\nJaldi aa jaayein. Aditya Saloon ✂`);
      job.stop();
    });
    console.log(`Reminder set: ${cronExpr} for ${to}`);
  } catch (e) {
    console.error('Reminder error:', e.message);
  }
}

app.get('/webhook', (req, res) => {
  if (req.query['hub.verify_token'] === process.env.VERIFY_TOKEN) {
    res.send(req.query['hub.challenge']);
  } else res.sendStatus(403);
});

app.post('/webhook', (req, res) => {
  try {
    const entry = req.body?.entry?.[0]?.changes?.[0]?.value;
    const msg = entry?.messages?.[0];
    if (msg) {
      const from = msg.from;
      const text = msg.text?.body;
      if (text) handleMessage(from, text);
    }
  } catch (e) {
    console.error('Webhook error:', e.message);
  }
  res.sendStatus(200);
});

app.listen(process.env.PORT || 3000, () => console.log('Saloon bot chal raha hai!'));