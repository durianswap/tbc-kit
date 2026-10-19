'use strict'

const crypto = require('crypto')
const {
  CONTRACT_PACKAGE,
  TBC_PACKAGE,
  contract,
  tbc
} = require('./multisig-js-165-dependencies')

const { MultiSig } = contract

for (const helper of [
  'getMultiSigAddress',
  'getMultiSigLockScript',
  'getCombineHash',
  'buildHoldScript',
  'buildTapeScript'
]) {
  if (typeof MultiSig[helper] !== 'function') {
    throw new Error(`tbc-contract 1.6.5 runtime helper MultiSig.${helper} is unavailable`)
  }
}

function publicKeyForTestScalar (value) {
  const scalarHex = value.toString(16).padStart(64, '0')
  return new tbc.PrivateKey(scalarHex, 'testnet').toPublicKey().toString()
}

function scriptFixture (script) {
  const bytes = script.toBuffer()
  return {
    hex: bytes.toString('hex'),
    length: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex')
  }
}

function buildCase (name, requiredSignatures, publicKeyCount) {
  // Rust canonicalizes compressed keys. The JS helper hashes caller order, so canonicalize
  // before invoking JS to compare the two SDKs under the Rust address policy.
  const publicKeys = Array.from(
    { length: publicKeyCount },
    (_, index) => publicKeyForTestScalar(index + 1)
  ).sort()
  const address = MultiSig.getMultiSigAddress(
    publicKeys,
    requiredSignatures,
    publicKeyCount
  )
  const decoded = MultiSig.getSignatureAndPublicKeyCount(address)
  if (
    decoded.signatureCount !== requiredSignatures ||
    decoded.publicKeyCount !== publicKeyCount
  ) {
    throw new Error(`decoded policy mismatch for ${name}`)
  }

  return {
    name,
    requiredSignatures,
    publicKeyCount,
    publicKeys,
    address,
    lockScript: scriptFixture(
      tbc.Script.fromASM(MultiSig.getMultiSigLockScript(address))
    ),
    combineHash: MultiSig.getCombineHash(address),
    holdScripts: publicKeys.map((publicKey) =>
      scriptFixture(MultiSig.buildHoldScript(publicKey))
    ),
    tapeScript: scriptFixture(MultiSig.buildTapeScript(address, publicKeys))
  }
}

const fixture = {
  contractName: CONTRACT_PACKAGE.name,
  contractVersion: CONTRACT_PACKAGE.version,
  tbcLibVersion: TBC_PACKAGE.version,
  publicKeyOrder: 'compressed-hex-ascending',
  cases: [
    buildCase('1-of-3', 1, 3),
    buildCase('2-of-3', 2, 3),
    buildCase('6-of-10', 6, 10)
  ]
}

process.stdout.write(`${JSON.stringify(fixture, null, 2)}\n`)
