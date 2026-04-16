// app/api/top-tokens/route.js
// Reads launched tokens directly from your TokenFactory contract
// Falls back to Etherscan token list if factory not configured

import { NextResponse } from 'next/server';

const ETHERSCAN_KEY  = process.env.ETHERSCAN_API_KEY || '';
const CHAIN_ID       = process.env.CHAIN_ID || '84532';           // Base Sepolia
const BASE_API       = 'https://api.etherscan.io/v2/api';
const FACTORY_ADDR   = process.env.NEXT_PUBLIC_FACTORY_ADDRESS || '';
const RPC_URL        = process.env.RPC_URL || 'https://sepolia.base.org';

// Minimal ABI for reading factory
const FACTORY_ABI_FRAGMENTS = [
  'function totalLaunched() view returns (uint256)',
  'function allTokens(uint256) view returns (address)',
  'function launches(address) view returns (address token, address bondingCurve, address devVesting, address pool, address dev, uint256 launchedAt, bool graduated)',
];

async function rpcCall(method, params) {
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const data = await res.json();
  return data.result;
}

// Encode function call (minimal ABI encoder)
function encodeCall(sig) {
  // keccak256 of signature, first 4 bytes
  // We use eth_call with pre-encoded data for simple view calls
  return sig;
}

async function getTokenInfo(tokenAddr) {
  try {
    const url = `${BASE_API}?chainid=${CHAIN_ID}&module=token&action=tokeninfo&contractaddress=${tokenAddr}&apikey=${ETHERSCAN_KEY}`;
    const res = await fetch(url);
    const data = await res.json();
    if (data.status === '1' && data.result?.[0]) {
      const t = data.result[0];
      return {
        id:      tokenAddr.toLowerCase(),
        address: tokenAddr.toLowerCase(),
        symbol:  t.symbol || 'UNKNOWN',
        name:    t.name   || '',
        holders: Number(t.holdersCount || t.holders || 0),
      };
    }
  } catch {}
  return { id: tokenAddr.toLowerCase(), address: tokenAddr.toLowerCase(), symbol: 'UNKNOWN', name: '', holders: 0 };
}

async function getTokensFromFactory(want) {
  if (!FACTORY_ADDR) return null;
  try {
    // eth_call to totalLaunched()
    // selector for totalLaunched() = 0x2c4e722e
    const totalHex = await rpcCall('eth_call', [{ to: FACTORY_ADDR, data: '0x2c4e722e' }, 'latest']);
    const total = parseInt(totalHex, 16);
    if (!total) return [];

    const limit = Math.min(total, want);
    const addresses = [];

    // allTokens(uint256) selector = 0x0e7afec5
    for (let i = 0; i < limit; i++) {
      const idx = i.toString(16).padStart(64, '0');
      const result = await rpcCall('eth_call', [{ to: FACTORY_ADDR, data: `0x0e7afec5${idx}` }, 'latest']);
      if (result && result !== '0x') {
        addresses.push('0x' + result.slice(-40));
      }
    }

    // Fetch token info for each in parallel (batched 5 at a time)
    const items = [];
    for (let i = 0; i < addresses.length; i += 5) {
      const batch = addresses.slice(i, i + 5);
      const infos = await Promise.all(batch.map(getTokenInfo));
      items.push(...infos);
    }
    return items.reverse(); // newest first
  } catch (e) {
    console.error('[top-tokens] factory read failed:', e.message);
    return null;
  }
}

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const n    = Number(searchParams.get('limit') || '100');
    const want = Number.isFinite(n) && n > 0 ? Math.min(n, 500) : 100;

    // Prefer factory tokens — exact list of Hypapad-launched tokens
    const factoryTokens = await getTokensFromFactory(want);
    if (factoryTokens && factoryTokens.length > 0) {
      return NextResponse.json({ items: factoryTokens, fetchedAt: Date.now(), source: 'factory' });
    }

    // Fallback: Etherscan token list for the chain (no direct "top tokens" endpoint — use search)
    // Note: Etherscan has no public "top ERC20 by holders" endpoint without Pro tier
    // Return empty so frontend shows nothing until factory is deployed
    return NextResponse.json({ items: [], fetchedAt: Date.now(), source: 'empty' });

  } catch (e) {
    return NextResponse.json(
      { error: 'Failed to fetch top tokens', detail: String(e?.message || e) },
      { status: 500 }
    );
  }
}
