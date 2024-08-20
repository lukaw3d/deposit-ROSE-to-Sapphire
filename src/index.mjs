// @ts-check
import * as oasis from '@oasisprotocol/client'
import * as oasisRT from '@oasisprotocol/client-rt'
import { bytesToHex, privateToAddress, toChecksumAddress } from '@ethereumjs/util'
import { hdkey } from '@ethereumjs/wallet'

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

// consensus (signer) -> sapphire (intermediateSapphireSigner) -> target sapphire (sapphireAddress)
async function init() {
  const mnemonic = oasis.hdkey.HDKey.generateMnemonic(256)
  const signer = oasis.signature.NaclSigner.fromSecret((await oasis.hdkey.HDKey.getAccountSigner(mnemonic, 0)).secretKey, 'this key is not important')
  const consensusAddress =
    /** @type {`oasis1${string}`} */
    (await publicKeyToAddress(signer.public()))

  const intermediateSapphireSigner = oasisRT.signatureSecp256k1.EllipticSigner.fromPrivate(hdkey.EthereumHDKey.fromMnemonic(mnemonic).derivePath("m/44'/60'/0'/0/0").getWallet().getPrivateKey(), 'this key is not important')
  const intermediateSapphireAddress = privateToEthAddress(intermediateSapphireSigner.key.getPrivate('hex'))

  const sapphireAddress =
    /** @type {`0x${string}`} */
    (prompt('Sapphire address you want to send ROSE to', '0x') || '')
  if (!sapphireAddress) throw new Error('Invalid sapphire address')
  if (!/^0x[0-9a-fA-F]{40}$/.test(sapphireAddress)) throw new Error('Invalid sapphire address')

  const nic = new oasis.client.NodeInternal('https://grpc.oasis.io')
  const chainContext = await nic.consensusGetChainContext()

  async function updateBalances() {
    const consensusBalance = await getConsensusBalance(consensusAddress)
    const intermediateSapphireBalance = await getSapphireBalance(intermediateSapphireAddress)
    const sapphireBalance = await getSapphireBalance(sapphireAddress)

    window.print_mnemonic.textContent = mnemonic
    window.print_consensus_account.textContent = consensusAddress + '   balance: ' + consensusBalance
    window.print_intermediate_sapphire_account.textContent = intermediateSapphireAddress + '   balance: ' + intermediateSapphireBalance
    window.print_sapphire_account.textContent = sapphireAddress + '   balance: ' + sapphireBalance
    return { consensusBalance, intermediateSapphireBalance, sapphireBalance }
  }

  async function poll() {
    try {
      const { consensusBalance, intermediateSapphireBalance, sapphireBalance } = await updateBalances()
      console.log({ consensusBalance, intermediateSapphireBalance, sapphireBalance })
      if (consensusBalance > 0n) {
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

        // Deposit into intermediate Sapphire
        const rtw = new oasisRT.consensusAccounts.Wrapper(
          oasis.misc.fromHex(sapphireConfig.mainnet.runtimeId),
        ).callDeposit()
        rtw
          .setBody({
            amount: [oasis.quantity.fromBigInt(amountToDeposit * multiplyConsensusToSapphire), oasisRT.token.NATIVE_DENOMINATION],
            // Don't deposit to final sapphire account directly. Users might input an exchange account
            // that doesn't recognize deposit txs.
            to: oasis.staking.addressFromBech32(await getEvmBech32Address(intermediateSapphireAddress)),
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
        setTimeout(poll, 10000) // Fetch balances again and it'll trigger next IF
      } else if (intermediateSapphireBalance > 0n) {
        console.log('transferable', intermediateSapphireBalance)
        const feeAmount = sapphireConfig.gasPrice * sapphireConfig.feeGas * multiplyConsensusToSapphire
        const amountToTransfer = intermediateSapphireBalance - feeAmount

        // Transfer into final Sapphire
        const rtw = new oasisRT.accounts.Wrapper(
          oasis.misc.fromHex(sapphireConfig.mainnet.runtimeId),
        ).callTransfer()
        rtw
          .setBody({
            amount: [oasis.quantity.fromBigInt(amountToTransfer), oasisRT.token.NATIVE_DENOMINATION],
            to: oasis.staking.addressFromBech32(await getEvmBech32Address(sapphireAddress)),
          })
          .setFeeAmount([oasis.quantity.fromBigInt(feeAmount), oasisRT.token.NATIVE_DENOMINATION])
          .setFeeGas(sapphireConfig.feeGas)
          .setSignerInfo([
            {
              address_spec: {
                signature: { secp256k1eth: intermediateSapphireSigner.public() },
              },
              nonce: await getSapphireNonce(await getEvmBech32Address(intermediateSapphireAddress)),
            },
          ])

        await rtw.sign([new oasis.signature.BlindContextSigner(intermediateSapphireSigner)], chainContext)
        await rtw.submit(nic)
        setTimeout(poll, 1) // Update balances
      } else {
        setTimeout(poll, 10000)
      }
    } catch (err) {
      console.error(err)
      alert(err)
      setTimeout(poll, 10000)
    }
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

/** @param {string} ethPrivateKey */
function privateToEthAddress(ethPrivateKey) {
  return /** @type {`0x${string}`} */ (
    toChecksumAddress(bytesToHex(privateToAddress(hexToBuffer(ethPrivateKey))))
  )
}

/** @param {string} value */
function hexToBuffer(value) {
  return Buffer.from(value, 'hex')
}

/** @param {`0x${string}`} evmAddress */
async function getEvmBech32Address(evmAddress) {
  const evmBytes = oasis.misc.fromHex(evmAddress.replace('0x', ''))
  const address = await oasis.address.fromData(
    oasisRT.address.V0_SECP256K1ETH_CONTEXT_IDENTIFIER,
    oasisRT.address.V0_SECP256K1ETH_CONTEXT_VERSION,
    evmBytes,
  )
  const bech32Address = /** @type {`oasis1${string}`}*/ (oasisRT.address.toBech32(address))
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
