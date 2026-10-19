'use strict'

// Simulate an ordinary checkout where the optional tx-parser sibling repository
// does not exist. Source-family authority must come from files in this repo.
const fs = require('fs')
const path = require('path')

const readFileSync = fs.readFileSync
fs.readFileSync = function portableReadFileSync (file, ...args) {
  const resolved = typeof file === 'string' ? path.resolve(file) : ''
  if (resolved.includes(`${path.sep}tx-parser${path.sep}`)) {
    throw new Error(`external tx-parser fixture access blocked: ${resolved}`)
  }
  return readFileSync.call(fs, file, ...args)
}

require('./generate-pool-v2-unlock-fixtures')
