'use strict';

require('dotenv').config();

const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

// ============================================================
// CONFIG
// ============================================================

const CHECK_INTERVAL_MS = Number(process.env.CHECK_INTERVAL_MS || 2000);

const DRY_RUN =
  String(process.env.DRY_RUN || 'true').toLowerCase() === 'true';

const MIN_SWEEP_NATIVE =
  String(process.env.MIN_SWEEP_NATIVE || '0');

const GAS_LIMIT_BUFFER_BPS =
  BigInt(process.env.GAS_LIMIT_BUFFER_BPS || '12000');

const GAS_PRICE_MULTIPLIER_BPS =
  BigInt(process.env.GAS_PRICE_MULTIPLIER_BPS || '11000');

const CONFIRMATIONS =
  Number(process.env.CONFIRMATIONS || 1);

const NETWORKS_FILE =
  path.join(__dirname, 'networks.json');

const STATE_FILE =
  path.join(__dirname, 'sweeper-state.json');

let stopping = false;


// ============================================================
// HELPERS
// ============================================================

const sleep = ms =>
  new Promise(resolve => setTimeout(resolve, ms));

const validAddress = address =>
  ethers.isAddress(address);

const bps = (value, basisPoints) =>
  (value * BigInt(basisPoints)) / 10000n;

function formatNative(value) {
  return ethers.formatEther(value);
}

function formatToken(value, decimals) {
  return ethers.formatUnits(value, decimals);
}


// ============================================================
// LOAD NETWORK CONFIG
// ============================================================

function loadNetworks() {
  if (!fs.existsSync(NETWORKS_FILE)) {
    throw new Error(
      `Missing ${NETWORKS_FILE}. Create the file using the example provided.`
    );
  }

  let data;

  try {
    data = JSON.parse(
      fs.readFileSync(NETWORKS_FILE, 'utf8')
    );
  } catch (error) {
    throw new Error(
      `Invalid JSON in networks.json: ${error.message}`
    );
  }

  if (!Array.isArray(data)) {
    throw new Error(
      'networks.json must contain a JSON array.'
    );
  }

  return data;
}

const NETWORKS = loadNetworks();


// ============================================================
// STATE
// ============================================================

function loadState() {
  if (!fs.existsSync(STATE_FILE)) {
    return {
      networks: {}
    };
  }

  try {
    return JSON.parse(
      fs.readFileSync(STATE_FILE, 'utf8')
    );
  } catch (error) {
    throw new Error(
      'Cannot read sweeper-state.json. Resolve any pending transaction before editing it.'
    );
  }
}

const state = loadState();

if (!state.networks) {
  state.networks = {};
}


function saveState() {
  const temporaryFile = `${STATE_FILE}.tmp`;

  fs.writeFileSync(
    temporaryFile,
    JSON.stringify(state, null, 2),
    'utf8'
  );

  fs.renameSync(
    temporaryFile,
    STATE_FILE
  );
}


function networkState(name) {
  if (!state.networks[name]) {
    state.networks[name] = {
      nativePending: null,
      tokenPending: null
    };
  }

  return state.networks[name];
}


// ============================================================
// VALIDATE CONFIG
// ============================================================

