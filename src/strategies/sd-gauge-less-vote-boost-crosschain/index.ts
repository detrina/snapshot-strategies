import { getAddress } from '@ethersproject/address';
import { getProvider, multicall, subgraphRequest } from '../../utils';
import { BigNumber } from '@ethersproject/bignumber';
import { formatUnits } from '@ethersproject/units';

export const author = 'pierremarsotlyon1';
export const version = '0.0.1';

const VE_SDT = '0x0C30476f66034E11782938DF8e4384970B6c9e8a';
const VE_PROXY_BOOST_SDT = '0xD67bdBefF01Fc492f1864E61756E5FBB3f173506';
const TOKENLESS_PRODUCTION = 40;

// Used ABI
const abi = [
  'function balanceOf(address account) external view returns (uint256)',
  'function working_supply() external view returns (uint256)',
  'function totalSupply() external view returns (uint256)',
  'function working_balances(address account) external view returns (uint256)',
  'function balances(uint256 i) external view returns (uint256)',
  'function adjusted_balance_of(address user) external view returns (uint256)'
];

export async function strategy(
  space,
  network,
  provider,
  addresses,
  options,
  snapshot
): Promise<Record<string, number>> {
  // Maximum of 2 multicall!
  if (options.twavpNumberOfBlocks > 2) {
    throw new Error('maximum of 2 calls');
  }

  // Maximum of 20 whitelisted address
  if (options.whiteListedAddress.length > 20) {
    throw new Error('maximum of 20 whitelisted address');
  }

  // Addresses in tlc
  addresses = addresses.map((addr) => addr.toLowerCase());

  // --- Create block number list for twavp
  // Obtain last block number
  // Create block tag
  let blockTag = 0;
  if (typeof snapshot === 'number') {
    blockTag = snapshot;
  } else {
    blockTag = await provider.getBlockNumber();
  }

  // Mainnet data
  const mainnetProvider = getProvider("1");

  // Get corresponding block number on mainnet
  let mainnetBlockTag = await getIDChainBlock(
    blockTag,
    provider,
    "1"
  );

  if (mainnetBlockTag === "latest") {
    mainnetBlockTag = await mainnetProvider.getBlockNumber();
  }

  // Create block lists
  const blockListMainnet = getPreviousBlocks(
    mainnetBlockTag,
    options.twavpNumberOfBlocks,
    options.twavpDaysInterval,
    7200
  );

  const blockList = getPreviousBlocks(
    blockTag,
    options.twavpNumberOfBlocks,
    options.twavpDaysInterval,
    options.blocksPerDay
  );

  // Queries
  const ajustedBalancesMainnet = addresses.map((address: any) => [
    VE_PROXY_BOOST_SDT,
    'adjusted_balance_of',
    [address]
  ]);

  const sdTknGaugeBalanceCurrentChain = addresses.map((address: any) => [
    options.sdTokenGauge,
    'balanceOf',
    [address]
  ]);

  const responsesMainnet: any[] = [];
  const responsesCurrentChain: any[] = [];

  let veSDTTotalSupply = 0;
  let sdTokenGaugeTotalSupply = 0;

  for (let i = 0; i < options.twavpNumberOfBlocks; i++) {
    const isEnd = i === options.twavpNumberOfBlocks - 1;

    // Mainnet
    let calls: any[] = ajustedBalancesMainnet;
    if (isEnd) {
      // Fetch veSDT total supply
      calls.push([VE_SDT, 'totalSupply']);
    }

    let callResp: any[] = await multicall("1", mainnetProvider, abi, calls, {
      blockTag: blockListMainnet[i]
    });

    if (isEnd) {
      veSDTTotalSupply = parseFloat(formatUnits(callResp.pop()[0], 18));
    }

    responsesMainnet.push(callResp);

    // Destination chain
    calls = sdTknGaugeBalanceCurrentChain;
    if (isEnd) {
      calls.push([options.sdTokenGauge, 'totalSupply']);
    }

    callResp = await multicall(
      network,
      provider,
      abi,
      calls,
      { blockTag: blockList[i] }
    );

    if (isEnd) {
      sdTokenGaugeTotalSupply = parseFloat(
        formatUnits(callResp.pop()[0], 18)
      );
    }

    responsesCurrentChain.push(callResp);
  }

  return Object.fromEntries(
    Array(addresses.length)
      .fill('x')
      .map((_, i) => {
        // Init array of working balances for user
        const userWorkingBalances: number[] = [];

        for (let j = 0; j < options.twavpNumberOfBlocks; j++) {
          const voting_balance = parseFloat(
            formatUnits(BigNumber.from(responsesMainnet[j].shift()[0]), 18)
          );
          const l = parseFloat(
            formatUnits(
              BigNumber.from(responsesCurrentChain[j].shift()[0]),
              18
            )
          );

          let lim = (l * TOKENLESS_PRODUCTION) / 100;
          if (veSDTTotalSupply > 0) {
            lim +=
              (((sdTokenGaugeTotalSupply * voting_balance) /
                veSDTTotalSupply) *
                (100 - TOKENLESS_PRODUCTION)) /
              100;
          }

          userWorkingBalances.push(Math.min(l, lim));
        }

        // Get average working balance.
        const averageWorkingBalance = average(
          userWorkingBalances,
          addresses[i],
          options.whiteListedAddress
        );

        // Return address and voting power
        return [getAddress(addresses[i]), Number(averageWorkingBalance)];
      })
  );
}

function getPreviousBlocks(
  currentBlockNumber: number,
  numberOfBlocks: number,
  daysInterval: number,
  blocksPerDay: number
): number[] {
  // Calculate total blocks interval
  const totalBlocksInterval = blocksPerDay * daysInterval;
  // Calculate block interval
  const blockInterval = totalBlocksInterval / (numberOfBlocks - 1);

  // Init array of block numbers
  const blockNumbers: number[] = [];

  for (let i = 0; i < numberOfBlocks; i++) {
    // Calculate block number
    const blockNumber =
      currentBlockNumber - totalBlocksInterval + blockInterval * i;

    // Add block number to array
    blockNumbers.push(Math.round(blockNumber));
  }

  // Return array of block numbers
  return blockNumbers;
}

function average(
  numbers: number[],
  address: string,
  whiteListedAddress: string[]
): number {
  // If no numbers, return 0 to avoid division by 0.
  if (numbers.length === 0) return 0;

  // If address is whitelisted, return most recent working balance. i.e. no twavp applied.
  if (whiteListedAddress.includes(address)) return numbers[numbers.length - 1];

  // Init sum
  let sum = 0;
  // Loop through all elements and add them to sum
  for (let i = 0; i < numbers.length; i++) {
    sum += numbers[i];
  }

  // Return sum divided by array length to get mean
  return sum / numbers.length;
}

async function getIDChainBlock(snapshot, provider, chainId) {
  const ts = (await provider.getBlock(snapshot)).timestamp;
  const query = {
    blocks: {
      __args: {
        where: {
          ts: ts,
          network_in: [chainId]
        }
      },
      number: true
    }
  };
  const url = 'https://blockfinder.snapshot.org';
  const data = await subgraphRequest(url, query);
  return data.blocks[0].number;
}
