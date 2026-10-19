'use strict'

const fs = require('fs')
const { Interpreter, tbc } = require('./multisig-js-165-dependencies')

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
  } catch (error) {
    throw new Error(`request.raw is not a transaction: ${error.message}`)
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
    } catch (error) {
      throw new Error(`${location}.lockingScript is invalid: ${error.message}`)
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
    } catch (error) {
      throw new Error(`input ${input.index}: interpreter exception: ${error.message}`)
    }
    if (!verified) {
      throw new Error(`input ${input.index}: ${interpreter.errstr || 'SCRIPT_ERR_UNKNOWN'}`)
    }
  }

  return request.inputs.length
}

function main () {
  if (process.argv.length !== 2) {
    throw new Error('verify-multisig-inputs accepts JSON on stdin only')
  }
  const stdin = fs.readFileSync(0, 'utf8')
  if (stdin.trim().length === 0) {
    throw new Error('stdin must contain one JSON request')
  }

  let request
  try {
    request = JSON.parse(stdin)
  } catch (error) {
    throw new Error(`stdin is not valid JSON: ${error.message}`)
  }
  const count = verifyRequest(request)
  process.stdout.write(`verified ${count} input${count === 1 ? '' : 's'}\n`)
}

try {
  main()
} catch (error) {
  process.stderr.write(`${error.message}\n`)
  process.exitCode = 1
}
