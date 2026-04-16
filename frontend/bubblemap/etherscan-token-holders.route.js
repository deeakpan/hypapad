// app/api/token-holders/route.js
// Simple token holder list via Etherscan V2

import { NextResponse } from 'next/server';

const ETHERSCAN_KEY = process.env.ETHERSCAN_API_KEY || '';
const CHAIN_ID      = process.env.CHAIN_ID || '84532';
const BASE_API      = 'https://api.etherscan.io/v2/api';

export async function GET(req) {
  const { searchParams } = new URL(req.url);
  const token  = searchParams.get('token');
  const page   = searchParams.get('page')   || '1';
  const offset = searchParams.get('offset') || '50';

  if (!token) {
    return NextResponse.json(
      { error: 'Token address required (pass ?token=0x...)' },
      { status: 400 }
    );
  }

  try {
    const url  = `${BASE_API}?chainid=${CHAIN_ID}&module=token&action=tokenholderlist&contractaddress=${token}&page=${page}&offset=${offset}&apikey=${ETHERSCAN_KEY}`;
    const res  = await fetch(url);
    const data = await res.json();

    if (data.status !== '1') {
      return NextResponse.json([], { status: 200 }); // no holders yet
    }

    const holders = (data.result || []).map(h => ({
      address: (h.TokenHolderAddress || h.address || '').toLowerCase(),
      balance: h.TokenHolderQuantity || h.balance || '0',
    }));

    return NextResponse.json(holders);

  } catch (err) {
    console.error('[token-holders] error:', err);
    return NextResponse.json(
      { error: 'Failed to fetch token holders' },
      { status: 500 }
    );
  }
}
