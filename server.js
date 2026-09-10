const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const mongoose = require('mongoose');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*" }
});

app.use(express.static(path.join(__dirname)));
app.use(express.json());

// --- MONGODB ATLAS CONNECTION ---
// Aapka MongoDB Atlas connection link yahan aayega:
const MONGO_URI = process.env.MONGO_URI || "mongodb+srv://prinxleo:0079@cluster0.qjozuck.mongodb.net/cashledger?retryWrites=true&w=majority&appName=Cluster0";

mongoose.connect(MONGO_URI)
  .then(async () => {
    console.log('MongoDB Connected: Cash Ledger Permanent Storage Active');
    await seedInitialExcelData();
  })
  .catch(err => console.error('MongoDB Connection Error:', err.message));

// --- TRANSACTION SCHEMA ---
const TransactionSchema = new mongoose.Schema({
  date: { type: String, required: true },
  description: { type: String, required: true },
  usdAmount: { type: Number, default: 0 },
  cashInPkr: { type: Number, default: 0 },
  netCreditPkr: { type: Number, default: 0 },
  expensePkr: { type: Number, default: 0 },
  deductionPkr: { type: Number, default: 0 },
  usdRateUsed: { type: Number, default: 0 },
  type: { type: String, enum: ['income_pkr', 'income_usd', 'expense'], required: true },
  createdAt: { type: Date, default: Date.now }
});

const Transaction = mongoose.model('Transaction', TransactionSchema);

// Auto-seed initial Excel transactions if database is fresh
async function seedInitialExcelData() {
  try {
    const count = await Transaction.countDocuments();
    if (count === 0) {
      console.log('Seeding initial September 2026 transactions from Excel...');
      const initialRows = [
        { date: '2026-09-08', description: 'Previous Balance', cashInPkr: 26426, netCreditPkr: 26426, type: 'income_pkr' },
        { date: '2026-09-08', description: 'Mama Ko Diye', expensePkr: 10000, type: 'expense' },
        { date: '2026-09-08', description: 'Personal Expenses', expensePkr: 16426, type: 'expense' },
        { date: '2026-09-09', description: 'CG-TRADER', cashInPkr: 8811, netCreditPkr: 8811, type: 'income_pkr' },
        { date: '2026-09-09', description: 'Mama Ko Diye', expensePkr: 8000, type: 'expense' },
        { date: '2026-09-09', description: 'CG-TRADER', usdAmount: 11.91, usdRateUsed: 277.38, deductionPkr: 1163, netCreditPkr: 2140.58, type: 'income_usd' },
        { date: '2026-09-10', description: 'Personal Expenses', expensePkr: 800, type: 'expense' }
      ];
      await Transaction.insertMany(initialRows);
      console.log('Initial Excel transactions imported successfully!');
    }
  } catch (err) {
    console.error('Seed error:', err.message);
  }
}

// Live USD to PKR rate fetcher
let currentUsdRate = 277.38;

async function fetchLiveUsdRate() {
  try {
    const res = await fetch('https://open.er-api.com/v6/latest/USD');
    const data = await res.json();
    if (data && data.rates && data.rates.PKR) {
      currentUsdRate = parseFloat(data.rates.PKR.toFixed(2));
      console.log('Live USD/PKR Rate updated:', currentUsdRate);
    }
  } catch (e) {
    console.log('Using default USD/PKR Rate:', currentUsdRate);
  }
}

fetchLiveUsdRate();
setInterval(fetchLiveUsdRate, 30 * 60 * 1000);

app.get('/api/rate', (req, res) => {
  res.json({ rate: currentUsdRate });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// --- REALTIME SOCKET ENGINE ---
io.on('connection', async (socket) => {
  console.log('Client connected to Cash Ledger:', socket.id);

  // Send current rate & all permanent transactions
  socket.emit('init_data', {
    rate: currentUsdRate,
    transactions: await Transaction.find().sort({ date: 1, createdAt: 1 })
  });

  // Add Transaction
  socket.on('add_transaction', async (data) => {
    try {
      let netCredit = 0;
      let usdAmount = parseFloat(data.usdAmount) || 0;
      let cashInPkr = parseFloat(data.cashInPkr) || 0;
      let expensePkr = parseFloat(data.expensePkr) || 0;
      let deduction = parseFloat(data.deductionPkr) || 0;
      let rate = parseFloat(data.usdRateUsed) || currentUsdRate;

      if (data.type === 'income_usd') {
        netCredit = parseFloat(((usdAmount * rate) - deduction).toFixed(2));
        if (netCredit < 0) netCredit = 0;
      } else if (data.type === 'income_pkr') {
        netCredit = cashInPkr;
      }

      const newTx = await Transaction.create({
        date: data.date || new Date().toISOString().split('T')[0],
        description: data.description,
        usdAmount,
        cashInPkr,
        netCreditPkr: netCredit,
        expensePkr,
        deductionPkr: deduction,
        usdRateUsed: rate,
        type: data.type
      });

      io.emit('transaction_added', newTx);
    } catch (err) {
      console.error('Error saving transaction:', err);
      socket.emit('error_msg', 'Failed to save transaction');
    }
  });

  // Delete Transaction
  socket.on('delete_transaction', async (id) => {
    try {
      await Transaction.findByIdAndDelete(id);
      io.emit('transaction_deleted', id);
    } catch (err) {
      console.error('Error deleting transaction:', err);
    }
  });

  // Manual Rate Update
  socket.on('update_rate', (newRate) => {
    const val = parseFloat(newRate);
    if (val > 0) {
      currentUsdRate = val;
      io.emit('rate_updated', currentUsdRate);
    }
  });

  socket.on('disconnect', () => {});
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Cash Ledger running on http://localhost:${PORT}`));
