const { TronWeb } = require('tronweb');
const bip39 = require('bip39');
const HDKey = require('hdkey');

// Child wallets start at index 1; index 0 is reserved for master derivation
const CHILD_START_INDEX = 1;

function buildTronWeb(privateKey = null) {
  // Defaulting to Shasta (testnet) made every balance check/sweep/withdrawal
  // silently query the wrong network whenever TRON_NETWORK wasn't set —
  // this is a production app handling real deposits, so mainnet is the
  // only sane default. Set TRON_NETWORK=shasta explicitly for testing.
  const network = process.env.TRON_NETWORK || 'mainnet';
  const fullHost = network === 'mainnet'
    ? 'https://api.trongrid.io'
    : 'https://api.shasta.trongrid.io';

  const opts = {
    fullHost,
    headers: { 'TRON-PRO-API-KEY': process.env.TRON_API_KEY },
  };
  if (privateKey) opts.privateKey = privateKey;
  return new TronWeb(opts);
}

// Derive private key + address for a given derivation index
async function deriveWallet(index) {
  const mnemonic = process.env.MASTER_MNEMONIC;
  if (!mnemonic) throw new Error('MASTER_MNEMONIC not set in .env');

  const seed = await bip39.mnemonicToSeed(mnemonic);
  const master = HDKey.fromMasterSeed(seed);
  const child = master.derive(`m/44'/195'/0'/0/${index}`);
  const privateKey = child.privateKey.toString('hex');

  const tw = buildTronWeb();
  const address = tw.address.fromPrivateKey(privateKey);
  return { privateKey, address };
}

// Derive master wallet (index 0)
async function deriveMasterWallet() {
  return deriveWallet(0);
}

// Single source of truth for the sweep/receive destination — always the
// address actually derived from MASTER_MNEMONIC, never a separately
// configured MASTER_ADDRESS env var. A hand-set MASTER_ADDRESS that drifts
// out of sync with the mnemonic (typo, stale copy-paste, mnemonic rotated)
// silently sends swept deposits to an address nobody can open with the
// mnemonic — the sweep still "succeeds" (valid txid) and gas still gets
// deducted correctly from the real derived wallet, so nothing ever errors;
// the funds just never show up in the actual HD wallet.
let _cachedMasterAddress = null;
async function getMasterAddress() {
  if (!_cachedMasterAddress) {
    const master = await deriveMasterWallet();
    _cachedMasterAddress = master.address;
    if (process.env.MASTER_ADDRESS && process.env.MASTER_ADDRESS !== _cachedMasterAddress) {
      console.error(
        `[tronWalletService] MASTER_ADDRESS env var (${process.env.MASTER_ADDRESS}) does NOT match ` +
        `the address derived from MASTER_MNEMONIC (${_cachedMasterAddress}). Sweeps now go to the ` +
        `derived address — if MASTER_ADDRESS was being used elsewhere, check any funds already sent ` +
        `there under the old, wrong address.`
      );
    }
  }
  return _cachedMasterAddress;
}

// Derive child wallet for a user (index >= 1)
async function deriveChildWallet(derivationIndex) {
  if (derivationIndex < CHILD_START_INDEX) {
    throw new Error('derivationIndex must be >= 1');
  }
  return deriveWallet(derivationIndex);
}

// Get TRX balance of any address in TRX (not sun)
// Returns 0 for unactivated addresses instead of throwing
async function getBalance(address) {
  const tw = buildTronWeb();
  try {
    const sunBalance = await tw.trx.getBalance(address);
    return Number(sunBalance) / 1_000_000;
  } catch (err) {
    if (/not exist|not activated|not found/i.test(err.message || '')) return 0;
    throw err;
  }
}

// Get master wallet TRX balance
async function getMasterBalance() {
  return getBalance(await getMasterAddress());
}

// Sweep entire balance from child wallet → master wallet
// Returns txid string on success
async function sweepToMaster(derivationIndex) {
  const child = await deriveChildWallet(derivationIndex);
  const tw = buildTronWeb();

  const sunBalance = await tw.trx.getBalance(child.address);
  const minSun = Math.floor((parseFloat(process.env.SWEEP_MIN_AMOUNT_TRX) || 1) * 1_000_000);
  const feeSun = 200_000; // 0.2 TRX buffer for network fee

  if (sunBalance < minSun) {
    throw new Error(
      `Child balance ${sunBalance / 1_000_000} TRX is below sweep minimum ${process.env.SWEEP_MIN_AMOUNT_TRX || 1} TRX`
    );
  }

  const sendSun = sunBalance - feeSun;
  if (sendSun <= 0) throw new Error('Insufficient balance after deducting fee');

  const masterAddress = await getMasterAddress();
  const childTw = buildTronWeb(child.privateKey);
  const tx = await childTw.trx.sendTrx(masterAddress, sendSun, { privateKey: child.privateKey });

  if (!tx || !tx.txid) throw new Error('Sweep broadcast failed — no txid returned');
  return tx.txid;
}

// Sweep USDT TRC20 from child wallet → master wallet
const USDT_CONTRACT = {
  mainnet: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
  shasta:  'TG3XXyExBkPp9nzdajDZsozEu4BkaSJozs'
};

