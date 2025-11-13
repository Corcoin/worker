// worker.js — FULL BACKEND API (runs locally like a real server)
importScripts("https://cdnjs.cloudflare.com/ajax/libs/uuid/9.0.0/uuidv4.min.js");

const JWT_SECRET = "SUPER_SECRET_KEY";
const PAYPAL_CLIENT_ID = "YOUR_PAYPAL_CLIENT_ID";
const PAYPAL_SECRET = "YOUR_PAYPAL_SECRET";
const PAYPAL_ACCOUNT = "YOUR_PAYPAL_EMAIL";
const MAX_WITHDRAW = 500;

let db = {
  users: [],
  commodities: {
    ALU: { price: 0.000000011, supply: 1000000000 },
    OIL: { price: 0.000000100, supply: 500000000 },
    GAS: { price: 0.000000007, supply: 200000000 },
    COP: { price: 0.000000008, supply: 200000000 }
  },
  trades: []
};

function generateToken(email) {
  const header = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = btoa(JSON.stringify({ email, exp: Date.now() + 86400000 }));
  const signature = btoa(header + payload + JWT_SECRET);
  return `${header}.${payload}.${signature}`;
}

function verifyToken(token) {
  try {
    const [header, payload, signature] = token.split(".");
    const newSig = btoa(header + payload + JWT_SECRET);
    if (signature !== newSig) return null;

    const data = JSON.parse(atob(payload));
    if (Date.now() > data.exp) return null;

    return data.email;
  } catch {
    return null;
  }
}

async function getPayPalToken() {
  const res = await fetch("https://api-m.paypal.com/v1/oauth2/token", {
    method: "POST",
    headers: {
      "Authorization":
        "Basic " + btoa(`${PAYPAL_CLIENT_ID}:${PAYPAL_SECRET}`),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  const data = await res.json();
  return data.access_token;
}

async function sendPayPal(recipient, amount) {
  const token = await getPayPalToken();

  const res = await fetch(
    "https://api-m.paypal.com/v1/payments/payouts",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        sender_batch_header: {
          sender_batch_id: self.crypto.randomUUID(),
          email_subject: "Payout",
        },
        items: [
          {
            recipient_type: "EMAIL",
            amount: { value: amount, currency: "USD" },
            receiver: recipient,
            note: "Payment",
            sender_item_id: self.crypto.randomUUID(),
          },
        ],
      }),
    }
  );

  return await res.json();
}

async function handleAPI(url, method, body, headers) {
  const path = url;

  // signup
  if (path === "/signup" && method === "POST") {
    const { email, password, paypalEmail } = body;
    if (db.users.find((u) => u.email === email))
      return { error: "User exists" };
    db.users.push({
      email,
      password,
      paypalEmail,
      holdings: {},
      withdrawals: 0,
    });
    return { message: "Signup successful" };
  }

  // login
  if (path === "/login" && method === "POST") {
    const { email, password } = body;
    const user = db.users.find((u) => u.email === email);
    if (!user || user.password !== password) return { error: "Invalid" };
    return { token: generateToken(email) };
  }

  // protected routes
  const token = headers["Authorization"];
  if (!token) return { error: "No token" };
  const email = verifyToken(token);
  if (!email) return { error: "Invalid token" };

  const user = db.users.find((u) => u.email === email);

  if (path === "/commodities" && method === "GET") {
    return db.commodities;
  }

  if (path === "/buy" && method === "POST") {
    const { symbol, units, amount } = body;
    if (!db.commodities[symbol]) return { error: "Invalid commodity" };

    if (!user.holdings[symbol]) user.holdings[symbol] = 0;
    if (user.holdings[symbol] + units > 1000)
      return { error: "Max 1000 units" };

    await sendPayPal(PAYPAL_ACCOUNT, amount);

    user.holdings[symbol] += units;
    db.trades.push({
      user: email,
      type: "buy",
      symbol,
      units,
      price: db.commodities[symbol].price,
      date: new Date().toISOString(),
    });

    db.commodities[symbol].price += units * 0.000000001;

    return { message: `Bought ${units} ${symbol}` };
  }

  if (path === "/sell" && method === "POST") {
    const { symbol, units } = body;

    if (!db.commodities[symbol]) return { error: "Invalid commodity" };
    if (!user.holdings[symbol] || user.holdings[symbol] < units)
      return { error: "Not enough units" };

    user.holdings[symbol] -= units;

    db.trades.push({
      user: email,
      type: "sell",
      symbol,
      units,
      price: db.commodities[symbol].price,
      date: new Date().toISOString(),
    });

    db.commodities[symbol].price -= units * 0.000000001;
    return { message: `Sold ${units} ${symbol}` };
  }

  if (path === "/withdraw" && method === "POST") {
    const { amount } = body;
    if (amount > MAX_WITHDRAW)
      return { error: `Max ${MAX_WITHDRAW}` };

    const payout = await sendPayPal(user.paypalEmail, amount);
    return { success: true, payout };
  }

  if (path === "/admin/trades" && method === "GET") {
    if (email !== "brianwesson0@gmail.com") return [];
    return db.trades;
  }

  return { error: "Unknown route" };
}

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  if (!url.pathname.startsWith("/api")) return;

  event.respondWith(
    (async () => {
      const result = await handleAPI(
        url.pathname.replace("/api", ""),
        event.request.method,
        event.request.method === "GET" ? {} : await event.request.json(),
        Object.fromEntries(event.request.headers)
      );

      return new Response(JSON.stringify(result), {
        headers: { "Content-Type": "application/json" },
      });
    })()
  );
});
