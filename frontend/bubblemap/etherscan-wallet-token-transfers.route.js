// app/api/wallet-token-transfers/route.js
// Fetches token transfers for a wallet or transaction via Etherscan V2

import { NextResponse } from 'next/server';

const ETHERSCAN_KEY = process.env.ETHERSCAN_API_KEY || '';
const CHAIN_ID      = process.env.CHAIN_ID || '84532';
const BASE_API      = 'https://api.etherscan.io/v2/api';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export async function OPTIONS() {
  return NextResponse.json({}, { status: 200, headers: CORS_HEADERS });
}

export async function GET(req) {
  const { searchParams } = new URL(req.url);
  const address  = searchParams.get('address');
  const txhash   = searchParams.get('txhash');
  const token    = searchParams.get('token');    // optional: filter by token contract
  const page     = searchParams.get('page')    || '1';
  const limit    = searchParams.get('limit')   || '100';
  const sinceDays = Number(searchParams.get('sinceDays') || '180');

  try {
    let url;

    if (txhash) {
      // Get transfers for a specific transaction
      url = `${BASE_API}?chainid=${CHAIN_ID}&module=account&action=tokentx&txhash=${txhash}&apikey=${ETHERSCAN_KEY}`;
    } else if (address) {
      // Get token transfers for a wallet, optionally filtered by token
      const startBlock = await getStartBlock(sinceDays);
      url = `${BASE_API}?chainid=${CHAIN_ID}&module=account&action=tokentx&address=${address}&startblock=${startBlock}&endblock=99999999&page=${page}&offset=${limit}&sort=desc&apikey=${ETHERSCAN_KEY}`;
      if (token) url += `&contractaddress=${token}`;
    } else {
      return NextResponse.json({ error: 'address or txhash required' }, { status: 400, headers: CORS_HEADERS });
    }

    const res  = await fetch(url);
    const data = await res.json();

    if (data.status !== '1') {
      // No results is fine (new token, no transfers yet)
      return NextResponse.json(
        { items: [], next_page_params: null },
        { status: 200, headers: { ...CORS_HEADERS, 'Cache-Control': 'public, s-maxage=60' } }
      );
    }

    // Normalize to the shape GalaxyMap expects
    const items = (data.result || []).map(t => ({
      hash:         t.hash,
      from:         (t.from || '').toLowerCase(),
      to:           (t.to   || '').toLowerCase(),
      value:        t.value || '0',
      decimals:     t.tokenDecimal || '18',
      tokenSymbol:  t.tokenSymbol,
      tokenName:    t.tokenName,
      contractAddress: (t.contractAddress || '').toLowerCase(),
      blockNumber:  t.blockNumber,
      timeStamp:    t.timeStamp,
      // Normalized amount for GalaxyMap
      amount:       Number(t.value) / Math.pow(10, Number(t.tokenDecimal || 18)),
    }));

    return NextResponse.json(
      { items, next_page_params: items.length >= Number(limit) ? { page: String(Number(page) + 1) } : null },
      { status: 200, headers: { ...CORS_HEADERS, 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=30' } }
    );

  } catch (err) {
    console.error('[wallet-token-transfers] error:', err);
    return NextResponse.json(
      { error: 'Failed to fetch transfers' },
      { status: 502, headers: CORS_HEADERS }
    );
  }
}

// Approximate start block for sinceDays (13s avg block time on Base)
async function getStartBlock(days) {
  try {
    const blocksPerDay = Math.floor(86400 / 2); // ~2s block time on Base
    const latestRes    = await fetch(`${BASE_API}?chainid=${CHAIN_ID}&module=proxy&action=eth_blockNumber&apikey=${ETHERSCAN_KEY}`);
    const latestData   = await latestRes.json();
    const latest       = parseInt(latestData.result, 16);
    return Math.max(0, latest - days * blocksPerDay);
  } catch {
    return 0;
  }
}
