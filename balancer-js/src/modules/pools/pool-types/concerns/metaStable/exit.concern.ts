import { BigNumber, parseFixed } from '@ethersproject/bignumber';
import OldBigNumber from 'bignumber.js';
import * as SDK from '@georgeroman/balancer-v2-pools';
import {
  ExitConcern,
  ExitExactBPTInParameters,
  ExitExactTokensOutParameters,
  ExitPool,
  ExitPoolAttributes,
} from '../types';
import { AssetHelpers, parsePoolInfo } from '@/lib/utils';
import { Vault__factory } from '@balancer-labs/typechain';
import { WeightedPoolEncoder } from '@/pool-weighted';
import { addSlippage, subSlippage } from '@/lib/utils/slippageHelper';
import { balancerVault } from '@/lib/constants/config';
import { BalancerError, BalancerErrorCode } from '@/balancerErrors';

export class MetaStablePoolExit implements ExitConcern {
  /**
   * Build exit pool transaction parameters with exact BPT in and minimum token amounts out based on slippage tolerance
   * @param {string}  exiter - Account address exiting pool
   * @param {Pool}    pool - Subgraph pool object of pool being exited
   * @param {string}  bptIn - BPT provided for exiting pool
   * @param {string}  slippage - Maximum slippage tolerance in percentage. i.e. 0.05 = 5%
   * @param {string}  singleTokenMaxOut - Optional: token address that if provided will exit to given token
   * @returns         transaction request ready to send with signer.sendTransaction
   */
  buildExitExactBPTIn = ({
    exiter,
    pool,
    bptIn,
    slippage,
    singleTokenMaxOut,
  }: ExitExactBPTInParameters): ExitPoolAttributes => {
    if (!bptIn.length || parseFixed(bptIn, 18).isNegative()) {
      throw new BalancerError(BalancerErrorCode.INPUT_OUT_OF_BOUNDS);
    }
    if (
      singleTokenMaxOut &&
      !pool.tokens.map((t) => t.address).some((a) => a === singleTokenMaxOut)
    ) {
      throw new BalancerError(BalancerErrorCode.TOKEN_MISMATCH);
    }

    // Check if there's any relevant weighted pool info missing
    if (pool.tokens.some((token) => !token.decimals))
      throw new BalancerError(BalancerErrorCode.MISSING_DECIMALS);
    if (!pool.amp) throw new BalancerError(BalancerErrorCode.MISSING_AMP);
    if (pool.tokens.some((token) => !token.priceRate))
      throw new BalancerError(BalancerErrorCode.MISSING_PRICE_RATE);

    const {
      parsedTokens,
      parsedBalances,
      parsedAmp,
      parsedPriceRates,
      parsedTotalShares,
      parsedSwapFee,
    } = parsePoolInfo(pool);

    const WETH = '0x000000000000000000000000000000000000000F'; // TODO: check if it should be possible to exit with ETH instead of WETH
    const assetHelpers = new AssetHelpers(WETH);
    const [sortedTokens, sortedBalances, sortedPriceRates] =
      assetHelpers.sortTokens(
        parsedTokens,
        parsedBalances,
        parsedPriceRates
      ) as [string[], string[], string[]];

    // scale balances based on price rate for each token
    const scaledBalances = sortedBalances.map((balance, i) => {
      return BigNumber.from(balance)
        .mul(BigNumber.from(sortedPriceRates[i]))
        .div(parseFixed('1', 18))
        .toString();
    });

    let minAmountsOut = Array(parsedTokens.length).fill('0');
    let userData: string;

    if (singleTokenMaxOut) {
      // Exit pool with single token using exact bptIn

      const singleTokenMaxOutIndex = parsedTokens.indexOf(singleTokenMaxOut);

      const scaledAmountOut = SDK.StableMath._calcTokenOutGivenExactBptIn(
        new OldBigNumber(parsedAmp as string),
        scaledBalances.map((b) => new OldBigNumber(b)),
        singleTokenMaxOutIndex,
        new OldBigNumber(bptIn),
        new OldBigNumber(parsedTotalShares),
        new OldBigNumber(parsedSwapFee)
      ).toString();

      // reverse scaled amount out based on token price rate
      const amountOut = BigNumber.from(scaledAmountOut)
        .div(BigNumber.from(sortedPriceRates[singleTokenMaxOutIndex]))
        .mul(parseFixed('1', 18))
        .toString();

      minAmountsOut[singleTokenMaxOutIndex] = subSlippage(
        BigNumber.from(amountOut),
        BigNumber.from(slippage)
      ).toString();

      userData = WeightedPoolEncoder.exitExactBPTInForOneTokenOut(
        bptIn,
        singleTokenMaxOutIndex
      );
    } else {
      // Exit pool with all tokens proportinally

      const scaledAmountsOut = SDK.StableMath._calcTokensOutGivenExactBptIn(
        scaledBalances.map((b) => new OldBigNumber(b)),
        new OldBigNumber(bptIn),
        new OldBigNumber(parsedTotalShares)
      ).map((amount) => amount.toString());

      // reverse scaled amounts out based on token price rate
      const amountsOut = scaledAmountsOut.map((amount, i) => {
        return BigNumber.from(amount)
          .div(BigNumber.from(sortedPriceRates[i]))
          .mul(parseFixed('1', 18))
          .toString();
      });

      minAmountsOut = amountsOut.map((amount) => {
        const minAmount = subSlippage(
          BigNumber.from(amount),
          BigNumber.from(slippage)
        );
        return minAmount.toString();
      });

      userData = WeightedPoolEncoder.exitExactBPTInForTokensOut(bptIn);
    }

    const to = balancerVault;
    const functionName = 'exitPool';
    const attributes: ExitPool = {
      poolId: pool.id,
      sender: exiter,
      recipient: exiter,
      exitPoolRequest: {
        assets: sortedTokens,
        minAmountsOut,
        userData,
        toInternalBalance: false,
      },
    };
    const vaultInterface = Vault__factory.createInterface();
    // encode transaction data into an ABI byte string which can be sent to the network to be executed
    const data = vaultInterface.encodeFunctionData(functionName, [
      attributes.poolId,
      attributes.sender,
      attributes.recipient,
      attributes.exitPoolRequest,
    ]);

    return {
      to,
      functionName,
      attributes,
      data,
      minAmountsOut,
      maxBPTIn: bptIn,
    };
  };

