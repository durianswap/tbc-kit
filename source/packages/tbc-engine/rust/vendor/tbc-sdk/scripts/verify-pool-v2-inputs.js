'use strict'

const fs = require('fs')
const path = require('path')
const {
  TBC_ROOT,
  assertLoadedAuthorityClosure,
  tbc
} = require('./pool-v2-js-165-dependencies')

const Interpreter = require(path.join(TBC_ROOT, 'lib/script/interpreter.js'))
const MAX_SAFE_SATOSHIS = BigInt(Number.MAX_SAFE_INTEGER)

function isObject (value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function requireExactFields (value, expected, location) {
  if (!isObject(value)) {
    throw new Error(`${location} must be an object`)
  }
  const expectedFields = new Set(expected)
  for (const field of Object.keys(value)) {
    if (!expectedFields.has(field)) {
      throw new Error(`${location}: unexpected field ${field}`)
    }
  }
  for (const field of expected) {
    if (!Object.hasOwn(value, field)) {
      throw new Error(`${location}: missing field ${field}`)
    }
  }
}

function requireHex (value, location) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length % 2 !== 0 ||
    !/^[0-9a-fA-F]+$/.test(value)
  ) {
    throw new Error(`${location} must be non-empty even-length hex`)
  }
}

function parseSatoshis (value, location) {
  let amount
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`${location} must be a safe non-negative integer or decimal string`)
    }
    amount = BigInt(value)
  } else if (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)) {
    amount = BigInt(value)
  } else {
    throw new Error(`${location} must be a safe non-negative integer or decimal string`)
  }

  if (amount > MAX_SAFE_SATOSHIS) {
    throw new Error(`${location} must be a safe non-negative integer or decimal string`)
  }
  return new tbc.crypto.BN(amount.toString(10), 10)
}

function verifyRequest (request) {
  requireExactFields(request, ['raw', 'inputs'], 'request')
  requireHex(request.raw, 'request.raw')
  if (!Array.isArray(request.inputs) || request.inputs.length === 0) {
    throw new Error('request.inputs must be a non-empty array')
  }

  let transaction
  try {
    transaction = new tbc.Transaction(request.raw)
  } catch (_) {
    throw new Error('request.raw is not a transaction')
  }
  if (transaction.uncheckedSerialize().toLowerCase() !== request.raw.toLowerCase()) {
    throw new Error('request.raw is not a canonical transaction encoding')
  }

  Interpreter.MAX_SCRIPT_ELEMENT_SIZE = Number.MAX_SAFE_INTEGER
  Interpreter.MAXIMUM_ELEMENT_SIZE = Number.MAX_SAFE_INTEGER
  Interpreter.MAX_SCRIPT_SIZE = Number.MAX_SAFE_INTEGER
  Interpreter.MAX_OPCODE_COUNT = Number.MAX_SAFE_INTEGER

  const seenIndexes = new Set()
  for (let position = 0; position < request.inputs.length; position++) {
    const input = request.inputs[position]
    const location = `request.inputs[${position}]`
    requireExactFields(input, ['index', 'satoshis', 'lockingScript'], location)
    if (!Number.isSafeInteger(input.index) || input.index < 0) {
      throw new Error(`${location}.index must be a safe non-negative integer`)
    }
    if (input.index >= transaction.inputs.length) {
      throw new Error(`${location}.index ${input.index} is outside the transaction input range`)
    }
    if (seenIndexes.has(input.index)) {
      throw new Error(`duplicate input index ${input.index}`)
    }
    seenIndexes.add(input.index)

    const satoshis = parseSatoshis(input.satoshis, `${location}.satoshis`)
    requireHex(input.lockingScript, `${location}.lockingScript`)

    let lockingScript
    try {
      lockingScript = tbc.Script.fromHex(input.lockingScript)
    } catch (_) {
      throw new Error(`${location}.lockingScript is invalid`)
    }

    const interpreter = new Interpreter()
    let verified
    try {
      verified = interpreter.verify(
        transaction.inputs[input.index].script,
        lockingScript,
        transaction,
        input.index,
        Interpreter.DEFAULT_FLAGS,
        satoshis
      )
    } catch (_) {
      throw new Error(`input ${input.index}: mandatory-script-verify: interpreter exception`)
    }
    if (!verified) {
      const code = /^SCRIPT_ERR_[A-Z0-9_]+$/.test(interpreter.errstr)
        ? interpreter.errstr
        : 'SCRIPT_ERR_UNKNOWN'
      throw new Error(`input ${input.index}: mandatory-script-verify: ${code}`)
    }
  }

  return request.inputs.length
}

function main () {
  if (process.argv.length !== 2) {
    throw new Error('verify-pool-v2-inputs accepts JSON on stdin only')
  }
  const stdin = fs.readFileSync(0, 'utf8')
  if (stdin.trim().length === 0) {
    throw new Error('stdin must contain one JSON request')
  }

  let request
  try {
    request = JSON.parse(stdin)
  } catch (_) {
    throw new Error('stdin is not valid JSON')
  }
  assertLoadedAuthorityClosure()
  const count = verifyRequest(request)
  process.stdout.write(`${JSON.stringify({ ok: true, verified: count })}\n`)
}

try {
  main()
} catch (error) {
  process.stderr.write(`${error.message}\n`)
  process.exitCode = 1
}
