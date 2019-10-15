import { validateProofs, verifyProfileToken } from 'blockstack'
import { logger } from './utils'
import fetch from 'node-fetch'
import * as cheerio from 'cheerio'

import { NotEnoughProofError } from './errors'
import { ProofCheckerConfigInterface } from './config'
import { getTokenPayload } from './authentication'

export class ProofChecker {
  proofsRequired: number

  constructor(proofsConfig?: ProofCheckerConfigInterface) {
    if (!proofsConfig) {
      this.proofsRequired = 0
    } else {
      this.proofsRequired = proofsConfig.proofsRequired
    }
  }

  async fetchProfile(address: string, readURL: string) {
    const filename = `${address}/profile.json`
    const url = `${readURL}${filename}`

    const result = await fetch(url)
    const json = await result.json()
    const token = json[0].token
    const verified = await verifyProfileToken(token, address)
    return getTokenPayload(verified).claim
  }

  validEnough(validProofs: Array<any>) {
    logger.debug(`Found ${validProofs.length} valid proofs for user.`)
    return (validProofs.length >= this.proofsRequired)
  }

  async checkProofs(address: string, filename: string, readURL: string) {
    if (this.proofsRequired == 0 || filename.endsWith('/profile.json')) {
      return true
    }

    let validProofs
    try {
      const profile = await this.fetchProfile(address, readURL)
      const proofs: any[] = await validateProofs(profile, address, cheerio)
      validProofs = proofs.filter(p => p.valid)
    } catch (error) {
      logger.error(error)
      throw new NotEnoughProofError('Error fetching and verifying social proofs')
    }

    if (this.validEnough(validProofs)) {
      return true
    } else {
      throw new NotEnoughProofError('Not enough social proofs for gaia hub writes')
    }
  }
}
