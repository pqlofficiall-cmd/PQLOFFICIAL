const https = require('https');
const prisma = require('../prismaClient');
const { TronWeb } = require('tronweb');

// USDT TRC20 contract addresses
const USDT_CONTRACT = {
  mainnet: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
  shasta: 'TG3XXyExBkPp9nzdajDZsozEu4BkaSJozs'
};

class DepositPoller {
  constructor() {
    this.polling = false;
    // Same fail-safe as tronWalletService.js — this is production, real
    // deposits, mainnet is the only sane default.
    this.network = process.env.TRON_NETWORK || 'mainnet';
    this.apiKey = process.env.TRON_API_KEY;
    this.baseHost = this.network === 'mainnet' ? 'api.trongrid.io' : 'api.shasta.trongrid.io';
    this.usdtContract = process.env.USDT_CONTRACT_ADDRESS || USDT_CONTRACT[this.network] || USDT_CONTRACT.mainnet;
    this.masterAddress = null;
  }

  start() {
    const intervalMs = parseInt(process.env.DEPOSIT_POLL_INTERVAL_MS) || 600000; // 10 minutes default

    // Resolve master address to ignore gas fee deposits from it. Always derive
    // from MASTER_MNEMONIC (not a separately configured MASTER_ADDRESS env var)
    // so this can never drift out of sync with the wallet sweeps actually pay into.
    if (process.env.MASTER_MNEMONIC) {
      const tronWalletService = require('./tronWalletService');
      tronWalletService.deriveMasterWallet().then(w => {
        this.masterAddress = w.address;
        console.log('[DepositPoller] Resolved Master Address:', this.masterAddress);
      }).catch(e => console.error('[DepositPoller] Failed to resolve master wallet', e));
    }

    setTimeout(() => {
      this.poll();
      setInterval(() => this.poll(), intervalMs);
    }, 10000);
    console.log(`Deposit poller started — checking every ${intervalMs / 1000}s on ${this.network}`);
  }

