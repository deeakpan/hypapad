// app/api/bubblemap-data/route.js
// Fetches top token holders via Etherscan V2 API (Base Sepolia / Base Mainnet)

import { NextResponse } from 'next/server';

const ETHERSCAN_KEY = process.env.ETHERSCAN_API_KEY || '';
const CHAIN_ID      = process.env.CHAIN_ID || '84532'; // Base Sepolia
const BASE_API      = 'https://api.etherscan.io/v2/api';

const isAddr = (s) => typeof s === 'string' && /^0x[a-fA-F0-9]{40}$/i.test(s);
const toLower = (s) => (typeof s === 'string' ? s.toLowerCase() : s);

async function fetchHolders(token, limit = 50) {
  const out = [];
  let page = 1;
  const pageSize = Math.min(limit * 2, 500);

  while (out.length < limit) {
    const url = `${BASE_API}?chainid=${CHAIN_ID}&module=token&action=tokenholderlist&contractaddress=${token}&page=${page}&offset=${pageSize}&apikey=${ETHERSCAN_KEY}`;
    const res  = await fetch(url);
    const data = await res.json();

    if (data.status !== '1' || !Array.isArray(data.result)) break;

    for (const h of data.result) {
      const addr    = toLower(h.TokenHolderAddress || h.address);
      const balance = h.TokenHolderQuantity || h.balance || '0';
      if (isAddr(addr)) out.push({ address: addr, balance, is_contract: false });
    }

    if (data.result.length < pageSize) break; // no more pages
    page++;
  }

  // Dedupe
  const map = new Map();
  for (const h of out) if (Number(h.balance) > 0) map.set(h.address, h);

  return [...map.values()]
    .sort((a, b) => Number(b.balance) - Number(a.balance))
    .slice(0, limit);
}

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const token = toLower(searchParams.get('token'));

    if (!isAddr(token)) {
      return NextResponse.json({ error: 'Token address required' }, { status: 400 });
    }

    const n     = Number(searchParams.get('limit') || searchParams.get('topCount') || '50');
    const LIMIT = Number.isFinite(n) && n > 0 ? Math.min(n, 200) : 50;

    const holders = await fetchHolders(token, LIMIT);

    return NextResponse.json({
      holders,
      transfers: [],   // edges come from wallet-token-transfers endpoint
      fetchedAt: Date.now()
    });

  } catch (e) {
    return NextResponse.json(
      { error: 'Failed to fetch holders', detail: String(e?.message || e) },
      { status: 500 }
    );
  }
}