function validateConfig() {
  if (!NETWORKS.length) {
    throw new Error(
      'networks.json is empty.'
    );
  }

  if (!process.env.EVM_PRIVATE_KEY) {
    throw new Error(
      'Missing EVM_PRIVATE_KEY in .env'
    );
  }

  for (const network of NETWORKS) {

    if (!network.name) {
      throw new Error(
        'A network is missing "name".'
      );
    }

    if (!network.rpcUrl) {
      throw new Error(
        `${network.name}: missing rpcUrl.`
      );
    }

    if (!network.nativeSymbol) {
      throw new Error(
        `${network.name}: missing nativeSymbol.`
      );
    }

    if (!validAddress(network.businessWallet)) {
      throw new Error(
        `${network.name}: invalid businessWallet.`
      );
    }

    if (!validAddress(network.destinationWallet)) {
      throw new Error(
        `${network.name}: invalid destinationWallet.`
      );
    }

    if (
      network.businessWallet.toLowerCase() ===
      network.destinationWallet.toLowerCase()
    ) {
      throw new Error(
        `${network.name}: businessWallet and destinationWallet cannot be the same.`
      );
    }

    if (!Array.isArray(network.tokens)) {
      network.tokens = [];
    }

    for (const token of network.tokens) {

      if (!validAddress(token.address)) {
        throw new Error(
          `${network.name}: invalid token address ${token.address}`
        );
      }

      if (!token.symbol) {
        throw new Error(
          `${network.name}: token ${token.address} is missing symbol`
        );
      }

      if (
        token.decimals !== undefined &&
        (
          !Number.isInteger(Number(token.decimals)) ||
          Number(token.decimals) < 0 ||
          Number(token.decimals) > 255
        )
      ) {
        throw new Error(
          `${network.name}: invalid decimals for ${token.symbol}`
        );
      }
    }
  }
}


// ============================================================
// ERC-20 ABI
// ============================================================

const ERC20_ABI = [

  'function balanceOf(address owner) view returns (uint256)',

  'function decimals() view returns (uint8)',

  'function symbol() view returns (string)',

  'function transfer(address to, uint256 amount) returns (bool)'
];


// ============================================================
// FEE QUOTE
// ============================================================

async function getFeeQuote(provider) {

  const feeData =
    await provider.getFeeData();

  if (
    feeData.maxFeePerGas !== null &&
    feeData.maxPriorityFeePerGas !== null
  ) {

    return {
      type: 'eip1559',

      maxFeePerGas:
        bps(
          feeData.maxFeePerGas,
          GAS_PRICE_MULTIPLIER_BPS
        ),

      maxPriorityFeePerGas:
        bps(
          feeData.maxPriorityFeePerGas,
          GAS_PRICE_MULTIPLIER_BPS
        )
    };
  }

  if (feeData.gasPrice !== null) {

    return {
      type: 'legacy',

      gasPrice:
        bps(
          feeData.gasPrice,
          GAS_PRICE_MULTIPLIER_BPS
        )
    };
  }

  throw new Error(
    'RPC did not provide gas pricing information.'
  );
}


// ============================================================
// APPLY FEE
// ============================================================

function applyFee(transaction, fee) {

  if (fee.type === 'legacy') {

    transaction.gasPrice =
      fee.gasPrice;

  } else {

    transaction.maxFeePerGas =
      fee.maxFeePerGas;

    transaction.maxPriorityFeePerGas =
      fee.maxPriorityFeePerGas;
  }

  return transaction;
}


// ============================================================
// PENDING TRANSACTION CHECK
// ============================================================

async function checkPendingNative(
  provider,
  network,
  networkStateData
) {

  if (!networkStateData.nativePending) {
    return false;
  }

  const pending =
    networkStateData.nativePending;

  try {

    const receipt =
      await provider.getTransactionReceipt(
        pending.hash
      );

    if (!receipt) {

      console.log(
        `  ⏳ Native transaction still pending: ${pending.hash}`
      );

      return true;
    }

    if (Number(receipt.status) === 1) {

      console.log(
        `  ✅ Native transaction confirmed: ${pending.hash}`
      );

    } else {

      console.log(
        `  ❌ Native transaction failed: ${pending.hash}`
      );
    }

    networkStateData.nativePending = null;

    saveState();

    return false;

  } catch (error) {

    console.log(
      `  ⚠️ Could not check native transaction: ${error.message}`
    );

    return true;
  }
}


async function checkPendingToken(
  provider,
  networkStateData
) {

  if (!networkStateData.tokenPending) {
    return false;
  }

  const pending =
    networkStateData.tokenPending;

  try {

    const receipt =
      await provider.getTransactionReceipt(
        pending.hash
      );

    if (!receipt) {

      console.log(
        `  ⏳ Token transaction still pending: ${pending.hash}`
      );

      return true;
    }

    if (Number(receipt.status) === 1) {

      console.log(
        `  ✅ ${pending.symbol} transaction confirmed: ${pending.hash}`
      );

    } else {

      console.log(
        `  ❌ ${pending.symbol} transaction failed: ${pending.hash}`
      );
    }

    networkStateData.tokenPending = null;

    saveState();

    return false;

  } catch (error) {

    console.log(
      `  ⚠️ Could not check token transaction: ${error.message}`
    );

    return true;
  }
}


