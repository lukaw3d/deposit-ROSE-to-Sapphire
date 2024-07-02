// @ts-check
import * as oasis from '@oasisprotocol/client'
import * as oasisRT from '@oasisprotocol/client-rt'

const sapphireConfig = {
  mainnet: {
    address: 'oasis1qrd3mnzhhgst26hsp96uf45yhq6zlax0cuzdgcfc',
    runtimeId: '000000000000000000000000000000000000000000000000f80306c9858e7279',
  },
  testnet: {
    address: 'oasis1qqczuf3x6glkgjuf0xgtcpjjw95r3crf7y2323xd',
    runtimeId: '000000000000000000000000000000000000000000000000a6d1e3ebf60dff6c',
  },
  gasPrice: 100n,
  feeGas: 70_000n, // hardcoded. TODO: update when sapphire is upgraded
  decimals: 18,
}
const consensusConfig = {
  decimals: 9,
}
const multiplyConsensusToSapphire = 10n ** BigInt(sapphireConfig.decimals - consensusConfig.decimals)

async function init() {
  const mnemonic = oasis.hdkey.HDKey.generateMnemonic(256)
  const signer = oasis.signature.NaclSigner.fromSecret((await oasis.hdkey.HDKey.getAccountSigner(mnemonic, 0)).secretKey, 'this key is not important')
  const consensusAddress =
    /** @type {`oasis1${string}`} */
    (await publicKeyToAddress(signer.public()))

  const sapphireAddress =
    /** @type {`0x${string}`} */
    (prompt('Sapphire address you want to send ROSE to', '0x') || '')
  if (!sapphireAddress) throw new Error('Invalid sapphire address')
  if (!/^0x[0-9a-fA-F]{40}$/.test(sapphireAddress)) throw new Error('Invalid sapphire address')

  const nic = new oasis.client.NodeInternal('https://grpc.oasis.io')
  const chainContext = await nic.consensusGetChainContext()

  async function poll() {
    try {
      const consensusBalance = await getConsensusBalance(consensusAddress)
      const sapphireBalance = await getSapphireBalance(sapphireAddress)
      console.log({ consensusBalance, sapphireBalance })

      window.print_mnemonic.textContent = mnemonic
      window.print_consensus_account.textContent = consensusAddress + ' balance: ' + consensusBalance
      window.print_sapphire_account.textContent = sapphireAddress + ' balance: ' + sapphireBalance
      if (consensusBalance <= 0n) {
        setTimeout(poll, 10000)
        return
      }

      console.log('depositable', consensusBalance)
      const amountToDeposit = consensusBalance

      // setAllowance to sapphireConfig.mainnet.address
      const tw = oasis.staking.allowWrapper()
      tw.setNonce(await getConsensusNonce(consensusAddress))
      tw.setFeeAmount(oasis.quantity.fromBigInt(0n))
      tw.setBody({
        beneficiary: oasis.staking.addressFromBech32(sapphireConfig.mainnet.address),
        negative: false,
        amount_change: oasis.quantity.fromBigInt(amountToDeposit), // TODO: this assumes that initial allowance is 0
      })
      const gas = await tw.estimateGas(nic, signer.public())
      tw.setFeeGas(gas)
      await tw.sign(new oasis.signature.BlindContextSigner(signer), chainContext)
      await tw.submit(nic)

      // Deposit into Sapphire
      const rtw = new oasisRT.consensusAccounts.Wrapper(
        oasis.misc.fromHex(sapphireConfig.mainnet.runtimeId),
      ).callDeposit()
      rtw
        .setBody({
          amount: [oasis.quantity.fromBigInt(amountToDeposit * multiplyConsensusToSapphire), oasisRT.token.NATIVE_DENOMINATION],
          to: oasis.staking.addressFromBech32(await getEvmBech32Address(sapphireAddress)),
        })
        .setFeeAmount([oasis.quantity.fromBigInt(0n), oasisRT.token.NATIVE_DENOMINATION])
        .setFeeGas(sapphireConfig.feeGas)
        .setFeeConsensusMessages(1)
        .setSignerInfo([
          {
            address_spec: {
              signature: { ed25519: signer.public() },
            },
            nonce: await getSapphireNonce(consensusAddress),
          },
        ])
      await rtw.sign([new oasis.signature.BlindContextSigner(signer)], chainContext)
      await rtw.submit(nic)
    } catch (err) {
      console.error(err)
      alert(err)
    }

    poll()
  }
  poll()

  window.addEventListener('beforeunload', event => {
    event.preventDefault()
    // Included for legacy support, e.g. Chrome/Edge < 119
    event.returnValue = true
  })
}
init().catch((err) => {
  console.error(err)
  alert(err)
})

