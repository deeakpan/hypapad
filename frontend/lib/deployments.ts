import { parseEther } from "viem";
import raw from "../deployments.json";

export type HypapadDeployments = {
  network: string;
  chainId: number;
  deployedAt: string;
  deployer: string;
  contracts: {
    WETH9: string;
    UniswapV2Factory: string;
    UniswapV2Router02: string;
    TokenFactory: string;
    PredictionMarket: string;
  };
  graduationTargetEth: string;
  launchFeeWei: string;
  launchFeeEth: string;
};

export const deployments = raw as HypapadDeployments;

/** Prefer `NEXT_PUBLIC_TOKEN_FACTORY` for staging; else `frontend/deployments.json`. */
export const TOKEN_FACTORY_ADDRESS =
  (process.env.NEXT_PUBLIC_TOKEN_FACTORY as `0x${string}` | undefined) ??
  (deployments.contracts.TokenFactory as `0x${string}`);

export const PREDICTION_MARKET_ADDRESS = deployments.contracts
  .PredictionMarket as `0x${string}`;

export const LAUNCH_FEE_WEI_FALLBACK = BigInt(deployments.launchFeeWei);

/** Fallback if `graduationEthTarget()` RPC fails — should match last deploy config. */
export const GRADUATION_ETH_TARGET_WEI_FALLBACK = parseEther(
  deployments.graduationTargetEth,
);