// ============================================================
// TOKEN SWEEP
// ============================================================

async function sweepTokens(
  network,
  provider,
  wallet,
  networkStateData
) {

  if (networkStateData.tokenPending) {

    const busy =
      await checkPendingToken(
        provider,
        networkStateData
      );

    if (busy) {
      return true;
    }
  }


  if (!network.tokens.length) {
    return false;
  }


  for (const tokenConfig of network.tokens) {

    let contract;
    let symbol =
      tokenConfig.symbol;

    let decimals;
    let balance;

    try {

      contract =
        new ethers.Contract(
          tokenConfig.address,
          ERC20_ABI,
          wallet
        );

      decimals =
        tokenConfig.decimals !== undefined
          ? Number(tokenConfig.decimals)
          : Number(await contract.decimals());

      balance =
        await contract.balanceOf(
          network.businessWallet
        );

    } catch (error) {

      console.log(
        `  ⚠️ ${symbol}: unable to read balance: ${error.message}`
      );

      continue;
    }


    if (balance === 0n) {
      continue;
    }


    const displayBalance =
      formatToken(
        balance,
        decimals
      );


    let minimum = 0n;

    if (
      tokenConfig.minAmount !== undefined
    ) {

      minimum =
        ethers.parseUnits(
          String(tokenConfig.minAmount),
          decimals
        );
    }


    if (balance < minimum) {

      console.log(
        `  ℹ️ ${symbol}: ${displayBalance} below minimum ${tokenConfig.minAmount}`
      );

      continue;
    }


    console.log(
      `  🪙 ${symbol}: ${displayBalance} available`
    );


    // --------------------------------------------------------
    // Estimate token transfer gas
    // --------------------------------------------------------

    let gasLimit;
    let fee;

    try {

      gasLimit =
        await contract.transfer.estimateGas(
          network.destinationWallet,
          balance
        );

      gasLimit =
        bps(
          gasLimit,
          GAS_LIMIT_BUFFER_BPS
        );

      fee =
        await getFeeQuote(
          provider
        );

    } catch (error) {

      console.log(
        `  ⚠️ ${symbol}: gas estimation failed: ${error.message}`
      );

      continue;
    }


    const feePerGas =
      fee.type === 'legacy'
        ? fee.gasPrice
        : fee.maxFeePerGas;


    const gasCost =
      gasLimit * feePerGas;


    const nativeBalance =
      await provider.getBalance(
        network.businessWallet
      );


    console.log(
      `  ⛽ ${symbol}: estimated gas ~${formatNative(gasCost)} ${network.nativeSymbol}`
    );


    if (nativeBalance < gasCost) {

      console.log(
        `  ⚠️ ${symbol}: insufficient ${network.nativeSymbol} for gas.`
      );

      console.log(
        `     Required: ~${formatNative(gasCost)} ${network.nativeSymbol}`
      );

      console.log(
        `     Available: ${formatNative(nativeBalance)} ${network.nativeSymbol}`
      );

      continue;
    }


    // --------------------------------------------------------
    // DRY RUN
    // --------------------------------------------------------

    if (DRY_RUN) {

      console.log(
        `  🟡 DRY RUN: would transfer ${displayBalance} ${symbol}`
      );

      console.log(
        `     From: ${network.businessWallet}`
      );

      console.log(
        `     To:   ${network.destinationWallet}`
      );

      continue;
    }


    // --------------------------------------------------------
    // SEND TOKEN
    // --------------------------------------------------------

    try {

      const nonce =
        await provider.getTransactionCount(
          network.businessWallet,
          'pending'
        );


      const data =
        contract.interface.encodeFunctionData(
          'transfer',
          [
            network.destinationWallet,
            balance
          ]
        );


      const transaction = {

        to:
          tokenConfig.address,

        data,

        nonce,

        gasLimit
      };


      applyFee(
        transaction,
        fee
      );


      console.log(
        `  🚀 ${symbol}: broadcasting nonce ${nonce}...`
      );


      const sent =
        await wallet.sendTransaction(
          transaction
        );


      networkStateData.tokenPending = {

        hash:
          sent.hash,

        nonce,

        token:
          tokenConfig.address,

        symbol,

        amount:
          displayBalance,

        submittedAt:
          Date.now()
      };


      saveState();


      console.log(
        `  ✅ ${symbol}: transaction broadcast`
      );

      console.log(
        `     Hash: ${sent.hash}`
      );


      // Only one transaction at a time.
      return true;

    } catch (error) {

      console.log(
        `  ❌ ${symbol}: transaction failed: ${error.message}`
      );

      return false;
    }
  }


  return false;
}