  async poll() {
    if (this.polling) return;
    this.polling = true;
    try {
      const wallets = await prisma.tronWallet.findMany({
        select: { userId: true, tronAddress: true, derivationIndex: true }
      });
      for (const wallet of wallets) {
        await this.checkAddressTRC20(wallet).catch(err =>
          console.error(`TRC20 poller error for ${wallet.tronAddress}:`, err.message)
        );
        
        // Sleep between requests to avoid 429 Too Many Requests limits (burst)
        await new Promise(resolve => setTimeout(resolve, 500));

        await this.checkAddressTRX(wallet).catch(err =>
          console.error(`TRX poller error for ${wallet.tronAddress}:`, err.message)
        );

        // Sleep between wallets to stretch out the checks over time safely
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    } finally {
      this.polling = false;
    }
  }

  // ── TRC20 USDT deposits ────────────────────────────────────────────────────
  checkAddressTRC20(wallet) {
    return new Promise((resolve) => {
      const path = `/v1/accounts/${wallet.tronAddress}/transactions/trc20?limit=20&only_confirmed=true&contract_address=${this.usdtContract}`;
      const options = {
        hostname: this.baseHost,
        path,
        method: 'GET',
        headers: { 'TRON-PRO-API-KEY': this.apiKey, 'Accept': 'application/json' }
      };

      const req = https.request(options, (res) => {
        let body = '';
        res.on('data', chunk => { body += chunk; });
        res.on('end', async () => {
          try {
            if (res.statusCode !== 200) return resolve();
            const parsed = JSON.parse(body);
            if (!Array.isArray(parsed.data)) return resolve();
            for (const tx of parsed.data) {
              await this.processTRC20Tx(tx, wallet);
            }
          } catch {
            // Ignore parse errors
          } finally {
            resolve();
          }
        });
      });

      req.on('error', () => resolve());
      req.setTimeout(10000, () => { req.destroy(); resolve(); });
      req.end();
    });
  }

  async processTRC20Tx(tx, wallet) {
    // Only incoming transfers to this address
    if (tx.to !== wallet.tronAddress) return;
    if (tx.type !== 'Transfer') return;

    const txHash = tx.transaction_id;
    if (!txHash) return;

    const decimals = tx.token_info?.decimals ?? 6;
    const amountUsdt = parseInt(tx.value || '0') / Math.pow(10, decimals);
    if (amountUsdt <= 0) return;

    const fromAddress = tx.from;
    const symbol = tx.token_info?.symbol || 'USDT';

    // Idempotent: skip if already recorded
    const existing = await prisma.deposit.findUnique({ where: { txHash } });
    if (existing) return;

    const deposit = await prisma.deposit.create({
      data: {
        userId: wallet.userId,
        txHash,
        fromAddress,
        amount: amountUsdt,
        currency: symbol || 'USDT',
        status: 'pending_approval',
        sweepStatus: 'pending'
      }
    });

    console.log(`[DepositPoller] New TRC20 deposit: ${amountUsdt} ${symbol} | user ${wallet.userId} | tx ${txHash}`);

    const depositApproval = require('./depositApproval');
    try {
      await depositApproval.approveDeposit(deposit.id);
      console.log(`[DepositPoller] Auto-approved deposit ${deposit.id}`);
    } catch (err) {
      console.error(`[DepositPoller] Auto-approve failed for deposit ${deposit.id}:`, err.message);
      if (global.ns) {
        await global.ns.send(
          wallet.userId,
          'Deposit Detected',
          `We detected ${amountUsdt} ${symbol} sent to your wallet. It will be credited shortly.`,
          'DEPOSIT'
        );
      }
    }
  }

  // ── Native TRX deposits ────────────────────────────────────────────────────
  checkAddressTRX(wallet) {
    return new Promise((resolve) => {
      const path = `/v1/accounts/${wallet.tronAddress}/transactions?limit=20&only_confirmed=true&order_by=block_timestamp,desc`;
      const options = {
        hostname: this.baseHost,
        path,
        method: 'GET',
        headers: { 'TRON-PRO-API-KEY': this.apiKey, 'Accept': 'application/json' }
      };

      const req = https.request(options, (res) => {
        let body = '';
        res.on('data', chunk => { body += chunk; });
        res.on('end', async () => {
          try {
            if (res.statusCode !== 200) return resolve();
            const parsed = JSON.parse(body);
            if (!Array.isArray(parsed.data)) return resolve();
            for (const tx of parsed.data) {
              await this.processTRXTx(tx, wallet);
            }
          } catch {
            // Ignore parse errors
          } finally {
            resolve();
          }
        });
      });

      req.on('error', () => resolve());
      req.setTimeout(10000, () => { req.destroy(); resolve(); });
      req.end();
    });
  }

  async processTRXTx(tx, wallet) {
    if (!tx.ret || tx.ret[0]?.contractRet !== 'SUCCESS') return;

    const contract = tx.raw_data?.contract?.[0];
    if (contract?.type !== 'TransferContract') return;

    const value = contract.parameter?.value;
    if (!value || !value.to_address || !value.owner_address || !value.amount) return;

    const toAddress = TronWeb.address.fromHex(value.to_address);
    if (toAddress !== wallet.tronAddress) return;

    const txHash = tx.txID;
    const amountTrx = value.amount / 1_000_000;
    const fromAddress = TronWeb.address.fromHex(value.owner_address);

    // Ignore ANY deposit from our own master wallet (it's gas fee top-up)
    if (this.masterAddress && fromAddress === this.masterAddress) {
      console.log(`[DepositPoller] Ignored gas fee deposit from master wallet to ${wallet.userId}`);
      return;
    }

    // Ignore 0 to 16 TRX (covers small gas fee transfers and smart contract triggers)
    if (amountTrx >= 0 && amountTrx <= 16) {
      console.log(`[DepositPoller] Ignored small TRX deposit of ${amountTrx} TRX (0-16 limit) for user ${wallet.userId}`);
      return;
    }

    const existing = await prisma.deposit.findUnique({ where: { txHash } });
    if (existing) return;

    const deposit = await prisma.deposit.create({
      data: {
        userId: wallet.userId,
        txHash,
        fromAddress,
        amount: amountTrx,
        currency: 'TRX',
        status: 'pending_approval',
        sweepStatus: 'pending'
      }
    });

    console.log(`[DepositPoller] New TRX deposit: ${amountTrx} TRX | user ${wallet.userId} | tx ${txHash}`);

    const depositApproval = require('./depositApproval');
    try {
      await depositApproval.approveDeposit(deposit.id);
      console.log(`[DepositPoller] Auto-approved deposit ${deposit.id}`);
    } catch (err) {
      console.error(`[DepositPoller] Auto-approve failed for deposit ${deposit.id}:`, err.message);
      if (global.ns) {
        await global.ns.send(
          wallet.userId,
          'Deposit Detected',
          `We detected ${amountTrx} TRX sent to your wallet. It will be credited shortly.`,
          'DEPOSIT'
        );
      }
    }
  }
}

module.exports = DepositPoller;