  /**
   * Build exit pool transaction parameters with exact tokens out and maximum BPT in based on slippage tolerance
   * @param {string}    exiter - Account address exiting pool
   * @param {Pool}      pool - Subgraph pool object of pool being exited
   * @param {string[]}  tokensOut - Tokens provided for exiting pool
   * @param {string[]}  amountsOut - Amoutns provided for exiting pool
   * @param {string}    slippage - Maximum slippage tolerance in percentage. i.e. 0.05 = 5%
   * @returns           transaction request ready to send with signer.sendTransaction
   */
  buildExitExactTokensOut = ({
    exiter,
    pool,
    tokensOut,
    amountsOut,
    slippage,
  }: ExitExactTokensOutParameters): ExitPoolAttributes => {
    if (
      tokensOut.length != amountsOut.length ||
      tokensOut.length != pool.tokensList.length
    ) {
      throw new BalancerError(BalancerErrorCode.INPUT_LENGTH_MISMATCH);
    }

    const {
      parsedTokens,
      parsedBalances,
      parsedPriceRates,
      parsedAmp,
      parsedTotalShares,
      parsedSwapFee,
    } = parsePoolInfo(pool);

    const WETH = '0x000000000000000000000000000000000000000F'; // TODO: check if it should be possible to exit with ETH instead of WETH
    const assetHelpers = new AssetHelpers(WETH);
    const [, sortedBalances, sortedPriceRates] = assetHelpers.sortTokens(
      parsedTokens,
      parsedBalances,
      parsedPriceRates
    ) as [string[], string[], string[]];
    const [sortedTokens, sortedAmounts] = assetHelpers.sortTokens(
      tokensOut,
      amountsOut
    ) as [string[], string[]];

    // scale amounts in based on price rate for each token
    const scaledAmounts = sortedAmounts.map((amount, i) => {
      return BigNumber.from(amount)
        .mul(BigNumber.from(sortedPriceRates[i]))
        .div(parseFixed('1', 18))
        .toString();
    });

    // scale balances based on price rate for each token
    const scaledBalances = sortedBalances.map((balance, i) => {
      return BigNumber.from(balance)
        .mul(BigNumber.from(sortedPriceRates[i]))
        .div(parseFixed('1', 18))
        .toString();
    });

    const bptIn = SDK.StableMath._calcBptInGivenExactTokensOut(
      new OldBigNumber(parsedAmp as string),
      scaledBalances.map((b) => new OldBigNumber(b)),
      scaledAmounts.map((a) => new OldBigNumber(a)),
      new OldBigNumber(parsedTotalShares),
      new OldBigNumber(parsedSwapFee)
    ).toString();

    const maxBPTIn = addSlippage(
      BigNumber.from(bptIn),
      BigNumber.from(slippage)
    ).toString();

    const userData = WeightedPoolEncoder.exitBPTInForExactTokensOut(
      sortedAmounts,
      maxBPTIn
    );

    const to = balancerVault;
    const functionName = 'exitPool';
    const attributes: ExitPool = {
      poolId: pool.id,
      sender: exiter,
      recipient: exiter,
      exitPoolRequest: {
        assets: sortedTokens,
        minAmountsOut: sortedAmounts,
        userData,
        toInternalBalance: false,
      },
    };
    const vaultInterface = Vault__factory.createInterface();
    // encode transaction data into an ABI byte string which can be sent to the network to be executed
    const data = vaultInterface.encodeFunctionData(functionName, [
      attributes.poolId,
      attributes.sender,
      attributes.recipient,
      attributes.exitPoolRequest,
    ]);

    return {
      to,
      functionName,
      attributes,
      data,
      minAmountsOut: sortedAmounts,
      maxBPTIn,
    };
  };
}