async function sweepUSDTToMaster(derivationIndex) {
  const network = process.env.TRON_NETWORK || 'mainnet';
  const contractAddress = process.env.USDT_CONTRACT_ADDRESS || USDT_CONTRACT[network];
  const masterAddress = await getMasterAddress();

  const child = await deriveChildWallet(derivationIndex);
  const tw = buildTronWeb(child.privateKey);

  // Get USDT balance
  const contract = await tw.contract().at(contractAddress);
  const rawBalance = await contract.balanceOf(child.address).call();

  // Handle BigNumber / string / number from different TronWeb versions
  let amountRaw;
  if (rawBalance && typeof rawBalance === 'object' && rawBalance._isBigNumber) {
    amountRaw = rawBalance.toString();
  } else if (rawBalance && typeof rawBalance === 'object' && typeof rawBalance.toString === 'function') {
    amountRaw = rawBalance.toString();
  } else {
    amountRaw = String(rawBalance);
  }

  const amountUsdt = Number(amountRaw) / 1_000_000;
  if (amountUsdt <= 0) throw new Error('No USDT balance in child wallet');

  const minSweepUsdt = parseFloat(process.env.SWEEP_MIN_USDT || '0');
  if (minSweepUsdt > 0 && amountUsdt < minSweepUsdt) {
    throw new Error(`USDT balance ${amountUsdt} below minimum ${minSweepUsdt}`);
  }

  // Use triggerSmartContract for reliable TRC20 transfer
  const { transaction } = await tw.transactionBuilder.triggerSmartContract(
    contractAddress,
    'transfer(address,uint256)',
    { feeLimit: 100_000_000, callValue: 0, shouldPollResponse: false },
    [
      { type: 'address', value: masterAddress },
      { type: 'uint256', value: amountRaw }
    ],
    child.address
  );

  const signed = await tw.trx.sign(transaction, child.privateKey);
  const result = await tw.trx.sendRawTransaction(signed);

  if (!result || (!result.result && !result.txid)) {
    throw new Error(`USDT sweep failed: ${JSON.stringify(result)}`);
  }
  return result.txid || result.transaction?.txID;
}

// In-memory lock to prevent concurrent sweeps for the same address
const _sweepLocks = new Set();

// Ensure child wallet has enough TRX and is activated on-chain
async function ensureChildTRX(childAddress, forUsdt = false) {
  const energyTrx = parseFloat(process.env.SWEEP_ENERGY_TRX || '15');
  const activationTrx = parseFloat(process.env.WALLET_ACTIVATION_TRX || '1.1');
  const needed = forUsdt ? energyTrx : activationTrx;

  const balance = await getBalance(childAddress);
  if (balance < needed) {
    const topUp = parseFloat((needed - balance).toFixed(2));
    const txid = await sendFromMaster(childAddress, topUp);
    console.log(`Topped up ${childAddress} with ${topUp} TRX | txid ${txid}`);

    // Poll until account is activated (max 60 seconds)
    for (let i = 0; i < 12; i++) {
      await new Promise(r => setTimeout(r, 5000));
      const newBalance = await getBalance(childAddress);
      if (newBalance >= 1) {
        console.log(`${childAddress} activated, balance: ${newBalance} TRX`);
        return;
      }
    }
    throw new Error(`Account ${childAddress} not activated after 60s`);
  }
}

// Send TRX from master wallet → any address (used for withdrawals)
// amountTrx is a string or number in TRX (not sun)
async function sendFromMaster(toAddress, amountTrx) {
  const master = await deriveMasterWallet();
  const amountSun = Math.floor(parseFloat(amountTrx) * 1_000_000);
  if (amountSun <= 0) throw new Error('Invalid withdrawal amount');

  const tw = buildTronWeb(master.privateKey);

  // Validate destination address
  if (!tw.isAddress(toAddress)) throw new Error(`Invalid TRON address: ${toAddress}`);

  const tx = await tw.trx.sendTrx(toAddress, amountSun, { privateKey: master.privateKey });
  if (!tx || !tx.txid) throw new Error('Withdrawal broadcast failed — no txid returned');
  return tx.txid;
}

// Verify that a tx hash actually delivered TRX to the expected address
// Returns { confirmed, amount } where amount is in TRX
async function verifyTransaction(txHash) {
  const tw = buildTronWeb();
  try {
    const tx = await tw.trx.getTransaction(txHash);
    if (!tx || !tx.ret || tx.ret[0]?.contractRet !== 'SUCCESS') {
      return { confirmed: false, amount: 0 };
    }
    const contract = tx.raw_data?.contract?.[0];
    if (contract?.type !== 'TransferContract') return { confirmed: false, amount: 0 };
    const value = contract.parameter?.value;
    return {
      confirmed: true,
      toAddress: TronWeb.address.fromHex(value.to_address),
      fromAddress: TronWeb.address.fromHex(value.owner_address),
      amount: value.amount / 1_000_000,
    };
  } catch {
    return { confirmed: false, amount: 0 };
  }
}

module.exports = {
  deriveChildWallet,
  deriveMasterWallet,
  getMasterAddress,
  getBalance,
  getMasterBalance,
  ensureChildTRX,
  sweepToMaster,
  sweepUSDTToMaster,
  sendFromMaster,
  verifyTransaction,
};