// ============================================================
// NATIVE COIN SWEEP
// ============================================================

async function sweepNative(
  network,
  provider,
  wallet,
  networkStateData
) {

  if (networkStateData.nativePending) {

    return await checkPendingNative(
      provider,
      network,
      networkStateData
    );
  }


  const balance =
    await provider.getBalance(
      network.businessWallet
    );


  if (balance === 0n) {

    console.log(
      `  💰 Native balance: 0 ${network.nativeSymbol}`
    );

    return false;
  }


  let gasLimit;
  let fee;


  try {

    gasLimit =
      await provider.estimateGas({

        from:
          network.businessWallet,

        to:
          network.destinationWallet,

        value:
          0n
      });


    gasLimit =
      bps(
        gasLimit,
        GAS_LIMIT_BUFFER_BPS
      );


    fee =
      await getFeeQuote(
        provider
      );

  } catch (error) {

    console.log(
      `  ⚠️ Native gas estimation failed: ${error.message}`
    );

    return false;
  }


  const feePerGas =
    fee.type === 'legacy'
      ? fee.gasPrice
      : fee.maxFeePerGas;


  const gasCost =
    gasLimit * feePerGas;


  const available =
    balance > gasCost
      ? balance - gasCost
      : 0n;


  const minimum =
    ethers.parseEther(
      MIN_SWEEP_NATIVE
    );


  console.log(
    `  💰 Native balance: ${formatNative(balance)} ${network.nativeSymbol}`
  );

  console.log(
    `  ⛽ Native gas budget: ~${formatNative(gasCost)} ${network.nativeSymbol}`
  );


  if (available <= 0n) {

    console.log(
      `  ℹ️ Nothing available after gas.`
    );

    return false;
  }


  if (available < minimum) {

    console.log(
      `  ℹ️ Available native amount ${formatNative(available)}`
    );

    console.log(
      `     is below MIN_SWEEP_NATIVE=${MIN_SWEEP_NATIVE}`
    );

    return false;
  }


  console.log(
    `  🚨 Native available: ${formatNative(available)} ${network.nativeSymbol}`
  );


  // ----------------------------------------------------------
  // DRY RUN
  // ----------------------------------------------------------

  if (DRY_RUN) {

    console.log(
      `  🟡 DRY RUN: would transfer ${formatNative(available)} ${network.nativeSymbol}`
    );

    console.log(
      `     From: ${network.businessWallet}`
    );

    console.log(
      `     To:   ${network.destinationWallet}`
    );

    return false;
  }


  // ----------------------------------------------------------
  // SEND NATIVE
  // ----------------------------------------------------------

  try {

    const nonce =
      await provider.getTransactionCount(
        network.businessWallet,
        'pending'
      );


    const transaction = {

      to:
        network.destinationWallet,

      value:
        available,

      nonce,

      gasLimit
    };


    applyFee(
      transaction,
      fee
    );


    console.log(
      `  🚀 Native: broadcasting nonce ${nonce}...`
    );


    const sent =
      await wallet.sendTransaction(
        transaction
      );


    networkStateData.nativePending = {

      hash:
        sent.hash,

      nonce,

      amountNative:
        formatNative(available),

      submittedAt:
        Date.now()
    };


    saveState();


    console.log(
      `  ✅ Native: transaction broadcast`
    );

    console.log(
      `     Hash: ${sent.hash}`
    );


    return true;

  } catch (error) {

    console.log(
      `  ❌ Native: transaction failed: ${error.message}`
    );

    return false;
  }
}


