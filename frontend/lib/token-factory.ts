import type { Abi } from "viem";
import tokenFactoryAbiJson from "./abis/token-factory-abi.json";
import {
  GRADUATION_ETH_TARGET_WEI_FALLBACK,
  LAUNCH_FEE_WEI_FALLBACK,
  PREDICTION_MARKET_ADDRESS,
  TOKEN_FACTORY_ADDRESS,
} from "./deployments";

export {
  GRADUATION_ETH_TARGET_WEI_FALLBACK,
  LAUNCH_FEE_WEI_FALLBACK,
  PREDICTION_MARKET_ADDRESS,
  TOKEN_FACTORY_ADDRESS,
} from "./deployments";

export const tokenFactoryAbi = tokenFactoryAbiJson as Abi;
