'use strict'

const assert = require('assert/strict')
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const {
  CONTRACT_ENTRY,
  CONTRACT_PACKAGE,
  CONTRACT_ROOT,
  TBC_ENTRY,
  TBC_PACKAGE,
  TBC_ROOT,
  contract,
  tbc
} = require('./multisig-js-165-dependencies')

assert.equal(CONTRACT_ROOT, fs.realpathSync('/home/ubuntu/projects/tbc-contract'))
assert.equal(CONTRACT_ENTRY, fs.realpathSync('/home/ubuntu/projects/tbc-contract/index.js'))
assert.equal(CONTRACT_PACKAGE.name, 'tbc-contract')
assert.equal(CONTRACT_PACKAGE.version, '1.6.5')
assert.equal(TBC_ROOT, fs.realpathSync('/home/ubuntu/projects/tbc-contract/node_modules/tbc-lib-js'))
assert.equal(TBC_ENTRY, fs.realpathSync('/home/ubuntu/projects/tbc-contract/node_modules/tbc-lib-js/index.js'))
assert.equal(TBC_PACKAGE.name, 'tbc-lib-js')
assert.equal(TBC_PACKAGE.version, '1.0.31')
assert.equal(contract.MultiSig, require(CONTRACT_ENTRY).MultiSig)
assert.equal(tbc, require(TBC_ENTRY))

const verifier = path.join(__dirname, 'verify-multisig-inputs.js')

const privateKey = new tbc.PrivateKey('07'.padStart(64, '0'), 'testnet')
const address = privateKey.toAddress()
const lockingScript = tbc.Script.buildPublicKeyHashOut(address)
const transaction = new tbc.Transaction()
  .from({
    txid: '11'.repeat(32),
    vout: 0,
    scriptPubKey: lockingScript.toHex(),
    satoshis: 100000
  })
  .to(address, 99920)
  .fee(80)
  .sign(privateKey)

assert.equal(transaction.isFullySigned(), true)

const validRequest = {
  raw: transaction.uncheckedSerialize(),
  inputs: [{
    index: 0,
    satoshis: '100000',
    lockingScript: lockingScript.toHex()
  }]
}

function run (request) {
  return spawnSync(process.execPath, [verifier], {
    encoding: 'utf8',
    input: `${JSON.stringify(request)}\n`
  })
}

const success = run(validRequest)
assert.equal(success.status, 0, success.stderr)
assert.equal(success.stdout, 'verified 1 input\n')
assert.equal(success.stderr, '')

const wrongAmount = structuredClone(validRequest)
wrongAmount.inputs[0].satoshis = 100001
const wrongAmountResult = run(wrongAmount)
assert.notEqual(wrongAmountResult.status, 0)
assert.match(wrongAmountResult.stderr, /input 0: SCRIPT_ERR_/)
assert.equal(wrongAmountResult.stdout, '')

const otherPrivateKey = new tbc.PrivateKey('08'.padStart(64, '0'), 'testnet')
const wrongScript = structuredClone(validRequest)
wrongScript.inputs[0].lockingScript = tbc.Script
  .buildPublicKeyHashOut(otherPrivateKey.toAddress())
  .toHex()
const wrongScriptResult = run(wrongScript)
assert.notEqual(wrongScriptResult.status, 0)
assert.match(wrongScriptResult.stderr, /input 0: SCRIPT_ERR_/)
assert.equal(wrongScriptResult.stdout, '')

const signerSet = [1, 2, 3]
  .map((scalar) => {
    const signer = new tbc.PrivateKey(scalar.toString(16).padStart(64, '0'), 'testnet')
    return { signer, publicKey: signer.toPublicKey().toString() }
  })
  .sort((left, right) => left.publicKey.localeCompare(right.publicKey))