// ============================================================
// PROCESS ONE NETWORK
// ============================================================

async function processNetwork(network) {

  const provider =
    new ethers.JsonRpcProvider(
      network.rpcUrl
    );


  const wallet =
    new ethers.Wallet(
      process.env.EVM_PRIVATE_KEY,
      provider
    );


  const networkStateData =
    networkState(
      network.name
    );


  let chain;

  try {

    chain =
      await provider.getNetwork();

  } catch (error) {

    console.log(
      `❌ ${network.name}: unable to connect to RPC: ${error.message}`
    );

    return;
  }


  // ----------------------------------------------------------
  // PRIVATE KEY CHECK
  // ----------------------------------------------------------

  if (
    wallet.address.toLowerCase() !==
    network.businessWallet.toLowerCase()
  ) {

    throw new Error(
      `${network.name}: EVM_PRIVATE_KEY does not match businessWallet.`
    );
  }


  console.log(
    `\n[${new Date().toLocaleTimeString()}] ${network.name}`
  );

  console.log(
    `  Chain ID: ${chain.chainId}`
  );


  // ----------------------------------------------------------
  // CHECK NATIVE PENDING
  // ----------------------------------------------------------

  if (
    await checkPendingNative(
      provider,
      network,
      networkStateData
    )
  ) {

    return;
  }


  // ----------------------------------------------------------
  // CHECK TOKEN PENDING
  // ----------------------------------------------------------

  if (
    await checkPendingToken(
      provider,
      networkStateData
    )
  ) {

    return;
  }


  // ----------------------------------------------------------
  // TOKEN FIRST
  // ----------------------------------------------------------

  const tokenBusy =
    await sweepTokens(
      network,
      provider,
      wallet,
      networkStateData
    );


  if (tokenBusy) {
    return;
  }


  // ----------------------------------------------------------
  // NATIVE LAST
  // ----------------------------------------------------------

  await sweepNative(
    network,
    provider,
    wallet,
    networkStateData
  );
}


// ============================================================
// MAIN
// ============================================================

async function main() {

  validateConfig();


  const signer =
    new ethers.Wallet(
      process.env.EVM_PRIVATE_KEY
    );


  console.log('');
  console.log('========================================');
  console.log('       MULTI-NETWORK EVM AUTO SWEEPER');
  console.log('========================================');

  console.log(
    `Signer: ${signer.address}`
  );

  console.log(
    `Networks: ${NETWORKS.map(n => n.name).join(', ')}`
  );

  console.log(
    `Check interval: ${CHECK_INTERVAL_MS} ms`
  );

  console.log(
    `Dry run: ${DRY_RUN}`
  );

  console.log(
    `Native minimum: ${MIN_SWEEP_NATIVE}`
  );

  console.log(
    `Confirmations: ${CONFIRMATIONS}`
  );

  console.log(
    `Token mode: explicit allowlist`
  );

  console.log('========================================');


  while (!stopping) {

    for (const network of NETWORKS) {

      if (stopping) {
        break;
      }


      try {

        await processNetwork(
          network
        );

      } catch (error) {

        console.log(
          `❌ ${network.name}: ${error.message}`
        );
      }
    }


    if (!stopping) {

      await sleep(
        CHECK_INTERVAL_MS
      );
    }
  }
}


// ============================================================
// SHUTDOWN
// ============================================================

function stop() {

  if (stopping) {
    return;
  }

  stopping = true;

  saveState();

  console.log('');
  console.log(
    '🛑 Stopping sweeper. Pending state is preserved.'
  );
}


process.on(
  'SIGINT',
  stop
);

process.on(
  'SIGTERM',
  stop
);


// ============================================================
// START
// ============================================================

main().catch(error => {

  console.error('');
  console.error(
    `❌ Fatal error: ${error.message}`
  );

  process.exit(1);
});