// Utils

/** @param {Uint8Array} publicKey */
async function publicKeyToAddress(publicKey) {
  const data = await oasis.staking.addressFromPublicKey(publicKey)
  return oasis.staking.addressToBech32(data)
}

/** @param {`0x${string}`} evmAddress */
async function getEvmBech32Address(evmAddress) {
  const evmBytes = oasis.misc.fromHex(evmAddress.replace('0x', ''))
  const address = await oasis.address.fromData(
    oasisRT.address.V0_SECP256K1ETH_CONTEXT_IDENTIFIER,
    oasisRT.address.V0_SECP256K1ETH_CONTEXT_VERSION,
    evmBytes,
  )
  const bech32Address = oasisRT.address.toBech32(address)
  return bech32Address
}

/**
 * @param {`oasis1${string}`} oasisAddress
 */
async function getConsensusBalance(oasisAddress) {
  const nic = new oasis.client.NodeInternal('https://grpc.oasis.io')
  const owner = oasis.staking.addressFromBech32(oasisAddress)
  const account = await nic.stakingAccount({ height: oasis.consensus.HEIGHT_LATEST, owner: owner })
  return oasis.quantity.toBigInt(account.general?.balance ?? new Uint8Array([0]))
}
/**
 * @param {`oasis1${string}`} oasisAddress
 */
async function getConsensusNonce(oasisAddress) {
  const nic = new oasis.client.NodeInternal('https://grpc.oasis.io')
  const nonce =
    (await nic.consensusGetSignerNonce({
      account_address: oasis.staking.addressFromBech32(oasisAddress),
      height: 0,
    })) ?? 0
  return nonce
}

/**
 * @param {`oasis1${string}`} oasisAddress
 */
async function getSapphireNonce(oasisAddress) {
  const nic = new oasis.client.NodeInternal('https://grpc.oasis.io')
  const accountsWrapper = new oasisRT.accounts.Wrapper(oasis.misc.fromHex(sapphireConfig.mainnet.runtimeId))
  const nonce = await accountsWrapper
    .queryNonce()
    .setArgs({ address: oasis.staking.addressFromBech32(oasisAddress) })
    .query(nic)
  return nonce
}

/**
 * @param {`0x${string}`} ethAddress
 */
async function getSapphireBalance(ethAddress) {
  const nic = new oasis.client.NodeInternal('https://grpc.oasis.io')
  const consensusWrapper = new oasisRT.consensusAccounts.Wrapper(
    oasis.misc.fromHex(sapphireConfig.mainnet.runtimeId),
  )
  const underlyingAddress = await oasis.address.fromData(
    oasisRT.address.V0_SECP256K1ETH_CONTEXT_IDENTIFIER,
    oasisRT.address.V0_SECP256K1ETH_CONTEXT_VERSION,
    oasis.misc.fromHex(ethAddress.replace('0x', '')),
  )

  const balanceResult = await consensusWrapper
    .queryBalance()
    .setArgs({
      address: underlyingAddress,
    })
    .query(nic)
  const balance = oasis.quantity.toBigInt(balanceResult.balance)
  return balance
}