const multisigPublicKeys = signerSet.map(({ publicKey }) => publicKey)
const multisigAddress = contract.MultiSig.getMultiSigAddress(multisigPublicKeys, 2, 3)
const multisigLockingScript = tbc.Script.fromASM(
  contract.MultiSig.getMultiSigLockScript(multisigAddress)
)
const multisigUnsigned = contract.MultiSig.buildMultiSigTransaction_sendTBC(
  multisigAddress,
  new tbc.PrivateKey('09'.padStart(64, '0'), 'livenet').toAddress().toString(),
  '0.05',
  [{
    txid: '22'.repeat(32),
    vout: 0,
    scriptPubKey: multisigLockingScript.toHex(),
    satoshis: 100000
  }]
)
const firstSignerSignatures = contract.MultiSig.signMultiSigTransaction_sendTBC(
  multisigAddress,
  multisigUnsigned,
  signerSet[0].signer
)
const secondSignerSignatures = contract.MultiSig.signMultiSigTransaction_sendTBC(
  multisigAddress,
  multisigUnsigned,
  signerSet[1].signer
)

function finishMultisig (firstSignature, secondSignature, publicKeys = multisigPublicKeys) {
  return contract.MultiSig.finishMultiSigTransaction_sendTBC(
    multisigUnsigned.txraw,
    [[firstSignature, secondSignature]],
    publicKeys
  )
}

function multisigRequest (raw) {
  return {
    raw,
    inputs: [{
      index: 0,
      satoshis: '100000',
      lockingScript: multisigLockingScript.toHex()
    }]
  }
}

function assertMultisigFailure (raw, expectedError) {
  const result = run(multisigRequest(raw))
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, expectedError)
  assert.equal(result.stdout, '')
}

const validMultisigRaw = finishMultisig(
  firstSignerSignatures[0],
  secondSignerSignatures[0]
)
const validMultisigResult = run(multisigRequest(validMultisigRaw))
assert.equal(validMultisigResult.status, 0, validMultisigResult.stderr)
assert.equal(validMultisigResult.stdout, 'verified 1 input\n')
assert.equal(validMultisigResult.stderr, '')

const tamperedSignatureBytes = Buffer.from(firstSignerSignatures[0], 'hex')
const rLength = tamperedSignatureBytes[3]
tamperedSignatureBytes[4 + rLength - 1] ^= 0x01
assertMultisigFailure(
  finishMultisig(tamperedSignatureBytes.toString('hex'), secondSignerSignatures[0]),
  /input 0: SCRIPT_ERR_/
)

const malformedDerBytes = Buffer.from(firstSignerSignatures[0], 'hex')
malformedDerBytes[0] = 0x31
assertMultisigFailure(
  finishMultisig(malformedDerBytes.toString('hex'), secondSignerSignatures[0]),
  /input 0: SCRIPT_ERR_SIG_DER_INVALID_FORMAT/
)

const tamperedPublicKeys = [...multisigPublicKeys]
tamperedPublicKeys[2] = new tbc.PrivateKey('0a'.padStart(64, '0'), 'testnet')
  .toPublicKey()
  .toString()
assertMultisigFailure(
  finishMultisig(firstSignerSignatures[0], secondSignerSignatures[0], tamperedPublicKeys),
  /input 0: SCRIPT_ERR_EQUALVERIFY/
)

function withHashType (signature, hashType) {
  return `${signature.slice(0, -2)}${hashType.toString(16).padStart(2, '0')}`
}

assertMultisigFailure(
  finishMultisig(withHashType(firstSignerSignatures[0], 0x01), secondSignerSignatures[0]),
  /input 0: SCRIPT_ERR_/
)
assertMultisigFailure(
  finishMultisig(withHashType(firstSignerSignatures[0], 0x40), secondSignerSignatures[0]),
  /input 0: SCRIPT_ERR_/
)

const duplicateIndex = structuredClone(validRequest)
duplicateIndex.inputs.push(structuredClone(duplicateIndex.inputs[0]))
const duplicateResult = run(duplicateIndex)
assert.notEqual(duplicateResult.status, 0)
assert.match(duplicateResult.stderr, /duplicate input index 0/)

const unsafeAmount = structuredClone(validRequest)
unsafeAmount.inputs[0].satoshis = Number.MAX_SAFE_INTEGER + 1
const unsafeAmountResult = run(unsafeAmount)
assert.notEqual(unsafeAmountResult.status, 0)
assert.match(unsafeAmountResult.stderr, /safe non-negative integer/)

const extraField = { ...validRequest, signature: 'must-not-be-accepted' }
const extraFieldResult = run(extraField)
assert.notEqual(extraFieldResult.status, 0)
assert.match(extraFieldResult.stderr, /unexpected field/)

process.stdout.write('verify-multisig-inputs tests passed\n')
